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

export type { ChatSource } from './chat.types.js';

const EXCERPT_LEN = 200;
const CONTEXT_SNIPPET_LEN = 800;
const CITATION_RE = /\[(\d+)\]/g;

/**
 * 非流式 Agentic RAG：意图路由 → 检索 + 切题评估 → 不足改写再查 → 按需联网 → 作答。
 *
 * 保留既有能力：检索模式透传、可见性 scope、MIN_SCORE/PG 兜底、引用溯源、
 * 会话与双层记忆落库（尽力而为）。
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
  ): Promise<{
    sessionId: string | null;
    answer: string;
    sources: ChatSource[];
  }> {
    const trimmed = question.trim();
    if (!trimmed) {
      return { sessionId: sessionId ?? null, answer: '请输入问题。', sources: [] };
    }

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
    const graphP: Promise<GraphChatHit | undefined> =
      plan.allowGraph && user && access && plan.graphQueries.length
        ? this.graph.retrieveForChat(plan.graphQueries, 8, access).catch((error) => {
            const message =
              error instanceof Error ? error.message : String(error);
            this.logger.warn(`图谱检索失败，按无图谱继续：${message}`);
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

    const web =
      plan.allowWeb && (!plan.allowRetrieve || kbInsufficient)
        ? await this.webSearch.search(searchQuery)
        : undefined;
    const memHits = await memHitsP;

    if (plan.intent === 'kb' && kbInsufficient && !hasGraph) {
      const empty = {
        answer: '知识库里没有相关内容。',
        sources: [] as ChatSource[],
      };
      const session = user
        ? await this.persistTurn(
            user.userId,
            sessionId,
            trimmed,
            empty.answer,
            empty.sources,
          )
        : null;
      if (user && session) {
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
      return { sessionId: session?.id ?? sessionId ?? null, ...empty };
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
    const response = await this.llm.invoke([
      new SystemMessage(
        this.buildSystemPrompt(plan.intent, Boolean(hits.length), web),
      ),
      ...(memoryMsg ? [memoryMsg] : []),
      ...(graphMsg ? [new SystemMessage(graphMsg)] : []),
      ...history,
      new HumanMessage(userTurn),
    ]);

    const answer =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    const sources = this.toCitedSources(answer, hits);
    this.logger.log(
      `RAG 对话完成：intent=${plan.intent}, hits=${hits.length}, cited=${sources.length}, answerLength=${answer.length}`,
    );

    const session = user
      ? await this.persistTurn(user.userId, sessionId, trimmed, answer, sources)
      : null;
    if (user && session) {
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
    return { sessionId: session?.id ?? sessionId ?? null, answer, sources };
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
