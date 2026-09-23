/**
 * `kh_chunk` 索引定义
 *
 * 与基线实现 同名同结构，便于对照。
 *
 * ⚠️ 两条硬约束：
 * 1. `embedding.dims` 建索引后**不可原地修改**。变更 EMBEDDING_DIMENSION 必须删索引重建 + 全量重索引。
 * 2. IK 插件版本必须与 ES 严格一致（8.17.0 ↔ 8.17.0），否则节点起不来。
 *
 * ✅ 相对基线实现的关键改进：基线实现装了 IK 却在 mapping 里没指定 analyzer，
 * `content` 走了默认 standard 分词，中文被切成单字，等于白装。
 * 这里在 content / document_title 上**显式指定** ik_max_word（索引期细粒度，提高召回）
 * 与 ik_smart（查询期粗粒度，提高精度）。
 */

export const KH_CHUNK_INDEX = 'kh_chunk';

/** mapping 中的向量维度；必须与环境变量 EMBEDDING_DIMENSION 一致 */
export const KH_CHUNK_EMBEDDING_DIMS = 1024;

export interface IndexSettings {
  settings: {
    number_of_shards: number;
    number_of_replicas: number;
    refresh_interval: string;
  };
  mappings: {
    properties: Record<string, unknown>;
  };
}

/**
 * 生成索引 body。dims 通过参数注入，方便单测覆盖不同维度场景。
 */
export function buildKhChunkIndexBody(dims = KH_CHUNK_EMBEDDING_DIMS): IndexSettings {
  return {
    settings: {
      number_of_shards: 1,
      number_of_replicas: 0,
      refresh_interval: '5s',
    },
    mappings: {
      properties: {
        chunk_id: { type: 'keyword' },
        document_id: { type: 'keyword' },
        document_title: {
          type: 'text',
          analyzer: 'ik_max_word',
          search_analyzer: 'ik_smart',
          fields: { keyword: { type: 'keyword' } },
        },
        content: {
          type: 'text',
          analyzer: 'ik_max_word',
          search_analyzer: 'ik_smart',
        },
        heading: { type: 'keyword' },
        chunk_index: { type: 'integer' },
        total_chunks: { type: 'integer' },
        category_id: { type: 'keyword' },
        author_id: { type: 'keyword' },
        team_id: { type: 'keyword' },
        doc_status: { type: 'integer' },
        publish_time: { type: 'date' },
        indexed_at: { type: 'date' },
        embedding: {
          type: 'dense_vector',
          dims,
          index: true,
          similarity: 'cosine',
        },
      },
    },
  };
}
