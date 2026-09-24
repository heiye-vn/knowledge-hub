import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { RagOrchestrator } from '../rag/rag.orchestrator.js';
import type { RustfsService } from '../storage/rustfs.service.js';
import { DocumentService } from './document.service.js';
import type { DocumentReviewService } from './document-review.service.js';
import type { DocumentEntity, DocumentStatus } from './entities/document.entity.js';
import type { FileParserService } from './parser/file-parser.service.js';
import type { SearchIndexService } from '../search/search-index.service.js';
import { DocumentStatus as Status } from './document-status.js';

/**
 * 文档状态流转与索引联动的单元测试（不依赖 PG / ES，纯 fake）
 *
 * 背景：发布态守卫此前缺失，已归档（Archived）文档也能被重新发布并重建向量。
 * 引入审核机制后，发布语义进一步分叉（需审 → 待审核；免审 → 直接发布），
 * 用测试锁住这些边界，防退化。
 *
 * 说明：审核开关默认按「免审」构造（requireApproval 缺省 false），
 * 以保持原有 publish 用例的语义；需审分支在「发布审核流程」用例组里单独覆盖。
 */

/** 最小 EntityManager 替身：只实现本文件用例用到的能力 */
interface FakeEm {
  findOne(
    entity: unknown,
    opts?: { where?: Record<string, unknown> },
  ): Promise<unknown>;
  save(doc: DocumentEntity): Promise<DocumentEntity>;
  update(): Promise<undefined>;
  find(): Promise<unknown[]>;
  count(): Promise<number>;
  transaction(cb: (tx: FakeEm) => unknown): Promise<unknown>;
  create(entity: unknown, data: unknown): unknown;
}

