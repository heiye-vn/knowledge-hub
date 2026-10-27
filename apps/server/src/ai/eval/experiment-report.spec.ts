import { describe, expect, it } from 'vitest';
import type { ChatEvalSnapshot, GoldenItem } from './eval.types.js';
import type { EvalScore } from './evaluators.js';
import {
  buildExperimentReport,
  compareReports,
  summarizeScores,
} from './experiment-report.js';

function item(id: string, access: 'admin' | 'restricted' = 'admin'): GoldenItem {
  return {
    input: { question: `问题 ${id}` },
    expectedOutput: { intent: 'kb' },
    metadata: { id, suite: access === 'restricted' ? 'acl' : 'kb-hit', access },
  };
}

function snapshot(id: string): ChatEvalSnapshot {
  return {
    question: `问题 ${id}`,
    answer: '回答',
    intent: 'kb',
    allowRetrieve: true,
    allowGraph: true,
    allowWeb: false,
    graphQueries: [],
    attempts: [],
    retrieveCount: 0,
    rewrites: [],
    graphRuns: [],
    webRuns: [],
  };
}

const scoresA: EvalScore[] = [
  { name: 'intent_match', value: 1 },
  { name: 'final_hit_at_5', value: null },
  { name: 'precision_at_5', value: 0.5 },
];

describe('实验报告', () => {
  it('聚合忽略 null 分数，统计 count/mean/min/max', () => {
    const summary = summarizeScores([
      ...scoresA,
      { name: 'precision_at_5', value: 1 },
    ]);
    expect(summary.final_hit_at_5).toBeUndefined();
    expect(summary.precision_at_5).toEqual({
      count: 2,
      mean: 0.75,
      min: 0.5,
      max: 1,
    });
  });

  it('报告不保存回答正文，并记录版本与关键失败', () => {
    const report = buildExperimentReport({
      items: [item('admin-case'), item('acl-leak', 'restricted')],
      outputs: [snapshot('admin-case'), snapshot('acl-leak')],
      scores: [
        scoresA,
        [
          { name: 'tool_policy', value: 0, comment: '越权' },
          { name: 'refusal_quality', value: 0, comment: '编造' },
        ],
      ],
      generatedAt: '2026-10-26T00:00:00.000Z',
      gitCommit: 'abc1234',
      datasetVersion: 'golden-v1',
      modelConfig: { topK: 5 },
    });

    expect(report.cases[0].question).toBe('问题 admin-case');
    expect(JSON.stringify(report)).not.toContain('"answer"');
    expect(report.criticalFailures).toEqual([
      expect.objectContaining({
        id: 'acl-leak',
        scores: expect.arrayContaining(['tool_policy', 'refusal_quality']),
      }),
    ]);
  });

  it('compareReports 输出指标差值、逐题改善与退化', () => {
    const base = buildExperimentReport({
      items: [item('a'), item('b')],
      outputs: [snapshot('a'), snapshot('b')],
      scores: [
        [{ name: 'final_hit_at_5', value: 0 }],
        [{ name: 'final_hit_at_5', value: 1 }],
      ],
      generatedAt: 'base',
      gitCommit: 'base',
      datasetVersion: 'golden-v1',
      modelConfig: {},
    });
    const current = buildExperimentReport({
      items: [item('a'), item('b')],
      outputs: [snapshot('a'), snapshot('b')],
      scores: [
        [{ name: 'final_hit_at_5', value: 1 }],
        [{ name: 'final_hit_at_5', value: 0 }],
      ],
      generatedAt: 'current',
      gitCommit: 'current',
      datasetVersion: 'golden-v1',
      modelConfig: {},
    });

    const comparison = compareReports(base, current);
    expect(comparison.metrics.final_hit_at_5).toEqual({
      baseline: 0.5,
      current: 0.5,
      delta: 0,
    });
    expect(comparison.cases).toEqual([
      expect.objectContaining({ id: 'a', status: 'improved' }),
      expect.objectContaining({ id: 'b', status: 'regressed' }),
    ]);
  });
});
