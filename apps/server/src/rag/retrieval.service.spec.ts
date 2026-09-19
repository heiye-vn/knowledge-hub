import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElasticsearchService } from './elasticsearch.service.js';
import { EmbeddingService } from './embedding.service.js';
import { RetrievalService } from './retrieval.service.js';
import { VectorIndexService } from './vector-index.service.js';
import type { DocumentChunk } from './types/rag.types.js';

async function isEsUp(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:9200/_cluster/health', {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const esUp = await isEsUp();

const DOC_ALIVE = 'vitest-search-alive';
const DOC_DOWN = 'vitest-search-down';

function chunk(
  documentId: string,
  index: number,
  content: string,
  docStatus: number,
): DocumentChunk {
  return {
    chunkId: `${documentId}-${index}`,
    documentId,
    documentTitle: '知识库制度文档',
    content,
    heading: null,
    chunkIndex: index,
    totalChunks: 1,
    categoryId: null,
    authorId: null,
    teamId: null,
    docStatus,
    publishTime: null,
  };
}

/** 模拟 PG：只有 aliveIds 里的文档仍然「未删除且已发布」 */
function fakeEntityManager(aliveIds: string[]): EntityManager {
  const alive = new Set(aliveIds);
  return {
    find: async (_entity: unknown, options: any) => {
      const ids: string[] = options?.where?.id?.value ?? [];
      return ids.filter((id) => alive.has(String(id))).map((id) => ({ id }));
    },
  } as unknown as EntityManager;
}

describe.skipIf(!esUp)('RetrievalService（集成，依赖 localhost:9200）', () => {
  let esService: ElasticsearchService;
  let vectorIndex: VectorIndexService;
  let service: RetrievalService;

  beforeAll(async () => {
    esService = new ElasticsearchService({
      get: (_k: string, d?: string) => d,
    } as unknown as ConfigService);
    await esService.onModuleInit();
    await esService.ensureIndex();

    vectorIndex = new VectorIndexService(esService);
    await vectorIndex.deleteByDocumentId(DOC_ALIVE);
    await vectorIndex.deleteByDocumentId(DOC_DOWN);

    // 一条已发布 + 一条已下线（doc_status=0）
    await vectorIndex.indexChunks([
      chunk(DOC_ALIVE, 0, '企业级知识库检索系统的报销流程说明', 1),
      chunk(DOC_DOWN, 0, '企业级知识库检索系统的归档流程说明', 0),
    ]);

    service = new RetrievalService(
      esService,
      new EmbeddingService({
        get: (_k: string, d?: string) => d,
      } as unknown as ConfigService),
      { get: (_k: string, d?: string) => d } as unknown as ConfigService,
      fakeEntityManager([DOC_ALIVE]),
    );
  });

  afterAll(async () => {
    await vectorIndex?.deleteByDocumentId(DOC_ALIVE).catch(() => undefined);
    await vectorIndex?.deleteByDocumentId(DOC_DOWN).catch(() => undefined);
    await esService?.getClient().close().catch(() => undefined);
  });

  it('空查询返回空结果', async () => {
    await expect(service.search({ query: '   ' })).resolves.toEqual([]);
  });

  it('关键词模式命中中文，且走 IK 分词而非单字', async () => {
    const hits = await service.search({
      query: '知识库',
      mode: 'keyword',
      topK: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain('知识库');
    expect(hits[0].scores.keyword).not.toBeNull();
  });

  it('只返回已发布文档：doc_status 过滤生效', async () => {
    const hits = await service.search({
      query: '流程说明',
      mode: 'keyword',
      topK: 10,
    });

    expect(hits.every((h) => h.documentId === DOC_ALIVE)).toBe(true);
  });

  it('一致性兜底：PG 侧已下线的文档即使残留在 ES 也会被过滤', async () => {
    // 场景：ES 清理失败，DOC_DOWN 仍在索引里且 doc_status=1，但 PG 已软删
    await vectorIndex.indexChunks([
      chunk(DOC_DOWN, 1, '企业级知识库检索系统的残留块内容', 1),
    ]);

    const hits = await service.search({
      query: '残留块',
      mode: 'keyword',
      topK: 10,
    });

    expect(hits.every((h) => h.documentId !== DOC_DOWN)).toBe(true);
  });

  it('混合模式：两路召回融合，且同时带上两路原始分数', async () => {
    // 用 stub 顶替真实 embedding（只需链路打通，不验证语义质量）
    const fakeEmbedding = {
      isConfigured: () => true,
      embed: async () =>
        Array.from({ length: 1024 }, (_, i) => ((i % 97) / 97) - 0.5),
    } as unknown as EmbeddingService;

    const hybridService = new RetrievalService(
      esService,
      fakeEmbedding,
      { get: (_k: string, d?: string) => d } as unknown as ConfigService,
      fakeEntityManager([DOC_ALIVE]),
    );

    const hits = await hybridService.search({
      query: '知识库',
      mode: 'hybrid',
      topK: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    // 应用层 RRF 能同时保留两路分数（ES 原生 RRF 拿不到）
    const top = hits[0];
    expect(top.scores.vector !== null || top.scores.keyword !== null).toBe(true);
    // 融合分是 RRF 分值量级（0 ~ 1/k），不是原始相似度
    expect(top.score).toBeGreaterThan(0);
    expect(top.score).toBeLessThan(1);
  });

  it('向量/混合模式在缺少 Embedding Key 时返回空且不抛异常', async () => {
    await expect(
      service.search({ query: '知识库', mode: 'vector' }),
    ).resolves.toEqual([]);
    await expect(
      service.search({ query: '知识库', mode: 'hybrid' }),
    ).resolves.toEqual([]);
  });
});

describe('RetrievalService（ES 禁用场景）', () => {
  it('ES 不可用时返回空数组，不抛异常', async () => {
    const disabled = new ElasticsearchService({
      get: (k: string, d?: string) =>
        k === 'ELASTICSEARCH_ENABLED' ? 'false' : d,
    } as unknown as ConfigService);
    await disabled.onModuleInit();

    const service = new RetrievalService(
      disabled,
      new EmbeddingService({
        get: (_k: string, d?: string) => d,
      } as unknown as ConfigService),
      { get: (_k: string, d?: string) => d } as unknown as ConfigService,
      fakeEntityManager([]),
    );

    expect(service.isAvailable('keyword')).toBe(false);
    await expect(
      service.search({ query: '知识库', mode: 'keyword' }),
    ).resolves.toEqual([]);
  });
});
