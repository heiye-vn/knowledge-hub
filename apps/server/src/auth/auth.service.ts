import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from './auth-user.interface.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';
import { RoleCode } from '../common/constants/roles.js';
import { UserService } from '../user/user.service.js';
import { TokenRevocationService } from './token-revocation.service.js';

/** 登录 / 刷新的返回结构 */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** access token 有效期（秒），前端据此调度静默刷新 */
  expiresIn: number;
  userInfo: AuthUser;
}

/** 两类令牌共用的 payload 结构，靠 type 区分用途 */
export interface TokenPayload {
  /** 用户 ID */
  sub: string;
  username: string;
  type: 'access' | 'refresh';
  /** 仅 refresh token 携带：令牌唯一标识，登出吊销时按此作废 */
  jti?: string;
}

/**
 * 认证服务：注册 / 登录 / 刷新 / 当前用户。
 *
 * 双 Token 机制：access 短期（默认 2h）调业务接口，refresh 长期（默认 7d）
 * 只用来换新 access。两类令牌使用**独立签名密钥**——任一泄露不殃及另一类，
 * 且 payload.type 与验签密钥双重隔离，杜绝拿 refresh 直接调业务接口。
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly revocation: TokenRevocationService,
  ) {}

  private accessSecret(): string {
    return this.config.get<string>('JWT_ACCESS_SECRET', 'dev-access-secret');
  }

  private refreshSecret(): string {
    return this.config.get<string>('JWT_REFRESH_SECRET', 'dev-refresh-secret');
  }

  private accessExpires(): string {
    return this.config.get<string>('JWT_ACCESS_EXPIRES', '2h');
  }

  private refreshExpires(): string {
    return this.config.get<string>('JWT_REFRESH_EXPIRES', '7d');
  }

  /** 把 '2h' / '7d' 这类配置串换算成秒，解析失败兜底 7200 */
  private accessExpiresSeconds(): number {
    const match = /^(\d+)([smhd])$/.exec(this.accessExpires());
    if (!match) return 7200;
    const n = Number(match[1]);
    const unit = match[2];
    if (unit === 's') return n;
    if (unit === 'm') return n * 60;
    if (unit === 'h') return n * 3600;
    return n * 86400;
  }

  private signAccessToken(user: AuthUser): string {
    const payload: TokenPayload = {
      sub: user.userId,
      username: user.username,
      type: 'access',
    };
    return this.jwtService.sign(payload, {
      secret: this.accessSecret(),
      expiresIn: this.accessExpires() as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });
  }

  private signRefreshToken(user: AuthUser): string {
    const payload: TokenPayload = {
      sub: user.userId,
      username: user.username,
      type: 'refresh',
      jti: randomUUID(),
    };
    return this.jwtService.sign(payload, {
      secret: this.refreshSecret(),
      expiresIn: this.refreshExpires() as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userService.validateCredentials(
      dto.username,
      dto.password,
    );
    await this.userService.touchLastLogin(user.userId);
    return this.buildLoginResult(user);
  }

  async register(
    dto: RegisterDto,
  ): Promise<{ userId: string; message: string }> {
    const { userId } = await this.userService.register(dto);
    return {
      userId,
      message: '注册成功，请登录',
    };
  }

  /** 用 refresh token 换新双令牌；过期 / 伪造 / 类型不符均 401 */
  async refresh(refreshToken: string): Promise<LoginResult> {
    let payload: TokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<TokenPayload>(
        refreshToken,
        { secret: this.refreshSecret() },
      );
    } catch {
      throw new UnauthorizedException('refresh token 无效或已过期');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('无效的 refresh token');
    }
    if (payload.jti && (await this.revocation.isRevoked(payload.jti))) {
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }
    const user = await this.userService.buildAuthUser(payload.sub);
    return this.buildLoginResult(user);
  }

  /**
   * 登出：把当前 refresh token 的 jti 拉黑（TTL = 剩余有效期）。
   * token 无效 / 已过期视为已退出，幂等返回成功；
   * access token 短期有效且不落黑名单，自然过期即可。
   */
  async logout(refreshToken: string): Promise<{ message: string }> {
    let payload: TokenPayload & { exp?: number };
    try {
      payload = await this.jwtService.verifyAsync<
        TokenPayload & { exp?: number }
      >(refreshToken, { secret: this.refreshSecret() });
    } catch {
      return { message: '已退出登录' };
    }

    if (payload.type === 'refresh' && payload.jti) {
      const ttl = Math.floor((payload.exp ?? 0) - Date.now() / 1000);
      await this.revocation.revoke(payload.jti, ttl);
    }
    return { message: '已退出登录' };
  }

  async getMe(userId: string): Promise<AuthUser> {
    return this.userService.buildAuthUser(userId);
  }

  /** 审核员用户 ID 列表（供审核任务分派 / 前端选择审核人） */
  async getReviewerIds(): Promise<string[]> {
    return this.userService.getUserIdsByRoleCode(RoleCode.REVIEWER);
  }

  private buildLoginResult(user: AuthUser): LoginResult {
    return {
      accessToken: this.signAccessToken(user),
      refreshToken: this.signRefreshToken(user),
      tokenType: 'Bearer',
      expiresIn: this.accessExpiresSeconds(),
      userInfo: user,
    };
  }
}
