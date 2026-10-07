import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** 登录入参 */
export class LoginDto {
  @IsString()
  username: string;

  @IsString()
  password: string;
}

/**
 * 注册入参（密码至少 6 位）。
 * 默认注册即启用；REQUIRE_EMAIL_VERIFICATION=true 时 email 必填、注册后需邮件激活。
 */
export class RegisterDto {
  @IsString()
  username: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  realName?: string;
}

/** 刷新 Token 入参 */
export class RefreshTokenDto {
  @IsString()
  refreshToken: string;
}

/**
 * 重发激活邮件入参（TODO §8.2）
 *
 * 未激活账号无法通过登录鉴权（validateCredentials 会拒），故该接口是公开端点，
 * 用「用户名 + 密码」证明账号归属——否则任何人都能拿他人邮箱反复触发发信，
 * 变成邮件轰炸入口。
 */
export class ResendActivationDto {
  @IsString()
  username: string;

  @IsString()
  password: string;
}
