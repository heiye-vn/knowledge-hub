import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

/** DashScope text-embedding-v3 单次请求上限，超过会 400 InvalidParameter */
const DASHSCOPE_MAX_BATCH = 10;

/**
 * 文本向量化服务（LangChain OpenAIEmbeddings + 阿里云百炼 OpenAI 兼容协议）
 *
 * 与参考项目 knowledge-hub-backend 对齐：同模型、同维度、同 batch 钳制、同 stripNewLines=false。
 *
 * ✅ 相对参考项目的改进（修其 P1）：参考项目在**构造函数**中因缺 API Key 直接 throw，
 * 会拖垮整个应用启动 —— 没配 Key 连 /health 都起不来。
 * 这里改为**延迟初始化**：首次使用时才构造，失败抛明确业务异常并记录日志，不影响启动。
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

    const configuredBatch = Number(this.config.get('EMBEDDING_BATCH_SIZE', 10));
    const valid = Number.isFinite(configuredBatch) && configuredBatch > 0;
    this.batchSize = Math.min(valid ? configuredBatch : 10, DASHSCOPE_MAX_BATCH);

    if (configuredBatch > DASHSCOPE_MAX_BATCH) {
      this.logger.warn(
        `EMBEDDING_BATCH_SIZE=${configuredBatch} 超过 DashScope 上限，已钳制为 ${DASHSCOPE_MAX_BATCH}`,
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
    const model = this.config.get('EMBEDDING_MODEL', 'text-embedding-v3');

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
