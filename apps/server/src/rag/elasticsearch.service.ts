import { Client } from '@elastic/elasticsearch';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KH_CHUNK_EMBEDDING_DIMS,
  KH_CHUNK_INDEX,
  buildKhChunkIndexBody,
} from './constants/kh-chunk.mapping.js';

/**
 * Elasticsearch 客户端封装 + `kh_chunk` 索引初始化
 *
 * 设计要点（与 spec §7 一致）：
 * - **降级不阻断启动**：连接失败时置空 client 并 warn，应用照常起来（该做法沿用基线实现，予以保留）。
 * - **幂等建索引**：不存在才创建；已存在则校验 `embedding.dims` 与配置是否一致，不一致明确报错，
 *   避免「写入时报 400 但不知道根因」这种最难排查的故障。
 */
@Injectable()
export class ElasticsearchService implements OnModuleInit {
  private readonly logger = new Logger(ElasticsearchService.name);
  private client: Client | null = null;
  private enabled = false;
  private indexName = KH_CHUNK_INDEX;
  /**
   * 初始化单例 Promise。
   * 启动时 onModuleInit 会 fire-and-forget 调一次，业务侧也可能同时调用；
   * 若无此锁，两个 create 会并发撞车抛 resource_already_exists_exception。
   */
  private indexReady: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.enabled =
      this.config
        .get<string>('ELASTICSEARCH_ENABLED', 'true')
        .toLowerCase() !== 'false';

    if (!this.enabled) {
      this.logger.warn(
        'Elasticsearch 已禁用（ELASTICSEARCH_ENABLED=false），向量写入与检索将跳过',
      );
      return;
    }

    const node = this.config.get<string>(
      'ELASTICSEARCH_NODE',
      'http://localhost:9200',
    );
    this.indexName = this.config.get<string>(
      'ELASTICSEARCH_INDEX',
      KH_CHUNK_INDEX,
    );

    this.client = new Client({
      node,
      // 单节点本地环境，失败快速返回而不是长时间挂起
      requestTimeout: 30_000,
      maxRetries: 2,
    });

    void this.ensureIndex().catch((err) => {
      this.logger.warn(
        `Elasticsearch 索引初始化失败（首次使用时重试）: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  isEnabled(): boolean {
    return this.enabled && this.client != null;
  }

  /** 获取底层客户端；未启用时抛出明确异常 */
  getClient(): Client {
    if (!this.client) {
      throw new Error(
        'Elasticsearch 未启用或连接不可用（ELASTICSEARCH_ENABLED / ELASTICSEARCH_NODE）',
      );
    }
    return this.client;
  }

  getIndexName(): string {
    return this.indexName;
  }

  /**
   * 幂等确保索引存在；并发调用复用同一次初始化，重复调用不会重复建索引。
   * 已存在时校验向量维度一致性；失败会清空锁，允许下次重试。
   */
  async ensureIndex(): Promise<void> {
    if (!this.isEnabled() || !this.client) return;

    if (!this.indexReady) {
      this.indexReady = this.doEnsureIndex().catch((err) => {
        // 初始化失败不缓存，下次调用可重试（阶段二会由队列重试兜底）
        this.indexReady = null;
        throw err;
      });
    }

    return this.indexReady;
  }

  private async doEnsureIndex(): Promise<void> {
    const client = this.getClient();
    const exists = await client.indices.exists({ index: this.indexName });

    if (!exists) {
      const dims = Number(
        this.config.get<string>(
          'EMBEDDING_DIMENSION',
          String(KH_CHUNK_EMBEDDING_DIMS),
        ),
      );
      const dimsToUse =
        Number.isFinite(dims) && dims > 0 ? dims : KH_CHUNK_EMBEDDING_DIMS;

      try {
        await client.indices.create({
          index: this.indexName,
          ...buildKhChunkIndexBody(dimsToUse),
        });
        this.logger.log(
          `已创建索引 ${this.indexName}（dims=${dimsToUse}, analyzer=ik_max_word/ik_smart）`,
        );
        return;
      } catch (err) {
        // 并发创建时可能已被别的流程先建好，视为成功
        if (!isAlreadyExists(err)) throw err;
        this.logger.log(
          `索引 ${this.indexName} 已被并发创建，跳过（dims=${dimsToUse}）`,
        );
      }
    }

    await this.assertEmbeddingDims();
  }

  /**
   * 校验已存在索引的 embedding.dims 与当前配置一致。
   * dense_vector 的 dims 不可原地修改，不一致只能删索引重建 + 全量重索引。
   */
  private async assertEmbeddingDims(): Promise<void> {
    const client = this.getClient();

    const mapping = await client.indices.getMapping({ index: this.indexName });
    const properties = (mapping as Record<string, any>)[this.indexName]?.mappings
      ?.properties as Record<string, any> | undefined;
    const actualDims = properties?.embedding?.dims as number | undefined;

    if (actualDims == null) {
      this.logger.warn(
        `索引 ${this.indexName} 已存在但未找到 embedding.dims，跳过维度校验`,
      );
      return;
    }

    const expectedDims = Number(
      this.config.get<string>(
        'EMBEDDING_DIMENSION',
        String(KH_CHUNK_EMBEDDING_DIMS),
      ),
    );

    if (Number.isFinite(expectedDims) && expectedDims > 0 && actualDims !== expectedDims) {
      this.logger.error(
        `向量维度不匹配：索引 ${this.indexName} 的 embedding.dims=${actualDims}，` +
          `而 EMBEDDING_DIMENSION=${expectedDims}。dense_vector 维度不可原地修改，` +
          `请删除索引后重建并全量重索引。`,
      );
      throw new Error(
        `kh_chunk embedding.dims (${actualDims}) 与 EMBEDDING_DIMENSION (${expectedDims}) 不一致`,
      );
    }

    this.logger.log(
      `索引 ${this.indexName} 已存在，向量维度校验通过（dims=${actualDims}）`,
    );
  }
}

/** 判断是否为「索引已存在」类错误 */
function isAlreadyExists(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return (
    name === 'ResponseError' &&
    /resource_already_exists_exception|already exists/i.test(message)
  );
}
