import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { ElasticsearchService } from './elasticsearch.service.js';
import { EmbeddingService } from './embedding.service.js';
import {
  DocumentEntity,
  DocumentStatus,
} from '../document/entities/document.entity.js';
import type { SearchHit, SearchMode } from './types/rag.types.js';

export interface SearchParams {
  /** 用户查询词 */
  query: string;
  /** 检索模式；默认 hybrid */
  mode?: SearchMode;
  /** 返回条数；默认取 RAG_TOP_K */
  topK?: number;
  /** 结构化过滤（可选，随 RBAC 一起扩展可见性） */
  filters?: {
    categoryId?: string | null;
    teamId?: string | null;
    authorId?: string | null;
  };
}

/**
 * 混合检索服务（kNN 向量 + BM25 关键词 + RRF 融合）
 *
 * ✅ 相对参考项目的补齐（修其 P0）：参考项目「只写不读」，没有任何检索接口，
 * 向量写进 ES 后无法被使用。这里补齐 retrieval，并支持 `mode` 切换以做效果对比。
 *
 * 中文检索依赖 mapping 上显式配置的 IK 分析器；若退化成 standard 会按单字切分，精度显著下降。
 *
 * 一致性兜底：ES 与 PG 无法共享事务，删除文档时 ES 清理可能失败，
 * 因此检索后会回 PG 复核 `deleted=false && status=Published`，过滤掉已下线文档。
 *
 * ⚠️ **RRF 在应用层实现，不用 ES 原生 `retriever.rrf`**：
 * ES 8.17 免费版（basic license）执行 RRF 会抛
 * `security_exception: current license is non-compliant for [Reciprocal Rank Fusion (RRF)]`。
 * 应用层做融合不受 license 限制，且能同时保留两路原始分数便于调优。
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly esService: ElasticsearchService,
    private readonly embeddingService: EmbeddingService,
    private readonly config: ConfigService,
    @InjectEntityManager() private readonly em: EntityManager,
  ) {}

  /** 是否可用（ES 在线；keyword 模式不依赖 Embedding Key） */
  isAvailable(mode: SearchMode = 'hybrid'): boolean {
    if (!this.esService.isEnabled()) return false;
    return mode === 'keyword' || this.embeddingService.isConfigured();
  }

  async search(params: SearchParams): Promise<SearchHit[]> {
    const query = params.query?.trim();
    if (!query) return [];

    const mode: SearchMode = params.mode ?? 'hybrid';
    if (!this.isAvailable(mode)) {
      this.logger.warn(
        `检索链路不可用，返回空结果：mode=${mode}（检查 ELASTICSEARCH_ENABLED / EMBEDDING_API_KEY）`,
      );
      return [];
    }

    const topK = params.topK ?? Number(this.config.get('RAG_TOP_K', 5));
    const knnK = Number(this.config.get('RAG_KNN_K', 50));
    const knnCandidates = Number(this.config.get('RAG_KNN_CANDIDATES', 200));
    const rrfWindow = Number(this.config.get('RAG_RRF_WINDOW', 100));
    const rrfConstant = Number(this.config.get('RAG_RRF_CONSTANT', 60));

    const filterClauses = this.buildFilters(params.filters);

    const queryVector =
      mode === 'keyword' ? null : await this.embeddingService.embed(query);

    let candidates: SearchHit[];

    if (mode === 'hybrid' && queryVector) {
      // 两路并发召回，应用层 RRF 融合（ES 原生 RRF retriever 需商业 license，见类注释）
      const [vectorHits, keywordHits] = await Promise.all([
        this.runVectorSearch(
          queryVector,
          rrfWindow,
          knnK,
          knnCandidates,
          filterClauses,
        ),
        this.runKeywordSearch(query, rrfWindow, filterClauses),
      ]);

      candidates = this.reciprocalRankFusion(
        vectorHits,
        keywordHits,
        rrfConstant,
      ).slice(0, topK);
    } else if (mode === 'vector' && queryVector) {
      candidates = (
        await this.runVectorSearch(
          queryVector,
          topK,
          knnK,
          knnCandidates,
          filterClauses,
        )
      ).slice(0, topK);
    } else {
      candidates = (
        await this.runKeywordSearch(query, topK, filterClauses)
      ).slice(0, topK);
    }

    // 一致性兜底：剔除 PG 侧已删除或非已发布状态的文档
    const alive = await this.filterAliveDocumentIds(
      candidates.map((c) => c.documentId),
    );
    const results = candidates.filter((c) => alive.has(c.documentId));

    if (results.length !== candidates.length) {
      this.logger.warn(
        `检索结果已过滤下线文档：${candidates.length} → ${results.length}`,
      );
    }

    return results;
  }

  /**
   * kNN 向量召回
   *
   * ⚠️ **必须过滤低分**：kNN 是「找最近的 K 个」，**永远会返回 topK 条**，
   * 即使查询与知识库完全无关也会硬凑出结果（实测不相关查询相似度仍有 0.62~0.71）。
   * 低分结果喂给 LLM 就是噪声，甚至导致幻觉，因此按 `RAG_MIN_SCORE` 设下限。
   * （BM25 天然无此问题：无词项匹配就不返回。）
   */
  private async runVectorSearch(
    queryVector: number[],
    size: number,
    knnK: number,
    knnCandidates: number,
    filterClauses: Record<string, unknown>[],
  ): Promise<SearchHit[]> {
    const res = await this.esService.getClient().search({
      index: this.esService.getIndexName(),
      size,
      _source: { excludes: ['embedding'] },
      knn: {
        field: 'embedding',
        query_vector: queryVector,
        k: knnK,
        num_candidates: knnCandidates,
        ...(filterClauses.length
          ? { filter: { bool: { filter: filterClauses } } }
          : {}),
      },
    });

    const hits = this.toSearchHits(res, 'vector');
    // 默认 0.72：由实测校准（详见 .env 注释）。
    // 注意此处的 score 是 ES 对 cosine 的映射值 (1+cos)/2 ∈ [0,1]，不是原始余弦值。
    const minScore = Number(this.config.get('RAG_MIN_SCORE', 0.72));

    const kept = hits.filter((h) => (h.scores.vector ?? 0) >= minScore);
    if (kept.length !== hits.length) {
      this.logger.debug(
        `向量召回按 RAG_MIN_SCORE=${minScore} 过滤：${hits.length} → ${kept.length}`,
      );
    }
    return kept;
  }

  /** BM25 关键词召回（走 IK 分词） */
  private async runKeywordSearch(
    query: string,
    size: number,
    filterClauses: Record<string, unknown>[],
  ): Promise<SearchHit[]> {
    const res = await this.esService.getClient().search({
      index: this.esService.getIndexName(),
      size,
      _source: { excludes: ['embedding'] },
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                // 标题权重高于正文
                fields: ['document_title^2', 'content'],
              },
            },
          ],
          ...(filterClauses.length ? { filter: filterClauses } : {}),
        },
      },
    });

    return this.toSearchHits(res, 'keyword');
  }

  private toSearchHits(
    res: unknown,
    source: 'vector' | 'keyword',
  ): SearchHit[] {
    const hits = ((res as any)?.hits?.hits ?? []) as Array<{
      _id: string;
      _score: number | null;
      _source: Record<string, any>;
    }>;

    return hits.map((hit) => ({
      chunkId: hit._id,
      documentId: String(hit._source.document_id ?? ''),
      documentTitle: String(hit._source.document_title ?? ''),
      content: String(hit._source.content ?? ''),
      heading: hit._source.heading ?? null,
      chunkIndex: Number(hit._source.chunk_index ?? 0),
      totalChunks: Number(hit._source.total_chunks ?? 0),
      score: hit._score ?? 0,
      scores: {
        vector: source === 'vector' ? (hit._score ?? 0) : null,
        keyword: source === 'keyword' ? (hit._score ?? 0) : null,
      },
    }));
  }

  /**
   * 应用层 RRF（Reciprocal Rank Fusion）：score = Σ 1/(k + rank_i)
   *
   * 相比 ES 原生 RRF retriever 的额外收益：能同时保留两路原始分数（scores.vector / scores.keyword），
   * 便于效果调优时对比「向量召回 vs 关键词召回」各自的贡献。
   */
  private reciprocalRankFusion(
    vectorHits: SearchHit[],
    keywordHits: SearchHit[],
    rankConstant: number,
  ): SearchHit[] {
    const fused = new Map<string, SearchHit>();

    const collect = (hits: SearchHit[], kind: 'vector' | 'keyword') => {
      hits.forEach((hit, index) => {
        const rank = index + 1; // RRF rank 从 1 开始
        const existing = fused.get(hit.chunkId);

        if (!existing) {
          fused.set(hit.chunkId, {
            ...hit,
            score: 1 / (rankConstant + rank),
            scores: {
              vector: kind === 'vector' ? hit.score : null,
              keyword: kind === 'keyword' ? hit.score : null,
            },
          });
          return;
        }

        existing.score += 1 / (rankConstant + rank);
        if (kind === 'vector') existing.scores.vector = hit.score;
        else existing.scores.keyword = hit.score;
      });
    };

    collect(vectorHits, 'vector');
    collect(keywordHits, 'keyword');

    return [...fused.values()].sort((a, b) => b.score - a.score);
  }

  /** 结构化过滤条件：默认只检索已发布文档 */
  private buildFilters(
    filters?: SearchParams['filters'],
  ): Record<string, unknown>[] {
    const clauses: Record<string, unknown>[] = [
      { term: { doc_status: DocumentStatus.Published } },
    ];

    if (filters?.categoryId) {
      clauses.push({ term: { category_id: filters.categoryId } });
    }
    if (filters?.teamId) {
      clauses.push({ term: { team_id: filters.teamId } });
    }
    if (filters?.authorId) {
      clauses.push({ term: { author_id: filters.authorId } });
    }
    return clauses;
  }

  /** 回 PG 复核文档仍「未删除且已发布」 */
  private async filterAliveDocumentIds(
    documentIds: string[],
  ): Promise<Set<string>> {
    const unique = Array.from(new Set(documentIds.filter(Boolean)));
    if (!unique.length) return new Set();

    // 只取 id 一列，不拉整行
    const rows = await this.em.find(DocumentEntity, {
      where: {
        id: In(unique),
        deleted: false,
        status: DocumentStatus.Published,
      },
      select: { id: true },
    });

    return new Set(rows.map((r) => String(r.id)));
  }
}
