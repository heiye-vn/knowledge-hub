import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './jwt.strategy.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { TokenRevocationService } from './token-revocation.service.js';
import { UserModule } from '../user/user.module.js';

/**
 * 认证模块。
 *
 * JwtModule 不设全局 secret：access / refresh 各自持独立密钥，
 * 签发与验签时显式传入（见 AuthService / JwtStrategy）。
 *
 * 两个全局守卫在此注册（APP_GUARD），对全站接口生效：
 * 先 JwtAuthGuard（登录校验，@Public 放行）后 RolesGuard（@Roles 才校验）。
 */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), JwtModule.register({}), UserModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    TokenRevocationService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
