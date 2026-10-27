import { describe, expect, it } from 'vitest';
import { buildGoldenDataset, GOLDEN_DATASET } from './golden-dataset.js';

describe('Golden Dataset', () => {
  it('用例 id 唯一、suite 合法、访问级别明确', () => {
    const ids = GOLDEN_DATASET.map((item) => item.metadata.id);
    expect(new Set(ids).size).toBe(ids.length);
    const suites = new Set([
      'routing',
      'kb-hit',
      'rewrite',
      'kb-empty',
      'web',
    ]);
    for (const item of GOLDEN_DATASET) {
      expect(suites.has(item.metadata.suite)).toBe(true);
      expect(['admin', 'restricted']).toContain(item.metadata.access);
    }
  });

  it('空金标题必须显式给空数组，不能省略', () => {
    const emptyCases = GOLDEN_DATASET.filter(
      (item) => item.metadata.suite === 'kb-empty',
    );
    expect(emptyCases.length).toBeGreaterThan(0);
    for (const item of emptyCases) {
      expect(item.expectedOutput.relevantDocTitles).toEqual([]);
      expect(item.expectedOutput.expectRefusal).toBe(true);
    }
  });

  it('至少包含图谱必调用、改写与联网用例', () => {
    expect(
      GOLDEN_DATASET.some((item) => item.expectedOutput.requireGraph),
    ).toBe(true);
    expect(
      GOLDEN_DATASET.some((item) => item.expectedOutput.expectRewrite),
    ).toBe(true);
    expect(
      GOLDEN_DATASET.some((item) => item.expectedOutput.requireWeb),
    ).toBe(true);
  });

  it('未配置受限用户时不伪造 ACL 用例', () => {
    expect(buildGoldenDataset({})).toHaveLength(GOLDEN_DATASET.length);
  });

  it('配置受限用户与问题后追加 acl 拒答用例', () => {
    const dataset = buildGoldenDataset({
      EVAL_ACL_USER_ID: '2002',
      EVAL_ACL_QUESTION: '高管薪酬制度是什么',
    });
    expect(dataset).toHaveLength(GOLDEN_DATASET.length + 1);
    expect(dataset.at(-1)).toMatchObject({
      input: { question: '高管薪酬制度是什么' },
      expectedOutput: {
        relevantDocTitles: [],
        expectRefusal: true,
      },
      metadata: { suite: 'acl', access: 'restricted' },
    });
  });
});
