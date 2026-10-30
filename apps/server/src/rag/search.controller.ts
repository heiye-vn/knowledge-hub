import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { RetrievalService } from './retrieval.service.js';
import { SearchDto } from './dto/search.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { accessFromUser } from '../document/document-access.js';

/**
 * 知识检索接口
 *
 * 支持 vector（纯向量）/ keyword（纯关键词）/ hybrid（混合）三种模式。
 * 权限要求：拥有 `search` 权限码。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly retrievalService: RetrievalService) {}

  /** 检索（POST，查询词可含特殊字符与中文，放 body 更稳妥） */
  @Post()
  @RequirePermission('search')
  search(@Body() dto: SearchDto, @CurrentUser() user: AuthUser) {
    return this.retrievalService.search(
      {
        query: dto.query,
        mode: dto.mode,
        topK: dto.topK,
        filters: {
          categoryId: dto.categoryId ?? null,
          teamId: dto.teamId ?? null,
          authorId: dto.authorId ?? null,
        },
      },
      accessFromUser(user),
    );
  }

  /** 检索（GET 便捷版，供 curl / 浏览器快速验证） */
  @Get()
  @RequirePermission('search')
  searchByQuery(@Query() dto: SearchDto, @CurrentUser() user: AuthUser) {
    return this.retrievalService.search(
      {
        query: dto.query,
        mode: dto.mode,
        topK: dto.topK,
        filters: {
          categoryId: dto.categoryId ?? null,
          teamId: dto.teamId ?? null,
          authorId: dto.authorId ?? null,
        },
      },
      accessFromUser(user),
    );
  }
}
