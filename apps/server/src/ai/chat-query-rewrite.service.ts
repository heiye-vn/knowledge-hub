import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { z } from 'zod';
import { compactRewriteContext } from './chat-memory.util.js';
import type { SearchHit } from '../rag/types/rag.types.js';
import { packHitContext } from './context-budget.js';
import { withObservation } from '../observability/langfuse.js';

/**
 * 评估/改写模型在 Agent 工具内部被调用时会继承外层 LangChain callbacks，
 * 结构化输出的 JSON token 会混进回答正文。这里在内部调用期间清空 callbacks，
 * tags/metadata 作为流侧过滤的双保险。
 */
function invokeIsolated<T>(run: () => Promise<T>): Promise<T> {
  return AsyncLocalStorageProviderSingleton.runWithConfig(
    {
      callbacks: [],
      tags: ['kh-internal'],
      metadata: { khInternal: true },
    },
    run,
    true,
  );
}

/** 本轮路由意图。kb = knowledge base（知识库） */
export const CHAT_INTENTS = [
  'chitchat', // 问好、致谢、与库无关的闲聊
  'profile', // 只问/改用户自己的名字、部门、回答偏好
  'kb', // 公司制度、流程、岗位、内部系统
  'web', // 只要公开时效信息
  'kb_then_web', // 先查知识库，不够再联网
] as const;

export type ChatIntent = (typeof CHAT_INTENTS)[number];

/** 意图识别结果：同时给出检索词，以及本轮允许哪些工具。 */
export type ChatRoutePlan = {
  intent: ChatIntent;
  label: string;
  /** 消解指代后的独立短查询，给知识库 / 联网用（可以是一句） */
  query: string;
  /** 图谱用的短实体名，如 发票 / 报销 / 差旅；整句不能拿去对图 */
  graphQueries: string[];
  /** kb / kb_then_web 才挂 retrieve_knowledge */
  allowRetrieve: boolean;
  /** 与 allowRetrieve 相同：要查知识库的轮次才查图谱 */
  allowGraph: boolean;
  /** web / kb_then_web 才挂 web_search */
  allowWeb: boolean;
};

/** 非流式接口的兼容形态；新代码走 ChatRoutePlan */
export type RetrieveQueryPlan = {
  query: string;
  needRetrieve: boolean;
};

/** 一轮检索后的切题判断。empty 不调模型。 */
export type HitGrade = {
  ok: boolean;
  reason:
    /** 没有 chunk 命中 */
    | 'empty'
    /** 命中能支撑作答 */
    | 'relevant'
    /** 有命中但主题不是同一件事 */
    | 'irrelevant';
  text: string;
};

const INTENT_LABEL: Record<ChatIntent, string> = {
  chitchat: '闲聊',
  profile: '个人偏好',
  kb: '知识库',
  web: '联网搜索',
  kb_then_web: '知识库，不足则联网',
};

const routeSchema = z.object({
  intent: z.enum(CHAT_INTENTS).describe(
    'chitchat=寒暄闲聊；profile=只问用户自己的名字/偏好；kb=制度流程岗位系统；web=只要公开时效信息；kb_then_web=先查库不够再搜网',
  ),
  standalone_query: z
    .string()
    .describe('可独立检索的一句中文短查询，消解指代。闲聊/偏好可原样'),
  graph_queries: z
    .array(z.string())
    .optional()
    .describe(
      '图谱短实体名：2～6 个、每个 2～4 字。闲聊/偏好/纯联网必须空数组',
    ),
});

const gradeSchema = z.object({
  relevant: z
    .boolean()
    .describe(
      '只要有能支撑作答的资料即为 true；仅关键词沾边、主题不是同一件事为 false',
    ),
  reason: z.string().describe('一句中文：为何切题或不切题'),
});

const retryRewriteSchema = z.object({
  query: z
    .string()
    .describe('与上次不同的一句中文检索词，不超过 40 字，针对用户原问题'),
});

const GRADE_PROMPT =
  '你是企业知识库的检索评估器。判断命中资料能否回答用户问题。\n' +
  '\n' +
  '- 切题：同一主题、同一制度/岗位/流程，能支撑作答（不必覆盖每个细节）\n' +
  '- 不切题：只是词沾边（如问加班餐补却命中差旅报销）、或完全另一件事\n' +
  '- 只根据给定标题和摘录判断，不要假设库里还有别的文档\n' +
  '- 输出不要解释字段以外的内容';

const RETRY_REWRITE_PROMPT =
  '你是企业知识库的检索改写器。上次检索不足，请换一种问法再查。\n' +
  '\n' +
  '- 紧扣用户原问题，不要跑题\n' +
  '- 不要重复上次检索词\n' +
  '- 可换同义、补全制度/岗位/补贴类型等核心实体\n' +
  '- 不要编造条款号、专有名词\n' +
  '- 一句中文，尽量不超过 40 字';

