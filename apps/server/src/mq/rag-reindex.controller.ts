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
 * 🔵 相对基线实现的新增：基线实现只有「发布后自动投递」，没有手动/批量触发入口，
 * 因此换 embedding 模型后无法重建存量向量（只能靠重新发布）。
 * 本项目按**方案 B** 保持 publish 同步，故需要一个显式的批量重建入口，
 * 否则「换模型后全量重索引」（TODO 第 3 项）无解。
 *
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
