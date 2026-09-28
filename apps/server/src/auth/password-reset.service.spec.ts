import { describe, expect, it } from 'vitest';
import {
  PasswordResetService,
  RESET_CODE_COOLDOWN_SECONDS,
  RESET_CODE_TTL_SECONDS,
} from './password-reset.service.js';

/**
 * 密码重置验证码单测（纯 fake Redis）
 *
 * 覆盖语义：
 * - key 归一：邮箱大小写不敏感
 * - TTL 反推冷却：剩余 TTL > TTL-冷却 视为冷却中
 * - 一次性：delete 后 verify 失败
 * - fail-closed：Redis 不可用抛 503
 */

function fakeRedis(opts: { available?: boolean; ttl?: number } = {}) {
  const data = new Map<string, string>();
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
    set: async (k: string, v: string) => void data.set(k, v),
    del: async (...ks: string[]) => {
      for (const k of ks) data.delete(k);
    },
    ttl: async () => opts.ttl ?? -1,
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
    // 刚发：ttl=600 > 540 → 冷却中
    const cooling = new PasswordResetService(
      fakeRedis({ ttl: RESET_CODE_TTL_SECONDS }),
    );
    expect(await cooling.getTtl('a@b.com')).toBeGreaterThan(
      RESET_CODE_TTL_SECONDS - RESET_CODE_COOLDOWN_SECONDS,
    );

    // 过了冷却期：ttl=500 ≤ 540 → 可重发
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
