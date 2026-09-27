import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { TaskStatusService } from './task-status.service.js';

/**
 * 任务状态查询单测（纯 fake，不依赖 Redis）
 *
 * 覆盖的是「查询语义」，不是 BullMQ 本身：
 * - jobId 全局唯一，两个队列各查一次，先命中先用
 * - 都查不到 → 404（taskId 有误或已被清理）
 * - 队列全部不可用 / 查询超时 → 503（绝不挂死请求）
 */

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function fakeJob(over: Partial<Record<keyof Job, unknown>> = {}): Job {
  return {
    id: 'task-1',
    queueName: 'kg.graph',
    data: { taskId: 'task-1', type: 'BUILD_ALL' },
    attemptsMade: 0,
    opts: { attempts: 3 },
    failedReason: null,
    returnvalue: null,
    timestamp: 1000,
    processedOn: null,
    finishedOn: null,
    getState: async () => 'waiting',
    ...over,
  } as unknown as Job;
}

type PublisherFake = {
  isAvailable(): boolean;
  findJob(jobId: string): Promise<Job | null>;
};

function fakePublisher(options: {
  available?: boolean;
  job?: Job | null;
  error?: Error;
  /** findJob 永不 resolve（模拟 Redis 断连后命令在离线队列里挂起） */
  hangs?: boolean;
}): PublisherFake {
  return {
    isAvailable: () => options.available ?? true,
    findJob: vi.fn(async () => {
      if (options.error) throw options.error;
      if (options.hangs) return new Promise<Job>(() => undefined);
      return options.job ?? null;
    }),
  };
}

function makeService(
  reindex: PublisherFake,
  kg: PublisherFake,
  config: Record<string, string> = {},
): TaskStatusService {
  return new TaskStatusService(
    reindex as never,
    kg as never,
    fakeConfig({ REDIS_CONNECT_TIMEOUT_MS: '50', ...config }),
  );
}

describe('TaskStatusService.getTaskStatus', () => {
  it('KG 队列命中：返回队列名、消息类型与状态', async () => {
    const job = fakeJob({ getState: async () => 'active', processedOn: 2000 });
    const service = makeService(fakePublisher({ job: null }), fakePublisher({ job }));

    const view = await service.getTaskStatus('task-1');
    expect(view.queue).toBe('kg.graph');
    expect(view.type).toBe('BUILD_ALL');
    expect(view.state).toBe('active');
    expect(view.maxAttempts).toBe(3);
    expect(view.startedAt).toBe(2000);
  });

  it('KG 队列未命中时回落到重建队列', async () => {
    const job = fakeJob({
      queueName: 'rag.reindex',
      data: { taskId: 'task-2', type: 'BY_DOC_IDS', documentIds: ['d1', 'd2'] },
    });
    const service = makeService(fakePublisher({ job }), fakePublisher({ job: null }));

    const view = await service.getTaskStatus('task-2');
    expect(view.queue).toBe('rag.reindex');
    expect(view.type).toBe('BY_DOC_IDS');
    expect(view.documentIds).toEqual(['d1', 'd2']);
  });

  it('两个队列都查不到 → 404（taskId 有误或已完成超出保留期）', async () => {
    const service = makeService(fakePublisher({}), fakePublisher({}));
    await expect(service.getTaskStatus('no-such-task')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('两个队列都不可用（Redis 禁用）→ 503，而不是误导性的 404', async () => {
    const service = makeService(
      fakePublisher({ available: false }),
      fakePublisher({ available: false }),
    );
    await expect(service.getTaskStatus('task-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('一队不可用另一队可用：跳过不可用侧，正常查询', async () => {
    const job = fakeJob();
    const service = makeService(
      fakePublisher({ available: false }),
      fakePublisher({ job }),
    );
    const view = await service.getTaskStatus('task-1');
    expect(view.queue).toBe('kg.graph');
  });

  it('查询挂死（Redis 断连离线缓存）→ 按超时抛 503，不挂死请求', async () => {
    const service = makeService(
      fakePublisher({ hangs: true }),
      fakePublisher({ hangs: true }),
    );
    await expect(service.getTaskStatus('task-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('failed 任务：暴露失败原因与已尝试次数', async () => {
    const job = fakeJob({
      getState: async () => 'failed',
      attemptsMade: 3,
      failedReason: 'embedding 超时',
      finishedOn: 5000,
    });
    const service = makeService(fakePublisher({ job }), fakePublisher({ job: null }));

    const view = await service.getTaskStatus('task-1');
    expect(view.state).toBe('failed');
    expect(view.attemptsMade).toBe(3);
    expect(view.failedReason).toBe('embedding 超时');
    expect(view.finishedAt).toBe(5000);
  });
});
