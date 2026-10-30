/**
 * RAG 管线共用类型定义
 *
 * 这些结构在编排器、分块结果、ES 文档之间流转。
 */

/**
 * 一篇文档切出来的一块文本。
 * 附 embedding 后写入 ES `kh_chunk`（dense_vector + IK 分词 text）。
 */
export interface DocumentChunk {
  /** 稳定 ID：sha256(documentId:index)，重建时可覆盖写，保证幂等 */
  chunkId: string;
  documentId: string;
  documentTitle: string;
  /** 实际送去嵌入 / 检索的文本（通常含章节标题前缀） */
  content: string;
  /** 所属 Markdown 标题；无标题章节为 null */
  heading?: string | null;
  /** 从 0 开始的块序号 */
  chunkIndex: number;
  /** 该文档总块数（切完后回填） */
  totalChunks: number;
  categoryId?: string | null;
  authorId?: string | null;
  teamId?: string | null;
  isPublic?: boolean;
  docStatus?: number | null;
  publishTime?: string | null;
  /** 向量；分块阶段为空，EmbeddingService 填充后写入 ES dense_vector */
  embedding?: number[];
}

/**
 * 管线内部使用的「文档快照」：Postgres 元数据 + Mongo 正文
 */
export interface PipelineDocument {
  id: string;
  title: string;
  content: string;
  summary?: string | null;
  categoryId?: string | null;
  authorId?: string | null;
  teamId?: string | null;
  status: number;
  tags?: string | null;
  isPublic?: boolean;
  publishTime?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  /**
   * 计数类字段：不参与向量检索，仅用于文档级搜索索引与结果排序
   */
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
}

/** 检索模式（运行时数组与类型共用，避免 DTO 与检索实现漂移） */
export const SEARCH_MODES = ['hybrid', 'vector', 'keyword'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** 单条检索命中结果 */
export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  /** 块文本（含标题前缀） */
  content: string;
  heading: string | null;
  chunkIndex: number;
  totalChunks: number;
  /** 融合后的最终得分，越大越相关 */
  score: number;
  /** 各路召回的细分得分，便于效果对比与调优 */
  scores: {
    vector: number | null;
    keyword: number | null;
  };
}
