/**
 * RAG 重建索引消息结构
 *
 * 🟢 与参考项目 knowledge-hub-backend `mq/messages/pipeline.messages.ts` **完全一致**，
 * 字段同名同形，方便两项目对照与日后迁移。
 */

/** 重建类型。目前仅支持按文档 ID 列表；保留枚举形态以便扩展（如 BY_CATEGORY / ALL） */
export type ReindexType = 'BY_DOC_IDS';

/** 重建索引任务消息 */
export interface ReindexMessage {
  /** 任务 ID，用于日志追踪与（将来的）状态查询 */
  taskId: string;
  type: ReindexType;
  /** 待重建的文档 ID 列表 */
  documentIds?: string[];
}

/**
 * KG 建图 / 删图消息（feat-v5，对齐参考项目 v5 `KgBuildMessage`）
 *
 * 与参考项目分叉：`BUILD_ALL` 在参考项目里**没有任何投递入口**（死代码），
 * 本项目 `POST /kg/build` 不传 documentIds 即投递 BUILD_ALL。
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
