import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvalSnapshot, GoldenExpected } from './eval.types.js';
import {
  completeness,
  falseHit,
  finalHitAt5,
  firstHitAt5,
  intentMatch,
  mrrAt5,
  precisionAt5,
  refusalQuality,
  rewriteGain,
  rewriteLoop,
  runEvaluators,
  toolPolicy,
  groundedness,
} from './evaluators.js';

const judgeInvoke = vi.fn();

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: class {
    withStructuredOutput() {
      return { invoke: judgeInvoke };
    }
  },
}));

// Judge 实例在模块内懒加载；测试固定 Key，避免受外部环境变量顺序影响。
process.env.LLM_API_KEY = 'test-key-for-judge';

function snapshot(
  overrides: Partial<ChatEvalSnapshot> = {},
): ChatEvalSnapshot {
  return {
    question: '出差加签找谁',
    answer: '找张敏加签 [1]。',
    intent: 'kb',
    allowRetrieve: true,
    allowGraph: true,
    allowWeb: false,
    graphQueries: ['差旅'],
    attempts: [
      {
        query: '出差加签',
        rawHits: [
          {
            documentId: 'doc-1',
            documentTitle: '差旅管理制度',
            heading: null,
            score: 0.9,
            excerpt: '超过五千需要张敏加签。',
          },
        ],
        gradedHits: [
          {
            documentId: 'doc-1',
            documentTitle: '差旅管理制度',
            heading: null,
            score: 0.9,
            excerpt: '超过五千需要张敏加签。',
          },
        ],
        eval: {
          ok: true,
          reason: 'ok',
          text: '资料切题',
          retried: false,
          query: '出差加签',
        },
      },
    ],
    retrieveCount: 1,
    rewrites: [],
    graphRuns: [{ success: true, useful: true }],
    webRuns: [],
    ...overrides,
  };
}

function evalArgs(
  expectedOutput: GoldenExpected,
  output = snapshot(),
) {
  return {
    input: { question: output.question },
    output,
    expectedOutput,
  };
}

