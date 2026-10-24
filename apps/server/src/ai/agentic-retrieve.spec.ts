import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  retrieveAndGrade,
  retrieveUntilRelevant,
} from './agentic-retrieve.js';
import type { SearchHit, SearchMode } from '../rag/types/rag.types.js';
import type { RetrievalService } from '../rag/retrieval.service.js';
import type {
  ChatQueryRewriteService,
  HitGrade,
} from './chat-query-rewrite.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

function hit(id: string, score = 0.9): SearchHit {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    documentTitle: `文档 ${id}`,
    content: `内容 ${id}`,
    heading: null,
    chunkIndex: 0,
    totalChunks: 1,
    score,
    scores: { vector: null, keyword: score },
  };
}

const GRADE_RELEVANT: HitGrade = {
  ok: true,
  reason: 'relevant',
  text: '资料切题',
};
const GRADE_IRRELEVANT: HitGrade = {
  ok: false,
  reason: 'irrelevant',
  text: '只是词沾边',
};
const GRADE_EMPTY: HitGrade = {
  ok: false,
  reason: 'empty',
  text: '未检索到资料',
};

const USER = {
  userId: '1001',
  username: 'user',
  roles: [],
  permissions: [],
  teamIds: ['team-1'],
} as AuthUser;

function makeRetrieval(
  impl: (params: {
    query: string;
    topK?: number;
    mode?: SearchMode;
  }) => Promise<SearchHit[]>,
) {
  return { search: vi.fn(impl) } as unknown as RetrievalService;
}

function makeRewrite(grade: HitGrade, retryQuery = '改写后的词') {
  return {
    gradeHits: vi.fn(async () => grade),
    rewriteAfterRetrieve: vi.fn(async () => retryQuery),
  } as unknown as ChatQueryRewriteService;
}

