import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { GraphBuildService } from '../kg/graph-build.service.js';
import type { ElasticsearchService } from '../rag/elasticsearch.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { HealthService } from './health.service.js';

interface Options {
  pgOk?: boolean;
  redisEnabled?: boolean;
  redisOk?: boolean;
  esEnabled?: boolean;
  esOk?: boolean;
  neo4jEnabled?: boolean;
  neo4jOk?: boolean;
  timeoutMs?: number;
}

function makeService(options: Options = {}) {
  const dataSource = {
    query: vi.fn(async () => {
      if (options.pgOk === false) throw new Error('pg down');
      return [{ '?column?': 1 }];
    }),
  };
  const redis = {
    isEnabled: () => options.redisEnabled !== false,
    ping: vi.fn(async () => {
      if (options.redisOk === false) throw new Error('redis down');
    }),
  };
  const es = {
    isEnabled: () => options.esEnabled !== false,
    getClient: () => ({
      ping: vi.fn(async () => {
        if (options.esOk === false) throw new Error('es down');
        return true;
      }),
    }),
  };
  const graph = {
    isEnabled: () => options.neo4jEnabled !== false,
    ping: vi.fn(async () => {
      if (options.neo4jOk === false) throw new Error('neo4j down');
    }),
  };
  const config = {
    get: (key: string, fallback?: string) =>
      key === 'HEALTH_CHECK_TIMEOUT_MS'
        ? String(options.timeoutMs ?? fallback)
        : fallback,
  };

  const service = new HealthService(
    dataSource as unknown as DataSource,
    redis as unknown as RedisService,
    es as unknown as ElasticsearchService,
    graph as unknown as GraphBuildService,
    config as unknown as ConfigService,
  );

  return { service, dataSource, redis, graph };
}

describe('HealthService', () => {
  it('四个依赖正常时就绪状态为 ok', async () => {
    const { service } = makeService();

    const result = await service.readiness();

    expect(result.status).toBe('ok');
    expect(result.checks.postgres.status).toBe('up');
    expect(result.checks.redis.status).toBe('up');
    expect(result.checks.elasticsearch.status).toBe('up');
    expect(result.checks.neo4j.status).toBe('up');
  });

  it('PostgreSQL 不可用时就绪状态为 error', async () => {
    const { service } = makeService({ pgOk: false });

    const result = await service.readiness();

    expect(result.status).toBe('error');
    expect(result.checks.postgres).toMatchObject({
      status: 'down',
      error: 'pg down',
    });
  });

  it('可选依赖不可用只降级为 degraded', async () => {
    const { service } = makeService({ redisOk: false });

    const result = await service.readiness();

    expect(result.status).toBe('degraded');
    expect(result.checks.redis.status).toBe('down');
    expect(result.checks.postgres.status).toBe('up');
  });

  it('未启用的依赖标记 disabled，不影响就绪状态', async () => {
    const { service } = makeService({
      redisEnabled: false,
      esEnabled: false,
      neo4jEnabled: false,
    });

    const result = await service.readiness();

    expect(result.status).toBe('ok');
    expect(result.checks.redis.status).toBe('disabled');
    expect(result.checks.elasticsearch.status).toBe('disabled');
    expect(result.checks.neo4j.status).toBe('disabled');
  });

  it('探测超时记为 down，不会挂住整个就绪检查', async () => {
    const { service, redis } = makeService({ timeoutMs: 100 });
    redis.ping.mockImplementation(() => new Promise(() => undefined));

    const startedAt = Date.now();
    const result = await service.readiness();

    expect(result.checks.redis.status).toBe('down');
    expect(result.checks.redis.error).toContain('超时');
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});
