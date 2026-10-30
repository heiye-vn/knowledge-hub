import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { accessFromUser } from '../document/document-access.js';
import {
  DEFAULT_SEARCH_PAGE,
  DEFAULT_SEARCH_PAGE_SIZE,
  DEFAULT_SEARCH_STATUS,
  DocumentSearchDto,
} from './dto/document-search.dto.js';
import { SearchIndexService } from './search-index.service.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

/**
 * 文档级全文检索
 *
 * 基于 ES `kh_document` 索引提供全文关键词检索，支持高亮与多维度过滤。
 * 路由设计：`/search/documents` 区分于块级 RAG 检索（`POST /search`）。
 * 鉴权：统一要求 `search` 权限码。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly searchIndexService: SearchIndexService) {}

  /** 检索（POST：查询词可能含中文与特殊字符，放 body 更稳妥） */
  @Post('documents')
  @RequirePermission('search')
  search(@Body() dto: DocumentSearchDto, @CurrentUser() user: AuthUser) {
    return this.searchIndexService.search(
      this.toParams(dto),
      accessFromUser(user),
    );
  }

  /** 检索（GET 便捷版，供 curl / 浏览器快速验证） */
  @Get('documents')
  @RequirePermission('search')
  searchByQuery(@Query() dto: DocumentSearchDto, @CurrentUser() user: AuthUser) {
    return this.searchIndexService.search(
      this.toParams(dto),
      accessFromUser(user),
    );
  }

  private toParams(dto: DocumentSearchDto) {
    return {
      query: dto.query ?? '',
      page: dto.page ?? DEFAULT_SEARCH_PAGE,
      pageSize: dto.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE,
      categoryId: dto.categoryId ?? null,
      authorId: dto.authorId ?? null,
      teamId: dto.teamId ?? null,
      status: dto.status ?? DEFAULT_SEARCH_STATUS,
    };
  }
}
