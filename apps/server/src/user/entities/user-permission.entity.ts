import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 用户-权限直接关联（PostgreSQL kh_user_permission）。
 *
 * 标准 RBAC 之上的扩展：临时给单个用户分配权限，避免为一次性场景建角色。
 * 【易错】这是「补充」而非「主体」——常规授权仍应走角色；
 * 直接赋权没有角色那样的批量管理能力，长期用会散落成难以治理的例外。
 */
@Entity('kh_user_permission')
export class UserPermissionEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 用户 ID → kh_user.id */
  @Column({
    name: 'user_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  userId: string;

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
