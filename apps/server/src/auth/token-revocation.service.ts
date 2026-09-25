import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
  REDIS_CONNECT_TIMEOUT_MS,
} from '../mq/mq.constants.js';
import { describeError } from '../mq/mq-error.util.js';

/** 吊销标记的 Key 前缀（refresh token 的 jti） */
const REVOKE_PREFIX = 'kh_auth:revoke:';

/**
 * refresh token 吊销服务（登出能力）
 *
 * 原理：refresh token 签发时带 jti；登出后以
 * `SETEX kh_auth:revoke:{jti} <剩余有效期> 1` 记入黑名单，
 * refresh 时先查黑名单。TTL 到期标记自动清除，无需手动清扫。
 *
 * 降级：与重建索引队列同一风格——Redis 不可用时 isAvailable() 为 false，
 * 刷新接口放行（可用性优先于吊销的强一致，登出场景可接受）。
 */
@Injectable()
export class TokenRevocationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TokenRevocationService.name);
  private client: Redis | null = null;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled =
      this.config.get<string>('REDIS_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Redis 已禁用，登出吊销不可用（refresh 不校验黑名单）');
      return;
    }

    const host = this.config.get<string>('REDIS_HOST', DEFAULT_REDIS_HOST);
    const port = Number(this.config.get('REDIS_PORT', DEFAULT_REDIS_PORT));

    try {
      // lazyConnect：对象创建不触发连接，显式 connect 并限时探测
      this.client = new Redis({ host, port, lazyConnect: true });
      this.client.on('error', (err: Error) => {
        this.logger.warn(`吊销黑名单连接异常：${describeError(err)}`);
      });
      await Promise.race([
        this.client.connect(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('connect timeout')),
            Number(this.config.get('REDIS_CONNECT_TIMEOUT_MS', REDIS_CONNECT_TIMEOUT_MS)),
          ),
        ),
      ]);
      this.logger.log(`吊销黑名单已连接 Redis ${host}:${port}`);
    } catch (error) {
      this.logger.warn(
        `吊销黑名单连接失败，refresh 不校验黑名单：${describeError(error)}`,
      );
      this.client = null;
    }
  }

  async onModuleDestroy() {
    await this.client?.quit().catch(() => undefined);
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  /** 登出：把该 refresh token 拉黑，存活时间 = 剩余有效期（秒） */
  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    if (!this.client || ttlSeconds <= 0) return;
    await this.client.set(`${REVOKE_PREFIX}${jti}`, '1', 'EX', ttlSeconds);
  }

  /** refresh 前查黑名单 */
  async isRevoked(jti: string): Promise<boolean> {
    if (!this.client) return false;
    return (await this.client.exists(`${REVOKE_PREFIX}${jti}`)) === 1;
  }
}
