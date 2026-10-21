import { describe, expect, it } from 'vitest';
import {
  PasswordResetService,
  RESET_CODE_COOLDOWN_SECONDS,
  RESET_CODE_TTL_SECONDS,
  RESET_LOCK_SECONDS,
  RESET_MAX_ATTEMPTS,
} from './password-reset.service.js';

/**
 * 密码重置验证码单测（纯 fake Redis）
 *
 * 覆盖语义：
 * - key 归一：邮箱大小写不敏感
 * - TTL 反推冷却：剩余 TTL > TTL-冷却 视为冷却中
 * - 一次性：用掉即删，delete 后 verify 失败
 * - 防爆破：连续错误达到上限销毁验证码并锁定，重新发码解锁
 * - fail-closed：Redis 不可用抛 503
 */

function fakeRedis(opts: { available?: boolean; ttl?: number } = {}) {
  const data = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    data,
    isAvailable: () => opts.available ?? true,
    assertAvailable: () => {
      if (opts.available === false) {
        const err = new Error('服务暂时不可用，请稍后再试');
        err.name = 'ServiceUnavailableException';
        throw err;
      }
    },
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string, ttl?: number) => {
      data.set(k, v);
      if (ttl != null) ttls.set(k, ttl);
    },
    del: async (...ks: string[]) => {
      for (const k of ks) {
        data.delete(k);
        ttls.delete(k);
      }
    },
    // 未显式写入 TTL 的键返回 -1（与 Redis 语义一致）
    ttl: async (k: string) => ttls.get(k) ?? opts.ttl ?? -1,
    incrementWithTtl: async (k: string, ttl: number) => {
      const next = Number(data.get(k) ?? 0) + 1;
      data.set(k, String(next));
      if (!ttls.has(k)) ttls.set(k, ttl);
      return next;
    },
  } as never;
}

describe('PasswordResetService', () => {
  it('邮箱大小写归一：同一邮箱不同写法落在同一 key', async () => {
    const redis = fakeRedis();
    const svc = new PasswordResetService(redis);

    await svc.set('Foo@Bar.com', '123456');
    expect(await svc.verify('foo@bar.com', '123456')).toBe(true);
    expect(await svc.verify('FOO@BAR.COM', '654321')).toBe(false);
  });

  it('冷却判定：TTL > TTL-冷却 → 冷却中；≤ → 可重发', async () => {
    const cooling = fakeRedis();
    const coolingSvc = new PasswordResetService(cooling);
    await coolingSvc.set('a@b.com', '123456');
    expect(await coolingSvc.getTtl('a@b.com')).toBeGreaterThan(
      RESET_CODE_TTL_SECONDS - RESET_CODE_COOLDOWN_SECONDS,
    );

    const expired = new PasswordResetService(
      fakeRedis({ ttl: RESET_CODE_TTL_SECONDS - RESET_CODE_COOLDOWN_SECONDS - 1 }),
    );
    expect(await expired.getTtl('a@b.com')).toBeLessThanOrEqual(
      RESET_CODE_TTL_SECONDS - RESET_CODE_COOLDOWN_SECONDS,
    );
  });

  it('delete 后验证码失效（一次性）', async () => {
    const redis = fakeRedis();
    const svc = new PasswordResetService(redis);

    await svc.set('a@b.com', '123456');
    expect(await svc.verify('a@b.com', '123456')).toBe(true);

    await svc.delete('a@b.com');
    expect(await svc.verify('a@b.com', '123456')).toBe(false);
  });

  it('连续错误达到上限：清验证码并锁定，正确码也进不来', async () => {
    const svc = new PasswordResetService(fakeRedis());
    await svc.set('a@b.com', '123456');

    for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) {
      await expect(svc.verify('a@b.com', '000000')).resolves.toBe(false);
    }

    expect(await svc.isLocked('a@b.com')).toBe(true);
    // 验证码已销毁，即使拿对了也失败
    expect(await svc.verify('a@b.com', '123456')).toBe(false);
  });

  it('未达上限时正确码仍可通过，并清空错误计数', async () => {
    const redis = fakeRedis();
    const svc = new PasswordResetService(redis);
    await svc.set('a@b.com', '123456');

    await svc.verify('a@b.com', '000000');
    await svc.verify('a@b.com', '000001');
    expect(await svc.verify('a@b.com', '123456')).toBe(true);

    // 命中后错误计数归零：再发一次码仍可失败 4 次而未被锁定
    await svc.set('a@b.com', '654321');
    expect(await svc.isLocked('a@b.com')).toBe(false);
  });

  it('重新发码清除锁定（合法用户可自救）', async () => {
    const svc = new PasswordResetService(fakeRedis());
    await svc.set('a@b.com', '123456');
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) {
      await svc.verify('a@b.com', '000000');
    }
    expect(await svc.isLocked('a@b.com')).toBe(true);

    await svc.set('a@b.com', '999999');

    expect(await svc.isLocked('a@b.com')).toBe(false);
    expect(await svc.verify('a@b.com', '999999')).toBe(true);
    expect(RESET_LOCK_SECONDS).toBe(600);
  });

  it('Redis 不可用（fail-closed）：verify / set 直接抛异常', async () => {
    const redis = fakeRedis({ available: false });
    const svc = new PasswordResetService(redis);

    await expect(svc.set('a@b.com', '123456')).rejects.toThrow(
      '服务暂时不可用',
    );
    await expect(svc.verify('a@b.com', '123456')).rejects.toThrow(
      '服务暂时不可用',
    );
  });
});
