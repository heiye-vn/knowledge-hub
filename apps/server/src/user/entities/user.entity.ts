import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';

/**
 * 用户（PostgreSQL kh_user）
 *
 * 用户名唯一性由部分唯一索引 uk_kh_user_username 保证（仅约束未删除用户，
 * 软删后允许同名重建）；密码存 bcrypt 哈希（cost=10），不存明文。
 */
@Entity('kh_user')
export class UserEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 登录用户名（未删除范围内唯一） */
  @Column({ type: 'varchar', length: 50 })
  username: string;

  /** 密码哈希（bcrypt, cost=10） */
  @Column({ type: 'varchar', length: 255 })
  password: string;

  /** 邮箱 */
  @Column({ type: 'varchar', length: 100, nullable: true })
  email?: string | null;

  /** 真实姓名 / 显示名 */
  @Column({ name: 'real_name', type: 'varchar', length: 50, nullable: true })
  realName?: string | null;

  /** 头像 URL */
  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar?: string | null;

  /** 0 禁用 1 启用（禁用账户拒绝登录与鉴权） */
  @Column({ type: 'smallint', default: 1 })
  status: number;

  /** 最后登录时间（登录成功时更新） */
  @Column({ name: 'last_login_at', type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;

  /** 逻辑删除标记 */
  @Column({ type: 'boolean', default: false })
  deleted: boolean;
}
