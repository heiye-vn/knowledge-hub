import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module.js';
import { SearchController } from './search.controller.js';
import { SearchIndexService } from './search-index.service.js';

/**
 * 文档级全文搜索模块
 *
 * 对应参考项目 knowledge-hub-backend v4 的 `SearchIndexService`
 * （它放在 `pipeline/` 下；本项目 RAG 与 Search 是两个关注点，故独立成模块）。
 *
 * 依赖 `RagModule` 只为复用 `ElasticsearchService` 的单例 client 与降级判定；
 * 与 Embedding / 分块无耦合——**Search 不需要 Embedding Key**，
 * 因此「ES 可用但没配 Key」时，文档搜索仍可用，只是 RAG 语义检索不可用。
 */
@Module({
  imports: [RagModule],
  controllers: [SearchController],
  providers: [SearchIndexService],
  exports: [SearchIndexService],
})
export class SearchModule {}
