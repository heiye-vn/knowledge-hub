import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

const RESET_CODE_PREFIX = 'kh_auth:reset-code:';

/** 验证码有效期：10 分钟 */
export const RESET_CODE_TTL_SECONDS = 10 * 60;
/** 重发冷却：60 秒内不允许重复发送（用 TTL 反推，不单独存冷却键） */
export const RESET_CODE_COOLDOWN_SECONDS = 60;

/**
 * 密码重置验证码（Redis 存储）。
 *
 * key = `kh_auth:reset-code:{email}`（邮箱小写归一），value = 6 位数字码。
 * 冷却判定取巧：刚写入时 TTL≈600s；剩余 TTL > 540s 说明距上次发送不足 60s，拒绝重发。
 * 校验通过必须删除（一次性），防同一验证码重复改密。
 *
 * 降级：fail-closed——验证码是重置密码的唯一身份核验，Redis 不可用直接 503。
 */
@Injectable()
export class PasswordResetService {
  constructor(private readonly redis: RedisService) {}

  private key(email: string): string {
    return `${RESET_CODE_PREFIX}${email.toLowerCase()}`;
  }

  async set(email: string, code: string): Promise<void> {
    this.redis.assertAvailable();
    await this.redis.set(this.key(email), code, RESET_CODE_TTL_SECONDS);
  }

  async getTtl(email: string): Promise<number> {
    this.redis.assertAvailable();
    return this.redis.ttl(this.key(email));
  }

  async verify(email: string, code: string): Promise<boolean> {
    this.redis.assertAvailable();
    const stored = await this.redis.get(this.key(email));
    return stored !== null && stored === code;
  }

  async delete(email: string): Promise<void> {
    this.redis.assertAvailable();
    await this.redis.del(this.key(email));
  }
}
