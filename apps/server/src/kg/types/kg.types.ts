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

/**
 * 图谱关键词检索命中（feat-v10）
 *
 * 跨三类节点（KnowledgeDocument / DocumentChunk / KnowledgeEntity），
 * 关键词在节点的 name / title / summary / heading / description / content
 * 六种属性上做大小写不敏感的包含匹配。
 */
export interface GraphSearchHit {
  /** 节点业务 ID：文档 id / 实体 name（同为唯一键） */
  id: string;
  /** 展示名：实体名 / 文档标题 / 块 heading */
  name: string;
  /** 节点标签：KnowledgeDocument | DocumentChunk | KnowledgeEntity */
  label: string;
  /** 实体类型（仅实体节点有值） */
  type: string | null;
  /** 文档标题（文档节点自身 / 块所属文档） */
  title: string | null;
  description: string | null;
  heading: string | null;
  documentId: string | null;
  summary: string | null;
  /** 命中上下文片段：content 前 160 字（不回传全文） */
  snippet: string | null;
}

/** 图谱可视化：实体节点（GET /kg/nodes） */
export interface GraphNode {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

/** 图谱可视化：实体间 RELATED_TO 边（GET /kg/edges） */
export interface GraphEdge {
  source: string;
  target: string;
  /** 关系语义（边类型恒为 RELATED_TO，语义在属性上） */
  relation: string;
  weight: number;
}

/** 全景图谱可视化节点 */
export interface GraphViewNode {
  id: string;
  name: string;
  kind: 'document' | 'entity' | 'tag';
  type?: string | null;
  documentId?: string | null;
  updatedAt?: string | null;
  description?: string | null;
}

/** 全景图谱可视化边 */
export interface GraphViewEdge {
  source: string;
  target: string;
  relation: string;
  kind: 'mentions' | 'related' | 'tagged';
}

/** 全景图谱数据包（GET /kg/overview） */
export interface GraphOverview {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    documentCount: number;
    entityCount: number;
    tagCount: number;
    mentionCount: number;
    relatedCount: number;
    entityTypes: Array<{ type: string; count: number }>;
  };
  topEntities: Array<{ name: string; type: string | null; degree: number }>;
  recentNodes: Array<{
    id: string;
    name: string;
    kind: string;
    updatedAt: string | null;
  }>;
  entityTypes: string[];
}

