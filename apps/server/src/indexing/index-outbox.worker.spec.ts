import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DocumentService } from '../document/document.service.js';
import type { GraphBuildService } from '../kg/graph-build.service.js';
import type { KgBuildPublisher } from '../kg/kg-build.publisher.js';
import type { RagOrchestrator } from '../rag/rag.orchestrator.js';
import type { SearchIndexService } from '../search/search-index.service.js';
import type { IndexOutboxEntity } from './entities/index-outbox.entity.js';
import type { IndexOutboxService } from './index-outbox.service.js';
import { IndexOutboxWorker } from './index-outbox.worker.js';

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function task(overrides: Partial<IndexOutboxEntity> = {}): IndexOutboxEntity {
  return {
    id: '1',
    documentId: '1001',
    target: 'rag',
    operation: 'upsert',
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextRunAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const pipelineDoc = {
  id: '1001',
  title: '测试文档',
  isPublic: true,
  teamId: 't1',
  authorId: 'u1',
};

function makeWorker(tasks: IndexOutboxEntity[]) {
  const outbox = {
    findDue: vi.fn(async () => tasks),
    markSucceeded: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
  const documents = {
    loadForIndex: vi.fn(async () => [pipelineDoc]),
  };
  const rag = {
    indexDocument: vi.fn(async () => ({ documentId: '1001', chunks: 2 })),
    deleteDocument: vi.fn(async () => undefined),
    updateVisibility: vi.fn(async () => 1),
  };
  const search = {
    indexDocument: vi.fn(async () => undefined),
    deleteDocument: vi.fn(async () => undefined),
    updateVisibility: vi.fn(async () => 1),
  };
  const graph = {
    updateVisibility: vi.fn(async () => undefined),
  };
  const kgPublisher = {
    enqueueBuildByDocIds: vi.fn(async () => 'job-1'),
    enqueueDeleteByDocIds: vi.fn(async () => 'job-2'),
  };

  const worker = new IndexOutboxWorker(
    config(),
    outbox as unknown as IndexOutboxService,
    documents as unknown as DocumentService,
    rag as unknown as RagOrchestrator,
    search as unknown as SearchIndexService,
    graph as unknown as GraphBuildService,
    kgPublisher as unknown as KgBuildPublisher,
  );

  return { worker, outbox, documents, rag, search, graph, kgPublisher };
}

describe('IndexOutboxWorker', () => {
  it('rag upsert：加载文档后重建向量索引并标记成功', async () => {
    const { worker, outbox, documents, rag } = makeWorker([task()]);

    const result = await worker.scanOnce();

    expect(documents.loadForIndex).toHaveBeenCalledWith(['1001']);
    expect(rag.indexDocument).toHaveBeenCalledWith(pipelineDoc);
    expect(outbox.markSucceeded).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
  });

  it('rag delete：直接删块，不加载文档', async () => {
    const { worker, documents, rag } = makeWorker([
      task({ operation: 'delete' }),
    ]);

    await worker.scanOnce();

    expect(documents.loadForIndex).not.toHaveBeenCalled();
    expect(rag.deleteDocument).toHaveBeenCalledWith('1001');
  });

  it('visibility：并发刷新搜索索引、向量块与图谱可见性', async () => {
    const { worker, search, rag, graph } = makeWorker([
      task({ target: 'visibility', operation: 'visibility' }),
    ]);

    await worker.scanOnce();

    const expected = { isPublic: true, teamId: 't1', authorId: 'u1' };
    expect(search.updateVisibility).toHaveBeenCalledWith('1001', expected);
    expect(rag.updateVisibility).toHaveBeenCalledWith('1001', expected);
    expect(graph.updateVisibility).toHaveBeenCalledWith('1001', expected);
  });

  it('KG 队列不可用（入队返回 null）时标记失败，留待重试', async () => {
    const { worker, outbox, kgPublisher } = makeWorker([
      task({ target: 'kg' }),
    ]);
    kgPublisher.enqueueBuildByDocIds.mockResolvedValue(null as never);

    const result = await worker.scanOnce();

    expect(outbox.markFailed).toHaveBeenCalledTimes(1);
    expect(outbox.markSucceeded).not.toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
  });

  it('单个任务失败不阻断后续任务', async () => {
    const { worker, outbox, rag } = makeWorker([
      task({ id: '1' }),
      task({ id: '2', target: 'search', operation: 'upsert' }),
    ]);
    rag.indexDocument.mockRejectedValue(new Error('es down'));

    const result = await worker.scanOnce();

    expect(outbox.markFailed).toHaveBeenCalledTimes(1);
    expect(outbox.markSucceeded).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 2, succeeded: 1, failed: 1 });
  });
});
