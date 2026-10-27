import type { ChatEvalSnapshot, GoldenItem } from './eval.types.js';
import { isTraceContentEnabled } from '../../observability/langfuse.js';

/** 默认脱敏时给 LangFuse Experiment 的 output；不含答案、摘录与联网原文。 */
export type SafeExperimentOutput = {
  intent: string;
  retrieveCount: number;
  attemptCount: number;
  graphCalls: number;
  graphSuccess: number;
  webCalls: number;
  webSuccess: number;
  answerLength: number;
};

/**
 * Experiment runner 会无条件把 data.input、expectedOutput 和 task 返回值写入根 span，
 * 与 tracing 的 LANGFUSE_TRACE_CONTENT 无关。这里单独构造出网载荷：
 * - 默认只保留 id / suite / access / intent；
 * - 显式开启正文时才传原始问题和完整金标。
 */
export function buildExperimentData(
  items: GoldenItem[],
  includeContent = isTraceContentEnabled(),
): GoldenItem[] {
  if (includeContent) return items;
  return items.map((item) => ({
    input: { question: `[content-hidden:${item.metadata.id}]` },
    expectedOutput: { intent: item.expectedOutput.intent },
    metadata: { ...item.metadata },
  }));
}

/** Experiment 的 task 输出同样要独立脱敏，不能直接返回完整评测快照。 */
export function toExperimentOutput(
  output: ChatEvalSnapshot,
  includeContent = isTraceContentEnabled(),
): ChatEvalSnapshot | SafeExperimentOutput {
  if (includeContent) return output;
  return {
    intent: output.intent,
    retrieveCount: output.retrieveCount,
    attemptCount: output.attempts.length,
    graphCalls: output.graphRuns.length,
    graphSuccess: output.graphRuns.filter((run) => run.success).length,
    webCalls: output.webRuns.length,
    webSuccess: output.webRuns.filter((run) => run.success).length,
    answerLength: output.answer.length,
  };
}
