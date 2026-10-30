import {
  BadRequestException,
  Body,
  Controller,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DocumentService } from '../document/document.service.js';
import { ReindexDto } from './dto/reindex.dto.js';
import { RagReindexPublisher } from './rag-reindex.publisher.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RoleCode } from '../common/constants/roles.js';

/**
 * 触发 RAG 重建索引
 *
 * 提供显式的手动批量重建入口，支持换 embedding 模型或修复索引后对存量文档进行异步全量/指定重建。
 * publish 的响应语义不变，仍是同步返回 `indexed/chunks`。
 */
@Controller('rag')
export class RagReindexController {
  constructor(
    private readonly publisher: RagReindexPublisher,
    private readonly documentService: DocumentService,
  ) {}

  /**
   * 投递重建任务
   * - 传 `documentIds`：重建指定文档
   * - 省略：重建全部已发布文档（换模型后的标准操作）
   */
  @Post('reindex')
  @Roles(RoleCode.ADMIN)
  async reindex(@Body() dto: ReindexDto) {
    if (!this.publisher.isAvailable()) {
      throw new ServiceUnavailableException(
        '重建索引队列不可用（检查 REDIS_ENABLED 与 Redis 是否已启动）',
      );
    }

    const ids =
      dto.documentIds && dto.documentIds.length
        ? dto.documentIds
        : await this.documentService.findPublishedIds();

    if (!ids.length) {
      throw new BadRequestException('没有需要重建的文档');
    }

    return this.publisher.enqueue(ids);
  }
}
