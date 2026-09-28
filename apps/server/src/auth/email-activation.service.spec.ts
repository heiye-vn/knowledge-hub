import { describe, expect, it } from 'vitest';
import { EmailActivationService } from './email-activation.service.js';

/**
 * 邮箱激活 token 单测（纯 fake Redis，不依赖真实连接）
 *
 * 覆盖语义：
 * - 双键互指：同用户重发时旧 token 作废
 * - 一次性消费：consumeToken 成功后再次消费返回 null
 * - fail-closed：Redis 不可用时 assertAvailable 抛 503
 */

type FakeRedis = {
  data: Map<string, { value: string; ttl: number }>;
  available: boolean;
};

function fakeRedis(available = true): FakeRedis & {
  get(k: string): Promise<string | null>;
  set(k: string, v: string, ttl?: number): Promise<void>;
  del(...ks: string[]): Promise<void>;
  isAvailable(): boolean;
  assertAvailable(): void;
} {
  const state: FakeRedis = { data: new Map(), available };
  return {
    data: state.data,
    available,
    isAvailable: () => state.available,
    assertAvailable: () => {
      if (!state.available) {
        // 与 RedisService.assertAvailable 行为对齐：抛 503 类错误
        const err = new Error('服务暂时不可用，请稍后再试');
        err.name = 'ServiceUnavailableException';
        throw err;
      }
    },
    get: async (k: string) => state.data.get(k)?.value ?? null,
    set: async (k: string, v: string, ttl?: number) => {
      state.data.set(k, { value: v, ttl: ttl ?? -1 });
    },
    del: async (...ks: string[]) => {
      for (const k of ks) state.data.delete(k);
    },
  } as never;
}

describe('EmailActivationService', () => {
  it('创建 token：写入双键（token→userId、userId→token）', async () => {
    const redis = fakeRedis();
    const svc = new EmailActivationService(redis as never);

    const token = await svc.createToken('u1');

    expect(await redis.get(`kh_auth:activate:token:${token}`)).toBe('u1');
    expect(await redis.get('kh_auth:activate:user:u1')).toBe(token);
  });

  it('同用户重发：旧 token 被作废，只有最新 token 可消费', async () => {
    const redis = fakeRedis();
    const svc = new EmailActivationService(redis as never);

    const oldToken = await svc.createToken('u1');
    const newToken = await svc.createToken('u1');

    expect(await svc.consumeToken(oldToken)).toBeNull();
    expect(await svc.consumeToken(newToken)).toBe('u1');
  });

  it('一次性消费：成功后两个键都删除，再次消费返回 null', async () => {
    const redis = fakeRedis();
    const svc = new EmailActivationService(redis as never);

    const token = await svc.createToken('u1');
    expect(await svc.consumeToken(token)).toBe('u1');

    expect(await svc.consumeToken(token)).toBeNull();
    expect(await redis.get('kh_auth:activate:user:u1')).toBeNull();
  });

  it('deleteByToken：清理 token 键与对应 user 键（发信失败回滚）', async () => {
    const redis = fakeRedis();
    const svc = new EmailActivationService(redis as never);

    const token = await svc.createToken('u1');
    await svc.deleteByToken(token);

    expect(await redis.get(`kh_auth:activate:token:${token}`)).toBeNull();
    expect(await redis.get('kh_auth:activate:user:u1')).toBeNull();
  });

  it('Redis 不可用（fail-closed）：createToken 直接抛异常', async () => {
    const redis = fakeRedis(false);
    const svc = new EmailActivationService(redis as never);

    await expect(svc.createToken('u1')).rejects.toThrow('服务暂时不可用');
    await expect(svc.consumeToken('any')).rejects.toThrow('服务暂时不可用');
  });

  it('createToken 生成的 token 为 64 位 hex（32 字节随机数）', async () => {
    const redis = fakeRedis();
    const svc = new EmailActivationService(redis as never);

    const token = await svc.createToken('u1');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * 已知竞态【易错】：createToken 的「读旧 token → 删 → 写新」不是原子的，
   * 并发重发可能出现短暂双有效 token（get-then-set 竞态，需 Lua 才能保证互斥）。
   * 实际不可达：触发点是注册，同一用户并发注册会被用户名唯一索引挡住，
   * 且无重发激活邮件的入口。如需加固，用 Lua 脚本把删旧+写新合成单命令。
   */
});
