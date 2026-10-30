/**
 * RAG 重建索引消息结构与任务定义
 */

/** 重建类型。目前仅支持按文档 ID 列表；保留枚举形态以便扩展（如 BY_CATEGORY / ALL） */
export type ReindexType = 'BY_DOC_IDS';

/** 重建索引任务消息 */
export interface ReindexMessage {
  /** 任务 ID，用于日志追踪与状态查询 */
  taskId: string;
  type: ReindexType;
  /** 待重建的文档 ID 列表 */
  documentIds?: string[];
}

/**
 * KG 建图 / 删图消息
 * 支持 BUILD_ALL 全量重建、BUILD_BY_DOC_IDS 按文档列表构建与 DELETE_BY_DOC_IDS 批量删除。
 */
export type KgBuildType =
  | 'BUILD_ALL'
  | 'BUILD_BY_DOC_IDS'
  | 'DELETE_BY_DOC_IDS';

export interface KgBuildMessage {
  taskId: string;
  type: KgBuildType;
  documentIds?: string[];
}
