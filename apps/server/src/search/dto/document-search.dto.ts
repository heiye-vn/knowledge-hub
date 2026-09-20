import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DocumentStatus } from '../../document/entities/document.entity.js';

/**
 * 文档级全文检索请求
 *
 * 与块级检索 `rag/dto/search.dto.ts` 的区别：
 * - 块级 `/search`：返回文档中的**段落片段**，用于 RAG 喂给 LLM
 * - 文档级 `/search/documents`：返回**整篇文档**列表 + 高亮，用于搜索结果页
 */
export class DocumentSearchDto {
  /** 查询词；空串表示按条件浏览（不过滤关键词） */
  @IsOptional()
  @IsString()
  query?: string;

  /** 页码，从 1 开始 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** 每页条数 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;

  /** 分类过滤 */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** 作者过滤 */
  @IsOptional()
  @IsString()
  authorId?: string;

  /** 团队过滤 */
  @IsOptional()
  @IsString()
  teamId?: string;

  /**
   * 状态过滤，默认已发布。
   * 显式传 `status` 可覆盖（如后台管理需要检索草稿）。
   * 用 int 而非 enum：全局 ValidationPipe 开了 whitelist，
   * 枚举校验失败会直接 400，数字更利于 curl / 前端拼参数。
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2)
  status?: number;
}

/** 默认只召回已发布文档 */
export const DEFAULT_SEARCH_STATUS = DocumentStatus.Published;

/** 默认分页参数 */
export const DEFAULT_SEARCH_PAGE = 1;
export const DEFAULT_SEARCH_PAGE_SIZE = 10;
