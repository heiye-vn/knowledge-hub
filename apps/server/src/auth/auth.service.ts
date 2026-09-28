import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from './auth-user.interface.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';
import type {
  ResetPasswordByEmailDto,
  SendResetCodeDto,
} from './dto/password-reset.dto.js';
import { RoleCode } from '../common/constants/roles.js';
import { UserService } from '../user/user.service.js';
import { MailService } from '../mail/mail.service.js';
import { TokenRevocationService } from './token-revocation.service.js';
import { EmailActivationService } from './email-activation.service.js';
import {
  PasswordResetService,
  RESET_CODE_COOLDOWN_SECONDS,
  RESET_CODE_TTL_SECONDS,
} from './password-reset.service.js';

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
 * 认证服务：注册 / 登录 / 刷新 / 当前用户 / 邮箱激活 / 验证码重置密码。
 *
 * 双 Token 机制：access 短期（默认 2h）调业务接口，refresh 长期（默认 7d）
 * 只用来换新 access。两类令牌使用**独立签名密钥**——任一泄露不殃及另一类，
 * 且 payload.type 与验签密钥双重隔离，杜绝拿 refresh 直接调业务接口。
 *
 * 验证类流程（激活 / 验证码）的降级策略是 fail-closed：
 * Redis 或邮件不可用直接失败，绝不放行——它们是安全闸门，详见 dev-notes。
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly revocation: TokenRevocationService,
    private readonly mail: MailService,
    private readonly emailActivation: EmailActivationService,
    private readonly passwordReset: PasswordResetService,
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

  /** 是否要求注册后邮箱激活（默认 false：注册即启用，免激活） */
  private requireEmailVerification(): boolean {
    return (
      this.config.get<string>('REQUIRE_EMAIL_VERIFICATION', 'false') === 'true'
    );
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

  /**
   * 注册。开启邮箱验证时：写 email_verified=0 → 生成激活 token（Redis 24h）
   * → 发激活邮件；发信失败回滚 token，避免留下永远激活不了的账户。
   */
  async register(
    dto: RegisterDto,
  ): Promise<{
    userId: string;
    message: string;
    emailVerificationRequired: boolean;
  }> {
    const requireVerification = this.requireEmailVerification();
    const result = await this.userService.register({
      ...dto,
      requireEmailVerification: requireVerification,
    });

    if (result.emailVerificationRequired && dto.email) {
      const token = await this.emailActivation.createToken(result.userId);
      try {
        await this.mail.sendActivationEmail(dto.email, dto.username, token);
      } catch {
        await this.emailActivation.deleteByToken(token);
        throw new BadRequestException('激活邮件发送失败，请稍后再试');
      }
      return {
        userId: result.userId,
        message: '注册成功，请查收邮件激活账户',
        emailVerificationRequired: true,
      };
    }

    return {
      userId: result.userId,
      message: '注册成功，请登录',
      emailVerificationRequired: false,
    };
  }

  /** 邮箱激活：校验并消费 token（一次性），置 email_verified=1 */
  async verifyEmail(token: string): Promise<{ message: string }> {
    const userId = await this.emailActivation.consumeToken(token);
    if (!userId) {
      throw new BadRequestException('激活链接无效或已过期');
    }
    const message = await this.userService.activateEmail(userId);
    return { message };
  }

  /** 发送重置密码验证码：邮箱必须已注册；60 秒冷却（Redis TTL 反推） */
  async sendResetCode(dto: SendResetCodeDto): Promise<{ message: string }> {
    const user = await this.userService.findByEmail(dto.email);
    if (!user) {
      throw new BadRequestException('该邮箱未注册');
    }

    // 刚发出去时 TTL≈600s；剩余 TTL > 540s 说明距上次发送不足 60s，拦截重发
    const ttl = await this.passwordReset.getTtl(dto.email);
    if (ttl > RESET_CODE_TTL_SECONDS - RESET_CODE_COOLDOWN_SECONDS) {
      throw new BadRequestException('验证码已发送，请稍后再试');
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.passwordReset.set(dto.email, code);
    try {
      await this.mail.sendResetCodeEmail(dto.email, user.username, code);
    } catch {
      await this.passwordReset.delete(dto.email);
      throw new BadRequestException('邮件发送失败，请稍后再试');
    }
    return { message: '验证码已发送' };
  }

  /** 验证码重置密码：校验通过改密并删除验证码（一次性） */
  async resetPasswordByEmail(
    dto: ResetPasswordByEmailDto,
  ): Promise<{ message: string }> {
    if (!(await this.passwordReset.verify(dto.email, dto.code))) {
      throw new BadRequestException('验证码错误或已过期');
    }
    await this.userService.resetPasswordByEmail(dto.email, dto.newPassword);
    await this.passwordReset.delete(dto.email);
    return { message: '密码重置成功，请登录' };
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
