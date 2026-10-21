import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/** 补偿目标：RAG 向量块 / 文档搜索索引 / 知识图谱 / 可见性字段 */
export type IndexTarget = 'rag' | 'search' | 'kg' | 'visibility';

/** 操作类型：新建或覆盖 / 删除 / 仅刷可见性 */
export type IndexOperation = 'upsert' | 'delete' | 'visibility';

/** 任务状态：待执行 / 待重试 / 已完成 / 超过上限放弃 */
export type IndexOutboxStatus = 'pending' | 'retry' | 'succeeded' | 'dead';

/**
 * 索引失败补偿任务（PostgreSQL kh_index_outbox）。
 *
 * 【为什么需要】ES / Neo4j 与 PostgreSQL 无共享事务，索引写入失败只记日志
 * 会留下「已发布但搜不到」的静默缺口，且只能靠人工调用重建接口兜底。
 */
@Entity('kh_index_outbox')
export class IndexOutboxEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 目标文档 ID */
  @Column({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string;

  /** 补偿目标 */
  @Column({ type: 'varchar', length: 16 })
  target: IndexTarget;

  /** 操作类型 */
  @Column({ type: 'varchar', length: 16 })
  operation: IndexOperation;

  /** 任务状态 */
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: IndexOutboxStatus;

  /** 已尝试次数 */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** 最近一次失败原因（截断到 1000 字符） */
  @Column({ name: 'last_error', type: 'varchar', length: 1000, nullable: true })
  lastError: string | null;

  /** 下次可执行时间（退避由 Worker 计算） */
  @Column({ name: 'next_run_at', type: 'timestamp' })
  nextRunAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
