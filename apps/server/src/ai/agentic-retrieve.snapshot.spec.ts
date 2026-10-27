import { describe, expect, it, vi } from 'vitest';
import { retrieveUntilRelevant } from './agentic-retrieve.js';
import type { RetrievalService } from '../rag/retrieval.service.js';
import type { ChatQueryRewriteService } from './chat-query-rewrite.service.js';
import type { SearchHit } from '../rag/types/rag.types.js';

function hit(id: string): SearchHit {
  return {
    chunkId: id,
    documentId: `doc-${id}`,
    documentTitle: `文档 ${id}`,
    content: `内容 ${id}`,
    heading: null,
    chunkIndex: 0,
    totalChunks: 1,
    score: 0.9,
    scores: { vector: null, keyword: 0.9 },
  };
}

describe('retrieveUntilRelevant 全轮次快照', () => {
  it('保留首轮与改写轮各自的原始/切题命中', async () => {
    const first = hit('first');
    const second = hit('second');
    const retrieval = {
      search: vi
        .fn()
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second]),
    } as unknown as RetrievalService;
    const rewrite = {
      gradeHits: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          reason: 'irrelevant',
          text: '不切题',
        })
        .mockResolvedValueOnce({
          ok: true,
          reason: 'relevant',
          text: '切题',
        }),
      rewriteAfterRetrieve: vi.fn(async () => '改写词'),
    } as unknown as ChatQueryRewriteService;

    const result = await retrieveUntilRelevant({
      question: '原问题',
      query: '首轮词',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(result.retrieveCount).toBe(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      usedQuery: '首轮词',
      rawHits: [first],
      hits: [],
    });
    expect(result.attempts[1]).toMatchObject({
      usedQuery: '改写词',
      rawHits: [second],
      hits: [second],
    });
    expect(result.rawHits).toEqual([second]);
  });

  it('无法改写时仍保留首轮 attempt，retrieveCount 为 1', async () => {
    const retrieval = {
      search: vi.fn(async () => [hit('a')]),
    } as unknown as RetrievalService;
    const rewrite = {
      gradeHits: vi.fn(async () => ({
        ok: false,
        reason: 'irrelevant',
        text: '不切题',
      })),
      rewriteAfterRetrieve: vi.fn(async () => ''),
    } as unknown as ChatQueryRewriteService;

    const result = await retrieveUntilRelevant({
      question: '问题',
      query: '词',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(result.retrieveCount).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.rawHits).toEqual([hit('a')]);
  });

  it('检索异常也保留一次失败 attempt，且不再重试', async () => {
    const retrieval = {
      search: vi.fn(async () => {
        throw new Error('ES timeout');
      }),
    } as unknown as RetrievalService;
    const rewrite = {
      gradeHits: vi.fn(),
      rewriteAfterRetrieve: vi.fn(),
    } as unknown as ChatQueryRewriteService;

    const result = await retrieveUntilRelevant({
      question: '问题',
      query: '词',
      topK: 5,
      retrieval,
      rewrite,
    });

    expect(result.retrieveCount).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].eval.reason).toBe('error');
    expect(rewrite.rewriteAfterRetrieve).not.toHaveBeenCalled();
  });
});
