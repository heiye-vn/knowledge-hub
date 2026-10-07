import { describe, expect, it, vi } from 'vitest';
import { UserService } from './user.service.js';

/**
 * UserService.purgeInactiveAccounts 单测（TODO §8.4）
 *
 * 只验证「清理范围」这一件事：必须限定 email_verified=0 且未删除，
 * 且 cutoff 由入参天数推算——范围写宽了会误伤正常账号。
 */

interface FakeQb {
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  andWhere: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function fakeQb(affected: number): FakeQb {
  const qb: FakeQb = {
    update: vi.fn(() => qb),
    set: vi.fn(() => qb),
    where: vi.fn(() => qb),
    andWhere: vi.fn(() => qb),
    execute: vi.fn(async () => ({ affected })),
  };
  return qb;
}

function makeService(affected: number) {
  const qb = fakeQb(affected);
  const userRepo = { createQueryBuilder: vi.fn(() => qb) };
  const service = new UserService(
    userRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, qb };
}

describe('UserService.purgeInactiveAccounts', () => {
  it('软删范围内的账号，并返回清理数量', async () => {
    const { service } = makeService(3);
    const result = await service.purgeInactiveAccounts(7);
    expect(result.purged).toBe(3);
    expect(result.olderThanDays).toBe(7);
  });

  it('只清未激活 + 未删除的账号，cutoff 按天数推算', async () => {
    const { service, qb } = makeService(0);
    const before = Date.now();
    await service.purgeInactiveAccounts(7);

    expect(qb.where).toHaveBeenCalledWith('email_verified = 0');
    expect(qb.andWhere).toHaveBeenCalledWith('deleted = false');

    const [, params] = qb.andWhere.mock.calls[1];
    expect(params.cutoff).toBeInstanceOf(Date);
    const elapsedDays = (before - params.cutoff.getTime()) / 86_400_000;
    expect(elapsedDays).toBeCloseTo(7, 1);
  });

  it('天数非法（0 / 负数 / 小数）时兜底为至少 1 天', async () => {
    const { service } = makeService(0);
    expect((await service.purgeInactiveAccounts(0)).olderThanDays).toBe(1);
    expect((await service.purgeInactiveAccounts(-5)).olderThanDays).toBe(1);
    expect((await service.purgeInactiveAccounts(2.7)).olderThanDays).toBe(2);
  });

  it('不传天数时用默认 7 天', async () => {
    const { service } = makeService(0);
    expect((await service.purgeInactiveAccounts()).olderThanDays).toBe(7);
  });
});
