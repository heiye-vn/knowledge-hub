import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

/** 登录入参 */
export class LoginDto {
  @IsString()
  username: string;

  @IsString()
  password: string;
}

/** 注册入参（密码至少 6 位；注册即启用，无需激活） */
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
