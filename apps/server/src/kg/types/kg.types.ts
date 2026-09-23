/**
 * 知识图谱（KG）共用类型
 *
 * 字段与基线实现 v5 `pipeline/types/pipeline.types.ts`
 * 同名同形，便于两项目 grep 对照。
 */

/** 图谱实体（如「财务部」「入职流程」「知识库」） */
export interface ExtractedEntity {
  name: string;
  /** PERSON / ORGANIZATION / CONCEPT / DOCUMENT / PROCESS / PRODUCT … 见 constants/kg-schema.ts */
  type: string;
  description?: string;
  aliases?: string[];
}

/** 实体间关系：source -[relation]-> target */
export interface ExtractedRelation {
  source: string;
  target: string;
  relation: string;
  /** 置信度 0~1 */
  weight?: number;
}

/** 单个 chunk 的抽取结果 */
export interface ExtractionResult {
  chunkId?: string;
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/** 单篇文档建图结果 */
export interface KgBuildResult {
  documentId: string;
  /** 参与抽取的块数（受 KG_MAX_CHUNKS 上限约束） */
  chunks: number;
  /** 写入 / 复用的实体数 */
  entities: number;
  /** 写入 / 复用的关系数 */
  relations: number;
  /** 因抽取失败被跳过的块数 */
  failedChunks: number;
}

/** 批量建图汇总 */
export interface KgBuildSummary {
  succeeded: KgBuildResult[];
  failed: Array<{ documentId: string; message: string }>;
}

/** 图查询返回的实体 */
export interface GraphEntity {
  name: string;
  type: string;
  description: string | null;
  /** 提及该实体的文档块数 */
  mentions: number;
}

/** 图查询返回的邻居（实体 + 关系 + 关联实体） */
export interface GraphNeighbor {
  entity: GraphEntity;
  relation: string;
  weight: number;
  /** 关系方向：out = 本实体指向邻居，in = 邻居指向本实体 */
  direction: 'out' | 'in';
}
