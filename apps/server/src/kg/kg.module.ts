import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { DocumentContentEntity } from '../document/entities/document-content.entity.js';
import { RagModule } from '../rag/rag.module.js';
import { ExtractionService } from './extraction.service.js';
import { GraphBuildService } from './graph-build.service.js';
import { KgBuildPublisher } from './kg-build.publisher.js';
import { KgBuildWorker } from './kg-build.worker.js';
import { KgController } from './kg.controller.js';

/**
 * KG 知识图谱模块（feat-v5，对齐参考项目 knowledge-hub-backend v5 的 KG 管道）
 *
 * 组成：
 * - `ExtractionService`：LLM 结构化抽取实体 / 关系（ChatOpenAI + zod）
 * - `GraphBuildService`：Neo4j 建图 / 删图 / 约束 / 查询
 * - `KgBuildPublisher` / `KgBuildWorker`：BullMQ 第二队列 `kg.graph`
 *   （KG 单块抽取实测 19~57s，必须异步 —— 与 v4 Search 走同步正好相反）
 *
 * 🟡 **刻意不导入 DocumentModule**：DocumentModule 需要本模块的 `KgBuildPublisher`
 * 来在发布 / 删除时投递任务，反向导入会形成模块环。
 * 加载文档（按 ID 查 kh_document + kh_document_content，单库两表）由
 * `KgBuildWorker` 直接注入 EntityManager 完成，与 `DocumentService.loadForIndex` 同形。
 */
@Module({
  imports: [
    // 建图复用 RAG 同款分块（ChunkingService），保证图谱粒度与向量块一致
    RagModule,
    TypeOrmModule.forFeature([DocumentEntity, DocumentContentEntity]),
  ],
  controllers: [KgController],
  providers: [ExtractionService, GraphBuildService, KgBuildPublisher, KgBuildWorker],
  exports: [GraphBuildService, ExtractionService, KgBuildPublisher],
})
export class KgModule {}
