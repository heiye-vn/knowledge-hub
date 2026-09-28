import { IsEmail, IsString, Length, MinLength } from 'class-validator';

/** 发送重置密码验证码入参 */
export class SendResetCodeDto {
  @IsEmail()
  email: string;
}

/** 验证码重置密码入参（一次性提交邮箱 + 验证码 + 新密码） */
export class ResetPasswordByEmailDto {
  @IsEmail()
  email: string;

  /** 6 位数字验证码 */
  @IsString()
  @Length(6, 6)
  code: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}
