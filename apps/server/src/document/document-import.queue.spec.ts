import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DocumentImportQueue } from './document-import.queue.js';

const jobs = new Map<string, unknown>();
vi.mock('bullmq', () => ({
  Queue: class {
    async add(_name: string, data: unknown, options: { jobId: string }) { jobs.set(options.jobId, data); }
    async waitUntilReady() {}
    on() {}
    async close() {}
    async setGlobalConcurrency() {}
  },
  Worker: class { on() {} async close() {} async waitUntilReady() {} },
}));

describe('Import queue durable dispatch', () => {
  it('replays queued records after restart with only IDs in Redis', async () => {
    jobs.clear();
    const service = { pending: async () => [{ id: '1001', attempt: 2 }], process: async () => undefined };
    const queue = new DocumentImportQueue(new ConfigService({ REDIS_ENABLED: 'true' }), service as never);
    await queue.onModuleInit();
    await queue.dispatch();
    expect([...jobs.entries()]).toEqual([['1001-2', { id: '1001' }]]);
    await queue.dispatch();
    expect(jobs.size).toBe(1);
    await queue.onModuleDestroy();
  });
  it('does not initialize a worker when Redis is disabled', async () => {
    jobs.clear();
    const queue = new DocumentImportQueue(new ConfigService({ REDIS_ENABLED: 'false' }), { pending: async () => [{ id: '1002', attempt: 0 }] } as never);
    await queue.onModuleInit();
    await queue.dispatch();
    expect(jobs.size).toBe(0);
    await queue.onModuleDestroy();
  });
});
