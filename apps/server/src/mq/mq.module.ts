import { Module } from '@nestjs/common';
import { DocumentModule } from '../document/document.module.js';
import { RagModule } from '../rag/rag.module.js';
import { SearchModule } from '../search/search.module.js';
import { RagReindexController } from './rag-reindex.controller.js';
import { RagReindexPublisher } from './rag-reindex.publisher.js';
import { RagReindexWorker } from './rag-reindex.worker.js';

/**
 * 异步队列模块（BullMQ + Redis）
 *
 * 对应参考项目 `mq/mq.module.ts`（RabbitMQ，且是 @Global）。
 * 🟡 分叉：本项目不设 @Global —— 只有控制器和 Worker 用得到队列，
 * 显式导入比全局注入更容易看清依赖。
 *
 * 组成：
 * - `RagReindexPublisher`：投递重建任务（含重试/退避的 defaultJobOptions）
 * - `RagReindexWorker`：消费，按 ID 加载文档 → 复用 RagOrchestrator 的同一条管线
 * - `RagReindexController`：`POST /rag/reindex` 触发入口
 */
@Module({
  imports: [RagModule, DocumentModule, SearchModule],
  controllers: [RagReindexController],
  providers: [RagReindexPublisher, RagReindexWorker],
  exports: [RagReindexPublisher],
})
export class MqModule {}
