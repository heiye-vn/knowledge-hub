import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from './auth-user.interface.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import type { RoleCodeValue } from '../common/constants/roles.js';

/**
 * 角色守卫（RBAC 简化版），在 JwtAuthGuard 之后执行（同为 APP_GUARD，按注册顺序）。
 *
 * 规则：接口未标 @Roles → 放行（仅要求已登录）；
 * 标了 → request.user.roles 须命中其一，否则 403。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<RoleCodeValue[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user?.roles?.length) {
      throw new ForbiddenException('权限不足');
    }

    const ok = requiredRoles.some((role) => user.roles.includes(role));
    if (!ok) {
      throw new ForbiddenException('权限不足');
    }
    return true;
  }
}
