import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { PermissionsGuard } from './permissions.guard.js';
import { PERMISSIONS_KEY } from './decorators/require-permission.decorator.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from './auth-user.interface.js';

/**
 * 权限码守卫单测（纯函数，不启 Nest 上下文）
 *
 * 覆盖五条判定路径：
 * 1. 接口未标 @RequirePermission → 放行
 * 2. 管理员 → 短路放行（哪怕权限集合为空）
 * 3. 普通用户命中权限码之一 → 放行
 * 4. 普通用户不命中 → 403
 * 5. 多权限码为「或」语义（命中其一即可）
 */

function makeContext(required: string[] | undefined, user: AuthUser | undefined) {
  const handler = () => undefined;
  const cls = class TestController {};
  if (required) {
    Reflect.defineMetadata(PERMISSIONS_KEY, required, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

function makeUser(roles: string[], permissions: string[]): AuthUser {
  return {
    userId: '1',
    username: 'u',
    roles,
    permissions,
  };
}

describe('PermissionsGuard', () => {
  const guard = new PermissionsGuard(new Reflector());

  it('接口未标 @RequirePermission → 放行', () => {
    const ctx = makeContext(undefined, makeUser([], []));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('ROLE_ADMIN 短路放行（权限集合为空也放行）', () => {
    const ctx = makeContext(['system:user'], makeUser([RoleCode.ADMIN], []));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('普通用户命中权限码 → 放行', () => {
    const ctx = makeContext(
      ['system:user'],
      makeUser([RoleCode.USER], ['system:user']),
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('普通用户缺少权限码 → 403', () => {
    const ctx = makeContext(
      ['system:user'],
      makeUser([RoleCode.USER], ['document:list']),
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('多权限码为「或」语义：命中其一即放行', () => {
    const ctx = makeContext(
      ['system:user', 'system:role'],
      makeUser([RoleCode.USER], ['system:role']),
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('request.user 为空且接口标了权限码 → 403（兜底 @Public 误搭配）', () => {
    const ctx = makeContext(['system:team'], undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
