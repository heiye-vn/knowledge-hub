import { describe, expect, it } from 'vitest';
import type { ChatEvalSnapshot, GoldenItem } from './eval.types.js';
import {
  buildExperimentData,
  toExperimentOutput,
} from './experiment-privacy.js';

const ITEM: GoldenItem = {
  input: { question: '高管薪酬制度里的张敏是谁' },
  expectedOutput: {
    intent: 'kb',
    keyPoints: ['张敏'],
    mustNotContain: ['王芳'],
    relevantDocTitles: ['保密薪酬'],
  },
  metadata: { id: 'secret-case', suite: 'kb-hit', access: 'admin' },
};

const OUTPUT: ChatEvalSnapshot = {
  question: ITEM.input.question,
  answer: '张敏是薪酬负责人，内部电话 13800000000。',
  intent: 'kb',
  allowRetrieve: true,
  allowGraph: true,
  allowWeb: false,
  graphQueries: ['薪酬'],
  attempts: [
    {
      query: '保密薪酬',
      rawHits: [
        {
          documentId: 'doc-secret',
          documentTitle: '保密薪酬制度',
          heading: '负责人',
          score: 0.9,
          excerpt: '张敏负责薪酬审批，内部电话 13800000000。',
        },
      ],
      gradedHits: [
        {
          documentId: 'doc-secret',
          documentTitle: '保密薪酬制度',
          heading: '负责人',
          score: 0.9,
          excerpt: '张敏负责薪酬审批。',
        },
      ],
      eval: {
        ok: true,
        reason: 'ok',
        text: '切题',
        retried: false,
        query: '保密薪酬',
      },
    },
  ],
  retrieveCount: 1,
  rewrites: [],
  graphRuns: [{ success: true, useful: true }],
  webRuns: [
    {
      success: true,
      useful: true,
      snippet: '网上也写了张敏的电话 13800000000',
    },
  ],
};

describe('LangFuse Experiment 脱敏', () => {
  it('默认模式不把问题、金标要点与禁用事实传给 Experiment', () => {
    const data = buildExperimentData([ITEM], false);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('高管薪酬');
    expect(serialized).not.toContain('张敏');
    expect(serialized).not.toContain('王芳');
    expect(serialized).not.toContain('保密薪酬');
    expect(data[0].input.question).toBe('[content-hidden:secret-case]');
    expect(data[0].metadata.id).toBe('secret-case');
    expect(data[0].expectedOutput.intent).toBe('kb');
  });

  it('默认模式 task output 不含答案、文档摘录、电话与联网内容', () => {
    const output = toExperimentOutput(OUTPUT, false);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('张敏');
    expect(serialized).not.toContain('13800000000');
    expect(serialized).not.toContain('保密薪酬');
    expect(serialized).not.toContain('网上也写了');
    expect(output).toMatchObject({
      intent: 'kb',
      retrieveCount: 1,
      attemptCount: 1,
      graphCalls: 1,
      graphSuccess: 1,
      webCalls: 1,
      webSuccess: 1,
    });
  });

  it('显式开启正文时保留完整 data 与快照', () => {
    expect(buildExperimentData([ITEM], true)[0]).toBe(ITEM);
    expect(toExperimentOutput(OUTPUT, true)).toBe(OUTPUT);
  });
});
