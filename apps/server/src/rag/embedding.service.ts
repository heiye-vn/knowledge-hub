import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

/** 默认模型：qwen3.7-text-embedding-flash（1024 维，性价比高，128K 上下文） */
const DEFAULT_MODEL = 'qwen3.7-text-embedding-flash';

/**
 * 百炼各文本向量模型「单次请求文本条数」上限（超过会 400 InvalidParameter）：
 * - `text-embedding-v3` / `text-embedding-v4`：10
 * - `qwen3.7-text-embedding` / `qwen3.7-text-embedding-flash`：20
 *
 * 当前默认模型是 flash（上限 20），故默认取 20。
 * 换回 v3/v4 时若不想改代码，用 `EMBEDDING_MAX_BATCH_SIZE=10` 覆盖即可。
 */
const DEFAULT_MAX_BATCH = 20;

/**
 * 文本向量化服务（LangChain OpenAIEmbeddings + 阿里云百炼 OpenAI 兼容协议）
 *
 * 与基线实现 对齐：同维度、同 batch 钳制机制、同 stripNewLines=false；
 * 模型不同（基线实现 v3，本项目 qwen3.7-flash），但两者默认维度都是 1024，索引结构无需变更。
 *
 * ✅ 相对基线实现的改进（修其 P1）：基线实现在**构造函数**中因缺 API Key 直接 throw，
 * 会拖垮整个应用启动 —— 没配 Key 连 /health 都起不来。
 * 这里改为**延迟初始化**：首次使用时才构造，失败抛明确业务异常并记录日志，不影响启动。
 *
 * ⚠️ **换模型 = 全量重索引**：不同模型的向量空间不兼容，即使维度相同，
 * 旧向量与新查询向量算相似度没有意义。切换 EMBEDDING_MODEL 后必须重跑所有文档的索引。
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  /** 向量维度，需与 ES kh_chunk.embedding.dims 一致 */
  private readonly dimension: number;
  private readonly batchSize: number;
  private embeddings: OpenAIEmbeddings | null = null;

  constructor(private readonly config: ConfigService) {
    this.dimension = Number(this.config.get('EMBEDDING_DIMENSION', 1024));

    const maxBatchConfigured = Number(
      this.config.get('EMBEDDING_MAX_BATCH_SIZE', DEFAULT_MAX_BATCH),
    );
    const maxBatch =
      Number.isFinite(maxBatchConfigured) && maxBatchConfigured > 0
        ? maxBatchConfigured
        : DEFAULT_MAX_BATCH;

    const configuredBatch = Number(
      this.config.get('EMBEDDING_BATCH_SIZE', maxBatch),
    );
    const valid = Number.isFinite(configuredBatch) && configuredBatch > 0;
    this.batchSize = Math.min(valid ? configuredBatch : maxBatch, maxBatch);

    if (configuredBatch > maxBatch) {
      this.logger.warn(
        `EMBEDDING_BATCH_SIZE=${configuredBatch} 超过上限 ${maxBatch}，已钳制（上限由 EMBEDDING_MAX_BATCH_SIZE 控制）`,
      );
    }
  }

  /** 是否已配置 API Key（供健康检查 / 降级判断，不触发网络请求） */
  isConfigured(): boolean {
    return Boolean(this.resolveApiKey());
  }

  getDimension(): number {
    return this.dimension;
  }

  /** 单条嵌入 */
  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  /** 批量嵌入（内部由 LangChain 按 batchSize 切片） */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];

    const vectors = await this.getEmbeddings().embedDocuments(texts);
    this.logger.debug(`嵌入完成：count=${vectors.length}`);
    return vectors;
  }

  /**
   * 延迟初始化客户端。缺 Key 时抛明确异常，但**不在构造期抛**，避免拖垮启动。
   */
  private getEmbeddings(): OpenAIEmbeddings {
    if (this.embeddings) return this.embeddings;

    const apiKey = this.resolveApiKey();
    if (!apiKey) {
      throw new Error(
        '未配置 Embedding API Key（EMBEDDING_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY），无法生成向量',
      );
    }

    const baseUrl = this.config.get(
      'EMBEDDING_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const model = this.config.get('EMBEDDING_MODEL', DEFAULT_MODEL);

    this.embeddings = new OpenAIEmbeddings({
      apiKey,
      model,
      dimensions: this.dimension,
      batchSize: this.batchSize,
      // Markdown chunk 保留换行，避免语义被过度压扁
      stripNewLines: false,
      configuration: {
        baseURL: baseUrl,
      },
    });

    this.logger.log(
      `Embedding 客户端已初始化：model=${model}, dims=${this.dimension}, batch=${this.batchSize}`,
    );
    return this.embeddings;
  }

  private resolveApiKey(): string | undefined {
    return (
      this.config.get<string>('EMBEDDING_API_KEY') ||
      this.config.get<string>('DASHSCOPE_API_KEY') ||
      this.config.get<string>('OPENAI_API_KEY')
    );
  }
}
