import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { RedisService } from '../redis/redis.service.js';

const TOKEN_PREFIX = 'kh_auth:activate:token:';
const USER_PREFIX = 'kh_auth:activate:user:';

/** 激活 token 有效期：24 小时 */
export const ACTIVATION_TOKEN_TTL_SECONDS = 24 * 3600;

/**
 * 邮箱激活令牌（Redis 存储，24 小时有效，一次性消费）。
 *
 * 双键互指设计：
 * - `activate:token:{token} → userId`：用户点激活链接时按 token 反查账号；
 * - `activate:user:{userId} → token`：同一用户只保留一个有效 token，
 *   重复注册/重发时先按 userId 找到旧 token 一并作废，防止旧链接复活。
 *
 * 降级：fail-closed——激活是安全闸门，Redis 不可用时 assertAvailable 直接 503，
 * 绝不放行（区别于吊销黑名单的 fail-open，依据见 dev-notes）。
 */
@Injectable()
export class EmailActivationService {
  constructor(private readonly redis: RedisService) {}

  private tokenKey(token: string): string {
    return `${TOKEN_PREFIX}${token}`;
  }

  private userKey(userId: string): string {
    return `${USER_PREFIX}${userId}`;
  }

  /** 生成激活 token（同用户重发时旧 token 自动作废） */
  async createToken(userId: string): Promise<string> {
    this.redis.assertAvailable();

    const existing = await this.redis.get(this.userKey(userId));
    if (existing) {
      await this.redis.del(this.tokenKey(existing));
    }

    const token = randomBytes(32).toString('hex');
    await this.redis.set(this.tokenKey(token), userId, ACTIVATION_TOKEN_TTL_SECONDS);
    await this.redis.set(this.userKey(userId), token, ACTIVATION_TOKEN_TTL_SECONDS);
    return token;
  }

  /** 校验并消费 token（一次性），返回 userId；无效或过期返回 null */
  async consumeToken(token: string): Promise<string | null> {
    this.redis.assertAvailable();

    const userId = await this.redis.get(this.tokenKey(token));
    if (!userId) return null;

    await this.redis.del(this.tokenKey(token), this.userKey(userId));
    return userId;
  }

  /** 发信失败回滚：按 token 清理两个键，避免留下不可用的激活链接 */
  async deleteByToken(token: string): Promise<void> {
    this.redis.assertAvailable();

    const userId = await this.redis.get(this.tokenKey(token));
    await this.redis.del(this.tokenKey(token));
    if (userId) {
      await this.redis.del(this.userKey(userId));
    }
  }
}
