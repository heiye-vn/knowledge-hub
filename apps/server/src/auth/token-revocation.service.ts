import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/** 吊销标记的 Key 前缀（refresh token 的 jti） */
const REVOKE_PREFIX = 'kh_auth:revoke:';

/**
 * refresh token 吊销服务（登出能力）
 *
 * 原理：refresh token 签发时带 jti；登出后以
 * `SETEX kh_auth:revoke:{jti} <剩余有效期> 1` 记入黑名单，
 * refresh 时先查黑名单。TTL 到期标记自动清除，无需手动清扫。
 *
 * 降级：fail-open——Redis 不可用时 isAvailable() 为 false，
 * 刷新接口放行（可用性优先于吊销的强一致，登出场景可接受）。
 * 连接管理已收敛到 RedisService，本服务只保留黑名单语义。
 */
@Injectable()
export class TokenRevocationService {
  constructor(private readonly redis: RedisService) {}

  isAvailable(): boolean {
    return this.redis.isAvailable();
  }

  /** 登出：把该 refresh token 拉黑，存活时间 = 剩余有效期（秒） */
  async revoke(jti: string, ttlSeconds: number): Promise<void> {
    if (!this.redis.isAvailable() || ttlSeconds <= 0) return;
    await this.redis.set(`${REVOKE_PREFIX}${jti}`, '1', ttlSeconds);
  }

  /** refresh 前查黑名单 */
  async isRevoked(jti: string): Promise<boolean> {
    if (!this.redis.isAvailable()) return false;
    return (await this.redis.get(`${REVOKE_PREFIX}${jti}`)) !== null;
  }
}
