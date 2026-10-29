import { Module } from '@nestjs/common';
import { DocumentService } from './document.service.js';
import { DocumentReviewService } from './document-review.service.js';
import { DocumentController } from './document.controller.js';
import { FileParserService } from './parser/file-parser.service.js';
import { MineruParser } from './parser/mineru.parser.js';
import { DocumentImportService } from './document-import.service.js';
import { DocumentImportController } from './document-import.controller.js';
import { DocumentImportQueue } from './document-import.queue.js';
import { RagModule } from '../rag/rag.module.js';
import { SearchModule } from '../search/search.module.js';
import { KgModule } from '../kg/kg.module.js';
import { IndexOutboxModule } from '../indexing/index-outbox.module.js';
import { CategoryService } from './category.service.js';
import { CategoryController } from './category.controller.js';
import { DocumentVersionService } from './document-version.service.js';
import { DocumentSocialService } from './document-social.service.js';
import { DocumentShareService } from './document-share.service.js';
import {
  DocumentEngagementController,
  FavoriteController,
} from './document-engagement.controller.js';
import { ShareController } from './share.controller.js';
import { NotificationModule } from '../notification/notification.module.js';
import { RedisModule } from '../redis/redis.module.js';

/**
 * 文档模块
 * - DocumentService：文档 CRUD + 状态流转（草稿 / 待审核 / 已发布 / 已归档）+ 索引联动
 * - DocumentReviewService：审核流水（kh_document_review）读写
 *
 * 依赖保持单向（DocumentService → DocumentReviewService）：
 * 状态迁移要连带索引联动，交给持有索引编排能力的 DocumentService 统一收口，
 * 审核服务只管自己那张表。
 */
@Module({
  imports: [
    // 发布时触发 RAG 管线（分块 → 嵌入 → ES kh_chunk）
    RagModule,
    // 发布 / 删除时同步维护文档级搜索索引（ES kh_document）
    SearchModule,
    // 发布 / 删除时投递 KG 建图 / 清理任务（BullMQ kg.graph 队列）
    KgModule,
    // 索引失败写入 outbox，由 IndexMaintenanceModule 的 Worker 重试
    IndexOutboxModule,
    // 互动通知写入（点赞 / 评论 / 回复）
    NotificationModule,
    // 分享密码失败限流（Redis INCR + TTL）
    RedisModule,
  ],
  controllers: [
    DocumentImportController,
    DocumentController,
    DocumentEngagementController,
    FavoriteController,
    CategoryController,
    ShareController,
  ],
  providers: [
    DocumentService,
    DocumentReviewService,
    FileParserService,
    MineruParser,
    DocumentImportService,
    DocumentImportQueue,
    CategoryService,
    DocumentVersionService,
    DocumentSocialService,
    DocumentShareService,
  ],
  exports: [DocumentService, DocumentReviewService, FileParserService],
})
export class DocumentModule {}
