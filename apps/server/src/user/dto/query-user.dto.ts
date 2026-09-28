import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** 管理员分页查询用户入参 */
export class QueryUserDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 10;

  /** 模糊匹配用户名 / 姓名 / 邮箱 */
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 账户状态过滤：0 禁用 1 启用 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  status?: number;
}
