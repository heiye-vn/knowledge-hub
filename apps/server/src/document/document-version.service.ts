import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { canWriteDocument } from './document-access.js';
import { DocumentEntity } from './entities/document.entity.js';
import { DocumentVersionEntity } from './entities/document-version.entity.js';

export type VersionSnapshot = {
  documentId: string;
  version: number;
  title: string;
  content: string;
  summary?: string | null;
  userId?: string | null;
};

export type VersionSummary = {
  id: string;
  documentId: string;
  version: number;
  title: string;
  summary?: string | null;
  createBy?: string | null;
  createdAt: Date;
};

/**
 * 正文历史版本。
 *
 * - 快照在正文写入的同一事务里落库，避免"正文已改、历史没记"；
 * - 首改时若该文档还没有任何历史（升级前的存量文档），先补记改之前的旧稿；
 * - 回滚复用 DocumentService.update，天然生成一条新版本，旧记录不动。
 */
@Injectable()
export class DocumentVersionService {
  constructor(@InjectEntityManager() private readonly em: EntityManager) {}

  async recordInitial(
    snapshot: VersionSnapshot,
    manager: EntityManager = this.em,
  ): Promise<void> {
    await this.insertIgnore(snapshot, manager);
  }

  async recordContentChange(
    input: { previous: VersionSnapshot; next: VersionSnapshot },
    manager: EntityManager = this.em,
  ): Promise<void> {
    const count = await manager.count(DocumentVersionEntity, {
      where: { documentId: input.next.documentId },
    });
    if (count === 0) {
      await this.insertIgnore(input.previous, manager);
    }
    if (input.next.version !== input.previous.version) {
      await this.insertIgnore(input.next, manager);
    }
  }

  /** 版本列表只给元数据，正文按需单独拉取 */
  async list(documentId: string, user: AuthUser): Promise<VersionSummary[]> {
    await this.requireWriter(documentId, user);
    const rows = await this.em.find(DocumentVersionEntity, {
      where: { documentId },
      select: {
        id: true,
        documentId: true,
        version: true,
        title: true,
        summary: true,
        createBy: true,
        createdAt: true,
      },
      order: { version: 'DESC' },
    });
    return rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      version: row.version,
      title: row.title,
      summary: row.summary ?? null,
      createBy: row.createBy ?? null,
      createdAt: row.createdAt,
    }));
  }

  async get(
    documentId: string,
    versionId: string,
    user: AuthUser,
  ): Promise<DocumentVersionEntity> {
    await this.requireWriter(documentId, user);
    const row = await this.em.findOne(DocumentVersionEntity, {
      where: { id: versionId, documentId },
    });
    if (!row) throw new NotFoundException('版本不存在');
    return row;
  }

  private async requireWriter(documentId: string, user: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id: documentId, deleted: false },
    });
    if (!doc) throw new NotFoundException('文档不存在');
    if (!canWriteDocument(doc, user)) {
      throw new ForbiddenException('只有作者或管理员可以查看版本');
    }
    return doc;
  }

  private async insertIgnore(
    snapshot: VersionSnapshot,
    manager: EntityManager,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(DocumentVersionEntity)
      .values({
        id: nextSnowflakeId(),
        documentId: snapshot.documentId,
        version: snapshot.version,
        title: snapshot.title,
        content: snapshot.content,
        summary: snapshot.summary ?? null,
        createBy: snapshot.userId ?? null,
      })
      .orIgnore()
      .execute();
  }
}
