import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * AI 会话（PostgreSQL kh_ai_session）
 *
 * 每个用户的对话容器；updated_at 随最新一轮问答推进，
 * 会话列表按其倒序（最近活跃在前），索引 idx_kh_ai_session_user_updated 配套。
 */
@Entity('kh_ai_session')
export class AiSessionEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 所属用户（→ kh_user.id） */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 会话标题（首问自动生成，可重命名） */
  @Column({ type: 'varchar', length: 80 })
  title: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
