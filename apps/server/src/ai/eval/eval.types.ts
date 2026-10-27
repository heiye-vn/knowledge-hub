import type { ChatIntent, ChatRoutePlan } from '../chat-query-rewrite.service.js';
import type { RetrieveEval } from '../agentic-retrieve.js';
import type { SearchHit } from '../../rag/types/rag.types.js';

/** 评测用检索命中：只留定位与短摘录，避免把整段 chunk 送进实验元数据。 */
export type ChatEvalHit = {
  documentId: string;
  documentTitle: string;
  heading: string | null;
  score: number;
  excerpt: string;
};

/** 一次知识库检索的完整痕迹：切题过滤前后的结果都保留。 */
export type RetrieveAttempt = {
  query: string;
  rawHits: ChatEvalHit[];
  gradedHits: ChatEvalHit[];
  eval: RetrieveEval;
};

/** 工具执行结果：区分「调用过」「执行成功」「返回了可用内容」。 */
export type ToolRun = {
  success: boolean;
  useful: boolean;
  error?: string;
};

export type WebToolRun = ToolRun & {
  snippet: string;
};

export type RewriteRun = {
  previousQuery: string;
  query: string;
};

/**
 * 一轮 Agent 执行的评测快照。
 * attempts 保存全轮次检索，禁止退化为只看末轮；graphRuns/webRuns 保存多次工具调用。
 */
export type ChatEvalSnapshot = {
  question: string;
  answer: string;
  intent: ChatIntent;
  allowRetrieve: boolean;
  allowGraph: boolean;
  allowWeb: boolean;
  graphQueries: string[];
  attempts: RetrieveAttempt[];
  retrieveCount: number;
  rewrites: RewriteRun[];
  graphRuns: ToolRun[];
  webRuns: WebToolRun[];
  retrieveEval?: RetrieveEval;
};

export type GoldenExpected = {
  intent: ChatIntent;
  requireRetrieve?: boolean;
  requireGraph?: boolean;
  requireWeb?: boolean;
  forbidRetrieve?: boolean;
  forbidGraph?: boolean;
  forbidWeb?: boolean;
  expectRewrite?: boolean;
  /** 库空：必须承认没有且不编造（LLM judge） */
  expectRefusal?: boolean;
  /** 文档标题子串。空数组 = 不应把任何文档当切题。 */
  relevantDocTitles?: string[];
  /** 语义要点；由 completeness judge 判覆盖。 */
  keyPoints?: string[];
  /** 禁用事实；由 completeness judge 判误含。 */
  mustNotContain?: string[];
  /** 默认 true；闲聊/纯联网关掉，避免无上下文空跑。 */
  judgeGroundedness?: boolean;
};

export type GoldenItem = {
  input: { question: string };
  expectedOutput: GoldenExpected;
  metadata: {
    id: string;
    suite: string;
    /** restricted 用例必须以受限用户身份执行，验证 ACL 而不是管理员视野。 */
    access?: 'admin' | 'restricted';
  };
};

/** 统一的评测命中压缩：400 字摘录足够判断，避免实验元数据膨胀。 */
export function toEvalHit(hit: SearchHit): ChatEvalHit {
  const text = hit.content.replace(/\s+/g, ' ').trim();
  return {
    documentId: hit.documentId,
    documentTitle: hit.documentTitle,
    heading: hit.heading,
    score: hit.score,
    excerpt: text.length > 400 ? `${text.slice(0, 400)}...` : text,
  };
}

export function planFlags(plan: ChatRoutePlan) {
  return {
    intent: plan.intent,
    allowRetrieve: plan.allowRetrieve,
    allowGraph: plan.allowGraph,
    allowWeb: plan.allowWeb,
    graphQueries: plan.graphQueries,
  };
}
