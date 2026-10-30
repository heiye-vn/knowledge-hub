import { Injectable, Logger } from '@nestjs/common';
import { ChunkingService } from './chunking.service.js';
import { ElasticsearchService } from './elasticsearch.service.js';
import { EmbeddingService } from './embedding.service.js';
import { VectorIndexService } from './vector-index.service.js';
import type { PipelineDocument } from './types/rag.types.js';

export interface IndexResult {
  documentId: string;
  /** 写入 ES 的块数 */
  chunks: number;
}

/**
 * RAG 管线编排器：分块 → Embedding → ES kh_chunk
 *
 * 【职责与分层设计】
 * `indexDocument(s)` 接收已加载完成的 `PipelineDocument`，数据加载职责留在调用方，
 * 编排器纯粹负责流水线转换：分块 → 向量计算 → 写入 ES。
 * 无论同步发布还是异步队列消费，均复用此纯净编排管线。
 *
 * 幂等性：先按 document_id 删旧块，再以 chunkId 为 _id 执行 upsert 覆盖写。
 */
@Injectable()
export class RagOrchestrator {
  private readonly logger = new Logger(RagOrchestrator.name);

  constructor(
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorIndexService: VectorIndexService,
    private readonly esService: ElasticsearchService,
  ) {}

  /**
   * 索引链路是否可用（ES 在线 且 已配置 Embedding Key）。
   * 调用方可据此决定「跳过索引但仍允许发布」，避免发布动作被基础设施故障阻断。
   */
  isAvailable(): boolean {
    return this.esService.isEnabled() && this.embeddingService.isConfigured();
  }

  /** 单篇索引：清旧块 → 分块 → 批量嵌入 → 落 ES。失败直接抛出，由调用方决定如何处理 */
  async indexDocument(doc: PipelineDocument): Promise<IndexResult> {
    if (!doc.content?.trim()) {
      this.logger.warn(`文档内容为空，跳过 RAG：documentId=${doc.id}`);
      return { documentId: doc.id, chunks: 0 };
    }

    // 先清旧块，避免重复发布时脏数据残留
    await this.vectorIndexService.deleteByDocumentId(doc.id);

    const chunks = await this.chunkingService.chunk({
      content: doc.content,
      documentId: doc.id,
      documentTitle: doc.title,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      docStatus: doc.status,
      isPublic: doc.isPublic,
      publishTime: this.toIsoDate(doc.publishTime),
    });

    if (!chunks.length) {
      return { documentId: doc.id, chunks: 0 };
    }

    const embeddings = await this.embeddingService.embedBatch(
      chunks.map((c) => c.content),
    );
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = embeddings[i];
    }

    await this.vectorIndexService.indexChunks(chunks);
    this.logger.log(
      `RAG 索引完成：documentId=${doc.id}, chunks=${chunks.length}`,
    );

    return { documentId: doc.id, chunks: chunks.length };
  }

  /**
   * 批量索引：单篇失败不影响其余文档，返回成功/失败明细。
   * 阶段二接入队列后由 consumer 调用（届时失败可重试，现阶段只记录）。
   */
  async indexDocuments(docs: PipelineDocument[]): Promise<{
    succeeded: IndexResult[];
    failed: Array<{ documentId: string; message: string }>;
  }> {
    const succeeded: IndexResult[] = [];
    const failed: Array<{ documentId: string; message: string }> = [];

    for (const doc of docs) {
      try {
        succeeded.push(await this.indexDocument(doc));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`RAG 索引失败：documentId=${doc.id}, ${message}`);
        failed.push({ documentId: doc.id, message });
      }
    }

    return { succeeded, failed };
  }

  /**
   * 删除某文档的全部向量块（文档下线 / 删除时调用）
   *
   * 【索引生命周期同步】文档软删除后显式同步清理 ES 向量块，防止已下线文档被检索召回。
   * 注：ES 与 PG 无法共享事务，清理失败只记日志，检索侧还有兜底过滤（见 RetrievalService）。
   */
  async deleteDocument(documentId: string): Promise<void> {
    await this.vectorIndexService.deleteByDocumentId(documentId);
  }

  /** 原地更新文档向量块的可见性（is_public, team_id, author_id） */
  async updateVisibility(
    documentId: string,
    vis: {
      isPublic: boolean;
      teamId?: string | null;
      authorId?: string | null;
    },
  ): Promise<number> {
    return this.vectorIndexService.updateVisibility(documentId, vis);
  }

  /**
   * 探测缺 is_public 字段的向量块数量（存量数据缺口统计）
   */
  async countMissingVisibilityChunks(): Promise<number> {
    if (!this.esService.isEnabled()) return 0;
    try {
      const client = this.esService.getClient();
      const res = await client.count({
        index: this.esService.getIndexName(),
        query: {
          bool: {
            must_not: [{ exists: { field: 'is_public' } }],
          },
        },
      });
      return res.count ?? 0;
    } catch (err) {
      this.logger.warn(
        `探测 ES 存量向量块缺口失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * 存量向量块可见性回填：逐文档调用 updateVisibility（幂等，可重复执行）
   */
  async backfillVisibility(
    docs: Array<{
      id: string;
      isPublic: boolean;
      teamId?: string | null;
      authorId?: string | null;
    }>,
  ): Promise<number> {
    let totalUpdated = 0;
    for (const doc of docs) {
      try {
        const count = await this.vectorIndexService.updateVisibility(doc.id, {
          isPublic: doc.isPublic,
          teamId: doc.teamId,
          authorId: doc.authorId,
        });
        totalUpdated += count;
      } catch (err) {
        this.logger.warn(
          `回填文档向量可见性失败：documentId=${doc.id}, ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return totalUpdated;
  }

  /** ES date 字段需要 ISO-8601；Date#toString() 会被拒绝 */
  private toIsoDate(value?: Date | string | null): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
}
