import {
  ArrayUnique,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

/** 管理员新建用户入参（初始密码必填） */
export class CreateUserDto {
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

  @IsOptional()
  @IsString()
  avatar?: string;

  /** 账户状态：0 禁用 1 启用（默认 1） */
  @IsOptional()
  @IsInt()
  status?: number;

  /** 初始角色（默认绑 ROLE_USER） */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  roleCodes?: string[];
}
