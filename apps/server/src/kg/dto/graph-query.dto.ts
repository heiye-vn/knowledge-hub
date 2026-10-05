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

/** 图谱关键词检索请求（GET /kg/search，feat-v10） */
export class GraphSearchDto {
  /** 关键词：跨文档/块/实体三类节点的六种属性做包含匹配 */
  @IsString()
  @IsNotEmpty()
  keyword!: string;

  /** 返回条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** 图谱节点 / 边列表请求（GET /kg/nodes、/kg/edges，feat-v10） */
export class GraphQueryDto {
  /** 实体类型过滤（PERSON / ORGANIZATION / CONCEPT …；空 = 全部） */
  @IsOptional()
  @IsString()
  type?: string;

  /** 返回条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;
}

/** 全景图谱查询请求（GET /kg/overview，feat-v12） */
export class GraphOverviewDto {
  /** 关键词（匹配文档标题、摘要、标签或实体名/描述） */
  @IsOptional()
  @IsString()
  keyword?: string;

  /** 实体类型过滤 */
  @IsOptional()
  @IsString()
  entityType?: string;

  /** 文档 updatedAt 下界（ISO 8601 字符串） */
  @IsOptional()
  @IsString()
  from?: string;

  /** 文档 updatedAt 上界（ISO 8601 字符串） */
  @IsOptional()
  @IsString()
  to?: string;

  /** 主视图文档召回上限（默认 24，最小 1，最大 80） */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(80)
  docLimit?: number;
}

