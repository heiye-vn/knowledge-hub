import { Injectable, Logger } from '@nestjs/common';
import { ElasticsearchService } from './elasticsearch.service.js';
import type { DocumentChunk } from './types/rag.types.js';

export interface StoredDocumentChunk {
  chunkId: string;
  chunkIndex: number;
  totalChunks: number;
  heading: string | null;
  content: string;
  charLength: number;
  indexedAt: string | null;
}

/**
 * 向量索引存储（写入 ES `kh_chunk`）
 *
 * 核心功能：
 * - 按 document_id 级联删除旧分块（重建前清理，保证幂等）
 * - bulk 批量写入包含 dense_vector 的分块，以 chunkId 作为 _id 执行覆盖写入
 * - 索引创建与客户端实例统一收敛于 ElasticsearchService 托管
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

  /** 按文档 ID 读取已索引切块（按 chunk_index 升序，排除向量字段） */
  async findByDocumentId(
    documentId: string,
    maxChunks = 500,
  ): Promise<{ items: StoredDocumentChunk[]; total: number }> {
    if (!this.esService.isEnabled()) {
      return { items: [], total: 0 };
    }

    try {
      const res = await this.esService.getClient().search({
        index: this.esService.getIndexName(),
        query: { term: { document_id: documentId } },
        sort: [{ chunk_index: 'asc' }],
        size: maxChunks,
        _source: { excludes: ['embedding'] },
      });

      const items: StoredDocumentChunk[] = (res.hits?.hits ?? []).map(
        (hit) => {
          const src = (hit._source ?? {}) as Record<string, unknown>;
          const content = typeof src.content === 'string' ? src.content : '';
          return {
            chunkId:
              typeof src.chunk_id === 'string'
                ? src.chunk_id
                : String(hit._id ?? ''),
            chunkIndex:
              typeof src.chunk_index === 'number' ? src.chunk_index : 0,
            totalChunks:
              typeof src.total_chunks === 'number' ? src.total_chunks : 0,
            heading: typeof src.heading === 'string' ? src.heading : null,
            content,
            charLength: content.length,
            indexedAt:
              typeof src.indexed_at === 'string' ? src.indexed_at : null,
          };
        },
      );

      const rawTotal = res.hits?.total as
        | number
        | { value?: number }
        | undefined;
      const hitTotal =
        typeof rawTotal === 'number' ? rawTotal : (rawTotal?.value ?? 0);

      return {
        items,
        total: Math.max(hitTotal, items.length),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/index_not_found/i.test(message)) {
        return { items: [], total: 0 };
      }
      this.logger.error(
        `ES 查询文档切块失败：documentId=${documentId}, error=${message}`,
      );
      throw err;
    }
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
      is_public: chunk.isPublic ?? false,
      doc_status: chunk.docStatus ?? null,
      publish_time: chunk.publishTime ?? null,
      indexed_at: new Date().toISOString(),
    };

    if (chunk.embedding?.length) {
      doc.embedding = chunk.embedding;
    }
    return doc;
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
    if (!this.esService.isEnabled()) {
      this.logger.warn(
        `跳过更新向量块可见性（ES 不可用）：documentId=${documentId}`,
      );
      return 0;
    }

    try {
      const res = await this.esService.getClient().updateByQuery({
        index: this.esService.getIndexName(),
        query: { term: { document_id: documentId } },
        script: {
          lang: 'painless',
          source:
            'ctx._source.is_public = params.is_public; ctx._source.team_id = params.team_id; ctx._source.author_id = params.author_id;',
          params: {
            is_public: vis.isPublic,
            team_id: vis.teamId ?? null,
            author_id: vis.authorId ?? null,
          },
        },
        refresh: true,
      });
      const updated = (res as any).updated ?? 0;
      this.logger.log(
        `已更新文档向量块可见性：documentId=${documentId}, updatedChunks=${updated}`,
      );
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/index_not_found/i.test(message)) return 0;
      this.logger.error(
        `ES 更新向量块可见性失败：documentId=${documentId}, error=${message}`,
      );
      throw err;
    }
  }
}
