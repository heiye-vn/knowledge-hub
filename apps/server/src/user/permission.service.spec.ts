import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PermissionService } from './permission.service.js';
import { PERMISSION_WILDCARD } from '../common/constants/permissions.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 权限服务单测（fake 仓储，不连库）
 *
 * 覆盖三处优化/防护：
 * 1. 保留权限码 '*' 不能被业务权限占用（create / update 均拒绝）
 * 2. 树构造按 parent_id 分组，多级结构正确
 * 3. 传入 knownRoleCodes 时不再重复查角色（登录链路每请求省一条 SQL）
 */

/** 构造可链式调用的 QueryBuilder fake，getRawMany 返回给定结果 */
function fakeQb(result: unknown[]) {
  const b: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'where', 'andWhere', 'select']) {
    b[m] = () => b;
  }
  b.getRawMany = async () => result;
  return b;
}

function makeService(over: {
  permRepo?: Record<string, unknown>;
  userPermRepo?: Record<string, unknown>;
  userRoleRepo?: Record<string, unknown>;
}) {
  const noop = { find: async () => [], count: async () => 0 };
  return new PermissionService(
    (over.permRepo ?? { ...noop, create: (d: unknown) => d, save: async (d: unknown) => d }) as never,
    { delete: async () => undefined, insert: async () => undefined } as never,
    (over.userPermRepo ?? { find: async () => [] }) as never,
    (over.userRoleRepo ?? { find: async () => [] }) as never,
    { findOne: async () => ({ id: 'r1' }) } as never,
    { transaction: async (fn: (tx: never) => unknown) => fn({} as never) } as never,
  );
}

describe('PermissionService 保留权限码', () => {
  it(`create 拒绝保留码 '${PERMISSION_WILDCARD}'`, async () => {
    const svc = makeService({});
    await expect(
      svc.create({
        permissionName: '通配',
        permissionCode: PERMISSION_WILDCARD,
        permissionType: 2,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it(`update 拒绝把编码改成 '${PERMISSION_WILDCARD}'`, async () => {
    const svc = makeService({
      permRepo: {
        findOne: async () => ({
          id: 'p1',
          permissionCode: 'document:list',
        }),
        create: (d: unknown) => d,
        save: async (d: unknown) => d,
        count: async () => 0,
        find: async () => [],
      },
    });
    await expect(
      svc.update('p1', { permissionCode: PERMISSION_WILDCARD }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('PermissionService 树构造', () => {
  it('按 parent_id 分组，多级树结构正确', async () => {
    const perms = [
      { id: '1', parentId: '0', permissionCode: 'system' },
      { id: '2', parentId: '1', permissionCode: 'system:user' },
      { id: '3', parentId: '2', permissionCode: 'system:user:add' },
      { id: '4', parentId: '0', permissionCode: 'dashboard' },
    ];
    const svc = makeService({
      permRepo: {
        find: async () => perms,
        count: async () => 0,
        create: (d: unknown) => d,
        save: async (d: unknown) => d,
      },
    });
    const tree = (await svc.getTree()) as Array<
      Record<string, unknown> & { children?: unknown[] }
    >;
    expect(tree.map((n) => n.permissionCode)).toEqual(['system', 'dashboard']);
    expect(tree[0].children).toHaveLength(1);
    const lvl2 = tree[0].children as Array<
      Record<string, unknown> & { children?: unknown[] }
    >;
    expect(lvl2[0].permissionCode).toBe('system:user');
    expect(lvl2[0].children).toHaveLength(1);
    const lvl3 = lvl2[0].children as Array<Record<string, unknown>>;
    expect(lvl3[0].permissionCode).toBe('system:user:add');
  });
});

describe('PermissionService 权限码合并', () => {
  it('传入 knownRoleCodes 时不再重复查角色（省一条 SQL）', async () => {
    let userRoleQbCount = 0;
    const userRoleRepo = {
      find: async () => [],
      createQueryBuilder: () => {
        userRoleQbCount += 1;
        return fakeQb([{ code: 'document:list' }]);
      },
    };
    const svc = makeService({
      permRepo: { find: async () => [], count: async () => 0, create: (d: unknown) => d, save: async (d: unknown) => d },
      userPermRepo: {
        find: async () => [],
        createQueryBuilder: () => fakeQb([{ code: 'document:create' }]),
      },
      userRoleRepo,
    });

    // 不传角色：viaRole 一次 + roleCodes 一次 = 2 次
    await svc.getUserPermissionCodes('u1');
    expect(userRoleQbCount).toBe(2);

    // 传入已算好的角色：只剩 viaRole 一次
    userRoleQbCount = 0;
    const codes = await svc.getUserPermissionCodes('u1', [RoleCode.USER]);
    expect(userRoleQbCount).toBe(1);
    expect(codes).toContain('document:list');
    expect(codes).toContain('document:create');
  });

  it('管理员追加通配符与常量池', async () => {
    const svc = makeService({
      permRepo: { find: async () => [], count: async () => 0, create: (d: unknown) => d, save: async (d: unknown) => d },
      userPermRepo: {
        find: async () => [],
        createQueryBuilder: () => fakeQb([]),
      },
      userRoleRepo: {
        find: async () => [],
        createQueryBuilder: () => fakeQb([]),
      },
    });
    const codes = await svc.getUserPermissionCodes('admin', [RoleCode.ADMIN]);
    expect(codes).toContain(PERMISSION_WILDCARD);
    expect(codes).toContain('system:user');
  });
});
