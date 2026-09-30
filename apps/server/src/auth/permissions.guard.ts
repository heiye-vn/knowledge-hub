import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from './auth-user.interface.js';
import { PERMISSIONS_KEY } from './decorators/require-permission.decorator.js';
import { ADMIN_ROLES } from '../common/constants/permissions.js';

/**
 * 权限码守卫（第三层，在 JwtAuthGuard、RolesGuard 之后）。
 *
 * 规则：
 * - 接口未标 @RequirePermission → 放行（仅要求已登录）；
 * - 用户是超级管理员（roles 命中 ADMIN_ROLES）→ 短路放行，不比对权限码；
 * - 其余：request.user.permissions 须命中声明权限码之一，否则 403。
 *
 * 【易错】@Public 接口走到这里时 request.user 为空——此类接口一律
 * 不标 @RequirePermission，靠「未标注即放行」的顺序保证兼容。
 *
 * 【易错】permissions 在登录时由 buildAuthUser 计算并入 JWT 载荷上下文，
 * 管理端改完权限对存量 token **即时生效**（每请求重算），无需等 token 过期。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) {
      // 理论上 JwtAuthGuard 已保证 user 存在；此处兜底 @Public + @RequirePermission 的错误组合
      throw new ForbiddenException('权限不足');
    }

    if (user.roles.some((role) => (ADMIN_ROLES as readonly string[]).includes(role))) {
      return true;
    }

    const owned = new Set(user.permissions ?? []);
    const ok = required.some((p) => owned.has(p));
    if (!ok) {
      throw new ForbiddenException('权限不足');
    }
    return true;
  }
}
