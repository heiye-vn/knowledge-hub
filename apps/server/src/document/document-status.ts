/**
 * 文档状态与流转规则
 *
 * 状态值与 kh_document.status 一致：
 * - 0 Draft：草稿，编辑中，不进任何索引
 * - 1 Published：已发布，写入 RAG(kh_chunk) / 文档搜索(kh_document) / 图谱(Neo4j)
 * - 2 Archived：已归档，终态，清理索引后保留正文
 * - 3 PendingReview：待审核，不进索引，审核通过后才发布
 *
 * 索引写入的唯一入口是 Published：草稿、待审核、归档的文档都不应出现在
 * 语义检索、关键词搜索与图谱召回的结果里，否则未脱密内容会被问答直接吐出。
 *
 * 是否走审核由环境变量 DOCUMENT_REQUIRE_APPROVAL 控制（见 DocumentReviewService）。
 */
export enum DocumentStatus {
  /** 草稿 */
  Draft = 0,
  /** 已发布 */
  Published = 1,
  /** 已归档（终态） */
  Archived = 2,
  /** 待审核（提交发布后、审核完成前） */
  PendingReview = 3,
}

/** 各状态中文名，供列表 / 详情展示 */
export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: '草稿',
  [DocumentStatus.Published]: '已发布',
  [DocumentStatus.Archived]: '已归档',
  [DocumentStatus.PendingReview]: '待审核',
};

/**
 * 允许执行「发布 / 提审」的来源状态
 *
 * 🟢 与基线实现的差异：基线实现把 Archived 也放进可发布集合，
 * 且在需审核模式下会漏到「免审直接发布」分支 —— 等于归档文档能绕过审核直接上线。
 * 本项目将归档定为终态，一律不允许重新发布，两个缺陷一并消除。
 */
export function canPublishFrom(status: DocumentStatus): boolean {
  return status === DocumentStatus.Draft || status === DocumentStatus.Published;
}

/**
 * PATCH 是否允许改正文 / 标题
 * 待审核期间禁止改内容 —— 否则审核员看到的与被审核通过的内容可能不是同一份。
 */
export function canEditContent(status: DocumentStatus): boolean {
  return (
    status === DocumentStatus.Draft ||
    status === DocumentStatus.Published ||
    status === DocumentStatus.Archived
  );
}

/** 仅已发布文档可归档 */
export function canArchive(status: DocumentStatus): boolean {
  return status === DocumentStatus.Published;
}

/** 草稿或已发布可提交审核（已发布再提审会先清索引） */
export function canSubmitReview(status: DocumentStatus): boolean {
  return (
    status === DocumentStatus.Draft || status === DocumentStatus.Published
  );
}

/** 仅已发布文档可下架为草稿（清索引后可改内容） */
export function canSaveAsDraft(status: DocumentStatus): boolean {
  return status === DocumentStatus.Published;
}
