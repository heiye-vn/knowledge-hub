import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 文档正文（PostgreSQL kh_document_content）
 *
 * 与 kh_document 一对一：document_id 同时是主键与外键（DDL 层 ON DELETE CASCADE）。
 * 刻意不建 ORM 级 @OneToOne 关系——与 kh_document 的 category_id / team_id 一样
 * 只作裸列，避免 eager/lazy 加载语义混入；两表都按 documentId 直查。
 *
 * 前身是 MongoDB `document_content` 集合（双库时代）：
 * Mongo 侧原本规划的 chunks / chat_histories 已分别落在 ES / 未启动，
 * 为仅剩的一个集合维护一整套独立数据库得不偿失，故并入 PostgreSQL。
 */
@Entity('kh_document_content')
export class DocumentContentEntity {
  /** 文档 ID（kh_document.id），主键，1:1 */
  @PrimaryColumn({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string;

  /** Markdown 正文 */
  @Column({ type: 'text', default: '' })
  content: string;

  /** 正文字符数 */
  @Column({ name: 'content_length', type: 'int', default: 0 })
  contentLength: number;

  /** 正文摘要 / 预览（未显式传 summary 时取正文前 200 字） */
  @Column({ name: 'content_summary', type: 'varchar', default: '' })
  contentSummary: string;

  /** 版本号：每次正文变更 +1 */
  @Column({ type: 'int', default: 1 })
  version: number;

  /** 创建时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  /** 更新时间 */
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;

  /** 逻辑删除（与 kh_document.deleted 同步置位） */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
