import { Module } from '@nestjs/common';
import { IndexOutboxService } from './index-outbox.service.js';

/**
 * 索引失败 outbox（仅读写能力）。
 *
 * 【为什么拆成两个模块】DocumentModule 需要在索引失败时写 outbox，
 * 而补偿 Worker 又需要 DocumentModule 来加载文档——若放在同一模块会形成环。
 * 本模块不依赖任何业务模块，供 DocumentModule 单向导入。
 */
@Module({
  providers: [IndexOutboxService],
  exports: [IndexOutboxService],
})
export class IndexOutboxModule {}
