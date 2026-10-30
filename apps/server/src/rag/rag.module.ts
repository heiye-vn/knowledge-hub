import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { ChunkingService } from './chunking.service.js';
import { ElasticsearchService } from './elasticsearch.service.js';
import { EmbeddingService } from './embedding.service.js';
import { RagOrchestrator } from './rag.orchestrator.js';
import { RerankerService } from './reranker.service.js';
import { RetrievalService } from './retrieval.service.js';
import { SearchController } from './search.controller.js';
import { VectorIndexService } from './vector-index.service.js';

/**
 * RAG 检索增强生成模块
 *
 * 核心架构组件：
 * - ElasticsearchService：ES 客户端与 `kh_chunk` 索引（IK + dense_vector）初始化与连接管理
 * - ChunkingService：Markdown 结构感知分块
 * - EmbeddingService：文本向量化服务（延迟初始化，缺 Key 不阻断系统启动）
 * - VectorIndexService：ES 向量索引写入与按文档级联删除
 * - RagOrchestrator：分块 → 向量化 → 索引构建 全流程编排
 * - RetrievalService：kNN 向量 + BM25 关键词 + RRF 融合检索与重排精排
 */
@Module({
  imports: [
    // 检索侧需回 PG 复核文档是否已下线（ES 与 PG 无法共享事务）
    TypeOrmModule.forFeature([DocumentEntity]),
  ],
  controllers: [SearchController],
  providers: [
    ElasticsearchService,
    ChunkingService,
    EmbeddingService,
    VectorIndexService,
    RagOrchestrator,
    RerankerService,
    RetrievalService,
  ],
  exports: [
    ElasticsearchService,
    ChunkingService,
    EmbeddingService,
    VectorIndexService,
    RagOrchestrator,
    RerankerService,
    RetrievalService,
  ],
})
export class RagModule {}
