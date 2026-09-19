import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import type { RagOrchestrator } from '../rag/rag.orchestrator.js';
import type { RustfsService } from '../storage/rustfs.service.js';
import { DocumentService } from './document.service.js';
import type { DocumentEntity, DocumentStatus } from './entities/document.entity.js';
import type { FileParserService } from './parser/file-parser.service.js';
import type { DocumentContentDocument } from './schemas/document-content.schema.js';

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

function makeService(doc: DocumentEntity | null) {
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
  };

  const ragOrchestrator = {
    isAvailable: () => true,
    indexDocument: async (d: { id: string }) => ({
      documentId: d.id,
      chunks: 3,
    }),
  };

  const service = new DocumentService(
    em as never,
    contentModel as unknown as Model<DocumentContentDocument>,
    {} as unknown as FileParserService,
    {} as unknown as RustfsService,
    ragOrchestrator as unknown as RagOrchestrator,
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
