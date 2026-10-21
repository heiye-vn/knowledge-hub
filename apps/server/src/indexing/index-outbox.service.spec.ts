import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import { IndexOutboxService } from './index-outbox.service.js';
import type { IndexOutboxEntity } from './entities/index-outbox.entity.js';

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function makeEm() {
  return {
    query: vi.fn(),
    find: vi.fn(async () => [] as IndexOutboxEntity[]),
    update: vi.fn(async () => undefined),
  };
}

function makeService(values: Record<string, string> = {}) {
  const em = makeEm();
  const service = new IndexOutboxService(em as unknown as EntityManager, config(values));
  return { service, em };
}

function task(overrides: Partial<IndexOutboxEntity> = {}): IndexOutboxEntity {
  return {
    id: '1',
    documentId: '1001',
    target: 'rag',
    operation: 'upsert',
    status: 'pending',
    attempts: 0,
    lastError: null,
    nextRunAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('IndexOutboxService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('禁用时 record 直接返回 null，不写库', async () => {
    const { service, em } = makeService({ INDEX_OUTBOX_ENABLED: 'false' });

    await expect(
      service.record({
        documentId: '1001',
        target: 'rag',
        operation: 'upsert',
        error: new Error('boom'),
      }),
    ).resolves.toBeNull();
    expect(em.query).not.toHaveBeenCalled();
  });

  it('record 用 ON CONFLICT 合并未完成任务并返回 id', async () => {
    const { service, em } = makeService();
    em.query.mockResolvedValue([{ id: '99' }]);

    const id = await service.record({
      documentId: '1001',
      target: 'search',
      operation: 'delete',
      error: new Error('bulk failed'),
    });

    expect(id).toBe('99');
    const [sql, params] = em.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (document_id, target, operation)');
    expect(sql).toContain("WHERE status IN ('pending', 'retry')");
    expect(params[1]).toBe('1001');
    expect(params[2]).toBe('search');
    expect(params[3]).toBe('delete');
    expect(params[4]).toBe('bulk failed');
  });

  it('record 写库异常只告警，不影响调用方', async () => {
    const { service, em } = makeService();
    em.query.mockRejectedValue(new Error('pg down'));

    await expect(
      service.record({
        documentId: '1001',
        target: 'kg',
        operation: 'upsert',
        error: new Error('redis down'),
      }),
    ).resolves.toBeNull();
  });

  it('markFailed 未达上限时置 retry 并计算退避时间', async () => {
    const { service, em } = makeService({
      INDEX_OUTBOX_MAX_ATTEMPTS: '8',
      INDEX_OUTBOX_BACKOFF_MS: '1000',
    });

    await service.markFailed(task({ attempts: 1 }), new Error('still down'));

    const payload = (em.update.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe('retry');
    expect(payload.attempts).toBe(2);
    // 第二次失败：1000 * 2^(2-1) = 2000ms
    const delay = (payload.nextRunAt as Date).getTime() - Date.now();
    expect(delay).toBeGreaterThan(1_500);
    expect(delay).toBeLessThanOrEqual(2_100);
  });

  it('markFailed 达到上限时置 dead', async () => {
    const { service, em } = makeService({ INDEX_OUTBOX_MAX_ATTEMPTS: '3' });

    await service.markFailed(task({ attempts: 2 }), new Error('final'));

    const payload = (em.update.mock.calls[0] as unknown[])[2] as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe('dead');
    expect(payload.attempts).toBe(3);
  });

  it('stats 按状态聚合计数', async () => {
    const { service, em } = makeService();
    em.query.mockResolvedValue([
      { status: 'pending', count: 2 },
      { status: 'dead', count: 1 },
    ]);

    await expect(service.stats()).resolves.toEqual({ pending: 2, dead: 1 });
  });
});
