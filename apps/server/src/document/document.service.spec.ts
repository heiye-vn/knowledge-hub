import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { RagOrchestrator } from '../rag/rag.orchestrator.js';
import type { RustfsService } from '../storage/rustfs.service.js';
import { DocumentService } from './document.service.js';
import type { DocumentEntity, DocumentStatus } from './entities/document.entity.js';
import type { FileParserService } from './parser/file-parser.service.js';
import type { DocumentContentDocument } from './schemas/document-content.schema.js';
import type { SearchIndexService } from '../search/search-index.service.js';

/**
 * 发布态守卫的单元测试（不依赖 PG / Mongo / ES，纯 fake）
 *
 * 背景：对照参考项目 knowledge-hub-backend v3 时发现本服务缺失状态校验，
 * 已归档（Archived）文档也能被重新发布并重建向量。用测试锁住该边界，防退化。
 */

function makeDoc(status: DocumentStatus): DocumentEntity {
  return {
    id: 'doc-1',
    title: '测试文档',
    contentId: 'content-1',
    status,
    publishTime: null,
  } as unknown as DocumentEntity;
}

function makeService(
  doc: DocumentEntity | null,
  opts: {
    rag?: boolean;
    search?: boolean;
    kgQueue?: boolean;
  } = {},
) {
  const saved: DocumentEntity[] = [];

  const em = {
    findOne: async () => doc,
    save: async (d: DocumentEntity) => {
      saved.push(d);
      return d;
    },
  };

  const contentModel = {
    findOne: () => ({ lean: async () => ({ content: '正文内容' }) }),
    updateOne: async () => undefined,
  };

  const ragOrchestrator = {
    isAvailable: () => opts.rag !== false,
    indexDocument: async (d: { id: string }) => ({
      documentId: d.id,
      chunks: 3,
    }),
    deleteDocument: async () => undefined,
  };

  const searchIndexService = {
    isAvailable: () => opts.search !== false,
    indexDocument: async () => undefined,
    deleteDocument: async () => undefined,
  };

  const kgBuildPublisher = {
    isAvailable: () => opts.kgQueue !== false,
    enqueueBuildByDocIds: async () => 'kg-task-id',
    enqueueDeleteByDocIds: async () => 'kg-task-id',
  };

  const service = new DocumentService(
    em as never,
    contentModel as unknown as Model<DocumentContentDocument>,
    {} as unknown as FileParserService,
    {} as unknown as RustfsService,
    ragOrchestrator as unknown as RagOrchestrator,
    searchIndexService as unknown as SearchIndexService,
    kgBuildPublisher as never,
  );

  return { service, saved };
}

describe('DocumentService.publish 状态守卫', () => {
  it('草稿可以发布', async () => {
    const { service } = makeService(makeDoc(0));
    await expect(service.publish('doc-1')).resolves.toMatchObject({
      indexed: true,
      chunks: 3,
    });
  });

  it('已发布文档可再次发布（重建索引）', async () => {
    const { service } = makeService(makeDoc(1));
    await expect(service.publish('doc-1')).resolves.toMatchObject({
      indexed: true,
    });
  });

  it('已归档文档不允许发布（对齐参考项目 v3）', async () => {
    const { service, saved } = makeService(makeDoc(2));
    await expect(service.publish('doc-1')).rejects.toThrow(BadRequestException);
    // 被拒绝时不应产生任何写库动作
    expect(saved).toHaveLength(0);
  });

  it('文档不存在时抛 NotFound', async () => {
    const { service } = makeService(null);
    await expect(service.publish('doc-1')).rejects.toThrow(NotFoundException);
  });
});

/**
 * 两条索引链路的「可用性分开判定」：
 * RAG 需要 ES + Embedding Key，Search 只需要 ES。
 * 没配 Key 时不能把文档搜索一起判死 —— 这是对齐 v4 时刻意保留的分叉。
 */
describe('DocumentService.publish 双索引', () => {
  it('默认两条链路都可用', async () => {
    const { service } = makeService(makeDoc(0));
    await expect(service.publish('doc-1')).resolves.toMatchObject({
      indexed: true,
      chunks: 3,
      searchIndexed: true,
    });
  });

  it('RAG 不可用（缺 Embedding Key）时，文档搜索仍写入', async () => {
    const { service } = makeService(makeDoc(0), { rag: false });
    await expect(service.publish('doc-1')).resolves.toMatchObject({
      indexed: false,
      chunks: 0,
      searchIndexed: true,
    });
  });

  it('两条链路都不可用时发布成功但都不索引', async () => {
    const { service } = makeService(makeDoc(0), {
      rag: false,
      search: false,
    });
    await expect(service.publish('doc-1')).resolves.toMatchObject({
      indexed: false,
      searchIndexed: false,
    });
  });
});

describe('DocumentService.remove 双索引清理', () => {
  it('删除后同时清理向量块与文档搜索索引', async () => {
    const { service } = makeService(makeDoc(1));
    await expect(service.remove('doc-1')).resolves.toMatchObject({
      deleted: true,
      vectorsCleaned: true,
      searchCleaned: true,
    });
  });
});

describe('DocumentService.loadForIndex / findPublishedIds', () => {
  /** ids 中不存在的文档会被跳过；contents 按文档 id 给出 Mongo 正文 */
  function makeIndexService(options: {
    ids: string[];
    contents?: Record<string, string>;
    publishedIds?: string[];
  }) {
    const contents = options.contents ?? {};

    const em = {
      // 按「id 是否在 ids 里」区分存在/不存在，够用且直观
      findOne: async (_entity: unknown, opts: { where: { id: string } }) =>
        options.ids.includes(opts.where.id)
          ? ({
              id: opts.where.id,
              title: `标题-${opts.where.id}`,
              contentId: `c-${opts.where.id}`,
              status: 1,
            } as unknown as DocumentEntity)
          : null,
      find: async () => (options.publishedIds ?? []).map((id) => ({ id })),
    };

    const contentModel = {
      findOne: (q: { _id: string }) => ({
        lean: async () => ({ content: contents[q._id] ?? '' }),
      }),
    };

    const service = new DocumentService(
      em as never,
      contentModel as unknown as Model<DocumentContentDocument>,
      {} as unknown as FileParserService,
      {} as unknown as RustfsService,
      {} as unknown as RagOrchestrator,
      {} as unknown as SearchIndexService,
      {} as never,
    );

    return service;
  }

  it('loadForIndex 返回元数据 + Mongo 正文的组合', async () => {
    const service = makeIndexService({
      ids: ['doc-1', 'doc-2'],
      contents: { 'c-doc-1': '正文一', 'c-doc-2': '正文二' },
    });
    const docs = await service.loadForIndex(['doc-1', 'doc-2']);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ id: 'doc-1', title: '标题-doc-1', content: '正文一' });
    expect(docs[1].content).toBe('正文二');
  });

  it('loadForIndex 跳过已删除/不存在的文档，不中断整批', async () => {
    const service = makeIndexService({ ids: ['doc-1'], contents: { 'c-doc-1': '正文' } });
    const docs = await service.loadForIndex(['doc-1', 'ghost']);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('doc-1');
  });

  it('findPublishedIds 返回全部已发布未删除文档的 ID', async () => {
    const service = makeIndexService({ ids: [], publishedIds: ['a', 'b'] });
    await expect(service.findPublishedIds()).resolves.toEqual(['a', 'b']);
  });
});
