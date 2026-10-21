import { describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { HealthService } from './health.service.js';
import { HealthController } from './health.controller.js';

function makeController(readiness: {
  status: 'ok' | 'degraded' | 'error';
}) {
  const health = {
    liveness: vi.fn(() => ({ status: 'ok' as const, uptime: 12 })),
    readiness: vi.fn(async () => ({
      status: readiness.status,
      checks: {
        postgres: { status: 'up' as const },
        redis: { status: 'disabled' as const },
        elasticsearch: { status: 'disabled' as const },
        neo4j: { status: 'disabled' as const },
      },
    })),
  };
  const controller = new HealthController(
    health as unknown as HealthService,
  );
  const res = { status: vi.fn() };
  return { controller, health, res };
}

describe('HealthController', () => {
  it('存活探针返回 ok 与运行时长', () => {
    const { controller } = makeController({ status: 'ok' });

    expect(controller.liveness()).toEqual({ status: 'ok', uptime: 12 });
  });

  it('就绪正常时返回 200', async () => {
    const { controller, res } = makeController({ status: 'ok' });

    const result = await controller.readiness(res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(result.status).toBe('ok');
  });

  it('就绪降级（可选依赖故障）仍返回 200', async () => {
    const { controller, res } = makeController({ status: 'degraded' });

    await controller.readiness(res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('PostgreSQL 故障时就绪返回 503', async () => {
    const { controller, res } = makeController({ status: 'error' });

    const result = await controller.readiness(res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(result.status).toBe('error');
  });
});
