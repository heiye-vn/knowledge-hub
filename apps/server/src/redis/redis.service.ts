import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
  REDIS_CONNECT_TIMEOUT_MS,
} from '../mq/mq.constants.js';
import { describeError } from '../mq/mq-error.util.js';

/**
 * Redis 通用薄封装：一条连接 + 5 个原语方法，供所有需要 KV 语义的服务复用。
 *
 * 连接建立沿用 TokenRevocationService 验证过的模式：
 * lazyConnect + Promise.race 限时探测——`new Redis()` 对象创建不代表连得上，
 * 不显式探测会得到一个假装可用的客户端（详见 mq.constants 的【易错】注释）。
 *
 * 降级哲学分两类，由调用方按功能性质选择：
 * - fail-open（可用性优先）：吊销黑名单、队列类，isAvailable() 为 false 时自行放行；
 * - fail-closed（安全优先）：激活 token / 重置验证码等验证类功能，
 *   调用 assertAvailable()，Redis 不可用时直接 503——闸门断电不能等于敞开。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<string>('REDIS_ENABLED', 'true') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Redis 已禁用（REDIS_ENABLED=false），依赖 Redis 的功能不可用');
      return;
    }

    const host = this.config.get<string>('REDIS_HOST', DEFAULT_REDIS_HOST);
    const port = Number(this.config.get('REDIS_PORT', DEFAULT_REDIS_PORT));

    try {
      this.client = new Redis({ host, port, lazyConnect: true });
      this.client.on('error', (err: Error) => {
        this.logger.warn(`Redis 连接异常：${describeError(err)}`);
      });
      await Promise.race([
        this.client.connect(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('connect timeout')),
            Number(
              this.config.get('REDIS_CONNECT_TIMEOUT_MS', REDIS_CONNECT_TIMEOUT_MS),
            ),
          ),
        ),
      ]);
      this.logger.log(`Redis 已连接 ${host}:${port}`);
    } catch (error) {
      this.logger.warn(
        `Redis 连接失败，依赖 Redis 的功能将按各服务策略降级：${describeError(error)}`,
      );
      this.client = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  /** 连接是否可用（fail-open 场景由调用方据此自行决策） */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /** fail-closed 场景入口：验证类功能 Redis 不可用直接 503，绝不放行 */
  assertAvailable(): void {
    if (!this.client) {
      throw new ServiceUnavailableException('服务暂时不可用，请稍后再试');
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertAvailable();
    return this.client!.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.assertAvailable();
    if (ttlSeconds !== undefined) {
      await this.client!.set(key, value, 'EX', ttlSeconds);
      return;
    }
    await this.client!.set(key, value);
  }

  async del(...keys: string[]): Promise<void> {
    this.assertAvailable();
    await this.client!.del(...keys);
  }

  async ttl(key: string): Promise<number> {
    this.assertAvailable();
    return this.client!.ttl(key);
  }
}
