import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
  type UIMessageStreamWriter,
} from 'ai';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  createAgent,
  modelCallLimitMiddleware,
  summarizationMiddleware,
  tool,
} from 'langchain';
import { z } from 'zod';
import type { Response } from 'express';
import { RetrievalService } from '../rag/retrieval.service.js';
import { packHitContext } from './context-budget.js';
import type { SearchHit, SearchMode } from '../rag/types/rag.types.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import {
  ChatQueryRewriteService,
  type ChatRoutePlan,
} from './chat-query-rewrite.service.js';
import {
  retrieveAndGrade,
  type GradedRetrieve,
  type RetrieveEval,
} from './agentic-retrieve.js';
import {
  WebSearchService,
  type WebSearchResult,
} from './web-search.service.js';
import { formatGraphContext } from '../kg/chat-graph.js';
import { GraphBuildService } from '../kg/graph-build.service.js';
import type { GraphChatHit } from '../kg/types/kg.types.js';
import { accessFromUser } from '../document/document-access.js';
import { dbRowsToMessages } from './chat-memory.util.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import type { ChatSource } from './chat.types.js';
import type { ChatStreamDto } from './dto/chat-stream.dto.js';
import type {
  ChatEvalSnapshot,
  RewriteRun,
  ToolRun,
  WebToolRun,
} from './eval/eval.types.js';
import { toEvalHit } from './eval/eval.types.js';
import {
  createLangfuseCallbackHandler,
  withTraceAttrs,
  withObservation,
} from '../observability/langfuse.js';

const EXCERPT_LEN = 200;
const CITATION_RE = /\[(\d+)\]/g;

/** 流式消息上叠加的自定义事件（data-*），前端按 type 渲染过程组件 */
type KhUIMessage = UIMessage<
  unknown,
  {
    status: { stage: string; text: string };
    think: { text: string };
    sources: ChatSource[];
    retrieve: {
      query: string;
      items: Array<{
        index: number;
        documentId: string;
        documentTitle: string;
        heading: string | null;
      }>;
    };
    /** 意图识别卡 */
    intent: {
      intent: ChatRoutePlan['intent'];
      label: string;
      query: string;
      graphQueries: string[];
      allowRetrieve: boolean;
      allowGraph: boolean;
      allowWeb: boolean;
    };
    /** 检索切题评估卡 */
    eval: RetrieveEval;
    /** 图谱实体与关系 */
    graph: GraphChatHit;
    session: { sessionId: string };
  }
>;

/** 评测用真实工具痕迹。线上 streamChat 不传，行为不变。 */
type AgentEvalTrace = {
  retrieves: GradedRetrieve[];
  rewrites: RewriteRun[];
  graphRuns: ToolRun[];
  webRuns: WebToolRun[];
};

/**
 * 流式 Agentic RAG：每轮按意图挂工具，由模型调度检索、评估、改写与联网。
 *
 * 保留项目既有能力：流前会话归属校验、短期/长期记忆、百炼 reasoning 流转换、
 * 落库尽力而为、按 [n] 只持久化实际引用来源。
 */
@Injectable()
export class AiStreamService {
  private readonly logger = new Logger(AiStreamService.name);
  private readonly llm?: ChatOpenAI;
  private readonly compactLlm?: ChatOpenAI;