function makeDoc(status: DocumentStatus): DocumentEntity {
  return {
    id: 'doc-1',
    title: '测试文档',
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
    /** 是否开启发布审核（默认 false = 免审直发） */
    requireApproval?: boolean;
  } = {},
) {
  const saved: DocumentEntity[] = [];

  const em: FakeEm = {
    // 元数据查询返回 doc；正文查询（where 带 documentId）返回内容行
    findOne: async (_entity, opts2) => {
      if (opts2?.where && 'documentId' in opts2.where) {
        return { documentId: opts2.where.documentId, content: '正文内容' };
      }
      return doc;
    },
    save: async (d: DocumentEntity) => {
      saved.push(d);
      return d;
    },
    update: async () => undefined,
    find: async () => [],
    count: async () => 0,
    transaction: async (cb) => cb(em),
    create: (_e, data) => data,
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

  const createdReviews: Array<{ documentId: string; beforeStatus: number }> = [];
  const reviewService = {
    isRequireApproval: () => opts.requireApproval === true,
    createPendingReview: async (
      documentId: string,
      beforeStatus: number,
    ) => {
      createdReviews.push({ documentId, beforeStatus });
      return { id: 'review-1', documentId, beforeStatus };
    },
    approve: async () => ({ id: 'review-1', documentId: doc?.id ?? 'doc-1' }),
    reject: async () => ({ id: 'review-1', documentId: doc?.id ?? 'doc-1' }),
  };

  const service = new DocumentService(
    em as never,
    {} as unknown as FileParserService,
    {} as unknown as RustfsService,
    ragOrchestrator as unknown as RagOrchestrator,
    searchIndexService as unknown as SearchIndexService,
    kgBuildPublisher as never,
    reviewService as unknown as DocumentReviewService,
  );

  return { service, saved, createdReviews };
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

  it('已归档文档不允许发布（归档是终态）', async () => {
    const { service, saved } = makeService(makeDoc(2));
    await expect(service.publish('doc-1')).rejects.toThrow(BadRequestException);
    // 被拒绝时不应产生任何写库动作
    expect(saved).toHaveLength(0);
  });

  it('待审核文档不允许再次发布', async () => {
    const { service } = makeService(makeDoc(3));
    await expect(service.publish('doc-1')).rejects.toThrow(BadRequestException);
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
  it('删除已发布文档时清理向量块与文档搜索索引', async () => {
    const { service } = makeService(makeDoc(1));
    await expect(service.remove('doc-1')).resolves.toMatchObject({
      deleted: true,
      vectorsCleaned: true,
      searchCleaned: true,
    });
  });

  it('删除草稿 / 待审核文档不触发索引清理（本来就不在索引里）', async () => {
    const { service } = makeService(makeDoc(0));
    await expect(service.remove('doc-1')).resolves.toMatchObject({
      deleted: true,
      vectorsCleaned: false,
      searchCleaned: false,
      kgDeleteQueued: false,
    });
  });
});

describe('DocumentService 发布审核流程', () => {
  it('需审模式下 publish 转为待审核且不建索引', async () => {
    const { service, createdReviews } = makeService(makeDoc(0), {
      requireApproval: true,
    });
    await expect(service.publish('doc-1')).resolves.toMatchObject({
      status: Status.PendingReview,
      pendingApproval: true,
      reviewId: 'review-1',
    });
    expect(createdReviews).toEqual([
      { documentId: 'doc-1', beforeStatus: Status.Draft },
    ]);
  });

  it('已发布文档改稿提审时会先清掉旧索引', async () => {
    const { service } = makeService(makeDoc(1), { requireApproval: true });
    await expect(service.submitForReview('doc-1')).resolves.toMatchObject({
      status: Status.PendingReview,
      indexesCleaned: { vectorsCleaned: true, searchCleaned: true },
    });
  });

  it('草稿提审不需要清索引（本来就不在索引里）', async () => {
    const { service } = makeService(makeDoc(0), { requireApproval: true });
    await expect(
      service.submitForReview('doc-1'),
    ).resolves.toMatchObject({
      status: Status.PendingReview,
      indexesCleaned: null,
    });
  });

  it('已归档文档不允许提审', async () => {
    const { service } = makeService(makeDoc(2), { requireApproval: true });
    await expect(service.submitForReview('doc-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('审核通过：转已发布并建索引', async () => {
    const { service } = makeService(makeDoc(3));
    await expect(service.approveReview('review-1')).resolves.toMatchObject({
      status: Status.Published,
      indexed: true,
      chunks: 3,
    });
  });

  it('审核驳回：回草稿', async () => {
    const { service } = makeService(makeDoc(3));
    await expect(
      service.rejectReview('review-1', { reviewComment: '请补充操作步骤' }),
    ).resolves.toMatchObject({
      status: Status.Draft,
      reviewId: 'review-1',
    });
  });
});

describe('DocumentService 归档 / 下架', () => {
  it('已发布文档可归档并清索引', async () => {
    const { service } = makeService(makeDoc(1));
    await expect(service.archive('doc-1')).resolves.toMatchObject({
      status: Status.Archived,
      vectorsCleaned: true,
      searchCleaned: true,
    });
  });

  it('非已发布文档不可归档', async () => {
    const { service } = makeService(makeDoc(0));
    await expect(service.archive('doc-1')).rejects.toThrow(BadRequestException);
  });

  it('已发布文档可下架为草稿并清索引', async () => {
    const { service } = makeService(makeDoc(1));
    await expect(service.saveAsDraft('doc-1')).resolves.toMatchObject({
      status: Status.Draft,
      searchCleaned: true,
    });
  });

  it('非已发布文档不可下架为草稿', async () => {
    const { service } = makeService(makeDoc(3));
    await expect(service.saveAsDraft('doc-1')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('DocumentService.update 编辑门禁', () => {
  it('待审核文档不可改正文', async () => {
    const { service } = makeService(makeDoc(3));
    await expect(
      service.update('doc-1', { content: '# 新内容' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('已发布文档可以改正文', async () => {
    const { service } = makeService(makeDoc(1));
    await expect(
      service.update('doc-1', { content: '# 新内容' }),
    ).resolves.toMatchObject({ content: '# 新内容' });
  });

  it('PATCH 不允许直接改状态（状态走专用接口）', async () => {
    const { service } = makeService(makeDoc(0));
    await expect(service.update('doc-1', { status: 1 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('PATCH 传入与当前一致的状态不受影响', async () => {
    const { service } = makeService(makeDoc(1));
    await expect(service.update('doc-1', { status: 1 })).resolves.toMatchObject(
      { id: 'doc-1' },
    );
  });
});

describe('DocumentService.loadForIndex / findPublishedIds', () => {
  /** ids 中不存在的文档会被跳过；contents 按文档 id 给出正文（kh_document_content） */
  function makeIndexService(options: {
    ids: string[];
    contents?: Record<string, string>;
    publishedIds?: string[];
  }) {
    const contents = options.contents ?? {};

    const em = {
      // where 带 documentId → 内容表查询；否则按「id 是否在 ids 里」区分存在/不存在
      findOne: async (
        _entity: unknown,
        opts: { where: { id?: string; documentId?: string; deleted?: boolean } },
      ) => {
        if (opts.where.documentId !== undefined) {
          return { documentId: opts.where.documentId, content: contents[opts.where.documentId] ?? '' };
        }
        return options.ids.includes(opts.where.id ?? '')
          ? ({
              id: opts.where.id,
              title: `标题-${opts.where.id}`,
              status: 1,
            } as unknown as DocumentEntity)
          : null;
      },
      find: async () => (options.publishedIds ?? []).map((id) => ({ id })),
    };

    const reviewService = {
      isRequireApproval: () => true,
    };

    const service = new DocumentService(
      em as never,
      {} as unknown as FileParserService,
      {} as unknown as RustfsService,
      {} as unknown as RagOrchestrator,
      {} as unknown as SearchIndexService,
      {} as never,
      reviewService as unknown as DocumentReviewService,
    );

    return service;
  }

  it('loadForIndex 返回元数据 + 正文的组合', async () => {
    const service = makeIndexService({
      ids: ['doc-1', 'doc-2'],
      contents: { 'doc-1': '正文一', 'doc-2': '正文二' },
    });
    const docs = await service.loadForIndex(['doc-1', 'doc-2']);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ id: 'doc-1', title: '标题-doc-1', content: '正文一' });
    expect(docs[1].content).toBe('正文二');
  });

  it('loadForIndex 跳过已删除/不存在的文档，不中断整批', async () => {
    const service = makeIndexService({ ids: ['doc-1'], contents: { 'doc-1': '正文' } });
    const docs = await service.loadForIndex(['doc-1', 'ghost']);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('doc-1');
  });

  it('findPublishedIds 返回全部已发布未删除文档的 ID', async () => {
    const service = makeIndexService({ ids: [], publishedIds: ['a', 'b'] });
    await expect(service.findPublishedIds()).resolves.toEqual(['a', 'b']);
  });
});
