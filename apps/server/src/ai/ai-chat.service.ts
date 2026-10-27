import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { RetrievalService } from '../rag/retrieval.service.js';
import type { SearchHit, SearchMode } from '../rag/types/rag.types.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import {
  ChatQueryRewriteService,
  type ChatIntent,
} from './chat-query-rewrite.service.js';
import { retrieveUntilRelevant } from './agentic-retrieve.js';
import { WebSearchService, type WebSearchResult } from './web-search.service.js';
import { formatGraphSystemText } from '../kg/chat-graph.js';
import { GraphBuildService } from '../kg/graph-build.service.js';
import type { GraphChatHit } from '../kg/types/kg.types.js';
import { accessFromUser } from '../document/document-access.js';
import { dbRowsToMessages } from './chat-memory.util.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import type { ChatSource } from './chat.types.js';
import type {
  ChatEvalSnapshot,
  ToolRun,
  WebToolRun,
} from './eval/eval.types.js';
import { toEvalHit } from './eval/eval.types.js';
import {
  createLangfuseCallbackHandler,
  withObservation,
  withTraceAttrs,
} from '../observability/langfuse.js';

export type { ChatSource } from './chat.types.js';

export type ChatOptions = {
  /** 默认 true：写入会话与双层记忆；评测脚本必须显式关闭。 */
  persist?: boolean;
  /** 仅进程内评测使用；HTTP 响应默认不暴露内部召回与评估细节。 */
  includeEval?: boolean;
};

export type ChatResult = {
  sessionId: string | null;
  answer: string;
  sources: ChatSource[];
  eval?: ChatEvalSnapshot;
};

const EXCERPT_LEN = 200;
const CONTEXT_SNIPPET_LEN = 800;
const CITATION_RE = /\[(\d+)\]/g;

