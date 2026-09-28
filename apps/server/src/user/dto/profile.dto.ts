import { IsOptional, IsString, MaxLength } from 'class-validator';

/** 登录用户更新自己的资料（仅展示字段，不含敏感项） */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  realName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar?: string;
}
