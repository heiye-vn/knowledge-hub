import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { RedisService } from '../redis/redis.service.js';

/** Redis fake：内存 Map + 可断言调用；fail=true 时模拟连接故障 */
function makeRedis(fail = false) {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => {
      if (fail) throw new Error('redis down');
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, _ttl?: number) => {
      if (fail) throw new Error('redis down');
      store.set(key, value);
    }),
    del: vi.fn(async (...keys: string[]) => {
      if (fail) throw new Error('redis down');
      keys.forEach((key) => store.delete(key));
    }),
  };
}

function makeConfig(values: Record<string, number> = {}) {
  return {
    get: (key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
  } as unknown as ConfigService;
}

function makeService(
  redis: ReturnType<typeof makeRedis>,
  values: Record<string, number> = {},
) {
  return new ChatShortMemoryService(
    makeConfig(values),
    redis as unknown as RedisService,
  );
}

describe('ChatShortMemoryService（fake Redis）', () => {
  it('save 后 tryLoad 能还原 human / assistant 消息', async () => {
    const redis = makeRedis();
    const service = makeService(redis);

    await service.save('1001', '8001', [
      new HumanMessage('问'),
      new AIMessage('答'),
    ]);
    const loaded = await service.tryLoad('1001', '8001');
    expect(loaded).toHaveLength(2);
    expect(HumanMessage.isInstance(loaded![0])).toBe(true);
    expect(AIMessage.isInstance(loaded![1])).toBe(true);
    // TTL 按配置传入（默认 86400）
    expect(redis.set).toHaveBeenCalledWith(
      'kh:chat:1001:8001:messages',
      expect.any(String),
      86400,
    );
  });

  it('save 过滤系统消息并截断到窗口容量', async () => {
    const redis = makeRedis();
    const service = makeService(redis, { CHAT_SHORT_MEMORY_MAX_MESSAGES: 3 });

    await service.save('1001', '8001', [
      new HumanMessage('一'),
      new SystemMessage('系统消息'),
      new AIMessage('二'),
      new HumanMessage('三'),
      new AIMessage('四'),
    ]);
    const loaded = await service.tryLoad('1001', '8001');
    expect(loaded).toHaveLength(3);
    expect(loaded!.map((m) => m.content)).toEqual(['二', '三', '四']);
  });

  it('appendTurn 在历史后追加本轮问答', async () => {
    const redis = makeRedis();
    const service = makeService(redis);

    await service.appendTurn(
      '1001',
      '8001',
      [new HumanMessage('旧问'), new AIMessage('旧答')],
      '新问',
      '新答',
    );
    const loaded = await service.tryLoad('1001', '8001');
    expect(loaded!.map((m) => m.content)).toEqual([
      '旧问',
      '旧答',
      '新问',
      '新答',
    ]);
  });

  it('key 不存在时返回 null（调用方回源 Postgres）', async () => {
    const service = makeService(makeRedis());
    expect(await service.tryLoad('1001', '8001')).toBeNull();
  });

  it('Redis 故障时读写都不抛错：tryLoad 返回 null、save 静默降级', async () => {
    const redis = makeRedis(true);
    const service = makeService(redis);

    await expect(
      service.save('1001', '8001', [new HumanMessage('问')]),
    ).resolves.toBeUndefined();
    expect(await service.tryLoad('1001', '8001')).toBeNull();
    await expect(service.clear('1001', '8001')).resolves.toBeUndefined();
  });

  it('clear 按用户 + 会话删除对应 key', async () => {
    const redis = makeRedis();
    const service = makeService(redis);
    await service.save('1001', '8001', [new HumanMessage('问')]);

    await service.clear('1001', '8001');
    expect(await service.tryLoad('1001', '8001')).toBeNull();
    expect(redis.del).toHaveBeenCalledWith('kh:chat:1001:8001:messages');
  });
});
