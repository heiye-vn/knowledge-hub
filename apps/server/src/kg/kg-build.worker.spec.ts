import { describe, expect, it, vi } from 'vitest';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import type { KgBuildMessage } from '../mq/messages/pipeline.messages.js';
import type { ConfigService } from '@nestjs/config';
import { KgBuildWorker } from './kg-build.worker.js';

/**
 * KG 建图 Worker 纯单测（不依赖 Redis / Neo4j / PG / Mongo）
 *
 * 覆盖业务语义：
 * - DELETE / BUILD_BY_DOC_IDS / BUILD_ALL 三种消息的分支
 * - 建图失败汇总后抛错（触发 BullMQ 重试）
 * - 未支持的消息类型直接忽略
 */

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function doc(id: string): PipelineDocument {
  return {
    id,
    title: `文档-${id}`,
    content: '正文',
    status: 1,
  } as PipelineDocument;
}

function makeWorker(options: {
  loaded?: PipelineDocument[];
  failed?: Array<{ documentId: string; message: string }>;
}) {
  const deleteForDocument = vi.fn(async () => undefined);
  const buildBatch = vi.fn(async (docs: PipelineDocument[]) => ({
    succeeded: docs.map((d) => ({
      documentId: d.id,
      chunks: 1,
      entities: 2,
      relations: 1,
      failedChunks: 0,
    })),
    failed: options.failed ?? [],
  }));

  const graphBuildService = {
    isAvailable: () => true,
    buildBatch,
    deleteForDocument,
  };

  const em = {
    findOne: async () => null,
    find: async () => [],
  };

  const worker = new KgBuildWorker(
    fakeConfig(),
    graphBuildService as never,
    em as never,
    {} as never,
  );
  // 绕过私有加载方法：注入假数据源
  Object.defineProperty(worker, 'loadDocumentsByIds', {
    value: vi.fn(async (ids: string[]) =>
      (options.loaded ?? []).filter((d) => ids.includes(d.id)),
    ),
  });
  Object.defineProperty(worker, 'loadAllPublishedDocuments', {
    value: vi.fn(async () => options.loaded ?? []),
  });

  return { worker, buildBatch, deleteForDocument };
}

const msg = (over: Partial<KgBuildMessage> = {}): KgBuildMessage => ({
  taskId: 'kg-task-1',
  type: 'BUILD_BY_DOC_IDS',
  documentIds: ['d1', 'd2'],
  ...over,
});

describe('KgBuildWorker.processMessage', () => {
  it('按 ID 建图：加载文档 → buildBatch', async () => {
    const { worker, buildBatch } = makeWorker({ loaded: [doc('d1')] });
    await worker.processMessage(msg({ documentIds: ['d1'] }));
    expect(buildBatch).toHaveBeenCalledTimes(1);
    expect(buildBatch.mock.calls[0][0]).toHaveLength(1);
  });

  it('BUILD_ALL：全量已发布文档', async () => {
    const { worker, buildBatch } = makeWorker({
      loaded: [doc('d1'), doc('d2')],
    });
    await worker.processMessage(msg({ type: 'BUILD_ALL', documentIds: undefined }));
    expect(buildBatch).toHaveBeenCalledTimes(1);
    expect(buildBatch.mock.calls[0][0]).toHaveLength(2);
  });

  it('DELETE_BY_DOC_IDS：逐篇清理图谱，不调 buildBatch', async () => {
    const { worker, buildBatch, deleteForDocument } = makeWorker({});
    await worker.processMessage(msg({ type: 'DELETE_BY_DOC_IDS' }));
    expect(deleteForDocument).toHaveBeenCalledTimes(2);
    expect(buildBatch).not.toHaveBeenCalled();
  });

  it('⭐ 建图失败汇总后抛错，触发 BullMQ 重试（修参考项目「失败即丢弃」）', async () => {
    const { worker } = makeWorker({
      loaded: [doc('d1')],
      failed: [{ documentId: 'd1', message: 'Neo4j 写入超时' }],
    });
    await expect(worker.processMessage(msg())).rejects.toThrow(/KG 建图部分失败/);
  });

  it('无有效文档时不报错也不建图', async () => {
    const { worker, buildBatch } = makeWorker({ loaded: [] });
    await expect(worker.processMessage(msg())).resolves.toBeUndefined();
    expect(buildBatch).not.toHaveBeenCalled();
  });

  it('未支持的消息类型直接忽略', async () => {
    const { worker, buildBatch } = makeWorker({});
    await expect(
      worker.processMessage(msg({ type: 'BY_CATEGORY' as never })),
    ).resolves.toBeUndefined();
    expect(buildBatch).not.toHaveBeenCalled();
  });
});
