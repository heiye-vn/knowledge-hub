import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** 实体检索请求（GET /kg/entities） */
export class GraphEntitiesDto {
  /** 关键词（实体名包含匹配，大小写不敏感）；空 = 全部 */
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 返回条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** 邻居查询请求（GET /kg/neighbors） */
export class GraphNeighborsDto {
  /** 中心实体名（逐字匹配） */
  @IsString()
  @IsNotEmpty()
  name!: string;

  /** 返回条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
