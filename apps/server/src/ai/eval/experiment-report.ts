import type { ChatEvalSnapshot, GoldenItem } from './eval.types.js';
import type { EvalScore } from './evaluators.js';

export type ExperimentCase = {
  id: string;
  suite: string;
  question: string;
  access: 'admin' | 'restricted';
  intent: string;
  retrieveCount: number;
  scores: EvalScore[];
};

export type MetricSummary = {
  count: number;
  mean: number;
  min: number;
  max: number;
};

/** 可落盘、可跨运行比较的实验报告；不保存回答正文与文档摘录。 */
export type ExperimentReport = {
  generatedAt: string;
  gitCommit: string;
  datasetVersion: string;
  modelConfig: Record<string, string | number | boolean>;
  cases: ExperimentCase[];
  aggregate: Record<string, MetricSummary>;
  criticalFailures: Array<{
    id: string;
    reason: string;
    scores: string[];
  }>;
};

export function summarizeScores(
  scores: EvalScore[],
): Record<string, MetricSummary> {
  const grouped = new Map<string, number[]>();
  for (const score of scores) {
    if (score.value == null) continue;
    const values = grouped.get(score.name) ?? [];
    values.push(score.value);
    grouped.set(score.name, values);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, values]) => [
        name,
        {
          count: values.length,
          mean: values.reduce((sum, value) => sum + value, 0) / values.length,
          min: Math.min(...values),
          max: Math.max(...values),
        },
      ]),
  );
}

export function buildExperimentReport(opts: {
  items: GoldenItem[];
  outputs: ChatEvalSnapshot[];
  scores: EvalScore[][];
  generatedAt: string;
  gitCommit: string;
  datasetVersion: string;
  modelConfig: Record<string, string | number | boolean>;
}): ExperimentReport {
  const cases: ExperimentCase[] = opts.items.map((item, index) => {
    const output = opts.outputs[index];
    return {
      id: item.metadata.id,
      suite: item.metadata.suite,
      question: item.input.question,
      access: item.metadata.access ?? 'admin',
      intent: output.intent,
      retrieveCount: output.attempts.length,
      scores: opts.scores[index] ?? [],
    };
  });

  const criticalFailures: ExperimentReport['criticalFailures'] = [];
  for (const item of cases) {
    if (item.access !== 'restricted') continue;
    const names = new Set(
      item.scores
        .filter(
          (score) =>
            score.value != null &&
            score.value <= 0 &&
            ['tool_policy', 'false_hit', 'refusal_quality'].includes(score.name),
        )
        .map((score) => score.name),
    );
    if (names.size) {
      criticalFailures.push({
        id: item.id,
        reason: '受限用户用例未通过权限或拒答校验',
        scores: [...names],
      });
    }
  }

  return {
    generatedAt: opts.generatedAt,
    gitCommit: opts.gitCommit,
    datasetVersion: opts.datasetVersion,
    modelConfig: opts.modelConfig,
    cases,
    aggregate: summarizeScores(cases.flatMap((item) => item.scores)),
    criticalFailures,
  };
}

export type ReportComparison = {
  baseline: Pick<
    ExperimentReport,
    'generatedAt' | 'gitCommit' | 'datasetVersion'
  >;
  current: Pick<
    ExperimentReport,
    'generatedAt' | 'gitCommit' | 'datasetVersion'
  >;
  metrics: Record<
    string,
    { baseline: number | null; current: number | null; delta: number | null }
  >;
  cases: Array<{
    id: string;
    status: 'improved' | 'regressed' | 'changed' | 'unchanged' | 'added' | 'removed';
    scoreDeltas: Record<string, number>;
  }>;
};

/** 逐指标、逐用例比较两次实验，便于定位「总体变好但某题退化」。 */
export function compareReports(
  baseline: ExperimentReport,
  current: ExperimentReport,
): ReportComparison {
  const metricNames = new Set([
    ...Object.keys(baseline.aggregate),
    ...Object.keys(current.aggregate),
  ]);
  const metrics: ReportComparison['metrics'] = {};
  for (const name of [...metricNames].sort()) {
    const before = baseline.aggregate[name]?.mean ?? null;
    const after = current.aggregate[name]?.mean ?? null;
    metrics[name] = {
      baseline: before,
      current: after,
      delta: before == null || after == null ? null : after - before,
    };
  }

  const baselineCases = new Map(baseline.cases.map((item) => [item.id, item]));
  const currentCases = new Map(current.cases.map((item) => [item.id, item]));
  const ids = [...new Set([...baselineCases.keys(), ...currentCases.keys()])].sort();
  const cases: ReportComparison['cases'] = ids.map((id) => {
    const before = baselineCases.get(id);
    const after = currentCases.get(id);
    if (!before) {
      return {
        id,
        status: 'added' as const,
        scoreDeltas: Object.fromEntries(
          (after?.scores ?? [])
            .filter((score) => score.value != null)
            .map((score) => [score.name, score.value as number]),
        ),
      };
    }
    if (!after) {
      return { id, status: 'removed' as const, scoreDeltas: {} };
    }
    const beforeScores = new Map(
      before.scores
        .filter((score) => score.value != null)
        .map((score) => [score.name, score.value as number]),
    );
    const afterScores = new Map(
      after.scores
        .filter((score) => score.value != null)
        .map((score) => [score.name, score.value as number]),
    );
    const names = new Set([...beforeScores.keys(), ...afterScores.keys()]);
    const scoreDeltas: Record<string, number> = {};
    for (const name of names) {
      const left = beforeScores.get(name);
      const right = afterScores.get(name);
      if (left == null || right == null) continue;
      if (left !== right) scoreDeltas[name] = right - left;
    }
    const values = Object.values(scoreDeltas);
    const status: ReportComparison['cases'][number]['status'] =
      values.length === 0
        ? 'unchanged'
        : values.every((delta) => delta > 0)
          ? 'improved'
          : values.every((delta) => delta < 0)
            ? 'regressed'
            : 'changed';
    return { id, status, scoreDeltas };
  });

  return {
    baseline: {
      generatedAt: baseline.generatedAt,
      gitCommit: baseline.gitCommit,
      datasetVersion: baseline.datasetVersion,
    },
    current: {
      generatedAt: current.generatedAt,
      gitCommit: current.gitCommit,
      datasetVersion: current.datasetVersion,
    },
    metrics,
    cases,
  };
}
