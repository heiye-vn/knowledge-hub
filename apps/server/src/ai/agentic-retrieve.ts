import type { AuthUser } from '../auth/auth-user.interface.js';
import type { SearchHit, SearchMode } from '../rag/types/rag.types.js';
import type { RetrievalService } from '../rag/retrieval.service.js';
import { accessFromUser } from '../document/document-access.js';
import type {
  ChatQueryRewriteService,
  HitGrade,
} from './chat-query-rewrite.service.js';
import { withObservation } from '../observability/langfuse.js';

/** 推给前端 data-eval；ok 表示资料切题，不是「有条数」。 */
export type RetrieveEvalReason =
  /** 首轮检索切题 */
  | 'ok'
  /** 改写后再查切题 */
  | 'retried_ok'
  /** 首轮无命中 */
  | 'empty'
  /** 改写后再查仍无命中 */
  | 'retried_empty'
  /** 首轮有命中但不切题 */
  | 'irrelevant'
  /** 改写后再查仍不切题 */
  | 'retried_irrelevant'
  /** 检索接口失败 */
  | 'error';

export type RetrieveEval = {
  /** 是否可作为制度依据 */
  ok: boolean;
  reason: RetrieveEvalReason;
  /** 给过程条看的一句中文 */
  text: string;
  /** 是否已经走过第二轮检索 */
  retried: boolean;
  /** 首轮检索词 */
  query: string;
  /** 第二轮检索词（仅再查时有） */
  retryQuery?: string;
};

export type GradedRetrieve = {
  /** 原始命中，给改写器用；不切题时不要当制度依据 */
  rawHits: SearchHit[];
  /** 切题才有，给模型引用 */
  hits: SearchHit[];
  grade: HitGrade;
  eval: RetrieveEval;
  usedQuery: string;
};

/** 检索环完整结果：保留每一轮 attempt，供评测区分首轮与改写后效果。 */
export type RetrieveLoopResult = {
  hits: SearchHit[];
  /** 末轮原始命中，兼容既有调用方 */
  rawHits: SearchHit[];
  eval: RetrieveEval;
  usedQuery: string;
  retrieveCount: number;
  attempts: GradedRetrieve[];
};

/** 单次检索 + 切题评估。Agent loop 每次工具调用走这里。 */
export async function retrieveAndGrade(opts: {
  question: string;
  query: string;
  topK: number;
  mode?: SearchMode;
  user?: AuthUser;
  retrieval: RetrievalService;
  rewrite: ChatQueryRewriteService;
  retried?: boolean;
  previousQuery?: string;
}): Promise<GradedRetrieve> {
  const usedQuery = opts.query.trim() || opts.question;
  const retried = Boolean(opts.retried);
  const displayQuery = retried ? opts.previousQuery || usedQuery : usedQuery;
  const retryQuery = retried ? usedQuery : undefined;

  return withObservation('retrieve-and-grade', async (update) => {
    try {
      const rawHits = await opts.retrieval.search(
        { query: usedQuery, topK: opts.topK, mode: opts.mode },
        opts.user ? accessFromUser(opts.user) : undefined,
      );
      const grade = await opts.rewrite.gradeHits(opts.question, rawHits);
      const result = {
        rawHits,
        hits: grade.ok ? rawHits : [],
        grade,
        eval: toEval(grade, displayQuery, retried, retryQuery),
        usedQuery,
      };
      update({
        input: { query: usedQuery, retried },
        output: {
          n: rawHits.length,
          ok: result.eval.ok,
          reason: result.eval.reason,
        },
        metadata: {
          retrieveCount: 1,
          error: result.eval.reason === 'error',
        },
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed = {
        rawHits: [] as SearchHit[],
        hits: [] as SearchHit[],
        grade: { ok: false, reason: 'empty' as const, text: `检索失败：${detail}` },
        eval: {
          ok: false,
          reason: 'error' as const,
          text: retried ? `改写后再次检索失败：${detail}` : `检索失败：${detail}`,
          retried,
          query: displayQuery,
          retryQuery,
        },
        usedQuery,
      };
      update({
        input: { query: usedQuery, retried },
        metadata: { error: true, retrieveCount: 1 },
      });
      return failed;
    }
  });
}

/**
 * 无 Agent 时的等价环：查一次 → 评估 → 不足则改写再查一次。
 * 给非流式 /ai/chat 用。每轮结果都进 attempts，评测不再只看末轮。
 */
export async function retrieveUntilRelevant(opts: {
  question: string;
  query: string;
  topK: number;
  mode?: SearchMode;
  user?: AuthUser;
  retrieval: RetrievalService;
  rewrite: ChatQueryRewriteService;
  onEval?: (data: RetrieveEval) => void;
  onRewrite?: (retryQuery: string) => void;
}): Promise<RetrieveLoopResult> {
  const first = await retrieveAndGrade({
    question: opts.question,
    query: opts.query,
    topK: opts.topK,
    mode: opts.mode,
    user: opts.user,
    retrieval: opts.retrieval,
    rewrite: opts.rewrite,
  });
  opts.onEval?.(first.eval);
  if (first.eval.ok || first.eval.reason === 'error') {
    return {
      hits: first.hits,
      rawHits: first.rawHits,
      eval: first.eval,
      usedQuery: first.usedQuery,
      retrieveCount: 1,
      attempts: [first],
    };
  }

  const retryQuery = await opts.rewrite.rewriteAfterRetrieve(
    opts.question,
    first.usedQuery,
    first.grade,
    first.rawHits,
  );
  if (!retryQuery) {
    return {
      hits: [],
      rawHits: first.rawHits,
      eval: first.eval,
      usedQuery: first.usedQuery,
      retrieveCount: 1,
      attempts: [first],
    };
  }

  opts.onRewrite?.(retryQuery);
  const second = await retrieveAndGrade({
    question: opts.question,
    query: retryQuery,
    topK: opts.topK,
    mode: opts.mode,
    user: opts.user,
    retrieval: opts.retrieval,
    rewrite: opts.rewrite,
    retried: true,
    previousQuery: first.usedQuery,
  });
  opts.onEval?.(second.eval);
  return {
    hits: second.hits,
    rawHits: second.rawHits,
    eval: second.eval,
    usedQuery: second.usedQuery,
    retrieveCount: 2,
    attempts: [first, second],
  };
}

function toEval(
  grade: HitGrade,
  query: string,
  retried: boolean,
  retryQuery?: string,
): RetrieveEval {
  if (grade.reason === 'relevant') {
    return {
      ok: true,
      reason: retried ? 'retried_ok' : 'ok',
      text: retried ? `已改写再查，${grade.text}` : grade.text,
      retried,
      query,
      retryQuery,
    };
  }
  if (grade.reason === 'empty') {
    return {
      ok: false,
      reason: retried ? 'retried_empty' : 'empty',
      text: retried ? '改写后仍无结果' : grade.text,
      retried,
      query,
      retryQuery,
    };
  }
  return {
    ok: false,
    reason: retried ? 'retried_irrelevant' : 'irrelevant',
    text: retried ? `改写后仍不切题：${grade.text}` : grade.text,
    retried,
    query,
    retryQuery,
  };
}
