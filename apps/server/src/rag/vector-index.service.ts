import { Injectable, Logger } from '@nestjs/common';
import { ElasticsearchService } from './elasticsearch.service.js';
import type { DocumentChunk } from './types/rag.types.js';

/**
 * 向量索引存储（写入 ES `kh_chunk`）
 *
 * 职责与参考项目 knowledge-hub-backend 对齐：
 * - 按 document_id 删除旧块（重建前先清，保证幂等）
 * - bulk 写入带 embedding 的 chunk，`_id = chunkId` 可覆盖写
 *
 * ✅ 相对参考项目的改进：索引创建/客户端统一委托给 ElasticsearchService，
 * 避免多处各自 new Client 与各自建索引（参考项目里 createIndexIfNotExists 分散且无并发保护）。
 */
@Injectable()
export class VectorIndexService {
  private readonly logger = new Logger(VectorIndexService.name);

  constructor(private readonly esService: ElasticsearchService) {}

  /** 删除某文档全部向量块（发布重建 / 删除文档时调用） */
  async deleteByDocumentId(documentId: string): Promise<void> {
    if (!this.esService.isEnabled()) {
      this.logger.warn(
        `跳过删除向量块（ES 不可用）：documentId=${documentId}`,
      );
      return;
    }

    try {
      await this.esService.getClient().deleteByQuery({
        index: this.esService.getIndexName(),
        query: { term: { document_id: documentId } },
        refresh: true,
      });
      this.logger.log(`已从 ES 删除文档向量块：documentId=${documentId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 索引尚不存在时视为已删除
      if (/index_not_found/i.test(message)) return;

      this.logger.error(
        `ES 删除文档块失败：documentId=${documentId}, error=${message}`,
      );
      throw err;
    }
  }

  /** bulk 写入 / 覆盖 chunk（_id = chunkId，重复发布幂等） */
  async indexChunks(chunks: DocumentChunk[]): Promise<void> {
    if (!chunks.length) return;

    if (!this.esService.isEnabled()) {
      this.logger.warn(
        `跳过向量索引写入（ES 不可用）：chunks=${chunks.length}`,
      );
      return;
    }

    await this.esService.ensureIndex();

    const index = this.esService.getIndexName();
    const operations = chunks.flatMap((chunk) => [
      { index: { _index: index, _id: chunk.chunkId } },
      this.buildDocMap(chunk),
    ]);

    const response = await this.esService
      .getClient()
      .bulk({ refresh: true, operations });

    if (response.errors) {
      const failed = (response.items ?? [])
        .filter((item: any) => item.index?.error)
        .map(
          (item: any) =>
            `${item.index?._id}: ${item.index?.error?.reason ?? 'unknown'}`,
        );

      this.logger.error(`ES 批量索引部分失败：${failed.join(', ')}`);
      throw new Error(`ES 批量索引部分失败：${failed.length} 条`);
    }

    this.logger.log(
      `ES 批量索引成功：${chunks.length} chunks → ${index}`,
    );
  }

  private buildDocMap(chunk: DocumentChunk): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      chunk_id: chunk.chunkId,
      document_id: chunk.documentId,
      document_title: chunk.documentTitle,
      content: chunk.content,
      heading: chunk.heading ?? null,
      chunk_index: chunk.chunkIndex,
      total_chunks: chunk.totalChunks,
      category_id: chunk.categoryId ?? null,
      author_id: chunk.authorId ?? null,
      team_id: chunk.teamId ?? null,
      doc_status: chunk.docStatus ?? null,
      publish_time: chunk.publishTime ?? null,
      indexed_at: new Date().toISOString(),
    };

    if (chunk.embedding?.length) {
      doc.embedding = chunk.embedding;
    }
    return doc;
  }
}