  constructor(
    config: ConfigService,
    private readonly retrieval: RetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly webSearch: WebSearchService,
    private readonly shortMemory: ChatShortMemoryService,
    private readonly longMemory: ChatLongMemoryService,
    private readonly queryRewrite: ChatQueryRewriteService,
    private readonly graph: GraphBuildService,
  ) {
    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      '';
    const baseURL = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const modelName = config.get<string>('LLM_MODEL', 'qwen3.8-flash');
    const enableThinking =
      config.get<string>('LLM_ENABLE_THINKING') !== 'false';

    if (!apiKey) return;

    this.llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      streamUsage: false,
      configuration: { baseURL },
      modelKwargs: {
        ...(enableThinking ? { enable_thinking: true } : {}),
        parallel_tool_calls: true,
      },
    });
    // 摘要用独立模型实例：关思考，结构化程度更稳
    this.compactLlm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
  }

  /**
   * 按本轮意图挂工具。知识库与图谱都是 Agent tool，首次应并行调用；
   * 改写/再检索仍由 Agent 循环调度。trace 只在评测执行时收集。
   */
  private createTurnAgent(
    user: AuthUser,
    topK: number,
    mode: SearchMode | undefined,
    persistSources: ChatSource[],
    writer: UIMessageStreamWriter<KhUIMessage>,
    plan: ChatRoutePlan,
    question: string,
    trace?: AgentEvalTrace,
  ) {
    if (!this.llm || !this.compactLlm) return undefined;
    const retrieval = this.retrieval;
    const queryRewrite = this.queryRewrite;
    const search = this.webSearch;
    const graph = this.graph;
    const logger = this.logger;
    const tools: StructuredToolInterface[] = [];
    let retrieveCount = 0;
    let lastRetrieve: Awaited<ReturnType<typeof retrieveAndGrade>> | undefined;

    if (plan.allowRetrieve) {
      tools.push(
        tool(
          async (input: { query: string; topK?: number }) => {
            if (retrieveCount >= 2) {
              return {
                query: input.query,
                items: [],
                insufficient: true,
                error: '本轮知识库最多检索两次，请根据已有评估作答或联网',
              };
            }
            retrieveCount += 1;
            const result = await retrieveAndGrade({
              question,
              query: input.query,
              topK: input.topK ?? topK,
              mode,
              user,
              retrieval,
              rewrite: queryRewrite,
              retried: retrieveCount > 1,
              previousQuery: lastRetrieve?.usedQuery,
            });
            lastRetrieve = result;
            trace?.retrieves.push(result);
            writer.write({ type: 'data-eval', data: result.eval });
            if (result.eval.reason === 'error') {
              logger.warn(`RAG 检索失败：${result.eval.text}`);
              return {
                query: result.usedQuery,
                items: [],
                error: result.eval.text,
                insufficient: true,
                eval: result.eval,
              };
            }
            if (!result.eval.ok) {
              return packRetrieveResult(
                [],
                result.usedQuery,
                persistSources,
                writer,
                { insufficient: true, eval: result.eval },
              );
            }
            return packRetrieveResult(
              result.hits,
              result.usedQuery,
              persistSources,
              writer,
              { eval: result.eval },
            );
          },
          {
            name: 'retrieve_knowledge',
            description:
              '检索企业知识库一次（仅当前用户可见文档）并评估是否切题。不会自动再查。首次必须与 retrieve_graph 在同一次并行调用。eval.ok 为 false 时先 rewrite_query，再用新词再调本工具。本轮最多两次。',
            schema: z.object({
              query: z.string().min(1).describe('适合检索的关键词或短句'),
              topK: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe('条数，默认与请求一致'),
            }),
          },
        ),
      );
      tools.push(
        tool(
          async (input: { focus?: string }) => {
            if (!lastRetrieve) {
              return { error: '请先调用 retrieve_knowledge' };
            }
            if (lastRetrieve.eval.ok) {
              return {
                error: '当前资料已切题，无需改写',
                query: lastRetrieve.usedQuery,
              };
            }
            writer.write({
              type: 'data-status',
              data: { stage: 'rewrite', text: '正在改写检索词…' },
            });
            const retryQuery = await queryRewrite.rewriteAfterRetrieve(
              question,
              lastRetrieve.usedQuery,
              lastRetrieve.grade,
              lastRetrieve.rawHits,
            );
            if (!retryQuery) {
              return {
                error: '无法改写出与上次不同的检索词',
                previousQuery: lastRetrieve.usedQuery,
                reason: lastRetrieve.eval.text,
              };
            }
            trace?.rewrites.push({
              previousQuery: lastRetrieve.usedQuery,
              query: retryQuery,
            });
            return {
              query: retryQuery,
              previousQuery: lastRetrieve.usedQuery,
              reason: lastRetrieve.eval.text,
              focus: input.focus,
            };
          },
          {
            name: 'rewrite_query',
            description:
              '根据上次检索评估改写检索词。仅在 retrieve_knowledge 返回 insufficient 后调用，再把返回的 query 交给 retrieve_knowledge。',
            schema: z.object({
              focus: z.string().optional().describe('希望改写时强调的缺口，可空'),
            }),
          },
        ),
      );
    }

    if (plan.allowGraph) {
      tools.push(
        tool(
          async (input: { query: string }) =>
            withObservation('retrieve-graph', async (update) => {
              const keywords = [
                ...plan.graphQueries,
                ...(input.query.trim() ? [input.query.trim()] : []),
              ];
              let hit: GraphChatHit;
              try {
                hit = await graph.retrieveForChat(
                  keywords,
                  8,
                  accessFromUser(user),
                );
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                logger.warn(`图谱检索失败：${message}`);
                hit = {
                  query: keywords.join(' / '),
                  entities: [],
                  relations: [],
                  documents: [],
                  error: message,
                };
              }
              const run: ToolRun = {
                success: !hit.error,
                useful: Boolean(hit.entities.length || hit.relations.length),
                ...(hit.error ? { error: hit.error } : {}),
              };
              trace?.graphRuns.push(run);
              update({
                metadata: {
                  success: run.success,
                  useful: run.useful,
                  error: Boolean(hit.error),
                  n: hit.entities.length + hit.relations.length,
                },
              });
              writer.write({ type: 'data-graph', data: hit });
              return {
                query: hit.query,
                entities: hit.entities,
                relations: hit.relations,
                documents: hit.documents,
                context: formatGraphContext(hit),
                insufficient: !hit.entities.length && !hit.relations.length,
                ...(hit.error ? { error: hit.error } : {}),
              };
            }),
          {
            name: 'retrieve_graph',
            description:
              '检索知识图谱实体与关系（仅当前用户可见文档抽取出的图）。入参必须是短实体名，多个用空格或 / 分隔，例如「发票 / 报销」，不要整句。首次检索知识库时必须与 retrieve_knowledge 在同一次并行调用。图谱只说明实体关系，不能当制度原文。仅当还要查其他实体名时再单独再调。',
            schema: z.object({
              query: z
                .string()
                .min(1)
                .describe('短实体名，多个用空格或 / 分隔，不要整句'),
            }),
          },
        ),
      );
    }

    if (plan.allowWeb) {
      tools.push(
        tool(
          async (input: { query: string; count?: number }) =>
            withObservation('web-search', async (update) => {
              const web = await search.search(input.query, input.count ?? 5);
              const run: WebToolRun = {
                success: !web.error,
                useful: Boolean(web.items.length),
                ...(web.error ? { error: web.error } : {}),
                snippet: formatWebSnippet(web),
              };
              trace?.webRuns.push(run);
              update({
                metadata: {
                  success: run.success,
                  useful: run.useful,
                  error: Boolean(web.error),
                  n: web.items.length,
                },
              });
              return web;
            }),
          {
            name: 'web_search',
            description:
              '联网搜索公开信息（按配置自动选择 Bocha/Tavily）。仅在知识库循环结束后仍 insufficient，或本轮只需公开时效信息时调用。不要用网页替代已切题的知识库资料。',
            schema: z.object({
              query: z.string().min(1).describe('搜索关键词'),
              count: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe('条数，默认 5'),
            }),
          },
        ),
      );
    }

    return createAgent({
      model: this.llm,
      tools,
      systemPrompt: systemForPlan(plan),
      middleware: [
        summarizationMiddleware({
          model: this.compactLlm,
          trigger: { messages: 12 },
          keep: { messages: 6 },
          summaryPrompt:
            '用中文简洁总结对话：话题、已确认结论、待办。不要写入知识库条文。\n\n待摘要的对话：\n{messages}\n\n摘要：',
        }),
        modelCallLimitMiddleware({ runLimit: 8, exitBehavior: 'end' }),
      ],
    });
  }

  /**
   * 离线评测入口：复用线上同一个 Agent 与工具决策，不建会话、
   * 不读写任何用户记忆，避免真实用户画像污染实验结果。
   */
  async runForEval(
    question: string,
    topK: number,
    user: AuthUser,
    mode: SearchMode = 'hybrid',
  ): Promise<ChatEvalSnapshot> {
    const trimmed = question.trim();
    return withTraceAttrs(
      { userId: user.userId, tags: ['agentic-rag', 'eval'] },
      () =>
        withObservation('agent-eval', async (update) => {
          const plan = await this.queryRewrite.classify(trimmed, []);
          const trace: AgentEvalTrace = {
            retrieves: [],
            rewrites: [],
            graphRuns: [],
            webRuns: [],
          };
          const base = {
            question: trimmed,
            intent: plan.intent,
            allowRetrieve: plan.allowRetrieve,
            allowGraph: plan.allowGraph,
            allowWeb: plan.allowWeb,
            graphQueries: plan.graphQueries,
          };
          const agent = this.createTurnAgent(
            user,
            topK,
            mode,
            [],
            silentWriter(),
            plan,
            trimmed,
            trace,
          );
          if (!agent) {
            update({
              output: { answer: '未配置 LLM Key，无法生成回答' },
              metadata: { error: true },
            });
            return {
              ...base,
              answer: '未配置 LLM Key，无法生成回答',
              attempts: [],
              retrieveCount: 0,
              rewrites: [],
              graphRuns: [],
              webRuns: [],
            };
          }

          const langfuseHandler = createLangfuseCallbackHandler({
            userId: user.userId,
            tags: ['agentic-rag', 'eval', plan.intent],
          });
          const result = await agent.invoke(
            { messages: [new HumanMessage(trimmed)] },
            langfuseHandler ? { callbacks: [langfuseHandler] } : undefined,
          );
          const answer =
            lastAssistantText(result.messages as BaseMessage[]) ||
            '未能生成回答。';
          const lastEval = trace.retrieves.at(-1)?.eval;
          update({
            output: { answer, intent: plan.intent },
            metadata: {
              intent: plan.intent,
              retrieveCount: trace.retrieves.length,
              graphUsed: Boolean(trace.graphRuns.length),
              webUsed: Boolean(trace.webRuns.length),
            },
          });
          return {
            ...base,
            answer,
            attempts: trace.retrieves.map((attempt) => ({
              query: attempt.usedQuery,
              rawHits: attempt.rawHits.map(toEvalHit),
              gradedHits: attempt.hits.map(toEvalHit),
              eval: attempt.eval,
            })),
            retrieveCount: trace.retrieves.length,
            rewrites: trace.rewrites,
            graphRuns: trace.graphRuns,
            webRuns: trace.webRuns,
            ...(lastEval ? { retrieveEval: lastEval } : {}),
          };
        }),
    );
  }

  async streamChat(dto: ChatStreamDto, user: AuthUser, res: Response) {
    const question = lastUserText(dto.messages);
    const topK = dto.topK ?? 5;
    let persistSessionId = dto.sessionId;
    const persistSources: ChatSource[] = [];
    let persistHistory: BaseMessage[] = [];

    // 归属校验与默认标题覆盖都必须在流外：execute 内抛错只会降级成 SSE error
    // 事件（HTTP 200）；touchTitle 内部 getOwned，越权仍是 HTTP 404
    if (dto.sessionId) {
      await this.sessions.touchTitle(user.userId, dto.sessionId, question);
    }

    const stream = createUIMessageStream<KhUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });

        if (!question) {
          writer.write({ type: 'text-start', id: 'empty' });
          writer.write({
            type: 'text-delta',
            id: 'empty',
            delta: '请输入问题。',
          });
          writer.write({ type: 'text-end', id: 'empty' });
          writer.write({ type: 'finish' });
          return;
        }

        await withTraceAttrs(
          {
            userId: user.userId,
            sessionId: dto.sessionId,
            tags: ['agentic-rag'],
          },
          async () => {
            const sessionId = dto.sessionId
              ? dto.sessionId
              : (
                  await this.sessions.create(user.userId, {
                    title: titleFromQuestion(question),
                  })
                ).id;
            persistSessionId = sessionId;
            writer.write({
              type: 'data-session',
              data: { sessionId },
            });

            const history = await this.loadWorkingHistory(user.userId, sessionId);
            persistHistory = history;

            writer.write({
              type: 'data-status',
              data: { stage: 'intent', text: '正在识别意图…' },
            });
            // 记忆检索不依赖路由结果，先启动与意图分类重叠，减少首字延迟
            const memHitsP = this.longMemory.search(
              user.userId,
              sessionId,
              question,
            );
            // 路由在 Agent 之前完成：工具列表按 plan 挂载，前端立刻能画意图卡
            const plan = await this.queryRewrite.classify(question, history);
            writer.write({
              type: 'data-intent',
              data: {
                intent: plan.intent,
                label: plan.label,
                query: plan.query,
                graphQueries: plan.graphQueries,
                allowRetrieve: plan.allowRetrieve,
                allowGraph: plan.allowGraph,
                allowWeb: plan.allowWeb,
              },
            });

            const memHits = await memHitsP;

            const agent = this.createTurnAgent(
              user,
              topK,
              dto.mode,
              persistSources,
              writer,
              plan,
              question,
            );
            if (!agent) {
              writer.write({
                type: 'error',
                errorText: '未配置 LLM Key，无法生成回答',
              });
              writer.write({ type: 'finish' });
              return;
            }

            const memoryMsg = this.longMemory.buildSystemMessage(memHits);
            const langfuseHandler = createLangfuseCallbackHandler({
              userId: user.userId,
              sessionId,
              tags: ['agentic-rag', plan.intent],
            });
            const langchainStream = await agent.stream(
              {
                messages: [
                  ...(memoryMsg ? [memoryMsg] : []),
                  ...history,
                  new HumanMessage(question),
                ],
              },
              // messages：模型 token/思考；tools：retrieve / rewrite / graph / web_search
              {
                streamMode: ['messages', 'tools'],
                ...(langfuseHandler ? { callbacks: [langfuseHandler] } : {}),
              },
            );

            writer.merge(
              toUIMessageStream(mapReasoningStream(langchainStream) as never, {
                sendStart: false,
                sendFinish: false,
                onError: (error) => {
                  this.logger.warn(`LangChain 流失败：${error.message}`);
                },
              }) as never,
            );
          },
        );
      },
      onFinish: async ({ responseMessage }) => {
        const parts = responseMessage?.parts ?? [];
        const answer = parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('')
          .trim();
        const used = new Set(
          [...answer.matchAll(CITATION_RE)].map((m) => Number(m[1])),
        );
        const sources = used.size
          ? persistSources.filter((s) => used.has(s.index))
          : [];
        if (!question || !persistSessionId) return;
        const finalAnswer = answer || '未能生成回答。';
        try {
          await this.sessions.appendTurn(
            user.userId,
            persistSessionId,
            question,
            finalAnswer,
            sources,
          );
          await this.shortMemory.appendTurn(
            user.userId,
            persistSessionId,
            persistHistory,
            question,
            finalAnswer,
          );
        } catch (error) {
          this.logger.warn(
            `流式对话落库失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        void this.longMemory.rememberTurn(
          user.userId,
          persistSessionId,
          question,
          finalAnswer,
        );
      },
      onError: (error) =>
        error instanceof Error ? error.message : String(error),
    });

    await pipeUIMessageStreamToResponse({ response: res, stream });
  }

  /** 短期记忆工作窗口：Redis 命中直接用；miss 从 Postgres 取最近 N 条并回填 */
  private async loadWorkingHistory(
    userId: string,
    sessionId: string,
  ): Promise<BaseMessage[]> {
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
}

/** Agent 循环：检索 → 评估 → 不足则改写再检索 → 仍不足才联网 → 作答。 */
export function systemForPlan(plan: ChatRoutePlan) {
  let prompt =
    '你是企业知识库助手，必须按 Agentic RAG 循环作答，不要跳步。' +
    '结合对话历史和记忆里的用户背景，但制度/流程以本轮检索资料为准。' +
    `本轮意图：${plan.label}。`;
  if (plan.allowRetrieve && plan.allowGraph) {
    const graphHint = plan.graphQueries.length
      ? plan.graphQueries.join(' / ')
      : '从问题抽出的短实体名';
    prompt +=
      `知识库建议检索词「${plan.query}」，图谱建议检索词「${graphHint}」。` +
      '第一步必须在同一次回复里并行调用 retrieve_knowledge 和 retrieve_graph，两个都要调：' +
      '不要先查库再决定是否查图，不要只调其中一个，也不要等一个返回再调另一个。' +
      'retrieve_graph 的 query 必须是短实体名（空格或 / 分隔），不要整句。' +
      '循环：① 并行检索；② 若知识库 eval.ok 则用文档 context 作答并标 [n]，图谱只看实体关系、不能当制度原文；' +
      '③ 若 insufficient，先 rewrite_query，再用新词再次 retrieve_knowledge（知识库最多两次）；图谱词变了才再调 retrieve_graph；' +
      '④ 两次后仍不足再考虑联网。eval.ok 后不要再检索、不要改写。不要第三次 retrieve_knowledge。' +
      '图谱为空不要编造关系。不要用记忆替代文档。';
  } else if (plan.allowRetrieve) {
    prompt +=
      `建议检索词「${plan.query}」，可改写成更准的 query。` +
      '循环：① retrieve_knowledge；② 若 eval.ok 则用 context 作答并标 [n]；' +
      '③ 若 insufficient，先 rewrite_query，再用返回的新词再次 retrieve_knowledge（知识库最多两次）；' +
      '④ 两次后仍不足再考虑联网。eval.ok 后不要再检索、不要改写。不要第三次 retrieve_knowledge。' +
      '不要用记忆替代文档。';
  } else {
    prompt += '不要调用 retrieve_knowledge 或 rewrite_query。';
  }
  if (!plan.allowGraph) {
    prompt += '不要调用 retrieve_graph。';
  }
  if (plan.intent === 'chitchat') {
    prompt += '这是闲聊，直接回应，不要调用任何工具。';
  }
  if (plan.intent === 'profile') {
    prompt += '这是个人偏好或身份问题，根据记忆回答，不要检索知识库。';
  }
  if (plan.intent === 'kb') {
    prompt +=
      '两次检索后仍 insufficient：明确说知识库没有相关内容，禁止编造制度，不要联网。';
  }
  if (plan.intent === 'web') {
    prompt += '用 web_search 查公开信息，用标题+链接说明，不要编造。';
  }
  if (plan.intent === 'kb_then_web') {
    prompt +=
      '先走完知识库循环；两次后仍 insufficient 再 web_search。联网结果用标题+链接说明，不要把网页写成内部制度。';
  }
  if (!plan.allowWeb) {
    prompt += '不要调用 web_search。';
  }
  prompt += '资料不够就明确说不知道。';
  return prompt;
}

/** 命中写入 citations，并推 data-sources；context 给模型，excerpt 给前端。 */
export function packRetrieveResult(
  hits: SearchHit[],
  query: string,
  persistSources: ChatSource[],
  writer: UIMessageStreamWriter<KhUIMessage>,
  extra: Record<string, unknown> = {},
) {
  const offset = persistSources.length;
  const sources = hits.map((hit, i) => ({
    index: offset + i + 1,
    documentId: hit.documentId,
    documentTitle: hit.documentTitle,
    heading: hit.heading,
    excerpt: excerpt(hit.content),
    score: hit.score,
  }));
  persistSources.push(...sources);
  // 空命中不写空数组：前端按最后一个非空 data-sources 取引用
  if (sources.length) {
    writer.write({
      type: 'data-sources',
      data: [...persistSources],
    });
  }
  for (const src of sources) {
    writer.write({
      type: 'source-document',
      sourceId: src.documentId,
      mediaType: 'text/markdown',
      title: `[${src.index}] ${src.documentTitle}`,
    });
  }
  return {
    query,
    items: sources.map((src) => ({
      index: src.index,
      documentId: src.documentId,
      documentTitle: src.documentTitle,
      heading: src.heading,
      excerpt: src.excerpt,
    })),
    context: packHitContext(hits, { indexOffset: offset }),
    ...extra,
  };
}

/** 评测执行时丢弃所有 SSE 事件，但保留工具内部逻辑。 */
function silentWriter(): UIMessageStreamWriter<KhUIMessage> {
  return {
    write() {
      return undefined;
    },
    merge() {
      return undefined;
    },
  } as unknown as UIMessageStreamWriter<KhUIMessage>;
}

function formatWebSnippet(web: WebSearchResult): string {
  if (web.error) return web.error;
  if (!web.items.length) return '无结果。';
  return web.items
    .map((hit) => `${hit.title}\n${hit.url}\n${hit.snippet}`)
    .join('\n\n');
}

function lastAssistantText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'ai') continue;
    const text = messageText(message.content).trim();
    if (text) return text;
  }
  return '';
}

function messageText(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part.type === 'text') return part.text;
      return '';
    })
    .join('');
}

/**
 * 百炼兼容口把思考放在 additional_kwargs.reasoning_content；适配层只认
 * additional_kwargs.reasoning.summary，这里在流上原位改写。
 */
async function* mapReasoningStream(
  stream: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const event of stream) {
    attachDashScopeReasoning(event);
    yield event;
  }
}

/** 递归找 additional_kwargs.reasoning_content 并改写成适配层要的 reasoning.summary；seen 防循环引用 */
function attachDashScopeReasoning(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) attachDashScopeReasoning(item, seen);
    return;
  }
  const obj = value as Record<string, unknown>;
  const kwargs = obj.additional_kwargs as Record<string, unknown> | undefined;
  if (
    typeof kwargs?.reasoning_content === 'string' &&
    kwargs.reasoning_content
  ) {
    kwargs.reasoning = {
      summary: [{ type: 'summary_text', text: kwargs.reasoning_content }],
    };
  }
  attachDashScopeReasoning(obj.chunk, seen);
  attachDashScopeReasoning(obj.data, seen);
  attachDashScopeReasoning(obj.kwargs, seen);
  attachDashScopeReasoning(obj.messages, seen);
}

function lastUserText(
  messages: ChatStreamDto['messages'] | undefined,
): string {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('');
    return text.trim();
  }
  return '';
}

function titleFromQuestion(question: string) {
  const text = question.replace(/\s+/g, ' ').trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

function excerpt(content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= EXCERPT_LEN) return text;
  return `${text.slice(0, EXCERPT_LEN)}...`;
}
