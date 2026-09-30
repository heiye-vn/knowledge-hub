import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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
 * 对应基线实现 v4 写入的 ES `kh_document`，
 * 🔵 **相对基线实现的新增**：基线实现 v4 只写了索引、没有暴露任何读接口
 * （前端基线实现依赖的 `POST /search` 文档级搜索在参考后端里是缺的）。
 *
 * 路由为什么是 `/search/documents` 而不是 `/search`：
 * `/search` 已被块级 RAG 检索占用（`rag/search.controller.ts`），
 * 此处加子路径避免破坏既有契约。
 *
 * 鉴权（feat-v10 起）：权限码 `search`（菜单「搜索」与接口共用同一编码，
 * 与参考实现 v10 一致）；管理员由 PermissionsGuard 短路。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly searchIndexService: SearchIndexService) {}

  /** 检索（POST：查询词可能含中文与特殊字符，放 body 更稳妥） */
  @Post('documents')
  @RequirePermission('search')
  search(@Body() dto: DocumentSearchDto) {
    return this.searchIndexService.search(this.toParams(dto));
  }

  /** 检索（GET 便捷版，供 curl / 浏览器快速验证） */
  @Get('documents')
  @RequirePermission('search')
  searchByQuery(@Query() dto: DocumentSearchDto) {
    return this.searchIndexService.search(this.toParams(dto));
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
