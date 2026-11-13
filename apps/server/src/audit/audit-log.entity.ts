import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'
import { bigintTransformer } from '../common/transformers/bigint.transformer.js'

/**
 * 审计日志（首页「近期操作记录」数据源）
 *
 * 只记录**写操作**（创建/更新/删除/发布/归档/审核），读操作不入库；
 * target_name 冗余存储当时的标题，避免文档改名或软删后历史记录失真。
 * 不建外键：`actor` 与 `target` 均可能被软删，历史审计必须保留。
 */
@Entity('kh_audit_log')
export class AuditLogEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string

  /** 操作人（用户软删后 id 仍在，仅作追溯用） */
  @Column({ name: 'actor_id', type: 'bigint', transformer: bigintTransformer })
  actorId: string

  @Column({ name: 'actor_name', type: 'varchar', length: 50 })
  actorName: string

  /** create / update / delete / publish / archive / approve / reject */
  @Column({ type: 'varchar', length: 30 })
  action: string

  /** document / category / user / team */
  @Column({ name: 'target_type', type: 'varchar', length: 20 })
  targetType: string

  @Column({
    name: 'target_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  targetId: string | null

  @Column({ name: 'target_name', type: 'varchar', length: 200, nullable: true })
  targetName: string | null

  /** 补充说明（如「发布并进入审核」「审批通过」） */
  @Column({ type: 'varchar', length: 500, nullable: true })
  detail: string | null

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date
}
