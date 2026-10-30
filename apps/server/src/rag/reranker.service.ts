import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SearchHit } from './types/rag.types.js';

interface DashScopeRerankResponse {
  output?: {
    results?: Array<{
      index: number;
      relevance_score: number;
    }>;
  };
  message?: string;
  code?: string;
}

/** 单条候选送进 rerank 的正文上限（防超长拖慢打分） */
const MAX_DOCUMENT_CHARS = 2000;

/**
 * 检索精排服务（Rerank，feat-v11）
 *
 * 对 RRF 粗融合后的候选分块，调用文本重排模型按与 query 的语义相关性打分重排。
 *
 * 【架构设计与降级策略】
 * - **Key 回退链**：`RERANK_API_KEY` → `LLM_API_KEY` → `EMBEDDING_API_KEY` → `OPENAI_API_KEY`。
 * - **默认模型**：`qwen3.7-text-rerank`，与 embedding 同代且共享凭证额度。
 * - **平滑降级**：未配置 / 调用失败 / 返回空结果时返回 null，
 *   自动回退为 RRF 融合排序，保证检索链路高可用。
 */
@Injectable()
export class RerankerService {
  private readonly logger = new Logger(RerankerService.name);
  private readonly enabled: boolean;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(config: ConfigService) {
    this.enabled =
      config.get<string>('RAG_RERANK_ENABLED', 'true') !== 'false';
    this.apiKey =
      config.get<string>('RERANK_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      undefined;
    this.model = config.get('RERANK_MODEL', 'qwen3.7-text-rerank');
    const host = config.get('RERANK_BASE_URL', 'https://dashscope.aliyuncs.com');
    this.endpoint = `${host.replace(/\/$/, '')}/api/v1/services/rerank/text-rerank/text-rerank`;
  }

  /** 是否可用（开关开 + Key 已配置） */
  isEnabled(): boolean {
    return this.enabled && Boolean(this.apiKey);
  }

  /**
   * 按 query 与候选块的相关性重排，取 topN。
   * @returns 重排后的命中（score 已替换为相关性分）；不可用或失败时返回 null，
   *          由上层降级为 RRF 顺序
   */
  async rerank(
    query: string,
    candidates: SearchHit[],
    topN: number,
  ): Promise<SearchHit[] | null> {
    if (!candidates.length) return [];
    if (!this.isEnabled()) {
      this.logger.warn('Reranker 未启用或未配置 Key，跳过重排');
      return null;
    }

    const documents = candidates.map((hit) => this.toDocument(hit));
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: { query, documents },
          parameters: {
            return_documents: false,
            top_n: Math.min(topN, candidates.length),
          },
        }),
      });

      const body = (await response.json()) as DashScopeRerankResponse;
      if (!response.ok) {
        this.logger.warn(
          `Rerank 调用失败：status=${response.status}, code=${body.code ?? ''}, message=${body.message ?? ''}`,
        );
        return null;
      }

      const results = body.output?.results ?? [];
      if (!results.length) {
        this.logger.warn('Rerank 返回空结果，降级为 RRF 顺序');
        return null;
      }

      // 索引越界的条目直接丢弃（防御上游模型的异常响应）
      const reranked = results
        .filter((item) => item.index >= 0 && item.index < candidates.length)
        .map((item) => ({
          ...candidates[item.index],
          score: item.relevance_score,
        }));

      this.logger.log(
        `Rerank 完成：model=${this.model}, in=${candidates.length}, out=${reranked.length}`,
      );
      return reranked;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Rerank 异常，降级为 RRF 顺序：${message}`);
      return null;
    }
  }

  /** 候选块 → rerank 文档：标题 + heading + 正文，超长截断 */
  private toDocument(hit: SearchHit): string {
    const heading = hit.heading ? `${hit.heading}\n` : '';
    const text = `${hit.documentTitle}\n${heading}${hit.content}`.trim();
    return text.length > MAX_DOCUMENT_CHARS
      ? `${text.slice(0, MAX_DOCUMENT_CHARS)}...`
      : text;
  }
}
