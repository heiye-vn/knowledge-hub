import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { GraphBuildService } from './graph-build.service.js';
import { KgBuildPublisher } from './kg-build.publisher.js';
import { GraphEntitiesDto, GraphNeighborsDto } from './dto/graph-query.dto.js';

/** 手动建图 / 删图请求体 */
export class KgBuildDto {
  /**
   * 待建图文档 ID 列表；
   * 省略 = 全量重建所有已发布文档（换模型 / 修 bug 后的标准操作）
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  documentIds?: string[];
}

/**
 * KG 知识图谱接口
 *
 * 🔵 **相对参考项目的新增**：
 * - 参考项目 v5 只写了图、没有查询接口（`src/graph/graph.controller.ts` 要到 v10 才有），
 *   本项目在 feat-v5 直接补齐，避免第三次「只写不读」。
 * - 参考项目的 `BUILD_ALL` 消息类型**没有任何投递入口**（死代码）；
 *   本项目 `POST /kg/build` 不传 documentIds 即全量重建。
 *
 * 触发时机：publish 自动投递单篇建图；此处提供手动批量入口。
 */
@Controller('kg')
export class KgController {
  constructor(
    private readonly graphBuildService: GraphBuildService,
    private readonly kgBuildPublisher: KgBuildPublisher,
  ) {}

  /** 手动触发建图：传 documentIds 建指定文档，省略则全量重建已发布文档 */
  @Post('build')
  async build(@Body() dto: KgBuildDto) {
    if (!this.kgBuildPublisher.isAvailable()) {
      throw new ServiceUnavailableException(
        'KG 建图队列不可用（检查 REDIS_ENABLED 与 Redis 是否已启动）',
      );
    }
    if (!this.graphBuildService.isAvailable()) {
      throw new ServiceUnavailableException(
        'Neo4j 不可用（检查 NEO4J_ENABLED 与容器状态）',
      );
    }

    const taskId =
      dto.documentIds && dto.documentIds.length
        ? await this.kgBuildPublisher.enqueueBuildByDocIds(dto.documentIds)
        : await this.kgBuildPublisher.enqueueBuildAll();

    if (!taskId) {
      throw new ServiceUnavailableException('KG 建图任务入队失败');
    }
    return {
      taskId,
      queued: dto.documentIds?.length ?? 'all',
    };
  }

  /** 手动清理某篇文档的图谱（删除链路会自动触发，此处用于纠错） */
  @Delete('documents/:id')
  async removeGraph(@Param('id') id: string) {
    if (!this.graphBuildService.isAvailable()) {
      throw new ServiceUnavailableException('Neo4j 不可用');
    }
    await this.graphBuildService.deleteForDocument(id);
    return { id, deleted: true };
  }

  /** 图规模统计：文档 / 块 / 实体 / 关系 数量 */
  @Get('stats')
  async stats() {
    return this.graphBuildService.getStats();
  }

  /** 实体检索：按关键词过滤，按被提及次数倒序 */
  @Get('entities')
  async entities(@Query() dto: GraphEntitiesDto) {
    return this.graphBuildService.listEntities(dto.keyword ?? '', dto.limit ?? 20);
  }

  /** 邻居查询：某实体的全部关联实体与关系语义 */
  @Get('neighbors')
  async neighbors(@Query() dto: GraphNeighborsDto) {
    return this.graphBuildService.getNeighbors(dto.name, dto.limit ?? 20);
  }
}
