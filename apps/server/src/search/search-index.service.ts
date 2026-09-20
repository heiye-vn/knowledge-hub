import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ElasticsearchService } from '../rag/elasticsearch.service.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import {
  HIGHLIGHT_POST_TAG,
  HIGHLIGHT_PRE_TAG,
  KH_DOCUMENT_INDEX,
  buildKhDocumentIndexBody,
} from './constants/kh-document.mapping.js';

/** 文档级检索请求 */
export interface DocumentSearchParams {
  /** 查询词；为空则退化为「按条件浏览」 */
  query: string;
  /** 页码，从 1 开始 */
  page: number;
  /** 每页条数 */
  pageSize: number;
  categoryId?: string | null;
  authorId?: string | null;
  teamId?: string | null;
  /** 默认只召回已发布文档（DocumentStatus.Published） */
  status?: number | null;
}

/** 单条命中结果 */
export interface DocumentSearchHit {
  id: string;
  title: string;
  summary: string | null;
  /** 正文片段：有查询词时优先取高亮片段，否则取正文前 200 字 */
  snippet: string | null;
  /** ES 原始高亮片段，字段名与 mapping 一致 */
  highlight: {
    title?: string[];
    summary?: string[];
    content?: string[];
  } | null;
  score: number;
  status: number | null;
  tags: string[];
  categoryId: string | null;
  authorId: string | null;
  publishTime: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

export interface DocumentSearchResult {
  total: number;
  page: number;
  pageSize: number;
  hits: DocumentSearchHit[];
}

/** ES 返回的 _source 结构（只取用到的字段） */
interface DocumentSource {
  title?: string;
  summary?: string | null;
  content?: string | null;
  tags?: string[];
  status?: number;
  category_id?: string | null;
  author_id?: string | null;
  publish_time?: string | null;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
}

interface RawHit {
  _id?: string;
  _score?: number | null;
  _source?: DocumentSource;
  highlight?: Record<string, string[]>;
}

interface RawSearchResponse {
  hits?: {
    total?: number | { value?: number };
    hits?: RawHit[];
  };
}

/** 正文降级片段长度（无高亮时截取） */
const SNIPPET_LENGTH = 200;

/**
 * 文档级全文搜索索引（ES `kh_document`）
 *
 * 对应参考项目 knowledge-hub-backend v4 `pipeline/search-index.service.ts`。
 *
 * 与 `kh_chunk` 的分工：
 * - `kh_chunk`：一篇文档切成多块 + 向量 → 语义检索（`POST /search`）
 * - `kh_document`：一篇文档一条记录 → 关键词全文检索 + 高亮（`POST /search/documents`）
 *
 * 🟡 **有意分叉（已登记 reference-mapping.md）**：
 * - 参考项目由 MQ 消费者异步写；本项目在 publish / remove 里**同步写**。
 *   理由见 `docs/dev-notes/search-index.md`：Search upsert 是一次 ES 请求（毫秒级），
 *   同步可保证 write-your-reads——发布完立刻能搜到，异步会出现「发布成功但搜不到」。
 * - 参考项目 content **截前 1000 字**（因 MQ 消息体积）；本项目 publish 时正文已在内存，
 *   **全量写入**，长文档后半段也能被搜到。
 * - 参考项目 mapping 未指定 IK；本项目显式 `ik_max_word` / `ik_smart`。
 *
 * 降级：ES 不可用时所有写入 / 检索跳过，不阻断业务。
 */
@Injectable()
export class SearchIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchIndexService.name);
  private readonly indexName: string;
  /** 建索引的并发锁；服务内多处可能同时首次触发 */
  private indexReady: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly esService: ElasticsearchService,
  ) {
    this.indexName = this.config.get<string>(
      'ELASTICSEARCH_DOC_INDEX',
      KH_DOCUMENT_INDEX,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.isAvailable()) {
      this.logger.warn(
        'Elasticsearch 不可用，文档级搜索索引将跳过写入（不影响发布）',
      );
      return;
    }
    void this.ensureIndex().catch((err) => {
      this.logger.warn(
        `文档搜索索引初始化失败（首次使用时重试）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    // ES client 生命周期由 ElasticsearchService 统一管理，这里不重复关闭
  }

  /** ES 是否可用（不需要 Embedding Key，与 RAG 管线的可用性解耦） */
  isAvailable(): boolean {
    return this.esService.isEnabled();
  }

  /** 幂等确保索引存在；并发调用复用同一次初始化 */
  async ensureIndex(): Promise<void> {
    if (!this.isAvailable()) return;

    if (!this.indexReady) {
      this.indexReady = this.doEnsureIndex().catch((err) => {
        this.indexReady = null;
        throw err;
      });
    }
    return this.indexReady;
  }

  /** 写入 / 覆盖一篇文档的搜索记录（_id = 文档 ID，天然幂等） */
  async indexDocument(doc: PipelineDocument): Promise<void> {
    await this.indexDocuments([doc], true);
  }

  /**
   * 批量写入。单条失败会抛出，由调用方决定重试策略。
   * @param refresh 是否立即刷新；批量重建场景可传 false 减少开销
   */
  async indexDocuments(
    docs: PipelineDocument[],
    refresh = true,
  ): Promise<number> {
    if (!docs.length) return 0;
    if (!this.isAvailable()) {
      this.logger.warn(
        `跳过文档搜索索引写入（ES 不可用）：count=${docs.length}`,
      );
      return 0;
    }

    await this.ensureIndex();
    const client = this.esService.getClient();

    const operations = docs.flatMap((doc) => [
      { index: { _index: this.indexName, _id: doc.id } },
      this.toEsDocument(doc),
    ]);

    const response = await client.bulk({ refresh, operations });
    if (response.errors) {
      const failed = response.items
        .filter((item) => item.index?.error)
        .map(
          (item) =>
            `${item.index?._id}: ${item.index?.error?.reason ?? 'unknown'}`,
        );
      this.logger.error(`文档搜索索引批量写入部分失败：${failed.join(', ')}`);
      throw new Error(`文档搜索索引写入失败 ${failed.length} 条`);
    }

    this.logger.log(
      `文档搜索索引已写入：count=${docs.length} → ${this.indexName}`,
    );
    return docs.length;
  }

  /** 下架 / 删除时移除；索引或文档不存在都视为成功（幂等） */
  async deleteDocument(documentId: string): Promise<void> {
    if (!this.isAvailable()) {
      this.logger.warn(
        `跳过文档搜索索引删除（ES 不可用）：documentId=${documentId}`,
      );
      return;
    }

    const client = this.esService.getClient();
    try {
      await client.delete({
        index: this.indexName,
        id: documentId,
        refresh: true,
      });
      this.logger.log(`文档搜索索引已删除：documentId=${documentId}`);
    } catch (err) {
      if (isNotFound(err)) {
        this.logger.log(
          `文档搜索索引不存在，跳过删除：documentId=${documentId}`,
        );
        return;
      }
      throw err;
    }
  }

  /** 文档级全文检索；ES 不可用时返回空结果而不是抛错（检索是读路径，不该拖垮页面） */
  async search(params: DocumentSearchParams): Promise<DocumentSearchResult> {
    const { query, page, pageSize } = params;
    const empty: DocumentSearchResult = {
      total: 0,
      page,
      pageSize,
      hits: [],
    };

    if (!this.isAvailable()) {
      this.logger.warn('跳过文档检索（ES 不可用），返回空结果');
      return empty;
    }

    await this.ensureIndex();
    const client = this.esService.getClient();

    const keyword = query?.trim();
    const filter: Record<string, unknown>[] = [];
    const pushTerm = (field: string, value?: string | null) => {
      if (value) filter.push({ term: { [field]: value } });
    };
    // 默认只召回已发布文档，避免草稿 / 归档文档被搜出来
    if (params.status != null) {
      filter.push({ term: { status: params.status } });
    }
    pushTerm('category_id', params.categoryId);
    pushTerm('author_id', params.authorId);
    pushTerm('team_id', params.teamId);

    const response = (await client.search({
      index: this.indexName,
      from: (page - 1) * pageSize,
      size: pageSize,
      query: {
        bool: {
          must: keyword
            ? [
                {
                  multi_match: {
                    query: keyword,
                    // 标题权重最高，其次摘要，最后正文
                    fields: ['title^3', 'summary^2', 'content'],
                    type: 'best_fields',
                    operator: 'or',
                  },
                },
              ]
            : [{ match_all: {} }],
          filter,
        },
      },
      highlight: keyword
        ? {
            pre_tags: [HIGHLIGHT_PRE_TAG],
            post_tags: [HIGHLIGHT_POST_TAG],
            require_field_match: false,
            fields: {
              title: {},
              summary: { fragment_size: 150, number_of_fragments: 1 },
              content: { fragment_size: 200, number_of_fragments: 2 },
            },
          }
        : undefined,
    })) as unknown as RawSearchResponse;

    const rawHits = response.hits?.hits ?? [];
    const totalRaw = response.hits?.total;
    const total =
      typeof totalRaw === 'number' ? totalRaw : (totalRaw?.value ?? 0);

    return {
      total,
      page,
      pageSize,
      hits: rawHits.map((hit) => this.toSearchHit(hit)),
    };
  }

  /** 组装写入 ES 的文档：PG 侧是逗号分隔的 tags，这里拆成数组以便精确过滤 */
  private toEsDocument(doc: PipelineDocument): Record<string, unknown> {
    return {
      id: doc.id,
      title: doc.title,
      summary: doc.summary ?? null,
      content: doc.content ?? null,
      tags: splitTags(doc.tags),
      status: doc.status,
      is_public: doc.isPublic ?? false,
      category_id: doc.categoryId ?? null,
      author_id: doc.authorId ?? null,
      team_id: doc.teamId ?? null,
      view_count: doc.viewCount ?? 0,
      like_count: doc.likeCount ?? 0,
      comment_count: doc.commentCount ?? 0,
      publish_time: toIso(doc.publishTime),
      created_at: toIso(doc.createdAt),
      updated_at: toIso(doc.updatedAt),
      indexed_at: new Date().toISOString(),
    };
  }

  private toSearchHit(hit: RawHit): DocumentSearchHit {
    const source = hit._source ?? {};
    const highlight = hit.highlight ?? null;
    const snippet =
      highlight?.content?.[0] ??
      truncate(source.content) ??
      highlight?.summary?.[0] ??
      source.summary ??
      null;

    return {
      id: hit._id ?? '',
      title: source.title ?? '',
      summary: source.summary ?? null,
      snippet,
      highlight,
      score: hit._score ?? 0,
      status: source.status ?? null,
      tags: source.tags ?? [],
      categoryId: source.category_id ?? null,
      authorId: source.author_id ?? null,
      publishTime: source.publish_time ?? null,
      viewCount: source.view_count ?? 0,
      likeCount: source.like_count ?? 0,
      commentCount: source.comment_count ?? 0,
    };
  }

  private async doEnsureIndex(): Promise<void> {
    const client = this.esService.getClient();
    const exists = await client.indices.exists({ index: this.indexName });
    if (exists) return;

    try {
      await client.indices.create({
        index: this.indexName,
        ...buildKhDocumentIndexBody(),
      });
      this.logger.log(
        `已创建索引 ${this.indexName}（analyzer=ik_max_word/ik_smart）`,
      );
    } catch (err) {
      if (isAlreadyExists(err)) {
        this.logger.log(`索引 ${this.indexName} 已被并发创建，跳过`);
        return;
      }
      throw err;
    }
  }
}

/** `tags` 在 PG 里是逗号分隔字符串，ES 侧用数组 */
function splitTags(tags?: string | null): string[] {
  if (!tags) return [];
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** ES date 字段需要 ISO-8601；Date#toString() 会被拒绝 */
function toIso(value?: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function truncate(content?: string | null): string | null {
  if (!content) return null;
  return content.length > SNIPPET_LENGTH
    ? `${content.slice(0, SNIPPET_LENGTH)}…`
    : content;
}

function isNotFound(err: unknown): boolean {
  const meta = (err as { meta?: { statusCode?: number } } | null)?.meta;
  const message = err instanceof Error ? err.message : String(err);
  return meta?.statusCode === 404 || /not_found|404/i.test(message);
}

function isAlreadyExists(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);
  return (
    name === 'ResponseError' &&
    /resource_already_exists_exception|already exists/i.test(message)
  );
}
