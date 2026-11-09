import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 长期记忆本地镜像（PostgreSQL kh_ai_memory，feat-v22）
 *
 * Mem0 是外部 SaaS，条目无法本地统计、审计或批量治理。本表按 memory_id
 * 做幂等镜像：只反映「本地见过的 Mem0 条目」，删除与归档以 Mem0 为准。
 *
 * 默认关闭（CHAT_MEMORY_MIRROR_ENABLED=false）：没有真实数据量支撑时
 * 不引入额外写放大。开启后 rememberTurn 同步 upsert，删会话/全清同步删。
 *
 * 与 kh_ai_session 不建外键：镜像要保留已删会话的历史条目用于审计，
 * 会话删除由应用层显式清理（removeSession）。
 */
@Entity('kh_ai_memory')
export class AiMemoryEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** Mem0 侧记忆 ID（幂等键） */
  @Column({ name: 'memory_id', type: 'varchar', length: 64 })
  memoryId: string;

  /** 所属用户（→ kh_user.id） */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 所属会话；user 层为 NULL */
  @Column({
    name: 'session_id',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
  })
  sessionId: string | null;

  /** user = 跨会话画像，session = 随会话上下文 */
  @Column({ type: 'varchar', length: 16 })
  layer: 'user' | 'session';

  /** 抽取后的记忆正文 */
  @Column({ type: 'text' })
  content: string;

  /** active = 参与检索，archived = 已归出活跃集（Mem0 侧同步删除） */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: 'active' | 'archived';

  /** Mem0 侧创建时间，用于衰减与归档判断（本地 createdAt 是同步时间） */
  @Column({ name: 'source_created_at', type: 'timestamp', nullable: true })
  sourceCreatedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
