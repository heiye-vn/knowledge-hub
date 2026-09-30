import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { RetrievalService } from './retrieval.service.js';
import { SearchDto } from './dto/search.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

/**
 * 知识检索接口
 *
 * ✅ 相对基线实现的补齐：基线实现没有检索接口（向量写进 ES 却无法被查询）。
 * 支持三种 mode，便于对比「纯向量 / 纯关键词 / 混合」的实际效果。
 *
 * 鉴权（feat-v11 起）：search 权限码——基线 v11 的 /rag/search 同款收紧，
 * 此前为裸 JWT。路由保持 /search（基线是 /rag/search，分叉已登记）。
 */
@Controller('search')
export class SearchController {
  constructor(private readonly retrievalService: RetrievalService) {}

  /** 检索（POST，查询词可含特殊字符与中文，放 body 更稳妥） */
  @Post()
  @RequirePermission('search')
  search(@Body() dto: SearchDto) {
    return this.retrievalService.search({
      query: dto.query,
      mode: dto.mode,
      topK: dto.topK,
      filters: {
        categoryId: dto.categoryId ?? null,
        teamId: dto.teamId ?? null,
        authorId: dto.authorId ?? null,
      },
    });
  }

  /** 检索（GET 便捷版，供 curl / 浏览器快速验证） */
  @Get()
  @RequirePermission('search')
  searchByQuery(@Query() dto: SearchDto) {
    return this.retrievalService.search({
      query: dto.query,
      mode: dto.mode,
      topK: dto.topK,
      filters: {
        categoryId: dto.categoryId ?? null,
        teamId: dto.teamId ?? null,
        authorId: dto.authorId ?? null,
      },
    });
  }
}
