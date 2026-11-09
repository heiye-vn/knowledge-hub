import { describe, expect, it } from 'vitest';
import {
  evaluateMemoryCases,
  formatMemoryEvalSummary,
  type MemoryCase,
  type MemoryPrediction,
} from './memory-eval.js';

function makeCase(
  id: string,
  tag: string,
  writeUser: boolean,
  writeSession: boolean,
): MemoryCase {
  return {
    id,
    tag,
    question: `question-${id}`,
    answerSnippet: `answer-${id}`,
    expect: { writeUser, writeSession },
  };
}

describe('evaluateMemoryCases（记忆评测统计）', () => {
  const cases: MemoryCase[] = [
    makeCase('m01', 'identity', true, false),
    makeCase('m02', 'session-task', false, true),
    makeCase('m03', 'chitchat', false, false),
    makeCase('m04', 'kb-fact-trap', false, false),
    makeCase('m05', 'kb-fact-trap', false, false),
  ];

  it('全部命中时一致率为满、零陷阱误写', () => {
    const predictions: MemoryPrediction[] = [
      { writeUser: true, writeSession: false },
      { writeUser: false, writeSession: true },
      { writeUser: false, writeSession: false },
      { writeUser: false, writeSession: false },
      { writeUser: false, writeSession: false },
    ];
    const summary = evaluateMemoryCases(cases, predictions);
    expect(summary.correct).toBe(5);
    expect(summary.failures).toEqual([]);
    expect(summary.trapViolations).toBe(0);
    expect(summary.userPredicted).toBe(1);
    expect(summary.userCorrect).toBe(1);
    expect(summary.sessionPredicted).toBe(1);
    expect(summary.sessionCorrect).toBe(1);
  });

  it('陷阱样本被误判写入时计入红线指标并记录失败样本', () => {
    const predictions: MemoryPrediction[] = [
      { writeUser: true, writeSession: false },
      { writeUser: false, writeSession: true },
      { writeUser: false, writeSession: false },
      { writeUser: true, writeSession: false, reason: '把制度条文当画像' },
      { writeUser: false, writeSession: false },
    ];
    const summary = evaluateMemoryCases(cases, predictions);
    expect(summary.correct).toBe(4);
    expect(summary.trapViolations).toBe(1);
    expect(summary.trapTotal).toBe(2);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({
      id: 'm04',
      tag: 'kb-fact-trap',
    });
    // 误写也拉低 user 层 precision：2 次预测只有 1 次该写
    expect(summary.userPredicted).toBe(2);
    expect(summary.userCorrect).toBe(1);
  });

  it('预测数少于样本时缺失项按 false/false 处理，不会抛错', () => {
    const summary = evaluateMemoryCases(cases, [
      { writeUser: true, writeSession: false },
    ]);
    expect(summary.total).toBe(5);
    // m01 命中；m03/m04/m05 期望本来就是 false/false，缺失即命中；m02 落空
    expect(summary.correct).toBe(4);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].id).toBe('m02');
  });

  it('空数据集返回全零，不出现除零', () => {
    const summary = evaluateMemoryCases([], []);
    expect(summary.total).toBe(0);
    expect(formatMemoryEvalSummary(summary)).toContain('n/a');
  });

  it('格式化结果包含三个指标与红线提示', () => {
    const summary = evaluateMemoryCases(cases, [
      { writeUser: true, writeSession: false },
      { writeUser: false, writeSession: true },
      { writeUser: false, writeSession: false },
      { writeUser: false, writeSession: false },
      { writeUser: false, writeSession: false },
    ]);
    const text = formatMemoryEvalSummary(summary);
    expect(text).toContain('判定一致 5/5');
    expect(text).toContain('user 层 precision 1/1');
    expect(text).toContain('陷阱样本误写 0/2');
    expect(text).toContain('必须为 0');
  });
});
