import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import {
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
  ResendActivationDto,
} from './dto/auth.dto.js';
import {
  ResetPasswordByEmailDto,
  SendResetCodeDto,
} from './dto/password-reset.dto.js';
import { Public } from './decorators/public.decorator.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Roles } from './decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from './auth-user.interface.js';

/** 认证接口：注册 / 登录 / 刷新 / 激活 / 重置密码为公开端点，其余需登录 */
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  /** 登出：吊销当前 refresh token（Redis 黑名单），幂等 */
  @Public()
  @Post('logout')
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
  }

  /** 邮箱激活：邮件链接携带 token，校验通过置 email_verified=1 */
  @Public()
  @Get('verify-email')
  verifyEmail(@Query('token') token: string) {
    return this.authService.verifyEmail(token);
  }

  /**
   * 重发激活邮件（TODO §8.2）：公开端点，凭用户名 + 密码自助触发，60 秒冷却。
   * 未激活账号登录会被拒，只能这样自救，免得只能等 24h token 过期后重新注册。
   */
  @Public()
  @Post('activation/resend')
  resendActivation(@Body() dto: ResendActivationDto) {
    return this.authService.resendActivation(dto);
  }

  /** 管理员代发激活邮件（TODO §8.2）：按 userId 定向重发，跳过密码与冷却 */
  @Post('activation/resend/:userId')
  @Roles(RoleCode.ADMIN)
  resendActivationForUser(@Param('userId') userId: string) {
    return this.authService.resendActivationForUser(userId);
  }

  /** 发送重置密码验证码（6 位，10 分钟有效，60 秒冷却） */
  @Public()
  @Post('password/reset/send-code')
  sendResetCode(@Body() dto: SendResetCodeDto) {
    return this.authService.sendResetCode(dto);
  }

  /** 验证码重置密码（一次性提交邮箱 + 验证码 + 新密码） */
  @Public()
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordByEmailDto) {
    return this.authService.resetPasswordByEmail(dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.authService.getMe(user.userId);
  }

  /** 审核员用户 ID 列表（审核任务分派用） */
  @Get('reviewer-ids')
  @Roles(RoleCode.ADMIN, RoleCode.REVIEWER)
  getReviewerIds() {
    return this.authService.getReviewerIds();
  }
}
