import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { ChunkingService } from './chunking.service.js';
import { ElasticsearchService } from './elasticsearch.service.js';
import { EmbeddingService } from './embedding.service.js';
import { RagOrchestrator } from './rag.orchestrator.js';
import { RetrievalService } from './retrieval.service.js';
import { SearchController } from './search.controller.js';
import { VectorIndexService } from './vector-index.service.js';

/**
 * RAG 模块
 *
 * 命名刻意与基线实现 保持一致
 * （Chunking / Embedding / VectorIndex / Orchestrator），便于两个项目 grep 对照。
 *
 * 组成：
 * - ElasticsearchService：客户端 + `kh_chunk` 索引（IK + dense_vector）幂等初始化
 * - ChunkingService：Markdown 感知分块
 * - EmbeddingService：百炼 qwen3.7-text-embedding-flash，1024 维（延迟初始化，缺 Key 不阻断启动）
 * - VectorIndexService：ES 写入 / 按文档删除
 * - RagOrchestrator：分块 → 嵌入 → 索引 的编排
 * - RetrievalService：kNN + BM25 + RRF 混合检索（基线实现缺失，本项目补齐）
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
    RetrievalService,
  ],
  exports: [
    ElasticsearchService,
    ChunkingService,
    EmbeddingService,
    VectorIndexService,
    RagOrchestrator,
    RetrievalService,
  ],
})
export class RagModule {}
