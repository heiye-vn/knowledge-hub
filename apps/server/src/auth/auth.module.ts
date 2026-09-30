import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { PermissionsGuard } from './permissions.guard.js';
import { TokenRevocationService } from './token-revocation.service.js';
import { EmailActivationService } from './email-activation.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { RedisModule } from '../redis/redis.module.js';
import { MailModule } from '../mail/mail.module.js';
import { UserModule } from '../user/user.module.js';

/**
 * 认证模块。
 *
 * JwtModule 不设全局 secret：access / refresh 各自持独立密钥，
 * 签发与验签时显式传入（见 AuthService / JwtStrategy）。
 *
 * 三个全局守卫在此注册（APP_GUARD），按注册顺序流水线执行、任一失败短路拦截：
 * 1. JwtAuthGuard（登录校验，@Public 放行）
 * 2. RolesGuard（@Roles 才校验，用于角色语义明确的场景如审核）
 * 3. PermissionsGuard（@RequirePermission 权限码校验，管理员短路放行）
 */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({}), RedisModule, MailModule, UserModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    TokenRevocationService,
    EmailActivationService,
    PasswordResetService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
