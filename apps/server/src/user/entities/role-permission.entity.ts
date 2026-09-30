import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 角色-权限关联（PostgreSQL kh_role_permission）。
 *
 * 角色 ↔ 权限多对多；(role_id, permission_id) 唯一。
 * 重新分配采用「事务内先清后插」的整体替换语义。
 */
@Entity('kh_role_permission')
export class RolePermissionEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 角色 ID → kh_role.id */
  @Column({
    name: 'role_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  roleId: string;

  /** 权限 ID → kh_permission.id */
  @Column({
    name: 'permission_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  permissionId: string;

  /** 分配时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
