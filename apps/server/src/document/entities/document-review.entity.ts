import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';
import type { DocumentStatus } from '../document-status.js';

/** 审核结果：1 通过，2 驳回（NULL 表示待审） */
export enum ReviewResult {
  Approved = 1,
  Rejected = 2,
}

/**
 * 文档发布审核记录（PostgreSQL kh_document_review）
 *
 * 生命周期：提审时插入一行（review_result = NULL）→ 通过 / 驳回后回填结果结案。
 * 同一文档可有多条历史记录，但同时最多一条待审 —— 由部分唯一索引
 * uq_kh_document_review_pending 在数据库层兜底（应用层判空挡不住并发）。
 */
@Entity('kh_document_review')
export class DocumentReviewEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 被审文档 ID → kh_document.id */
  @Column({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string;

  /** 审核人 ID；待审时为 NULL */
  @Column({
    name: 'reviewer_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  reviewerId?: string | null;

  /** 审核人姓名 */
  @Column({ name: 'reviewer_name', type: 'varchar', nullable: true })
  reviewerName?: string | null;

  /** NULL = 待审，1 = 通过，2 = 驳回 */
  @Column({ name: 'review_result', type: 'smallint', nullable: true })
  reviewResult?: ReviewResult | null;

  /** 审核意见（驳回时必填） */
  @Column({ name: 'review_comment', type: 'varchar', nullable: true })
  reviewComment?: string | null;

  /** 提审前的文档状态，用于回溯这次审核是从草稿还是从已发布改稿发起 */
  @Column({ name: 'before_status', type: 'smallint' })
  beforeStatus: DocumentStatus;

  /** 审核完成时间 */
  @Column({ name: 'reviewed_at', type: 'timestamp', nullable: true })
  reviewedAt?: Date | null;

  /** 提交审核时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
