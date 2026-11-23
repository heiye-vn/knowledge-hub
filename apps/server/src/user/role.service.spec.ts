import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RoleService } from './role.service.js';
import { RoleEntity } from './entities/role.entity.js';
import { RolePermissionEntity } from './entities/role-permission.entity.js';

function makeService(role: RoleEntity | null, boundUsers = 0) {
  const roleRepo = {
    findOne: vi.fn(async () => role),
    update: vi.fn(async () => ({ affected: 1 })),
  };
  const userRoleRepo = {
    count: vi.fn(async () => boundUsers),
  };
  const txDelete = vi.fn(async () => ({ affected: 1 }));
  const em = {
    transaction: vi.fn(async (cb: (tx: { delete: typeof txDelete }) => Promise<void>) =>
      cb({ delete: txDelete }),
    ),
  };
  const service = new RoleService(
    roleRepo as never,
    userRoleRepo as never,
    em as never,
  );
  return { service, roleRepo, userRoleRepo, txDelete };
}

describe('RoleService 预置保护与安全删除', () => {
  it('预置角色禁止禁用', async () => {
    const { service } = makeService({
      id: '1',
      roleName: '管理员',
      roleCode: 'ROLE_ADMIN',
      status: 1,
    });
    await expect(service.update('1', { status: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('预置角色禁止删除', async () => {
    const { service } = makeService({
      id: '2',
      roleName: '普通用户',
      roleCode: 'ROLE_USER',
      status: 1,
    });
    await expect(service.delete('2')).rejects.toThrow('系统预置角色不允许删除');
  });

  it('仍绑定用户的自定义角色拒绝删除并提示人数', async () => {
    const { service } = makeService(
      {
        id: '10',
        roleName: '编辑员',
        roleCode: 'ROLE_EDITOR',
        status: 1,
      },
      2,
    );
    await expect(service.delete('10')).rejects.toBeInstanceOf(ConflictException);
  });

  it('未被用户绑定的自定义角色在事务中级联清理权限后删除', async () => {
    const { service, txDelete } = makeService(
      {
        id: '11',
        roleName: '临时角色',
        roleCode: 'ROLE_TEMP',
        status: 1,
      },
      0,
    );
    await service.delete('11');
    expect(txDelete).toHaveBeenCalledWith(RolePermissionEntity, { roleId: '11' });
    expect(txDelete).toHaveBeenCalledWith(RoleEntity, { id: '11' });
  });
});
