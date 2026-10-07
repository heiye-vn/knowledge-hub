import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';
import type { ChatSource } from '../chat.types.js';

/**
 * AI 会话消息（PostgreSQL kh_ai_message）
 *
 * 一轮问答落两条：role=user 的提问 + role=assistant 的回答；
 * assistant 消息的 sources 存当轮引用溯源（无引用为 NULL）。
 * 会话删除时消息由 kh_ai_session 外键 ON DELETE CASCADE 级联清理。
 */
@Entity('kh_ai_message')
export class AiMessageEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 所属会话（→ kh_ai_session.id，级联删除） */
  @Column({
    name: 'session_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  sessionId: string;

  /** user / assistant */
  @Column({ type: 'varchar', length: 16 })
  role: 'user' | 'assistant';

  /** 消息正文 */
  @Column({ type: 'text' })
  content: string;

  /** assistant 消息的引用溯源（JSONB，无引用为 NULL） */
  @Column({ type: 'jsonb', nullable: true })
  sources?: ChatSource[] | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
