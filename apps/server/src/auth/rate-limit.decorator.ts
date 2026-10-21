import { SetMetadata } from '@nestjs/common';

export const AUTH_RATE_LIMIT_KEY = 'auth_rate_limit';

/**
 * 限流维度：
 * - ip：按来源 IP
 * - account：按请求体里的 username（登录）/ email（重置密码）
 * - email：明确按邮箱维度（发码 / 校验验证码）
 */
export type RateLimitDimension = 'ip' | 'account' | 'email';

export interface RateLimitRule {
  dimension: RateLimitDimension;
  /** 窗口内允许的最大次数 */
  limit: number;
  /** 窗口长度（秒） */
  windowSeconds: number;
}

/**
 * 声明式限流规则，由 AuthRateLimitGuard 读取执行。
 *
 * 典型用法：登录同时限制 IP 与账号两个维度——
 * 只限 IP 挡不住分布式撞库，只限账号挡不住同一 IP 批量试账号。
 */
export const AuthRateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(AUTH_RATE_LIMIT_KEY, rules);
