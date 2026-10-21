import { Module } from '@nestjs/common';
import { DocumentModule } from '../document/document.module.js';
import { KgModule } from '../kg/kg.module.js';
import { RagModule } from '../rag/rag.module.js';
import { SearchModule } from '../search/search.module.js';
import { IndexMaintenanceController } from './index-maintenance.controller.js';
import { IndexOutboxModule } from './index-outbox.module.js';
import { IndexOutboxWorker } from './index-outbox.worker.js';
import { VisibilityPatrolService } from './visibility-patrol.service.js';

/**
 * 索引运维模块：失败补偿 Worker + 可见性巡检 + 管理员入口。
 *
 * 依赖方向：本模块 → DocumentModule → IndexOutboxModule（单向）。
 * Worker 复用 DocumentService.loadForIndex 加载待补偿文档，与重建队列同一条路径。
 */
@Module({
  imports: [
    DocumentModule,
    RagModule,
    SearchModule,
    KgModule,
    IndexOutboxModule,
  ],
  controllers: [IndexMaintenanceController],
  providers: [IndexOutboxWorker, VisibilityPatrolService],
})
export class IndexMaintenanceModule {}
