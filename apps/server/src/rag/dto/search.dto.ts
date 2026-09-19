import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { SearchMode } from '../types/rag.types.js';

/** 检索请求 */
export class SearchDto {
  /** 查询词 */
  @IsString()
  query: string;

  /** 检索模式：hybrid 混合 / vector 纯向量 / keyword 纯关键词 */
  @IsOptional()
  @IsEnum(['hybrid', 'vector', 'keyword'])
  mode?: SearchMode;

  /** 返回条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  topK?: number;

  /** 分类过滤 */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** 团队过滤 */
  @IsOptional()
  @IsString()
  teamId?: string;

  /** 作者过滤 */
  @IsOptional()
  @IsString()
  authorId?: string;
}
