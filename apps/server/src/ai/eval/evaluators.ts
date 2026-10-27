import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type {
  ChatEvalHit,
  ChatEvalSnapshot,
  GoldenExpected,
} from './eval.types.js';

/** LangFuse score：value=null 表示本题跳过，不写入实验结果。 */
export type EvalScore = {
  name: string;
  value: number | null;
  comment?: string;
};

export type EvalArgs = {
  input: { question: string };
  output: ChatEvalSnapshot;
  expectedOutput?: GoldenExpected;
  metadata?: Record<string, unknown>;
};

function titlesOf(hits: ChatEvalHit[]): string[] {
  return hits.map((hit) => hit.documentTitle);
}

/** 金标是标题子串，双向 includes 兼容「差旅」与「差旅管理制度」。 */
function matchesGold(title: string, gold: string): boolean {
  return title.includes(gold) || gold.includes(title);
}

function matchingHits(
  hits: ChatEvalHit[],
  gold: string[],
): ChatEvalHit[] {
  return hits.filter((hit) =>
    gold.some((item) => matchesGold(hit.documentTitle, item)),
  );
}

/** 金标是文档标题，同文档多 chunk 不能重复计入 Precision/MRR。 */
function uniqueDocuments(hits: ChatEvalHit[]): ChatEvalHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    if (seen.has(hit.documentId)) return false;
    seen.add(hit.documentId);
    return true;
  });
}

function firstAttempt(output: ChatEvalSnapshot) {
  return output.attempts[0];
}

function finalAttempt(output: ChatEvalSnapshot) {
  return output.attempts.at(-1);
}