const ROUTE_PROMPT =
  '你是企业知识库的意图与检索改写器。根据对话判断本轮意图，并给出一条可检索短查询。\n' +
  '\n' +
  '## intent\n' +
  '- chitchat：问好、致谢、与库无关的闲聊\n' +
  '- profile：只问/改「我自己」的名字、我所在部门、回答长短偏好。主语必须是用户本人\n' +
  '- kb：公司制度、流程、岗位、内部系统、文档\n' +
  '- web：只要最新公开信息，明显不是内部制度\n' +
  '- kb_then_web：像内部问题但也可能要外部时效（政策新闻+内部流程）\n' +
  '\n' +
  '## 易混\n' +
  '- 「我是哪个部门 / 以后回答短一点」→ profile\n' +
  '- 「预算审核员属于哪个部门」→ kb，不要因为出现「部门」就判 profile\n' +
  '- 记忆里的用户部门不能改变本题意图\n' +
  '\n' +
  '## standalone_query\n' +
  '- 给知识库全文检索用，可以是一句；消解「这个 / 谁负责 / 怎么办」，尽量不超过 40 字\n' +
  '- 不要编造上文没有的专有名词、条款号\n' +
  '- 不要复述助手已给出的制度条文\n' +
  '- 闲聊/偏好：用原问题即可\n' +
  '\n' +
  '## graph_queries\n' +
  '- 只在 kb / kb_then_web 填写，其他意图必须空数组\n' +
  '- 每个词 2～4 个字的实体短名（人/岗/制度对象），不要整句、不要问号\n' +
  '- 必须拆开：发票如何报销 → 发票、报销；发票报销流程和要求 → 发票、报销\n' +
  '- 可补 1 个同域短名（报销可带差旅）\n' +
  '- 禁止：流程、要求、办法、如何、怎么、什么、是什么\n' +
  '- 输出不要解释';

/**
 * 对话路由：识别意图 + 给出建议检索词。
 * 闲聊/个人偏好不检索；内部制度走知识库；公开时效走联网；两者都可能时先库后网。
 */
