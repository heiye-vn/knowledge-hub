import { IsString, MinLength } from 'class-validator';

/** 登录用户修改自己的密码（需验证旧密码） */
export class ChangePasswordDto {
  @IsString()
  oldPassword: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}

/** 管理员重置指定用户密码（不需要旧密码） */
export class ResetPasswordDto {
  @IsString()
  @MinLength(6)
  newPassword: string;
}
