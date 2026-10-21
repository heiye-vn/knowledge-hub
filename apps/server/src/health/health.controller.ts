import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { HealthService } from './health.service.js';

/**
 * 健康检查端点（公开：探活请求不带 token）。
 *
 * - `GET /health`：存活探针，进程能响应即 200；
 * - `GET /health/ready`：就绪探针，PG 不可用返回 503，可选依赖不可用返回 200 + degraded。
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  liveness() {
    return this.health.liveness();
  }

  @Public()
  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: Response) {
    const result = await this.health.readiness();
    // passthrough 保留拦截器信封；状态码由业务结果决定（PG 挂 = 503）
    res.status(result.status === 'error' ? 503 : 200);
    return result;
  }
}
