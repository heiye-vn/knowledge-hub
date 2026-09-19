import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentService } from '../document/document.service.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import type { RagOrchestrator } from '../rag/rag.orchestrator.js';
import type { ReindexMessage } from './messages/pipeline.messages.js';
import { RagReindexPublisher } from './rag-reindex.publisher.js';
import { RagReindexWorker } from './rag-reindex.worker.js';

/**
 * 重建索引队列的单测（纯 fake，不依赖 Redis / PG / Mongo / ES）
 *
 * 覆盖的是「业务语义」，不是 BullMQ 本身：
 * - Worker：不支持的消息类型 / 空批次直接忽略；**部分失败必须抛错**以触发重试
 *   （这是相对参考项目「失败即丢弃」的关键修复）
 * - Publisher：Redis 未启用时降级，不阻断启动，且 enqueue 给出明确错误
 */

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function doc(id: string): PipelineDocument {
  return { id, title: `文档-${id}`, content: '正文', status: 1 } as PipelineDocument;
}

function makeWorker(options: {
  loaded?: PipelineDocument[];
  failed?: Array<{ documentId: string; message: string }>;
}) {
  const loadForIndex = vi.fn(
    async (ids: string[]) => options.loaded ?? ids.map(doc),
  );
  const indexDocuments = vi.fn(async (docs: PipelineDocument[]) => ({
    succeeded: docs.map((d) => ({ documentId: d.id, chunks: 1 })),
    failed: options.failed ?? [],
  }));

  const documentService = { loadForIndex } as unknown as DocumentService;
  const orchestrator = { indexDocuments } as unknown as RagOrchestrator;

  const worker = new RagReindexWorker(
    fakeConfig(),
    orchestrator,
    documentService,
  );

  return { worker, loadForIndex, indexDocuments };
}

const msg = (over: Partial<ReindexMessage> = {}): ReindexMessage => ({
  taskId: 'task-1',
  type: 'BY_DOC_IDS',
  documentIds: ['d1', 'd2'],
  ...over,
});

describe('RagReindexWorker.processMessage', () => {
  it('按 ID 加载文档并走索引管线', async () => {
    const { worker, loadForIndex, indexDocuments } = makeWorker({});
    await worker.processMessage(msg());
    expect(loadForIndex).toHaveBeenCalledWith(['d1', 'd2']);
    expect(indexDocuments).toHaveBeenCalledTimes(1);
  });

  it('不支持的消息类型直接忽略，不调管线', async () => {
    const { worker, indexDocuments } = makeWorker({});
    await worker.processMessage(msg({ type: 'BY_CATEGORY' as never }));
    expect(indexDocuments).not.toHaveBeenCalled();
  });

  it('文档 ID 为空时忽略', async () => {
    const { worker, indexDocuments } = makeWorker({});
    await worker.processMessage(msg({ documentIds: [] }));
    expect(indexDocuments).not.toHaveBeenCalled();
  });

  it('文档全部已删除（加载为空）时不报错', async () => {
    const { worker, indexDocuments } = makeWorker({ loaded: [] });
    await expect(worker.processMessage(msg())).resolves.toBeUndefined();
    expect(indexDocuments).not.toHaveBeenCalled();
  });

  it('⭐ 部分失败必须抛错，以触发 BullMQ 重试（修参考项目「失败即丢弃」）', async () => {
    const { worker } = makeWorker({
      failed: [{ documentId: 'd2', message: 'embedding 超时' }],
    });
    await expect(worker.processMessage(msg())).rejects.toThrow(/重建部分失败/);
  });

  it('全部成功时不抛错', async () => {
    const { worker } = makeWorker({});
    await expect(worker.processMessage(msg())).resolves.toBeUndefined();
  });
});

describe('RagReindexPublisher 降级', () => {
  it('REDIS_ENABLED=false 时不可用，且不阻断初始化', async () => {
    const publisher = new RagReindexPublisher(
      fakeConfig({ REDIS_ENABLED: 'false' }),
    );
    await expect(publisher.onModuleInit()).resolves.toBeUndefined();
    expect(publisher.isAvailable()).toBe(false);
  });

  it('不可用时 enqueue 给出明确错误而不是静默失败', async () => {
    const publisher = new RagReindexPublisher(
      fakeConfig({ REDIS_ENABLED: 'false' }),
    );
    await publisher.onModuleInit();
    await expect(publisher.enqueue(['d1'])).rejects.toThrow(/队列不可用/);
  });

  it('空 ID 列表直接拒绝', async () => {
    const publisher = new RagReindexPublisher(
      fakeConfig({ REDIS_ENABLED: 'false' }),
    );
    await publisher.onModuleInit();
    await expect(publisher.enqueue([])).rejects.toThrow(/不能为空/);
  });
});
