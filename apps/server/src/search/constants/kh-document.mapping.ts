/**
 * `kh_document` 索引定义（ES 侧）
 *
 * 与基线实现 v4 `pipeline/search-index.service.ts` 同名同用途：
 * 一篇文档一条记录，服务于**关键词全文检索**；与 `kh_chunk`（多块 + 向量，服务语义检索）互补。
 *
 * ⚠️ 命名提醒：PG 侧的文档元数据表**也叫 `kh_document`**，两者同名但不是一个东西，
 * 排查日志时要看清是 TypeORM 还是 ES client 打的。索引名可用 `ELASTICSEARCH_DOC_INDEX` 覆盖。
 *
 * ✅ 相对基线实现的改进：基线实现 mapping 里 `title/summary/content` 是裸 `text`，
 * **没指定 IK**（它在 v3 的 kh_chunk 上犯过同样的错，v4 又犯一次）→ 中文被切成单字。
 * 这里显式指定 ik_max_word（索引期细粒度提高召回）/ ik_smart（查询期粗粒度提高精度）。
 */

export const KH_DOCUMENT_INDEX = 'kh_document';

export interface DocumentIndexSettings {
  settings: {
    number_of_shards: number;
    number_of_replicas: number;
    refresh_interval: string;
  };
  mappings: {
    properties: Record<string, unknown>;
  };
}

/** 高亮标签；前端可直接渲染，也可按需替换为自定义标签 */
export const HIGHLIGHT_PRE_TAG = '<em>';
export const HIGHLIGHT_POST_TAG = '</em>';

/**
 * 生成文档级索引 body
 *
 * 字段说明：
 * - `tags` 用 keyword 数组：PG 里是逗号分隔字符串，写入前会拆成数组，便于精确过滤
 * - `title` 额外挂 keyword 子字段：支持按标题精确排序 / 聚合
 */
export function buildKhDocumentIndexBody(): DocumentIndexSettings {
  return {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
      refresh_interval: '5s',
    },
    mappings: {
      properties: {
        id: { type: 'keyword' },
        title: {
          type: 'text',
          analyzer: 'ik_max_word',
          search_analyzer: 'ik_smart',
          fields: { keyword: { type: 'keyword' } },
        },
        summary: {
          type: 'text',
          analyzer: 'ik_max_word',
          search_analyzer: 'ik_smart',
        },
        content: {
          type: 'text',
          analyzer: 'ik_max_word',
          search_analyzer: 'ik_smart',
        },
        tags: { type: 'keyword' },
        status: { type: 'integer' },
        is_public: { type: 'boolean' },
        category_id: { type: 'keyword' },
        author_id: { type: 'keyword' },
        team_id: { type: 'keyword' },
        view_count: { type: 'integer' },
        like_count: { type: 'integer' },
        comment_count: { type: 'integer' },
        publish_time: { type: 'date' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
        indexed_at: { type: 'date' },
      },
    },
  };
}