@Injectable()
export class ChatQueryRewriteService {
  private readonly logger = new Logger(ChatQueryRewriteService.name);
  private readonly router?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof routeSchema>>;
  };
  private readonly grader?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof gradeSchema>>;
  };
  private readonly retryWriter?: {
    invoke: (
      messages: unknown[],
    ) => Promise<z.infer<typeof retryRewriteSchema>>;
  };

  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      '';
    if (!apiKey) return;

    const baseURL = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const modelName = config.get<string>('LLM_MODEL', 'qwen3.8-flash');

    const llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_QUERY_REWRITE_TIMEOUT_MS', 15000)),
      maxRetries: 0,
      streaming: false,
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.router =
      llm.withStructuredOutput(routeSchema) as ChatQueryRewriteService['router'];
    this.grader =
      llm.withStructuredOutput(gradeSchema) as ChatQueryRewriteService['grader'];
    this.retryWriter = llm.withStructuredOutput(
      retryRewriteSchema,
    ) as ChatQueryRewriteService['retryWriter'];
  }

  /** 失败时按 kb 处理，宁可多检索也不漏内部制度。 */
  async classify(
    question: string,
    history: BaseMessage[],
  ): Promise<ChatRoutePlan> {
    return withObservation('intent-classify', async (update) => {
      const fallback = this.toPlan('kb', question);
      if (!this.router) {
        update({ metadata: { intent: fallback.intent } });
        return fallback;
      }

      const context = compactRewriteContext(history);
      try {
        const result = await invokeIsolated(() =>
          this.router!.invoke([
            new SystemMessage(ROUTE_PROMPT),
            new HumanMessage(
              context
                ? `对话：\n${context}\n\n当前问题：${question}`
                : `当前问题：${question}`,
            ),
          ]),
        );
        const query = result.standalone_query.trim() || question;
        const plan = this.toPlan(result.intent, query, result.graph_queries);
        this.logger.log(
          `意图：${plan.intent} query=${plan.query.slice(0, 80)} graph=${plan.graphQueries.join('/') || '-'}`,
        );
        update({
          output: { intent: plan.intent, queryLength: plan.query.length },
          metadata: { intent: plan.intent },
        });
        return plan;
      } catch (error) {
        this.logger.warn(
          `意图识别失败，按知识库处理：${error instanceof Error ? error.message : String(error)}`,
        );
        update({
          metadata: { intent: fallback.intent, error: true },
        });
        return fallback;
      }
    });
  }

  /** 兼容旧调用：只关心要不要查知识库 */
  async rewrite(
    question: string,
    history: BaseMessage[],
  ): Promise<RetrieveQueryPlan> {
    const plan = await this.classify(question, history);
    return { query: plan.query, needRetrieve: plan.allowRetrieve };
  }

  /** 有命中再判切题；空结果不调模型。评估失败时有召回则放行，避免误杀。 */
  async gradeHits(question: string, hits: SearchHit[]): Promise<HitGrade> {
    return withObservation('retrieve-grade', async (update) => {
      if (!hits.length) {
        const empty: HitGrade = {
          ok: false,
          reason: 'empty',
          text: '未检索到资料',
        };
        update({
          output: { ok: false, reason: 'empty' },
          metadata: { n: 0, error: false },
        });
        return empty;
      }
      if (!this.grader) {
        const pass: HitGrade = {
          ok: true,
          reason: 'relevant',
          text: '有召回（未配置评估模型）',
        };
        update({
          output: { ok: true, reason: 'relevant' },
          metadata: { n: hits.length, success: true, useful: true },
        });
        return pass;
      }
      try {
        const result = await invokeIsolated(() =>
          this.grader!.invoke([
            new SystemMessage(GRADE_PROMPT),
            new HumanMessage(
              `用户问题：${question}\n\n命中资料：\n${summarizeHits(hits)}`,
            ),
          ]),
        );
        const ok = result.relevant;
        const text = result.reason.trim() || (ok ? '资料切题' : '资料不切题');
        this.logger.log(
          `检索评估：${ok ? '切题' : '不切题'} ${text.slice(0, 80)}`,
        );
        const grade: HitGrade = {
          ok,
          reason: ok ? 'relevant' : 'irrelevant',
          text,
        };
        update({
          output: { ok, reason: grade.reason },
          metadata: { n: hits.length, useful: ok },
        });
        return grade;
      } catch (error) {
        this.logger.warn(
          `检索评估失败，按有召回放行：${error instanceof Error ? error.message : String(error)}`,
        );
        const fallback: HitGrade = {
          ok: true,
          reason: 'relevant',
          text: '评估失败，按有召回处理',
        };
        update({
          output: { ok: true, reason: 'relevant' },
          metadata: { n: hits.length, success: true, useful: true, error: true },
        });
        return fallback;
      }
    });
  }

  /**
   * 首轮空或不切题后改写检索词。
   * 失败或与上次相同则回退用户原问题；原问题也相同则返回空字符串表示无法再查。
   */
  async rewriteAfterRetrieve(
    question: string,
    previousQuery: string,
    grade: HitGrade,
    hits: SearchHit[],
  ): Promise<string> {
    return withObservation('rewrite-query', async (update) => {
      const fallback = distinctQuery(question, previousQuery);
      if (!this.retryWriter) {
        update({ metadata: { success: Boolean(fallback), useful: false } });
        return fallback;
      }

      try {
        const hitBlock = hits.length
          ? `\n上次命中（不切题）：\n${summarizeHits(hits, 3)}`
          : '\n上次无命中。';
        const result = await invokeIsolated(() =>
          this.retryWriter!.invoke([
            new SystemMessage(RETRY_REWRITE_PROMPT),
            new HumanMessage(
              `用户问题：${question}\n上次检索词：${previousQuery}\n不足原因：${grade.text}${hitBlock}`,
            ),
          ]),
        );
        const query = distinctQuery(result.query.trim(), previousQuery);
        const finalQuery = query || fallback;
        this.logger.log(
          `检索改写：${previousQuery.slice(0, 40)} → ${finalQuery.slice(0, 40)}`,
        );
        update({
          output: { rewritten: Boolean(query) },
          metadata: { success: true, useful: Boolean(query), rewritten: Boolean(query) },
        });
        return finalQuery;
      } catch (error) {
        this.logger.warn(
          `检索改写失败，回退原问题：${error instanceof Error ? error.message : String(error)}`,
        );
        update({
          output: { rewritten: Boolean(fallback) },
          metadata: { success: Boolean(fallback), useful: false, error: true },
        });
        return fallback;
      }
    });
  }

  /** 意图 → 工具开关。识别失败时 classify 会落到 kb，避免内部问题漏检。 */
  private toPlan(
    intent: ChatIntent,
    query: string,
    graphQueries?: string[],
  ): ChatRoutePlan {
    const kb = intent === 'kb' || intent === 'kb_then_web';
    return {
      intent,
      label: INTENT_LABEL[intent],
      query,
      graphQueries: kb
        ? (graphQueries ?? []).map((q) => q.trim()).filter(Boolean)
        : [],
      allowRetrieve: kb,
      allowGraph: kb,
      allowWeb: intent === 'web' || intent === 'kb_then_web',
    };
  }
}

function summarizeHits(hits: SearchHit[], limit = 5): string {
  return packHitContext(hits, {
    limit,
    separator: '\n',
    format: (hit, index) => {
      const heading = hit.heading ? ` / ${hit.heading}` : '';
      const score = Number.isFinite(hit.score) ? hit.score.toFixed(2) : '-';
      return `${index}. ${hit.documentTitle}${heading}（分=${score}）\n${hit.content}`;
    },
  });
}

function distinctQuery(next: string, previous: string): string {
  const query = next.replace(/\s+/g, ' ').trim();
  if (!query) return '';
  if (query === previous.replace(/\s+/g, ' ').trim()) return '';
  return query;
}
