import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** 发表评论 / 回复 */
export class CreateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content: string;

  /** 回复哪条评论；只能回复顶层评论 */
  @IsOptional()
  @IsString()
  parentId?: string;
}

/** 创建分享链接 */
export class CreateShareDto {
  /** 不传则链接无需密码 */
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  password?: string;

  /** 不传则长期有效，最长 365 天 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  expireDays?: number;
}

/** 打开分享链接 */
export class AccessShareDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  password?: string;
}
