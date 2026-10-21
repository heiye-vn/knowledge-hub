import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { GraphBuildService } from '../kg/graph-build.service.js';
import { ElasticsearchService } from '../rag/elasticsearch.service.js';
import { RedisService } from '../redis/redis.service.js';

export type DependencyState = 'up' | 'down' | 'disabled';
export type ReadinessStatus = 'ok' | 'degraded' | 'error';

export interface DependencyCheck {
  status: DependencyState;
  latencyMs?: number;
  error?: string;
}

export interface ReadinessResult {
  status: ReadinessStatus;
  checks: Record<string, DependencyCheck>;
}

const DEFAULT_TIMEOUT_MS = 1500;

/**
 * 健康检查。
 *
 * - 存活探针只证明进程还在（K8s liveness）；
 * - 就绪探针真实探测四个依赖：PostgreSQL 是**必需**（挂了返回 error / 503），
 *   Redis / ES / Neo4j 是**可选**（挂了标记 degraded，仍返回 200），
 *   因为三者缺失时应用会降级运行而不是崩溃。
 *
 * 【易错】探测必须带超时：ES / Neo4j 连接挂死时若直接 await，就绪探针会一起挂住，
 * 编排系统会误判实例不可用并不断重启。
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly es: ElasticsearchService,
    private readonly graph: GraphBuildService,
    config: ConfigService,
  ) {
    this.timeoutMs = Math.max(
      100,
      Number(
        config.get('HEALTH_CHECK_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS)),
      ),
    );
  }

  /** 存活：进程能响应即 ok */
  liveness(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /** 就绪：真实探测依赖，PG 不可用视为 not ready */
  async readiness(): Promise<ReadinessResult> {
    const [postgres, redis, elasticsearch, neo4j] = await Promise.all([
      this.probe(() => this.dataSource.query('SELECT 1')),
      this.redis.isEnabled()
        ? this.probe(() => this.redis.ping())
        : Promise.resolve<DependencyCheck>({ status: 'disabled' }),
      this.es.isEnabled()
        ? this.probe(() => this.es.getClient().ping())
        : Promise.resolve<DependencyCheck>({ status: 'disabled' }),
      this.graph.isEnabled()
        ? this.probe(() => this.graph.ping())
        : Promise.resolve<DependencyCheck>({ status: 'disabled' }),
    ]);

    const checks: Record<string, DependencyCheck> = {
      postgres,
      redis,
      elasticsearch,
      neo4j,
    };

    let status: ReadinessStatus = 'ok';
    if (postgres.status === 'down') {
      status = 'error';
    } else if (
      [redis, elasticsearch, neo4j].some((check) => check.status === 'down')
    ) {
      status = 'degraded';
    }

    if (status !== 'ok') {
      this.logger.warn(
        `就绪检查未通过：status=${status}, ${Object.entries(checks)
          .map(([name, check]) => `${name}=${check.status}`)
          .join(', ')}`,
      );
    }

    return { status, checks };
  }

  private async probe(fn: () => Promise<unknown>): Promise<DependencyCheck> {
    const startedAt = Date.now();
    try {
      await withTimeout(fn(), this.timeoutMs);
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`探测超时（${timeoutMs}ms）`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
