import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { RedisService } from '../redis/redis.service.js';
import {
  AUTH_RATE_LIMIT_KEY,
  type RateLimitDimension,
  type RateLimitRule,
} from './rate-limit.decorator.js';

const KEY_PREFIX = 'kh_auth:rate:';

/**
 * 认证类接口限流守卫（Redis 计数，多实例共享）。
 *
 * 【降级决策】Redis 不可用时 **fail-open**：限流是防滥用，不是身份核验；
 * 若 fail-closed，Redis 抖动会把登录入口整体打死。与之相对，
 * 验证码校验本身是 fail-closed（见 PasswordResetService），两者方向刻意相反。
 *
 * 【易错】INCR 与 EXPIRE 必须原子（Lua）：分两步时进程在中间退出会留下
 * 永不过期的计数键，该账号/IP 会被永久限流。
 */
@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AuthRateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[]>(
      AUTH_RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!rules?.length) return true;

    if (!this.redis.isAvailable()) {
      this.logger.warn('Redis 不可用，认证限流降级放行（fail-open）');
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    for (const rule of rules) {
      const value = this.resolveDimension(rule.dimension, request);
      // 账号维度取不到值（如注册只带 username、重置只带 email）时跳过该规则
      if (!value) continue;

      const key = `${KEY_PREFIX}${routeOf(request)}:${rule.dimension}:${value}`;
      let count: number;
      try {
        count = await this.redis.incrementWithTtl(key, rule.windowSeconds);
      } catch (error) {
        this.logger.warn(
          `限流计数失败，降级放行：${error instanceof Error ? error.message : String(error)}`,
        );
        return true;
      }

      if (count > rule.limit) {
        const retryAfter = await this.redis
          .ttl(key)
          .catch(() => rule.windowSeconds);
        response.setHeader?.('Retry-After', String(Math.max(1, retryAfter)));
        throw new HttpException(
          '请求过于频繁，请稍后再试',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  private resolveDimension(
    dimension: RateLimitDimension,
    request: Request,
  ): string | null {
    if (dimension === 'ip') {
      return request.ip ?? request.socket?.remoteAddress ?? null;
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    if (dimension === 'account') {
      const account = body.username ?? body.email;
      return typeof account === 'string' ? account.toLowerCase() : null;
    }
    return typeof body.email === 'string' ? body.email.toLowerCase() : null;
  }
}

function routeOf(request: Request): string {
  const path = request.route?.path;
  return typeof path === 'string' ? path : request.path ?? 'unknown';
}
