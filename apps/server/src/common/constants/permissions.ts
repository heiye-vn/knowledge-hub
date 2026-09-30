import { RoleCode } from './roles.js';

/**
 * 权限类型：1 菜单 2 按钮 3 接口。
 *
 * 三类权限统一以 permission_code 判断；menu_url / api_url 仅用于
 * 管理界面展示「这个权限是什么」，不参与运行时鉴权。
 */
export enum PermissionType {
  Menu = 1,
  Button = 2,
  Api = 3,
}

/** 超级管理员角色列表（PermissionsGuard 命中即短路放行，不再比对权限码） */
export const ADMIN_ROLES = [RoleCode.ADMIN] as const;

/**
 * 管理员通配符权限码。
 *
 * 只注入到管理员的 AuthUser.permissions，**不落库、不可被业务权限使用**：
 * - 前端：见此码即全放行，动态新建的菜单/按钮不必再回头补常量池；
 * - 后端：PermissionsGuard 比对的是接口声明的具体权限码，
 *   `'*'` 与 `'system:user'` 不相等，拿通配符换不来任何接口放行。
 */
export const PERMISSION_WILDCARD = '*';

/**
 * 保留权限码：不允许作为业务权限编码写入 kh_permission。
 *
 * 【易错】若允许新建 code='*' 的权限并赋给普通用户，
 * 后端鉴权不受影响（Guard 不认通配符），但前端全放行语义会被误用。
 */
export const RESERVED_PERMISSION_CODES = [PERMISSION_WILDCARD] as const;

/**
 * 管理员在 AuthUser.permissions 中额外补充的操作权限码。
 *
 * 【易错】数据库里 kh_role_permission 并未给 ROLE_ADMIN 逐条绑定 system:*，
 * 管理员的接口访问由 PermissionsGuard 的 ADMIN 短路保证；这里追加常量
 * 是为了让 /auth/me 与登录响应里的 permissions 字段对管理员也完整，
 * 前端菜单 / 按钮显隐不因「库里没绑」而缺项。
 */
export const ADMIN_OPERATION_PERMISSIONS = [
  'dashboard',
  'document',
  'search',
  'profile',
  'document:list',
  'document:create',
  'document:edit',
  'document:delete',
  'document:review',
  'system:user',
  'system:role',
  'system:permission',
  'system:permission:create',
  'system:permission:edit',
  'system:permission:delete',
  'system:team',
] as const;