/**
 * 非流式 Agentic RAG：意图路由 → 检索 + 切题评估 → 不足改写再查 → 按需联网 → 作答。
 *
 * 保留既有能力：检索模式透传、可见性 scope、MIN_SCORE/PG 兜底、引用溯源、
 * 会话与双层记忆落库（尽力而为）。评测快照保存全轮次检索与真实工具执行结果。
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly llm: ChatOpenAI | null = null;

  constructor(
    config: ConfigService,
    private readonly retrieval: RetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly shortMemory: ChatShortMemoryService,
    private readonly longMemory: ChatLongMemoryService,
    private readonly queryRewrite: ChatQueryRewriteService,
    private readonly webSearch: WebSearchService,
    private readonly graph: GraphBuildService,
  ) {
    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      undefined;
    if (!apiKey) return;

    const baseUrl = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const model = config.get<string>('LLM_MODEL', 'qwen3.8-flash');

    this.llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      configuration: { baseURL: baseUrl },
    });
  }

  async chat(
    question: string,
    topK = 5,
    user?: AuthUser,
    sessionId?: string,
    mode?: SearchMode,
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const trimmed = question.trim();
    if (!trimmed) {
      return { sessionId: sessionId ?? null, answer: '请输入问题。', sources: [] };
    }

    return withTraceAttrs(
      {
        userId: user?.userId,
        sessionId,
        tags: ['ai-chat', 'agentic-rag'],
      },
      () =>
        withObservation('ai-chat', (update) =>
          this.runChatTurn({
            trimmed,
            topK,
            user,
            sessionId,
            mode,
            persist: options?.persist !== false,
            includeEval: Boolean(options?.includeEval),
            update,
          }),
        ),
    );
  }

  private async runChatTurn(opts: {
    trimmed: string;
    topK: number;
    user?: AuthUser;
    sessionId?: string;
    mode?: SearchMode;
    persist: boolean;
    includeEval: boolean;
    update: (fields: {
      input?: unknown;
      output?: unknown;
      metadata?: Record<string, unknown>;
    }) => void;
  }): Promise<ChatResult> {
    const { trimmed, topK, user, sessionId, mode, persist, includeEval, update } =
      opts;
    const history = user
      ? await this.loadWorkingHistory(user.userId, sessionId)
      : [];
    const plan = await this.queryRewrite.classify(trimmed, history);
    const memHitsP = user
      ? this.longMemory.search(user.userId, sessionId, plan.query)
      : Promise.resolve({ user: [] as string[], session: [] as string[] });

    // 图谱与知识库同一层：意图确定后再并行检索，不和 classify 抢跑。
    const access = user ? accessFromUser(user) : undefined;
    const kbP = plan.allowRetrieve
      ? retrieveUntilRelevant({
          question: trimmed,
          query: plan.query,
          topK,
          mode,
          user,
          retrieval: this.retrieval,
          rewrite: this.queryRewrite,
        })
      : Promise.resolve(undefined);
    let graphRun: ToolRun | undefined;
    const graphP: Promise<GraphChatHit | undefined> =
      plan.allowGraph && user && access && plan.graphQueries.length
        ? this.graph.retrieveForChat(plan.graphQueries, 8, access)
            .then((hit) => {
              graphRun = {
                success: true,
                useful: Boolean(hit.entities.length || hit.relations.length),
              };
              return hit;
            })
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              this.logger.warn(`图谱检索失败，按无图谱继续：${message}`);
              graphRun = { success: false, useful: false, error: message };
              return undefined;
            })
        : Promise.resolve(undefined);
    const [retrieved, graphHit] = await Promise.all([kbP, graphP]);
    let hits: SearchHit[] = [];
    let kbInsufficient = false;
    let searchQuery = plan.query || trimmed;
    if (retrieved) {
      hits = retrieved.hits;
      kbInsufficient = !retrieved.eval.ok;
      searchQuery = retrieved.usedQuery || searchQuery;
    }
    const hasGraph = Boolean(
      graphHit?.entities.length || graphHit?.relations.length,
    );

    const rawWeb =
      plan.allowWeb && (!plan.allowRetrieve || kbInsufficient)
        ? await this.webSearch.search(searchQuery).catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            return { query: searchQuery, items: [], error: message };
          })
        : undefined;
    const web: WebSearchResult | undefined = rawWeb;
    const webRun: WebToolRun | undefined = web
      ? {
          success: !web.error,
          useful: Boolean(web.items.length),
          ...(web.error ? { error: web.error } : {}),
          snippet: formatWebSnippet(web),
        }
      : undefined;
    const memHits = await memHitsP;

    const snapshot = (answer: string): ChatEvalSnapshot => ({
      question: trimmed,
      answer,
      intent: plan.intent,
      allowRetrieve: plan.allowRetrieve,
      allowGraph: plan.allowGraph,
      allowWeb: plan.allowWeb,
      graphQueries: plan.graphQueries,
      attempts: (retrieved?.attempts ?? []).map((attempt) => ({
        query: attempt.usedQuery,
        rawHits: attempt.rawHits.map(toEvalHit),
        gradedHits: attempt.hits.map(toEvalHit),
        eval: attempt.eval,
      })),
      retrieveCount: retrieved?.retrieveCount ?? 0,
      rewrites:
        retrieved && retrieved.attempts.length > 1
          ? [
              {
                previousQuery: retrieved.attempts[0].usedQuery,
                query: retrieved.attempts[1].usedQuery,
              },
            ]
          : [],
      graphRuns: graphRun ? [graphRun] : [],
      webRuns: webRun ? [webRun] : [],
      retrieveEval: retrieved?.eval,
    });

    const finish = (
      answer: string,
      sources: ChatSource[],
      sid: string | null,
    ): ChatResult => {
      const evalSnapshot = snapshot(answer);
      update({
        input: { question: trimmed },
        output: { answer, intent: plan.intent },
        metadata: {
          intent: plan.intent,
          retrieveCount: evalSnapshot.retrieveCount,
          graphUsed: Boolean(evalSnapshot.graphRuns.length),
          webUsed: Boolean(evalSnapshot.webRuns.length),
        },
      });
      return {
        sessionId: sid,
        answer,
        sources,
        ...(includeEval ? { eval: evalSnapshot } : {}),
      };
    };

    if (plan.intent === 'kb' && kbInsufficient && !hasGraph) {
      const empty = {
        answer: '知识库里没有相关内容。',
        sources: [] as ChatSource[],
      };
      const session =
        persist && user
          ? await this.persistTurn(
              user.userId,
              sessionId,
              trimmed,
              empty.answer,
              empty.sources,
            )
          : null;
      if (persist && user && session) {
        await this.shortMemory.appendTurn(
          user.userId,
          session.id,
          history,
          trimmed,
          empty.answer,
        );
        void this.longMemory.rememberTurn(
          user.userId,
          session.id,
          trimmed,
          empty.answer,
        );
      }
      return finish(
        empty.answer,
        empty.sources,
        session?.id ?? sessionId ?? null,
      );
    }

    if (!this.llm) {
      throw new ServiceUnavailableException(
        '未配置 LLM_API_KEY / EMBEDDING_API_KEY / OPENAI_API_KEY，无法生成回答',
      );
    }

    const memoryMsg = this.longMemory.buildSystemMessage(memHits);
    const graphMsg = graphHit ? formatGraphSystemText(graphHit) : '';
    const parts: string[] = [];
    if (hits.length) parts.push(`知识库资料：\n${this.buildContext(hits)}`);
    if (web) parts.push(`联网结果：\n${this.buildWebContext(web)}`);
    parts.push(`用户问题：${trimmed}`);
    const userTurn = parts.join('\n\n');
    const langfuseHandler = createLangfuseCallbackHandler({
      userId: user?.userId,
      sessionId,
      tags: ['agentic-rag', 'nonstream', plan.intent],
    });
    const response = await this.llm.invoke(
      [
        new SystemMessage(
          this.buildSystemPrompt(plan.intent, Boolean(hits.length), web),
        ),
        ...(memoryMsg ? [memoryMsg] : []),
        ...(graphMsg ? [new SystemMessage(graphMsg)] : []),
        ...history,
        new HumanMessage(userTurn),
      ],
      langfuseHandler ? { callbacks: [langfuseHandler] } : undefined,
    );

    const answer =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    const sources = this.toCitedSources(answer, hits);
    this.logger.log(
      `RAG 对话完成：intent=${plan.intent}, hits=${hits.length}, cited=${sources.length}, answerLength=${answer.length}`,
    );

    const session =
      persist && user
        ? await this.persistTurn(user.userId, sessionId, trimmed, answer, sources)
        : null;
    if (persist && user && session) {
      await this.shortMemory.appendTurn(
        user.userId,
        session.id,
        history,
        trimmed,
        answer,
      );
      void this.longMemory.rememberTurn(
        user.userId,
        session.id,
        trimmed,
        answer,
      );
    }
    return finish(answer, sources, session?.id ?? sessionId ?? null);
  }

  /**
   * 短期记忆工作窗口：Redis 命中直接用；miss 从 Postgres 取最近 N 条并回填。
   * 新建会话（无 sessionId）没有历史。
   */
  private async loadWorkingHistory(
    userId: string,
    sessionId: string | undefined,
  ): Promise<BaseMessage[]> {
    if (!sessionId) return [];
    const cached = await this.shortMemory.tryLoad(userId, sessionId);
    if (cached) return cached;
    const rows = await this.sessions.listRecentMessages(
      userId,
      sessionId,
      this.shortMemory.windowSize,
    );
    const history = dbRowsToMessages(rows);
    if (history.length) {
      await this.shortMemory.save(userId, sessionId, history);
      this.logger.log(
        `短期记忆从库回填：sessionId=${sessionId}, n=${history.length}`,
      );
    }
    return history;
  }

  /**
   * 一轮问答落库（尽力而为）：回答已生成，持久化失败只记日志不抛错，
   * 避免存储故障让用户拿不到答案。
   */
  private async persistTurn(
    userId: string,
    sessionId: string | undefined,
    question: string,
    answer: string,
    sources: ChatSource[],
  ) {
    try {
      return await this.sessions.appendTurn(
        userId,
        sessionId,
        question,
        answer,
        sources,
      );
    } catch (err) {
      this.logger.error(
        `会话落库失败（回答正常返回）：sessionId=${sessionId ?? '新建'}`,
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  /** 从回答中抽出 [n]，只返回实际引用的资料；未标注时回退为全部召回（摘录） */
  private toCitedSources(answer: string, hits: SearchHit[]): ChatSource[] {
    const cited = new Set<number>();
    for (const match of answer.matchAll(CITATION_RE)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= hits.length) cited.add(n);
    }

    const indexes =
      cited.size > 0
        ? [...cited].sort((a, b) => a - b)
        : hits.map((_, i) => i + 1);

    return indexes.map((index) => this.toSource(index, hits[index - 1]));
  }

  private toSource(index: number, hit: SearchHit): ChatSource {
    return {
      index,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: this.excerpt(hit.content),
      score: hit.score,
    };
  }

  private excerpt(content: string): string {
    const text = content.replace(/\s+/g, ' ').trim();
    if (text.length <= EXCERPT_LEN) return text;
    return `${text.slice(0, EXCERPT_LEN)}...`;
  }

  private buildContext(hits: SearchHit[]): string {
    return hits
      .map((src, i) => {
        const heading = src.heading ? ` / ${src.heading}` : '';
        const snippet =
          src.content.length > CONTEXT_SNIPPET_LEN
            ? `${src.content.slice(0, CONTEXT_SNIPPET_LEN)}...`
            : src.content;
        return `[${i + 1}] ${src.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n');
  }

  private buildWebContext(web: WebSearchResult): string {
    if (web.error) return web.error;
    if (!web.items.length) return '无结果。';
    return web.items
      .map((hit, i) => `${i + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`)
      .join('\n\n');
  }

  private buildSystemPrompt(
    intent: ChatIntent,
    hasKb: boolean,
    web?: WebSearchResult,
  ): string {
    let prompt =
      '你是企业知识库助手。结合对话历史和记忆里的用户背景回答。' +
      '制度/流程以本轮知识库资料为准，不要用记忆替代文档。';
    if (hasKb) {
      prompt +=
        '凡是依据某条资料作出的陈述，必须在句末标注对应编号，如 [1]、[2]。' +
        '编号必须与资料列表一致，不要标注未使用的编号，不要编造文档标题或链接。';
    } else if (intent === 'kb' || intent === 'kb_then_web') {
      prompt += '知识库没有切题资料，不要编造内部制度。';
    }
    if (web?.items.length) {
      prompt += '联网结果只作公开信息补充，用标题+链接说明，不要写成公司内部规定。';
    }
    if (intent === 'chitchat' || intent === 'profile') {
      prompt += '可回应寒暄或个人偏好，不要编造制度。';
    }
    prompt += '若资料不足以回答，明确说不知道。回答简洁，必要时列出条目。';
    return prompt;
  }
}

function formatWebSnippet(web: WebSearchResult): string {
  if (web.error) return web.error;
  if (!web.items.length) return '无结果。';
  return web.items
    .map((hit) => `${hit.title}\n${hit.url}\n${hit.snippet}`)
    .join('\n\n');
}
