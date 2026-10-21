import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

const RESET_CODE_PREFIX = 'kh_auth:reset-code:';
const RESET_ATTEMPT_PREFIX = 'kh_auth:reset-attempt:';
const RESET_LOCK_PREFIX = 'kh_auth:reset-lock:';

/** 验证码有效期：10 分钟 */
export const RESET_CODE_TTL_SECONDS = 10 * 60;
/** 重发冷却：60 秒内不允许重复发送（用 TTL 反推，不单独存冷却键） */
export const RESET_CODE_COOLDOWN_SECONDS = 60;
/** 验证码连续错误上限，达到后销毁验证码并锁定 */
export const RESET_MAX_ATTEMPTS = 5;
/** 错误上限触发后的锁定时长：10 分钟 */
export const RESET_LOCK_SECONDS = 10 * 60;

/**
 * 密码重置验证码（Redis 存储）。
 *
 * key = `kh_auth:reset-code:{email}`（邮箱小写归一），value = 6 位数字码。
 * 冷却判定取巧：刚写入时 TTL≈600s；剩余 TTL > 540s 说明距上次发送不足 60s，拒绝重发。
 * 校验通过必须删除（一次性），防同一验证码重复改密。
 *
 * 【防爆破】6 位码只有 10^6 组合，10 分钟窗口内无尝试上限即可枚举。
 * 连续错误 5 次即销毁验证码并锁定 10 分钟；重新发码清除计数与锁定
 * （重新发码要通过邮箱所有权，天然是合法用户）。
 *
 * 降级：fail-closed——验证码是重置密码的唯一身份核验，Redis 不可用直接 503。
 */
@Injectable()
export class PasswordResetService {
  constructor(private readonly redis: RedisService) {}

  private key(email: string): string {
    return `${RESET_CODE_PREFIX}${email.toLowerCase()}`;
  }

  private attemptKey(email: string): string {
    return `${RESET_ATTEMPT_PREFIX}${email.toLowerCase()}`;
  }

  private lockKey(email: string): string {
    return `${RESET_LOCK_PREFIX}${email.toLowerCase()}`;
  }

  async set(email: string, code: string): Promise<void> {
    this.redis.assertAvailable();
    await this.redis.set(this.key(email), code, RESET_CODE_TTL_SECONDS);
    // 重新发码：清掉上一次的错误计数与锁定，避免合法用户被自己之前的失败困住
    await this.redis.del(this.attemptKey(email));
    await this.redis.del(this.lockKey(email));
  }

  async getTtl(email: string): Promise<number> {
    this.redis.assertAvailable();
    return this.redis.ttl(this.key(email));
  }

  /** 是否处于错误上限后的锁定期 */
  async isLocked(email: string): Promise<boolean> {
    this.redis.assertAvailable();
    const ttl = await this.redis.ttl(this.lockKey(email));
    return ttl > 0;
  }

  async verify(email: string, code: string): Promise<boolean> {
    this.redis.assertAvailable();

    if (await this.isLocked(email)) return false;

    const stored = await this.redis.get(this.key(email));
    if (stored !== null && stored === code) {
      // 一次性验证码：用掉即删，并清空错误计数
      await this.redis.del(this.key(email));
      await this.redis.del(this.attemptKey(email));
      return true;
    }

    const attempts = await this.redis.incrementWithTtl(
      this.attemptKey(email),
      RESET_CODE_TTL_SECONDS,
    );
    if (attempts >= RESET_MAX_ATTEMPTS) {
      // 达到上限：验证码作废 + 锁定，必须重新发码才能继续
      await this.redis.del(this.key(email));
      await this.redis.set(this.lockKey(email), '1', RESET_LOCK_SECONDS);
    }
    return false;
  }

  async delete(email: string): Promise<void> {
    this.redis.assertAvailable();
    await this.redis.del(this.key(email));
  }
}
