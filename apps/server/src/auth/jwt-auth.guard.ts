import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './decorators/public.decorator.js';

/**
 * 全局 JWT 鉴权守卫（AuthModule 内经 APP_GUARD 注册）。
 *
 * 默认所有 HTTP 接口都要求登录；标了 @Public 的端点直接放行。
 * 验签 / 用户校验失败统一转 401，具体原因不外泄（防探测）。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }

  /** Passport 回调：无 user 或 Strategy 报错 → 401 */
  handleRequest<TUser>(err: Error | null, user: TUser): TUser {
    if (err || !user) {
      throw err ?? new UnauthorizedException('未登录或 token 已失效');
    }
    return user;
  }
}