describe('Agent 评测指标', () => {
  beforeEach(() => {
    judgeInvoke.mockReset();
    judgeInvoke.mockRejectedValue(new Error('judge unavailable'));
  });

  it('intent_match 严格比较意图', async () => {
    expect(
      await intentMatch(evalArgs({ intent: 'kb' })),
    ).toMatchObject({ value: 1 });
    expect(
      await intentMatch(evalArgs({ intent: 'web' })),
    ).toMatchObject({ value: 0 });
  });

  it('tool_policy 要求工具成功，不把失败调用算通过', async () => {
    const failedGraph = snapshot({
      graphRuns: [{ success: false, useful: false, error: 'neo4j down' }],
    });
    expect(
      await toolPolicy(
        evalArgs({ intent: 'kb', requireGraph: true }, failedGraph),
      ),
    ).toMatchObject({ value: 0 });
    expect(
      await toolPolicy(
        evalArgs({ intent: 'kb', requireGraph: true, forbidWeb: true }),
      ),
    ).toMatchObject({ value: 1 });

    const calledWeb = snapshot({
      webRuns: [
        { success: false, useful: false, error: 'timeout', snippet: '' },
      ],
    });
    expect(
      await toolPolicy(
        evalArgs({ intent: 'kb', forbidWeb: true }, calledWeb),
      ),
    ).toMatchObject({ value: 0 });
  });

  it('首轮与末轮指标分别计算，MRR 反映排序位置', async () => {
    const relevant = {
      documentId: 'doc-2',
      documentTitle: '差旅报销办法',
      heading: null,
      score: 0.8,
      excerpt: '...',
    };
    const irrelevant = {
      documentId: 'doc-9',
      documentTitle: '年会通知',
      heading: null,
      score: 0.7,
      excerpt: '...',
    };
    const output = snapshot({
      attempts: [
        {
          query: '首轮',
          rawHits: [irrelevant],
          gradedHits: [],
          eval: {
            ok: false,
            reason: 'irrelevant',
            text: '不切题',
            retried: false,
            query: '首轮',
          },
        },
        {
          query: '改写',
          rawHits: [irrelevant, relevant],
          gradedHits: [relevant],
          eval: {
            ok: true,
            reason: 'retried_ok',
            text: '切题',
            retried: true,
            query: '首轮',
            retryQuery: '改写',
          },
        },
      ],
      retrieveCount: 2,
      rewrites: [{ previousQuery: '首轮', query: '改写' }],
    });
    const expected: GoldenExpected = {
      intent: 'kb',
      relevantDocTitles: ['差旅'],
      expectRewrite: true,
    };

    expect(
      await firstHitAt5(evalArgs(expected, output)),
    ).toMatchObject({ value: 0 });
    expect(
      await finalHitAt5(evalArgs(expected, output)),
    ).toMatchObject({ value: 1 });
    expect(
      await precisionAt5(evalArgs(expected, output)),
    ).toMatchObject({ value: 0.5 });
    expect(
      await mrrAt5(evalArgs(expected, output)),
    ).toMatchObject({ value: 0.5 });
    expect(
      await rewriteLoop(evalArgs(expected, output)),
    ).toMatchObject({ value: 1 });
    expect(
      await rewriteGain(evalArgs(expected, output)),
    ).toMatchObject({ value: 1 });
  });

  it('没有真实改写事件时 rewrite_loop 不得分', async () => {
    const output = snapshot({
      attempts: [
        snapshot().attempts[0],
        { ...snapshot().attempts[0], query: '第二次直接换词' },
      ],
      rewrites: [],
    });
    expect(
      await rewriteLoop(
        evalArgs(
          { intent: 'kb', expectRewrite: true, relevantDocTitles: ['差旅'] },
          output,
        ),
      ),
    ).toMatchObject({ value: 0 });
  });

  it('空金标时任一 attempt 泄漏 gradedHits 都算误命中', async () => {
    expect(
      await falseHit(
        evalArgs({ intent: 'kb', relevantDocTitles: [] }),
      ),
    ).toMatchObject({ value: 0 });

    const clean = snapshot({
      attempts: [
        {
          ...snapshot().attempts[0],
          gradedHits: [],
          eval: {
            ok: false,
            reason: 'irrelevant',
            text: '不切题',
            retried: false,
            query: '年会',
          },
        },
      ],
    });
    expect(
      await falseHit(
        evalArgs({ intent: 'kb', relevantDocTitles: [] }, clean),
      ),
    ).toMatchObject({ value: 1 });
  });

  it('Judge 失败返回 null 而不是 0，缺省 Judge 不误伤指标', async () => {
    judgeInvoke.mockRejectedValueOnce(new Error('timeout'));
    expect(
      await groundedness(evalArgs({ intent: 'kb' })),
    ).toMatchObject({ value: null });
    expect(
      await refusalQuality(
        evalArgs({ intent: 'kb', expectRefusal: true }),
      ),
    ).toMatchObject({ value: null });
  });

  it('completeness 使用结构化 Judge 计算覆盖并拦截禁用事实', async () => {
    judgeInvoke.mockResolvedValueOnce({
      covered: ['张敏'],
      missing: ['加签'],
      forbiddenHit: [],
      comment: '基本覆盖',
    });
    expect(
      await completeness(
        evalArgs({ intent: 'kb', keyPoints: ['张敏', '加签'] }),
      ),
    ).toMatchObject({ value: 0.5 });

    judgeInvoke.mockResolvedValueOnce({
      covered: ['李明'],
      missing: [],
      forbiddenHit: ['王芳'],
      comment: '张冠李戴',
    });
    expect(
      await completeness(
        evalArgs({
          intent: 'kb',
          keyPoints: ['李明'],
          mustNotContain: ['王芳'],
        }),
      ),
    ).toMatchObject({ value: 0 });
  });

  it('Precision/MRR 按文档去重，同文档多 chunk 不重复计分', async () => {
    const sameDoc = {
      documentId: 'doc-1',
      documentTitle: '差旅管理制度',
      heading: null,
      score: 0.9,
      excerpt: '...',
    };
    const otherDoc = {
      documentId: 'doc-2',
      documentTitle: '年会通知',
      heading: null,
      score: 0.8,
      excerpt: '...',
    };
    const output = snapshot({
      attempts: [
        {
          query: '差旅',
          rawHits: [sameDoc, { ...sameDoc, heading: '第二段' }, otherDoc],
          gradedHits: [sameDoc],
          eval: {
            ok: true,
            reason: 'ok',
            text: '切题',
            retried: false,
            query: '差旅',
          },
        },
      ],
    });
    const expected: GoldenExpected = {
      intent: 'kb',
      relevantDocTitles: ['差旅'],
    };

    expect(
      await precisionAt5(evalArgs(expected, output)),
    ).toMatchObject({ value: 0.5, comment: '去重后相关 1/2' });
    expect(
      await mrrAt5(evalArgs(expected, output)),
    ).toMatchObject({ value: 1 });
  });

  it('runEvaluators 保留 null（跳过），由报告层过滤', async () => {
    const scores = await runEvaluators(
      evalArgs({ intent: 'kb', relevantDocTitles: ['差旅'] }),
    );
    expect(scores.find((score) => score.name === 'refusal_quality')?.value).toBeNull();
    expect(scores.find((score) => score.name === 'first_hit_at_5')?.value).toBe(1);
  });
});
