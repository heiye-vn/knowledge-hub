import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 团队（PostgreSQL kh_team），树形组织架构。
 *
 * 与 RBAC 权限体系**无关**：不控制接口访问，只承载「部门 / 成员」，
 * 为后续文档可见性过滤（kh_document.team_id）提供组织维度的数据来源。
 */
@Entity('kh_team')
export class TeamEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 团队名称 */
  @Column({ name: 'team_name', type: 'varchar', length: 100 })
  teamName: string;

  /** 团队编码（如 TECH_CENTER） */
  @Column({ name: 'team_code', type: 'varchar', length: 50, nullable: true })
  teamCode?: string | null;

  /** 描述 */
  @Column({ type: 'varchar', length: 500, nullable: true })
  description?: string | null;

  /** 负责人 → kh_user.id */
  @Column({
    name: 'leader_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  leaderId?: string | null;

  /** 父团队 ID，0 为根 */
  @Column({
    name: 'parent_id',
    type: 'bigint',
    default: '0',
    transformer: bigintTransformer,
  })
  parentId: string;

  /** 排序（同级从小到大） */
  @Column({ type: 'int', default: 0 })
  sort: number;

  /** 0 禁用 1 启用 */
  @Column({ type: 'smallint', default: 1 })
  status: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;

  /** 逻辑删除标记 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
