import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElasticsearchService } from './elasticsearch.service.js';
import type { DocumentChunk } from './types/rag.types.js';
import { VectorIndexService } from './vector-index.service.js';

/** ES 8.x 的 hits.total 是 { value, relation } 对象 */
function totalOf(res: { hits: { total: unknown } }): number {
  const total = res.hits.total as number | { value: number } | undefined;
  return typeof total === 'number' ? total : (total?.value ?? 0);
}

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

/** 造 1024 维假向量（本用例不依赖真实 embedding 质量） */
function fakeVector(seed = 1): number[] {
  return Array.from({ length: 1024 }, (_, i) => ((seed * (i + 1)) % 100) / 100);
}

function makeChunks(documentId: string, count: number): DocumentChunk[] {
  return Array.from({ length: count }, (_, i) => ({
    chunkId: `${documentId}-chunk-${i}`,
    documentId,
    documentTitle: '测试文档',
    content: `第 ${i} 块内容：企业级知识库检索系统`,
    heading: i === 0 ? '第一章' : null,
    chunkIndex: i,
    totalChunks: count,
    categoryId: null,
    authorId: null,
    teamId: null,
    docStatus: 2,
    publishTime: null,
    embedding: fakeVector(i + 1),
  }));
}

describe.skipIf(!esUp)('VectorIndexService（集成，依赖 localhost:9200）', () => {
  const documentId = 'vitest-doc-0001';
  let esService: ElasticsearchService;
  let service: VectorIndexService;

  beforeAll(async () => {
    esService = new ElasticsearchService({
      get: (_k: string, d?: string) => d,
    } as unknown as ConfigService);
    await esService.onModuleInit();
    await esService.ensureIndex();
    service = new VectorIndexService(esService);
    await service.deleteByDocumentId(documentId);
  });

  afterAll(async () => {
    await service?.deleteByDocumentId(documentId).catch(() => undefined);
    await esService?.getClient().close().catch(() => undefined);
  });

  it('写入后可按文档检索到全部块，且字段映射正确', async () => {
    await service.indexChunks(makeChunks(documentId, 3));

    const res = await esService.getClient().search({
      index: esService.getIndexName(),
      query: { term: { document_id: documentId } },
      size: 10,
    });

    expect(totalOf(res)).toBe(3);
    const first = res.hits.hits[0]._source as Record<string, any>;
    expect(first.chunk_index).toBeDefined();
    expect(first.total_chunks).toBe(3);
    expect(first.embedding).toHaveLength(1024);
    expect(first.indexed_at).toBeTruthy();
  });

  it('重复写入幂等：_id = chunkId 覆盖，不产生重复文档', async () => {
    await service.indexChunks(makeChunks(documentId, 3));
    await service.indexChunks(makeChunks(documentId, 3));

    const res = await esService.getClient().search({
      index: esService.getIndexName(),
      query: { term: { document_id: documentId } },
      size: 20,
    });

    expect(totalOf(res)).toBe(3);
  });

  it('按文档删除全部块', async () => {
    await service.deleteByDocumentId(documentId);

    const res = await esService.getClient().search({
      index: esService.getIndexName(),
      query: { term: { document_id: documentId } },
      size: 10,
    });

    expect(totalOf(res)).toBe(0);
  });

  it('空输入不发起写入', async () => {
    await expect(service.indexChunks([])).resolves.toBeUndefined();
  });
});

describe('VectorIndexService（ES 禁用场景）', () => {
  it('ES 不可用时跳过写入与删除，不抛异常（降级不阻断）', async () => {
    const disabled = new ElasticsearchService({
      get: (k: string, d?: string) =>
        k === 'ELASTICSEARCH_ENABLED' ? 'false' : d,
    } as unknown as ConfigService);
    await disabled.onModuleInit();

    const service = new VectorIndexService(disabled);

    await expect(
      service.indexChunks(makeChunks('x', 1)),
    ).resolves.toBeUndefined();
    await expect(service.deleteByDocumentId('x')).resolves.toBeUndefined();
  });
});
