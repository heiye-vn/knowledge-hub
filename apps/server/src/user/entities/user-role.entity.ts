import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 用户-角色关联（PostgreSQL kh_user_role）
 *
 * 用户与角色多对多；(user_id, role_id) 唯一，应用层 assignRole 先查后插幂等。
 */
@Entity('kh_user_role')
export class UserRoleEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 用户 ID → kh_user.id */
  @Column({ name: 'user_id', type: 'bigint', transformer: bigintTransformer })
  userId: string;

  /** 角色 ID → kh_role.id */
  @Column({ name: 'role_id', type: 'bigint', transformer: bigintTransformer })
  roleId: string;

  /** 分配时间 */
  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
