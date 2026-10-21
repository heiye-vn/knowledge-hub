import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { RedisService } from '../redis/redis.service.js';
import type { RateLimitRule } from './rate-limit.decorator.js';
import { AuthRateLimitGuard } from './rate-limit.guard.js';

function makeContext(body: Record<string, unknown> = {}, ip = '10.0.0.1') {
  const response = { setHeader: vi.fn() };
  const request = {
    ip,
    body,
    socket: { remoteAddress: ip },
    route: { path: '/auth/login' },
    path: '/auth/login',
  };
  return {
    context: {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext,
    response,
    request,
  };
}

function makeGuard(
  rules: RateLimitRule[] | undefined,
  behavior: {
    available?: boolean;
    counts?: number[];
    fail?: boolean;
  } = {},
) {
  const reflector = {
    getAllAndOverride: vi.fn(() => rules),
  };
  const counts = [...(behavior.counts ?? [1])];
  const redis = {
    isAvailable: () => behavior.available ?? true,
    incrementWithTtl: vi.fn(async () => {
      if (behavior.fail) throw new Error('redis error');
      return counts.length > 1 ? (counts.shift() as number) : counts[0];
    }),
    ttl: vi.fn(async () => 42),
  };
  const guard = new AuthRateLimitGuard(
    reflector as unknown as Reflector,
    redis as unknown as RedisService,
  );
  return { guard, redis, reflector };
}

describe('AuthRateLimitGuard', () => {
  it('未声明规则的端点直接放行，不触碰 Redis', async () => {
    const { guard, redis } = makeGuard(undefined);
    const { context } = makeContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redis.incrementWithTtl).not.toHaveBeenCalled();
  });

  it('未超限时放行', async () => {
    const { guard } = makeGuard([{ dimension: 'ip', limit: 5, windowSeconds: 60 }], {
      counts: [5],
    });
    const { context } = makeContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('超限抛 429 并写 Retry-After', async () => {
    const { guard } = makeGuard(
      [{ dimension: 'ip', limit: 5, windowSeconds: 60 }],
      { counts: [6] },
    );
    const { context, response } = makeContext();

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 429,
    });
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });

  it('IP 与账号两个维度分别计数（互不覆盖）', async () => {
    const { guard, redis } = makeGuard(
      [
        { dimension: 'ip', limit: 30, windowSeconds: 60 },
        { dimension: 'account', limit: 10, windowSeconds: 60 },
      ],
      { counts: [1] },
    );
    const { context } = makeContext({ username: 'Admin' });

    await guard.canActivate(context);

    const keys = redis.incrementWithTtl.mock.calls.map(
      (call) => (call as unknown[])[0] as string,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain(':ip:');
    expect(keys[1]).toContain(':account:admin');
  });

  it('账号维度取不到值时跳过该规则', async () => {
    const { guard, redis } = makeGuard([
      { dimension: 'account', limit: 10, windowSeconds: 60 },
    ]);
    const { context } = makeContext({});

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(redis.incrementWithTtl).not.toHaveBeenCalled();
  });

  it('Redis 不可用时 fail-open（不锁死登录入口）', async () => {
    const { guard } = makeGuard(
      [{ dimension: 'ip', limit: 1, windowSeconds: 60 }],
      { available: false },
    );
    const { context } = makeContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('计数阶段 Redis 报错同样降级放行', async () => {
    const { guard } = makeGuard(
      [{ dimension: 'ip', limit: 1, windowSeconds: 60 }],
      { fail: true },
    );
    const { context } = makeContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
