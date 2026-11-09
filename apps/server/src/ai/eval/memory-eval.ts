/**
 * 记忆抽取评测的纯统计逻辑（与 LLM 调用分离，便于单测）。
 *
 * 三个指标：
 * - 判定一致率：两层布尔值与期望完全一致的比例；
 * - 分层 precision：预测为 true 的样本里真正该写的比例（衡量「乱写」）；
 * - 陷阱误写数：tag 以 -trap 结尾的样本中被误判为 true 的数量。
 *   这是红线，非 0 即视为知识库内容污染用户画像。
 */

export type MemoryCase = {
  id: string;
  tag: string;
  question: string;
  answerSnippet: string;
  expect: { writeUser: boolean; writeSession: boolean };
};

export type MemoryPrediction = {
  writeUser: boolean;
  writeSession: boolean;
  reason?: string;
};

export type MemoryEvalFailure = {
  id: string;
  tag: string;
  expected: MemoryCase['expect'];
  predicted: MemoryPrediction;
};

export type MemoryEvalSummary = {
  total: number;
  correct: number;
  userPredicted: number;
  userCorrect: number;
  sessionPredicted: number;
  sessionCorrect: number;
  trapTotal: number;
  trapViolations: number;
  failures: MemoryEvalFailure[];
};

export function evaluateMemoryCases(
  cases: MemoryCase[],
  predictions: MemoryPrediction[],
): MemoryEvalSummary {
  const summary: MemoryEvalSummary = {
    total: cases.length,
    correct: 0,
    userPredicted: 0,
    userCorrect: 0,
    sessionPredicted: 0,
    sessionCorrect: 0,
    trapTotal: 0,
    trapViolations: 0,
    failures: [],
  };

  cases.forEach((item, index) => {
    const predicted = predictions[index] ?? {
      writeUser: false,
      writeSession: false,
    };
    const matched =
      predicted.writeUser === item.expect.writeUser &&
      predicted.writeSession === item.expect.writeSession;
    if (matched) summary.correct += 1;
    else {
      summary.failures.push({
        id: item.id,
        tag: item.tag,
        expected: item.expect,
        predicted,
      });
    }

    if (predicted.writeUser) {
      summary.userPredicted += 1;
      if (item.expect.writeUser) summary.userCorrect += 1;
    }
    if (predicted.writeSession) {
      summary.sessionPredicted += 1;
      if (item.expect.writeSession) summary.sessionCorrect += 1;
    }
    if (item.tag.endsWith('-trap')) {
      summary.trapTotal += 1;
      if (predicted.writeUser || predicted.writeSession) {
        summary.trapViolations += 1;
      }
    }
  });

  return summary;
}

/** 截图/日志用的一行式结论 */
export function formatMemoryEvalSummary(summary: MemoryEvalSummary): string {
  const pct = (numerator: number, denominator: number) =>
    denominator ? `${((numerator / denominator) * 100).toFixed(1)}%` : 'n/a';
  return [
    `样本 ${summary.total}｜判定一致 ${summary.correct}/${summary.total}（${pct(summary.correct, summary.total)}）`,
    `user 层 precision ${summary.userCorrect}/${summary.userPredicted}（${pct(summary.userCorrect, summary.userPredicted)}）`,
    `session 层 precision ${summary.sessionCorrect}/${summary.sessionPredicted}（${pct(summary.sessionCorrect, summary.sessionPredicted)}）`,
    `陷阱样本误写 ${summary.trapViolations}/${summary.trapTotal}（${pct(summary.trapViolations, summary.trapTotal)}）← 红线，必须为 0`,
  ].join('\n');
}
