import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RerankerService } from './reranker.service.js';
import type { SearchHit } from './types/rag.types.js';

function hit(id: string, score: number): SearchHit {
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

/** rerank 用例的固定配置：Key 已配置、开关开 */
function rerankerWithKey(): RerankerService {
  return new RerankerService({
    get: (k: string, d?: string) => (k === 'RERANK_API_KEY' ? 'test-key' : d),
  } as unknown as ConfigService);
}

describe('RerankerService（mock fetch）', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('未配置 Key 时 rerank 返回 null（上层降级 RRF 顺序）', async () => {
    const service = new RerankerService({
      get: (_k: string, d?: string) => d,
    } as unknown as ConfigService);
    expect(service.isEnabled()).toBe(false);
    await expect(service.rerank('q', [hit('a', 1)], 5)).resolves.toBeNull();
  });

  it('空候选直接返回空数组', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(rerankerWithKey().rerank('q', [], 5)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功重排：按服务端返回顺序与 relevance_score 重排', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: {
              results: [
                { index: 2, relevance_score: 0.9 },
                { index: 0, relevance_score: 0.5 },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const candidates = [hit('a', 0.1), hit('b', 0.2), hit('c', 0.3)];
    const reranked = await rerankerWithKey().rerank('q', candidates, 5);

    expect(reranked).not.toBeNull();
    expect(reranked!.map((h) => h.chunkId)).toEqual(['c', 'a']);
    expect(reranked![0].score).toBe(0.9);
    // 其余字段原样保留
    expect(reranked![0].documentId).toBe('doc-c');
  });

  it('topN 大于候选数时按候选数截断（服务端 top_n 也受限）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: {
            results: [
              { index: 1, relevance_score: 0.8 },
              { index: 0, relevance_score: 0.6 },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const reranked = await rerankerWithKey().rerank(
      'q',
      [hit('a', 0.1), hit('b', 0.2)],
      5,
    );
    expect(reranked!.length).toBe(2);
    // top_n 参数传的是 min(topN, candidates.length)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.parameters.top_n).toBe(2);
  });

  it('索引越界的条目被过滤（防御异常响应）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: {
              results: [
                { index: 0, relevance_score: 0.9 },
                { index: 99, relevance_score: 0.8 },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const reranked = await rerankerWithKey().rerank(
      'q',
      [hit('a', 0.1)],
      5,
    );
    expect(reranked!.length).toBe(1);
    expect(reranked![0].chunkId).toBe('a');
  });

  it('HTTP 非 2xx 返回 null（降级 RRF）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: 'InvalidApiKey', message: 'bad key' }),
          { status: 401 },
        ),
      ),
    );

    const service = rerankerWithKey();
    await expect(service.rerank('q', [hit('a', 1)], 5)).resolves.toBeNull();
  });

  it('服务端返回空 results 时返回 null（降级 RRF）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ output: { results: [] } }), {
          status: 200,
        }),
      ),
    );

    await expect(
      rerankerWithKey().rerank('q', [hit('a', 1)], 5),
    ).resolves.toBeNull();
  });

  it('fetch 抛异常时返回 null（降级 RRF，不向上抛）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    await expect(
      rerankerWithKey().rerank('q', [hit('a', 1)], 5),
    ).resolves.toBeNull();
  });

  it('documents 超长被截断到上限并带省略号', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ output: { results: [{ index: 0, relevance_score: 1 }] } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const longHit: SearchHit = {
      ...hit('a', 0.1),
      documentTitle: 'T',
      content: 'x'.repeat(3000),
    };
    await rerankerWithKey().rerank('q', [longHit], 5);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input.documents[0].length).toBeLessThanOrEqual(2004);
    expect(body.input.documents[0].endsWith('...')).toBe(true);
  });
});
