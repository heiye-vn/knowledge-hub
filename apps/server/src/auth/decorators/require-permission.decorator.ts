import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'permissions';

/**
 * 声明接口所需的权限码（配合 PermissionsGuard；未标注则跳过权限校验）。
 *
 * 语义：多个权限码为「或」——命中其一即放行（与 @Roles 一致）。
 * 【易错】不要与 @Roles 同时标注在同一接口上做双重收紧——
 * RolesGuard 先执行，角色不匹配会在权限码比对前被拦，
 * 等于把「给非管理员临时授权」的路径堵死（参考项目的踩坑，见 dev-notes/rbac.md）。
 */
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
