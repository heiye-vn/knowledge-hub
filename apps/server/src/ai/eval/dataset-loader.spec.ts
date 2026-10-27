import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadGoldenDataset,
  parseGoldenDataset,
} from './dataset-loader.js';
import { GOLDEN_DATASET } from './golden-dataset.js';

const ITEM = {
  input: { question: '年会在哪里办' },
  expectedOutput: {
    intent: 'kb',
    requireRetrieve: true,
    relevantDocTitles: [],
  },
  metadata: { id: 'case-1', suite: 'kb-empty', access: 'admin' },
};

describe('外部评测数据集加载', () => {
  it('校验通过后返回文件里的版本与用例', () => {
    const loaded = parseGoldenDataset(
      { version: 'kb-40-v1', description: '基线', items: [ITEM] },
      'test.json',
    );
    expect(loaded.version).toBe('kb-40-v1');
    expect(loaded.items).toHaveLength(1);
    expect(loaded.items[0].metadata.id).toBe('case-1');
  });

  it('重复用例 ID 直接报错', () => {
    expect(() =>
      parseGoldenDataset({
        version: 'v1',
        items: [ITEM, ITEM],
      }),
    ).toThrow('重复用例 ID');
  });

  it('非法意图或未知字段被拒绝', () => {
    expect(() =>
      parseGoldenDataset({
        version: 'v1',
        items: [{ ...ITEM, expectedOutput: { intent: 'unknown' } }],
      }),
    ).toThrow();
    expect(() =>
      parseGoldenDataset({
        version: 'v1',
        items: [{ ...ITEM, extra: true }],
      }),
    ).toThrow();
  });

  it('未配置路径使用内置数据集', async () => {
    const loaded = await loadGoldenDataset({});
    expect(loaded.source).toBe('builtin');
    expect(loaded.version).toBe('golden-v1');
    expect(loaded.items).toHaveLength(GOLDEN_DATASET.length);
  });

  it('从文件加载并允许环境变量覆盖版本', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kh-eval-'));
    try {
      const path = join(dir, 'dataset.json');
      await writeFile(
        path,
        JSON.stringify({ version: 'file-v1', items: [ITEM] }),
        'utf8',
      );
      const loaded = await loadGoldenDataset({
        EVAL_DATASET_PATH: path,
        EVAL_DATASET_VERSION: 'release-v2',
      });
      expect(loaded.version).toBe('release-v2');
      expect(loaded.items).toHaveLength(1);
      expect(loaded.source).toBe(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('仓库内 40 条真实语料基线集可加载且覆盖四类场景', async () => {
    const path = resolve(
      process.cwd(),
      'eval/datasets/knowledge-base-40.json',
    );
    const loaded = await loadGoldenDataset({ EVAL_DATASET_PATH: path });
    expect(loaded.version).toBe('kb-40-v1');
    expect(loaded.items).toHaveLength(40);
    expect(new Set(loaded.items.map((item) => item.metadata.id)).size).toBe(
      40,
    );
    const suites = new Set(
      loaded.items.map((item) => item.metadata.suite),
    );
    expect(suites).toEqual(
      new Set(['routing', 'kb-empty', 'kb-travel', 'kb-onboarding']),
    );
    expect(
      loaded.items.some((item) => item.expectedOutput.expectRewrite),
    ).toBe(true);
    expect(
      loaded.items.some((item) => item.expectedOutput.requireGraph),
    ).toBe(true);
  });

  it('配置受限用户后给外部数据集追加 ACL 用例', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kh-eval-acl-'));
    try {
      const path = join(dir, 'dataset.json');
      await writeFile(
        path,
        JSON.stringify({ version: 'file-v1', items: [ITEM] }),
        'utf8',
      );
      const loaded = await loadGoldenDataset({
        EVAL_DATASET_PATH: path,
        EVAL_ACL_USER_ID: '2002',
        EVAL_ACL_QUESTION: '高管薪酬制度',
      });
      expect(loaded.items).toHaveLength(2);
      expect(loaded.items.at(-1)).toMatchObject({
        input: { question: '高管薪酬制度' },
        metadata: { suite: 'acl', access: 'restricted' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