describe('retrieveAndGrade（一次检索 + 切题评估）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('切题时返回命中，并把 mode / topK / 可见范围传给检索', async () => {
    const hits = [hit('a')];
    const retrieval = makeRetrieval(async () => hits);
    const rewrite = makeRewrite(GRADE_RELEVANT);

    const result = await retrieveAndGrade({
      question: '报销流程',
      query: ' 报销流程 ',
      topK: 3,
      mode: 'keyword',
      user: USER,
      retrieval,
      rewrite,
    });

    expect(retrieval.search).toHaveBeenCalledWith(
      { query: '报销流程', topK: 3, mode: 'keyword' },
      expect.objectContaining({
        unrestricted: false,
        userId: '1001',
        teamIds: ['team-1'],
      }),
    );
    expect(result.hits).toEqual(hits);
    expect(result.rawHits).toEqual(hits);
    expect(result.usedQuery).toBe('报销流程');
    expect(result.eval).toMatchObject({
      ok: true,
      reason: 'ok',
      retried: false,
      query: '报销流程',
    });
  });

  it('不切题时清空可引用资料，但保留原始命中给改写器', async () => {
    const hits = [hit('a')];
    const retrieval = makeRetrieval(async () => hits);
    const rewrite = makeRewrite(GRADE_IRRELEVANT);

    const result = await retrieveAndGrade({
      question: '加班餐补',
      query: '加班餐补',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(result.rawHits).toEqual(hits);
    expect(result.hits).toEqual([]);
    expect(result.eval).toMatchObject({
      ok: false,
      reason: 'irrelevant',
      text: '只是词沾边',
    });
  });

  it('空结果按 empty 返回，可引用资料为空', async () => {
    const retrieval = makeRetrieval(async () => []);
    const rewrite = makeRewrite(GRADE_EMPTY);

    const result = await retrieveAndGrade({
      question: '年会抽奖',
      query: '年会抽奖',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(result.hits).toEqual([]);
    expect(result.eval).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('检索抛错时降级为 error 评估，不向上抛', async () => {
    const retrieval = makeRetrieval(async () => {
      throw new Error('ES timeout');
    });
    const rewrite = makeRewrite(GRADE_RELEVANT);

    const result = await retrieveAndGrade({
      question: '问题',
      query: '问题',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(result.hits).toEqual([]);
    expect(result.rawHits).toEqual([]);
    expect(result.eval.ok).toBe(false);
    expect(result.eval.reason).toBe('error');
    expect(result.eval.text).toContain('ES timeout');
    expect(rewrite.gradeHits).not.toHaveBeenCalled();
  });

  it('第二次检索的评估保留首轮词与改写词', async () => {
    const hits = [hit('a')];
    const retrieval = makeRetrieval(async () => hits);
    const rewrite = makeRewrite(GRADE_RELEVANT);

    const result = await retrieveAndGrade({
      question: '问题',
      query: '新检索词',
      topK: 5,
      retrieval,
      rewrite,
      retried: true,
      previousQuery: '旧检索词',
    });

    expect(result.eval).toMatchObject({
      ok: true,
      reason: 'retried_ok',
      retried: true,
      query: '旧检索词',
      retryQuery: '新检索词',
    });
  });
});

describe('retrieveUntilRelevant（非流式等价环）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('首轮不足时改写并再查一次，成功返回第二次命中', async () => {
    const firstHit = hit('a');
    const secondHit = hit('b');
    const retrieval = makeRetrieval(
      vi
        .fn()
        .mockResolvedValueOnce([firstHit])
        .mockResolvedValueOnce([secondHit]) as never,
    );
    const rewrite = {
      gradeHits: vi
        .fn()
        .mockResolvedValueOnce(GRADE_IRRELEVANT)
        .mockResolvedValueOnce(GRADE_RELEVANT),
      rewriteAfterRetrieve: vi.fn(async () => '新检索词'),
    } as unknown as ChatQueryRewriteService;
    const onEval = vi.fn();
    const onRewrite = vi.fn();

    const result = await retrieveUntilRelevant({
      question: '问题',
      query: '旧检索词',
      topK: 5,
      mode: 'hybrid',
      user: USER,
      retrieval,
      rewrite,
      onEval,
      onRewrite,
    });

    expect(retrieval.search).toHaveBeenNthCalledWith(
      1,
      { query: '旧检索词', topK: 5, mode: 'hybrid' },
      expect.anything(),
    );
    expect(retrieval.search).toHaveBeenNthCalledWith(
      2,
      { query: '新检索词', topK: 5, mode: 'hybrid' },
      expect.anything(),
    );
    expect(rewrite.rewriteAfterRetrieve).toHaveBeenCalledWith(
      '问题',
      '旧检索词',
      GRADE_IRRELEVANT,
      [firstHit],
    );
    expect(onEval).toHaveBeenCalledTimes(2);
    expect(onRewrite).toHaveBeenCalledWith('新检索词');
    expect(result.hits).toEqual([secondHit]);
    expect(result.eval.reason).toBe('retried_ok');
  });

  it('改写器无法给出新词时不再检索，保留首轮评估', async () => {
    const retrieval = makeRetrieval(async () => [hit('a')]);
    const rewrite = makeRewrite(GRADE_IRRELEVANT, '');

    const result = await retrieveUntilRelevant({
      question: '问题',
      query: '旧检索词',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(retrieval.search).toHaveBeenCalledTimes(1);
    expect(result.hits).toEqual([]);
    expect(result.eval.reason).toBe('irrelevant');
  });

  it('首轮检索错误时不再改写重查', async () => {
    const retrieval = makeRetrieval(async () => {
      throw new Error('boom');
    });
    const rewrite = makeRewrite(GRADE_RELEVANT);

    const result = await retrieveUntilRelevant({
      question: '问题',
      query: '问题',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(retrieval.search).toHaveBeenCalledTimes(1);
    expect(rewrite.rewriteAfterRetrieve).not.toHaveBeenCalled();
    expect(result.eval.reason).toBe('error');
  });
});
