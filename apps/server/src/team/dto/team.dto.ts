import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTeamDto {
  /** 团队名称 */
  @IsString()
  @MaxLength(100)
  teamName: string;

  /** 团队编码 */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  teamCode?: string;

  /** 描述 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** 负责人用户 ID */
  @IsOptional()
  @IsString()
  leaderId?: string;

  /** 父团队 ID（不传为根团队） */
  @IsOptional()
  @IsString()
  parentId?: string;

  /** 排序 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  /** 0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  teamName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  teamCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  leaderId?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;
}

export class QueryTeamDto {
  /** 关键词（模糊匹配团队名称 / 编码） */
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 状态过滤（0/1） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

/** 批量增删团队成员入参 */
export class TeamMembersDto {
  /** 用户 ID 列表 */
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}