function gradedContext(output: ChatEvalSnapshot): string {
  const seen = new Set<string>();
  const hits = output.attempts.flatMap((attempt) =>
    attempt.gradedHits.filter((hit) => {
      const key = `${hit.documentId}:${hit.heading ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
  if (!hits.length) return '（无知识库切题资料）';
  return hits
    .map(
      (hit, index) =>
        `[${index + 1}] ${hit.documentTitle}${hit.heading ? ` / ${hit.heading}` : ''}\n${hit.excerpt}`,
    )
    .join('\n\n');
}

/** 路由：实际 intent 是否等于金标。 */
export async function intentMatch({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const expected = expectedOutput?.intent;
  if (!expected) {
    return { name: 'intent_match', value: null, comment: '无期望意图' };
  }
  const ok = output.intent === expected;
  return {
    name: 'intent_match',
    value: ok ? 1 : 0,
    comment: ok
      ? `intent=${output.intent}`
      : `期望 ${expected}，实际 ${output.intent}`,
  };
}

/** 护栏：要求实际执行成功，禁止按是否「调用过」判断。 */
export async function toolPolicy({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const expected = expectedOutput;
  if (!expected) {
    return { name: 'tool_policy', value: null, comment: '无期望' };
  }
  const fails: string[] = [];
  if (expected.forbidRetrieve && output.attempts.length > 0) {
    fails.push(`禁止检索但检索 ${output.attempts.length} 次`);
  }
  if (expected.forbidGraph && output.graphRuns.length > 0) {
    fails.push('禁止图谱但调用了');
  }
  if (expected.forbidWeb && output.webRuns.length > 0) {
    fails.push('禁止联网但调用了');
  }
  if (expected.requireRetrieve && output.attempts.length < 1) {
    fails.push('应检索但未检索');
  }
  if (
    expected.requireGraph &&
    !output.graphRuns.some((run) => run.success)
  ) {
    fails.push('应成功检索图谱但未成功');
  }
  if (expected.requireWeb && !output.webRuns.some((run) => run.success)) {
    fails.push('应成功联网但未成功');
  }
  const ok = fails.length === 0;
  return {
    name: 'tool_policy',
    value: ok ? 1 : 0,
    comment: ok ? '工具策略符合意图' : fails.join('；'),
  };
}

/** 改写：必须有真实改写事件，且新旧检索词不同。 */
export async function rewriteLoop({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  if (!expectedOutput?.expectRewrite) {
    return { name: 'rewrite_loop', value: null, comment: '本题不要求改写' };
  }
  const last = output.rewrites.at(-1);
  const ok = Boolean(
    last && last.query.trim() && last.query.trim() !== last.previousQuery.trim(),
  );
  return {
    name: 'rewrite_loop',
    value: ok ? 1 : 0,
    comment: ok
      ? `改写 ${last?.previousQuery} → ${last?.query}`
      : `未发生有效改写，retrieveCount=${output.attempts.length}`,
  };
}

/** 首轮检索是否命中金标文档。 */
export async function firstHitAt5({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  if (!gold?.length) {
    return { name: 'first_hit_at_5', value: null, comment: '无相关文档金标' };
  }
  const top = firstAttempt(output)?.rawHits.slice(0, 5) ?? [];
  const ok = matchingHits(top, gold).length > 0;
  return {
    name: 'first_hit_at_5',
    value: ok ? 1 : 0,
    comment: ok
      ? `首轮命中 ${titlesOf(matchingHits(top, gold)).join(' / ')}`
      : `首轮 Top5=${titlesOf(top).join(' / ') || '空'}`,
  };
}

/** 末轮检索是否命中金标文档，用于观察改写最终效果。 */
export async function finalHitAt5({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  if (!gold?.length) {
    return { name: 'final_hit_at_5', value: null, comment: '无相关文档金标' };
  }
  const top = finalAttempt(output)?.rawHits.slice(0, 5) ?? [];
  const ok = matchingHits(top, gold).length > 0;
  return {
    name: 'final_hit_at_5',
    value: ok ? 1 : 0,
    comment: ok
      ? `末轮命中 ${titlesOf(matchingHits(top, gold)).join(' / ')}`
      : `末轮 Top5=${titlesOf(top).join(' / ') || '空'}`,
  };
}

/** 末轮 Top-5 按文档去重后，相关文档占比。 */
export async function precisionAt5({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  if (!gold?.length) {
    return { name: 'precision_at_5', value: null, comment: '无相关文档金标' };
  }
  const top = uniqueDocuments(
    finalAttempt(output)?.rawHits.slice(0, 5) ?? [],
  );
  if (!top.length) {
    return { name: 'precision_at_5', value: 0, comment: '无召回' };
  }
  const relevant = matchingHits(top, gold).length;
  return {
    name: 'precision_at_5',
    value: relevant / top.length,
    comment: `去重后相关 ${relevant}/${top.length}`,
  };
}

/** 末轮首个金标文档的倒数排名；同一文档多 chunk 只按首次出现计。 */
export async function mrrAt5({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  if (!gold?.length) {
    return { name: 'mrr_at_5', value: null, comment: '无相关文档金标' };
  }
  const top = uniqueDocuments(
    finalAttempt(output)?.rawHits.slice(0, 5) ?? [],
  );
  const index = top.findIndex((hit) =>
    gold.some((item) => matchesGold(hit.documentTitle, item)),
  );
  return {
    name: 'mrr_at_5',
    value: index < 0 ? 0 : 1 / (index + 1),
    comment:
      index < 0
        ? 'Top5 无金标文档'
        : `首个金标文档排第 ${index + 1}`,
  };
}

/** 改写收益：首轮未命中、末轮命中为 +1；反之 -1；不变为 0。 */
export async function rewriteGain({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  if (!expectedOutput?.expectRewrite || !gold?.length) {
    return { name: 'rewrite_gain', value: null, comment: '本题不计算改写收益' };
  }
  const first = firstAttempt(output)?.rawHits.slice(0, 5) ?? [];
  const final = finalAttempt(output)?.rawHits.slice(0, 5) ?? [];
  const before = matchingHits(first, gold).length > 0 ? 1 : 0;
  const after = matchingHits(final, gold).length > 0 ? 1 : 0;
  return {
    name: 'rewrite_gain',
    value: after - before,
    comment:
      after > before
        ? '改写后命中改善'
        : after < before
          ? '改写后命中退化'
          : '改写前后一致',
  };
}

/**
 * 空金标（库空/沾边题）：grader 仍把资料标切题并喂给模型，算误命中。
 * 只要任一轮 gradedHits 非空即失败。
 */
export async function falseHit({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const gold = expectedOutput?.relevantDocTitles;
  const emptyGold = Array.isArray(gold) && gold.length === 0;
  if (!emptyGold) {
    return { name: 'false_hit', value: null, comment: '非空检索题' };
  }
  const leaked = output.attempts.flatMap((attempt) => attempt.gradedHits);
  return {
    name: 'false_hit',
    value: leaked.length ? 0 : 1,
    comment: leaked.length
      ? `误把 ${titlesOf(leaked).join(' / ')} 当切题`
      : '未把不相关资料喂给模型',
  };
}

const refusalSchema = z.object({
  refused: z.boolean().describe('是否明确表示知识库没有、无法回答或资料不足'),
  fabricated: z
    .boolean()
    .describe('是否编造了制度、流程、负责人、材料清单等内部事实'),
  comment: z.string(),
});

/** 库空题：必须承认没有，且不能编造。 */
export async function refusalQuality({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  if (!expectedOutput?.expectRefusal) {
    return { name: 'refusal_quality', value: null, comment: '本题不要求拒答' };
  }
  const judged = await invokeJudge(
    refusalSchema,
    '你评估企业知识库助手在「库里没有」场景下的表现。' +
      'refused=true：清楚表示没有依据/未找到/无法回答，而不是用闲聊带过。' +
      'fabricated=true：捏造了制度、流程、材料、负责人或内部规定。礼貌收尾不算编造。',
    `用户问题：${output.question}\n\n助手回答：${output.answer}\n\n检索评估：${output.retrieveEval?.reason ?? '-'}\n切题资料条数：${output.attempts.flatMap((attempt) => attempt.gradedHits).length}`,
  );
  if (!judged.ok) {
    return { name: 'refusal_quality', value: null, comment: judged.error };
  }
  const { refused, fabricated, comment } = judged.data;
  const ok = refused && !fabricated;
  return {
    name: 'refusal_quality',
    value: ok ? 1 : 0,
    comment: `${refused ? '已拒答' : '未拒答'}${fabricated ? '，且编造' : ''}：${comment}`,
  };
}

const completenessSchema = z.object({
  covered: z.array(z.string()).describe('回答里已经覆盖的要点（从给定列表里选）'),
  missing: z.array(z.string()).describe('回答里缺失的要点'),
  forbiddenHit: z
    .array(z.string())
    .describe('回答里出现的禁用事实（从给定列表里选）'),
  comment: z.string(),
});

/** 生成层要点覆盖；人名/岗位用语义判断，避免同义表述被误判。 */
export async function completeness({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  const points = expectedOutput?.keyPoints ?? [];
  const forbidden = expectedOutput?.mustNotContain ?? [];
  if (!points.length && !forbidden.length) {
    return { name: 'completeness', value: null, comment: '无要点金标' };
  }
  const judged = await invokeJudge(
    completenessSchema,
    '你评估回答是否覆盖给定要点、是否误含禁用事实。' +
      '要点只要语义等价即可。covered/missing/forbiddenHit 只能出自给定列表。',
    `用户问题：${output.question}\n\n助手回答：${output.answer}\n\n要点：${points.join('、') || '无'}\n禁用：${forbidden.join('、') || '无'}`,
  );
  if (!judged.ok) {
    return { name: 'completeness', value: null, comment: judged.error };
  }
  const { covered, missing, forbiddenHit, comment } = judged.data;
  if (forbiddenHit.length) {
    return {
      name: 'completeness',
      value: 0,
      comment: `误含：${forbiddenHit.join('、')}。${comment}`,
    };
  }
  if (!points.length) {
    return { name: 'completeness', value: 1, comment };
  }
  const uniqueHit = points.filter((point) => covered.includes(point));
  const miss =
    missing.filter((point) => points.includes(point)).length > 0
      ? missing.filter((point) => points.includes(point))
      : points.filter((point) => !uniqueHit.includes(point));
  return {
    name: 'completeness',
    value: uniqueHit.length / points.length,
    comment: `覆盖 ${uniqueHit.length}/${points.length}${miss.length ? `，缺 ${miss.join('、')}` : ''}。${comment}`,
  };
}

const groundednessSchema = z.object({
  verdict: z.enum(['supported', 'mixed', 'fabricated']),
  comment: z.string(),
});

/** 生成层忠实度：制度性断言必须能被本轮资料或联网摘录支撑。 */
export async function groundedness({
  output,
  expectedOutput,
}: EvalArgs): Promise<EvalScore> {
  if (expectedOutput?.judgeGroundedness === false) {
    return { name: 'groundedness', value: null, comment: '本题不跑忠实度' };
  }
  const webContext = output.webRuns
    .map((run) => run.snippet)
    .filter(Boolean)
    .join('\n\n');
  const judged = await invokeJudge(
    groundednessSchema,
    '你评估企业知识库助手的忠实度。制度性断言必须能被检索资料或联网摘录支撑。' +
      '承认没有、闲聊、不涉及制度的句子不算编造。' +
      'supported=全部制度断言有依据；mixed=部分无依据；fabricated=编造了制度/负责人/电话/流程。',
    `用户问题：${output.question}\n\n助手回答：${output.answer}\n\n知识库资料：\n${gradedContext(output)}\n\n联网：\n${webContext || '（无联网结果）'}`,
  );
  if (!judged.ok) {
    return { name: 'groundedness', value: null, comment: judged.error };
  }
  const { verdict, comment } = judged.data;
  return {
    name: 'groundedness',
    value: verdict === 'supported' ? 1 : verdict === 'mixed' ? 0.5 : 0,
    comment: `${verdict}：${comment}`,
  };
}

export type EvaluatorFn = (args: EvalArgs) => Promise<EvalScore>;

export const BASE_EVALUATORS: EvaluatorFn[] = [
  intentMatch,
  toolPolicy,
  rewriteLoop,
  firstHitAt5,
  finalHitAt5,
  precisionAt5,
  mrrAt5,
  rewriteGain,
  falseHit,
  refusalQuality,
  completeness,
  groundedness,
];

/** 本地实验直接按函数执行；null 表示跳过，不参与均值。 */
export async function runEvaluators(
  args: EvalArgs,
): Promise<EvalScore[]> {
  return Promise.all(BASE_EVALUATORS.map((fn) => fn(args)));
}

/** LangFuse evaluate 约定：返回 [] 表示该题跳过此项。 */
function toLangfuseEvaluator(fn: EvaluatorFn) {
  return async (args: EvalArgs) => {
    const score = await fn(args);
    if (score.value == null) return [];
    return {
      name: score.name,
      value: score.value,
      comment: score.comment,
    };
  };
}

export const AGENT_EVALUATORS = BASE_EVALUATORS.map(toLangfuseEvaluator);

type JudgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

let judgeLlm: ChatOpenAI | undefined;
let judgeLlmReady = false;

function getJudgeLlm(): ChatOpenAI | undefined {
  if (judgeLlmReady) return judgeLlm;
  judgeLlmReady = true;
  const apiKey =
    process.env.LLM_API_KEY ||
    process.env.EMBEDDING_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  judgeLlm = new ChatOpenAI({
    apiKey,
    model:
      process.env.EVAL_JUDGE_MODEL ||
      process.env.LLM_MODEL ||
      'qwen3.8-flash',
    temperature: 0,
    timeout: Number(process.env.AI_QUERY_REWRITE_TIMEOUT_MS ?? 20000),
    maxRetries: 0,
    useResponsesApi: false,
    configuration: {
      baseURL:
        process.env.LLM_BASE_URL ||
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
  });
  return judgeLlm;
}

async function invokeJudge<T extends z.ZodType>(
  schema: T,
  system: string,
  user: string,
): Promise<JudgeResult<z.infer<T>>> {
  const llm = getJudgeLlm();
  if (!llm) return { ok: false, error: '未配置评测模型' };
  try {
    const data = await llm.withStructuredOutput(schema).invoke([
      new SystemMessage(system),
      new HumanMessage(user),
    ]);
    if (data == null) {
      return { ok: false, error: 'judge 返回空结果' };
    }
    return { ok: true, data: data as z.infer<T> };
  } catch (error) {
    return {
      ok: false,
      error: `judge 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
