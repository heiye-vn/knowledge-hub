import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer.js';
import { PermissionType } from '../../common/constants/permissions.js';

/**
 * 权限（PostgreSQL kh_permission），树形结构。
 *
 * parent_id 仅用于分类组织（前端权限树展示），**不承载权限继承语义**——
 * 拥有父权限不代表拥有子权限，鉴权永远只比对权限码本身。
 * 权限编码唯一性由部分唯一索引 uk_kh_permission_code 保证（仅约束未删除记录，
 * 软删后允许同编码重建）。
 */
@Index('uk_kh_permission_code', ['permissionCode'], {
  unique: true,
  where: 'deleted = false',
})
@Entity('kh_permission')
export class PermissionEntity {
  /** 雪花 ID */
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  /** 父权限 ID，0 为根节点 */
  @Column({
    name: 'parent_id',
    type: 'bigint',
    default: '0',
    transformer: bigintTransformer,
  })
  parentId: string;

  /** 权限名称（展示用） */
  @Column({ name: 'permission_name', type: 'varchar', length: 50 })
  permissionName: string;

  /** 权限编码（如 system:user），前后端鉴权判断的唯一依据 */
  @Column({
    name: 'permission_code',
    type: 'varchar',
    length: 100,
  })
  permissionCode: string;

  /** 权限类型：1 菜单 2 按钮 3 接口 */
  @Column({
    name: 'permission_type',
    type: 'smallint',
  })
  permissionType: PermissionType;

  /** 菜单路径（菜单级权限用，仅展示，不参与鉴权） */
  @Column({ name: 'menu_url', type: 'varchar', length: 200, nullable: true })
  menuUrl?: string | null;

  /** 接口 URL 模式（接口级权限用，仅展示，不参与鉴权） */
  @Column({ name: 'api_url', type: 'varchar', length: 500, nullable: true })
  apiUrl?: string | null;

  /** HTTP 方法（接口级权限用，仅展示） */
  @Column({ type: 'varchar', length: 10, nullable: true })
  method?: string | null;

  /** 图标（菜单级权限用） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  icon?: string | null;

  /** 排序（同级从小到大） */
  @Column({ type: 'int', default: 0 })
  sort: number;

  /** 0 禁用 1 启用（禁用权限不参与鉴权，也不并入用户权限集合） */
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
