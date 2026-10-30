import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module.js';
import { SearchController } from './search.controller.js';
import { SearchIndexService } from './search-index.service.js';

/**
 * 文档级全文搜索模块
 *
 * 依赖 `RagModule` 复用 `ElasticsearchService` 的单例 client 与可用性判定。
 * 与 Embedding / 分块无强耦合——Search 不需要 Embedding Key，
 * 即使未配置向量模型密钥，全文检索服务依然保持可用。
 */
@Module({
  imports: [RagModule],
  controllers: [SearchController],
  providers: [SearchIndexService],
  exports: [SearchIndexService],
})
export class SearchModule {}
