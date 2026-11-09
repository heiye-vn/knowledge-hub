import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { ChatMemoryMirrorService } from './chat-memory-mirror.service.js';
import { AiMemoryEntity } from './entities/ai-memory.entity.js';

function makeConfig(enabled: boolean) {
  return {
    get: (key: string, fallback?: unknown) =>
      key === 'CHAT_MEMORY_MIRROR_ENABLED'
        ? enabled
          ? 'true'
          : 'false'
        : fallback,
  } as unknown as ConfigService;
}

function makeEm() {
  return {
    findOne: vi.fn(async () => null as unknown),
    create: vi.fn((_entity: unknown, data: unknown) => data),
    save: vi.fn(async (data: unknown) => data),
    update: vi.fn(async () => ({ affected: 3 })),
    delete: vi.fn(async () => ({ affected: 1 })),
    count: vi.fn(async () => 2),
  };
}

function makeService(em: ReturnType<typeof makeEm>, enabled = true) {
  return new ChatMemoryMirrorService(
    makeConfig(enabled),
    em as unknown as EntityManager,
  );
}

describe('ChatMemoryMirrorService（mock EntityManager）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('开关关闭时全部 no-op，不产生任何数据库调用', async () => {
    const em = makeEm();
    const service = makeService(em, false);
    expect(service.active).toBe(false);

    await service.upsert('1001', null, 'user', [
      { id: 'm1', memory: '偏好简洁' },
    ]);
    await service.removeSession('1001', '8001');
    await service.removeAll('1001');
    await service.removeByMemoryId('m1');
    expect(await service.archiveStale('1001', 30)).toBe(0);
    expect(await service.stats('1001')).toEqual({
      user: 0,
      session: 0,
      archived: 0,
    });

    expect(em.findOne).not.toHaveBeenCalled();
    expect(em.save).not.toHaveBeenCalled();
    expect(em.delete).not.toHaveBeenCalled();
    expect(em.update).not.toHaveBeenCalled();
    expect(em.count).not.toHaveBeenCalled();
  });

  it('新条目 upsert 落库：layer / sessionId / 来源时间齐全', async () => {
    const em = makeEm();
    const service = makeService(em);

    await service.upsert('1001', '8001', 'session', [
      {
        id: 'm1',
        memory: '本轮只看住宿标准',
        createdAt: new Date('2026-01-02T03:04:05Z'),
      },
    ]);

    expect(em.save).toHaveBeenCalledTimes(1);
    expect(em.save.mock.calls[0][0]).toMatchObject({
      memoryId: 'm1',
      userId: '1001',
      sessionId: '8001',
      layer: 'session',
      content: '本轮只看住宿标准',
      status: 'active',
      sourceCreatedAt: new Date('2026-01-02T03:04:05Z'),
    });
  });

  it('已存在条目按 memory_id 更新正文并手动刷新 updatedAt', async () => {
    const em = makeEm();
    em.findOne.mockResolvedValue({ id: '9001', memoryId: 'm1' });
    const service = makeService(em);

    await service.upsert('1001', null, 'user', [
      { id: 'm1', memory: '偏好简洁' },
    ]);

    expect(em.save).not.toHaveBeenCalled();
    expect(em.update).toHaveBeenCalledWith(
      AiMemoryEntity,
      { id: '9001' },
      expect.objectContaining({
        content: '偏好简洁',
        status: 'active',
        // em.update 不走实体生命周期，必须显式带时间
        updatedAt: expect.any(Date),
      }),
    );
  });

  it('正文为空的条目跳过，避免写入空记忆', async () => {
    const em = makeEm();
    const service = makeService(em);
    await service.upsert('1001', null, 'user', [{ id: 'm1', memory: '   ' }]);
    expect(em.save).not.toHaveBeenCalled();
    expect(em.update).not.toHaveBeenCalled();
  });

  it('删除路径分别按会话 / 全量 / 单条清理镜像', async () => {
    const em = makeEm();
    const service = makeService(em);

    await service.removeSession('1001', '8001');
    expect(em.delete).toHaveBeenLastCalledWith(AiMemoryEntity, {
      userId: '1001',
      sessionId: '8001',
    });

    await service.removeAll('1001');
    expect(em.delete).toHaveBeenLastCalledWith(AiMemoryEntity, {
      userId: '1001',
    });

    await service.removeByMemoryId('m1');
    expect(em.delete).toHaveBeenLastCalledWith(AiMemoryEntity, {
      memoryId: 'm1',
    });
  });

  it('archiveStale 只标记超期 active 条目并返回影响行数', async () => {
    const em = makeEm();
    em.update.mockResolvedValue({ affected: 4 });
    const service = makeService(em);

    expect(await service.archiveStale('1001', 30)).toBe(4);
    const [, criteria, patch] = em.update.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(criteria).toMatchObject({ userId: '1001', status: 'active' });
    expect(criteria.updatedAt).toBeDefined();
    expect(patch).toMatchObject({ status: 'archived' });
    expect(patch.updatedAt).toBeInstanceOf(Date);
  });

  it('archiveStale 天数非正时不动数据库', async () => {
    const em = makeEm();
    const service = makeService(em);
    expect(await service.archiveStale('1001', 0)).toBe(0);
    expect(em.update).not.toHaveBeenCalled();
  });

  it('stats 分别统计 user / session 活跃数与归档数', async () => {
    const em = makeEm();
    em.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);
    const service = makeService(em);

    expect(await service.stats('1001')).toEqual({
      user: 3,
      session: 5,
      archived: 2,
    });
    expect(em.count).toHaveBeenCalledTimes(3);
  });
});
