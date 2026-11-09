import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { RedisService } from '../redis/redis.service.js';

const KEY = 'kh:chat:1001:8001:v2:messages';

/** Redis List fake：内存 Map<string, string[]>；fail=true 时模拟连接故障 */
function makeRedis(fail = false) {
  const store = new Map<string, string[]>();
  return {
    store,
    listRange: vi.fn(async (key: string) => {
      if (fail) throw new Error('redis down');
      return [...(store.get(key) ?? [])];
    }),
    appendListWindow: vi.fn(
      async (key: string, values: string[], maxLen: number, _ttl: number) => {
        if (fail) throw new Error('redis down');
        const list = [...(store.get(key) ?? []), ...values].slice(-maxLen);
        store.set(key, list);
        return list.length;
      },
    ),
    replaceListWindow: vi.fn(
      async (key: string, values: string[], maxLen: number, _ttl: number) => {
        if (fail) throw new Error('redis down');
        if (!values.length) {
          store.delete(key);
          return 0;
        }
        const list = values.slice(-maxLen);
        store.set(key, list);
        return list.length;
      },
    ),
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

describe('ChatShortMemoryService（fake Redis List）', () => {
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
    // 整体覆盖写走 replaceListWindow，key 已升到 v2
    expect(redis.replaceListWindow).toHaveBeenCalledWith(
      KEY,
      expect.any(Array),
      20,
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

  it('appendTurn 只追加本轮两条，不读取窗口（无共享快照覆盖）', async () => {
    const redis = makeRedis();
    const service = makeService(redis);

    await service.appendTurn('1001', '8001', '新问', '新答');
    expect(redis.listRange).not.toHaveBeenCalled();
    expect(redis.replaceListWindow).not.toHaveBeenCalled();
    expect(redis.appendListWindow).toHaveBeenCalledWith(
      KEY,
      expect.any(Array),
      20,
      86400,
    );
  });

  it('连续 5 轮追加后窗口保留全部轮次（覆盖写会丢中间轮次）', async () => {
    const redis = makeRedis();
    const service = makeService(redis);

    for (let index = 1; index <= 5; index += 1) {
      await service.appendTurn('1001', '8001', `问${index}`, `答${index}`);
    }
    const loaded = await service.tryLoad('1001', '8001');
    expect(loaded).toHaveLength(10);
    expect(loaded!.map((m) => m.content)).toEqual([
      '问1',
      '答1',
      '问2',
      '答2',
      '问3',
      '答3',
      '问4',
      '答4',
      '问5',
      '答5',
    ]);
  });

  it('条数未超但 token 超预算时，读取路径收敛并重写窗口', async () => {
    const redis = makeRedis();
    const writer = makeService(redis, {
      CHAT_SHORT_MEMORY_MAX_ESTIMATED_TOKENS: 1000,
    });
    // 4 轮问答，每条 10 个汉字 = 30 字节，总计 120 字节
    await writer.appendTurn('1001', '8001', '一'.repeat(10), '二'.repeat(10));
    await writer.appendTurn('1001', '8001', '三'.repeat(10), '四'.repeat(10));

    const reader = makeService(redis, {
      CHAT_SHORT_MEMORY_MAX_ESTIMATED_TOKENS: 70,
    });
    const loaded = await reader.tryLoad('1001', '8001');
    // 70 字节只能容纳最近两条
    expect(loaded).toHaveLength(2);
    expect(loaded![1].content).toBe('四'.repeat(10));
    await vi.waitFor(() =>
      expect(redis.replaceListWindow).toHaveBeenCalled(),
    );
  });

  it('save 返回实际落库窗口，回填路径据此得到与 Redis 一致的历史', async () => {
    const redis = makeRedis();
    const service = makeService(redis, {
      CHAT_SHORT_MEMORY_MAX_ESTIMATED_TOKENS: 70,
    });

    const saved = await service.save('1001', '8001', [
      new HumanMessage('一'.repeat(10)),
      new AIMessage('二'.repeat(10)),
      new HumanMessage('三'.repeat(10)),
    ]);
    // 每条 30 字节，预算 70 → 只保留最近两条
    expect(saved).toHaveLength(2);
    const loaded = await service.tryLoad('1001', '8001');
    expect(loaded!.map((m) => m.content)).toEqual(saved.map((m) => m.content));
  });

  it('key 不存在或空 List 时返回 null（调用方回源 Postgres）', async () => {
    const service = makeService(makeRedis());
    expect(await service.tryLoad('1001', '8001')).toBeNull();
  });

  it('Redis 故障时读写都不抛错：tryLoad 返回 null、写入静默降级', async () => {
    const redis = makeRedis(true);
    const service = makeService(redis);

    await expect(
      service.save('1001', '8001', [new HumanMessage('问')]),
    ).resolves.toHaveLength(1);
    await expect(
      service.appendTurn('1001', '8001', '问', '答'),
    ).resolves.toBeUndefined();
    expect(await service.tryLoad('1001', '8001')).toBeNull();
    await expect(service.clear('1001', '8001')).resolves.toBeUndefined();
  });

  it('clear 按用户 + 会话删除对应 key', async () => {
    const redis = makeRedis();
    const service = makeService(redis);
    await service.appendTurn('1001', '8001', '问', '答');

    await service.clear('1001', '8001');
    expect(await service.tryLoad('1001', '8001')).toBeNull();
    expect(redis.del).toHaveBeenCalledWith(KEY);
  });
});
