/**
 * RAG 管线共用类型定义
 *
 * 这些结构在编排器、分块结果、ES 文档之间流转。
 * 字段与参考项目 knowledge-hub-backend 的 pipeline.types.ts 保持一致，便于两项目对照。
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
}

/** 混合检索模式 */
export type SearchMode = 'hybrid' | 'vector' | 'keyword';

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
