/**
 * 通用知识图谱抽取 Schema（实体 / 关系类型枚举 + LLM 结构化输出约束）
 *
 * 对应参考项目 knowledge-hub-backend v5 `pipeline/kg-extraction.schema.ts`。
 *
 * 🟡 与参考项目的分叉：
 * - 它注释里写 `@see docs/kg-extraction-schema.md`，但该文件**根本不存在**（悬空引用），
 *   本文件把说明直接写在代码里。
 * - 实体 / 关系类型用 `string` 而非 `enum`：模型常返回中文类型或自造类型（如 APPLIES_TO），
 *   enum 校验失败会**丢掉整块抽取结果**。这一点两边一致，是踩过才知道的坑。
 */
import { z } from 'zod';

/** 核心 + 扩展实体类型 */
export const KG_ENTITY_TYPES = [
  'PERSON',
  'ORGANIZATION',
  'CONCEPT',
  'DOCUMENT',
  'PROCESS',
  'PRODUCT',
  'LOCATION',
  'TIME',
  'POLICY',
  'RESOURCE',
] as const;

export type KgEntityType = (typeof KG_ENTITY_TYPES)[number];

/**
 * 实体间语义关系。
 * ⚠️ Neo4j 里**边类型恒为 RELATED_TO**，语义存在边的 `relation` 属性上
 * （与参考项目一致）——查询时要按属性过滤，不能按边类型匹配。
 */
export const KG_RELATION_TYPES = [
  'HAS_PART',
  'BELONGS_TO',
  'RELATED_TO',
  'DEFINES',
  'REQUIRES',
  'USES',
  'RESPONSIBLE_FOR',
  'PARTICIPATES_IN',
  'LOCATED_IN',
  'OCCURS_AT',
  'CAUSES',
  'CONFLICTS_WITH',
] as const;

export type KgRelationType = (typeof KG_RELATION_TYPES)[number];

const ENTITY_TYPE_SET = new Set<string>(KG_ENTITY_TYPES);
const RELATION_TYPE_SET = new Set<string>(KG_RELATION_TYPES);

/** 未知实体类型兜底为 CONCEPT */
export function normalizeEntityType(
  raw: string | undefined | null,
): KgEntityType {
  const upper = (raw ?? '').trim().toUpperCase();
  if (ENTITY_TYPE_SET.has(upper)) return upper as KgEntityType;
  return 'CONCEPT';
}

/** 未知关系类型兜底为 RELATED_TO */
export function normalizeRelationType(
  raw: string | undefined | null,
): KgRelationType {
  const upper = (raw ?? '').trim().toUpperCase();
  if (RELATION_TYPE_SET.has(upper)) return upper as KgRelationType;
  return 'RELATED_TO';
}

export const kgExtractedEntitySchema = z.object({
  name: z.string().describe('文中原文实体名'),
  type: z.string().describe('实体类型').optional(),
  description: z.string().describe('简短描述，可空').optional(),
  aliases: z.array(z.string()).describe('别名').optional(),
});

export const kgExtractedRelationSchema = z.object({
  source: z.string().describe('起点实体 name，必须是已抽取实体'),
  target: z.string().describe('终点实体 name，必须是已抽取实体'),
  relation: z.string().describe('关系类型，字段名必须是 relation').optional(),
  // 兼容：模型常误把关系类型写成 type，整块 enum 校验失败会丢整块结果
  type: z.string().describe('兼容：模型误把关系写成 type 时读取').optional(),
  weight: z.number().min(0).max(1).describe('置信度 0-1').optional(),
});

/** 单个 chunk 的 LLM 结构化输出 */
export const kgExtractionResultSchema = z
  .object({
    entities: z.array(kgExtractedEntitySchema).describe('实体列表'),
    relations: z.array(kgExtractedRelationSchema).describe('关系列表'),
  })
  .describe('从文档片段抽取的知识实体与关系');

export type KgExtractionLlmOutput = z.infer<typeof kgExtractionResultSchema>;

/** 构建 LLM system prompt */
export function buildExtractionSystemPrompt(
  maxEntities: number,
  maxRelations: number,
): string {
  return `你是知识图谱构建专家。请严格从文档片段中抽取知识实体和关系。

## 抽取规则
1. 只抽取文中明确提到的、有实际意义的实体，不要臆测
2. 不要抽取过于泛化的词（如「系统」「功能」「数据」「问题」）
3. 实体名使用文中原文；别名放入 aliases
4. 关系必须有文中依据（同句或相邻句），且 source/target 必须是已抽取实体的 name
5. 每个片段最多 ${maxEntities} 个实体、${maxRelations} 个关系
6. 无法归类时用实体类型 CONCEPT、关系类型 RELATED_TO
7. 关系的 source / target 必须**逐字**等于上面实体列表里的某个 name，
   不得同义改写、缩写或概括（实测：模型改写端点名会导致该关系被校验丢弃）

## 实体类型
- PERSON: 人物、角色（如 张三、审核员）
- ORGANIZATION: 组织、部门（如 研发中心、财务部）
- CONCEPT: 术语、概念（如 分布式事务、试用期）
- DOCUMENT: 文档、规范（如 《员工手册》）
- PROCESS: 流程、活动（如 入职流程、发布流程）
- PRODUCT: 产品、系统（如 知识库、CRM、Redis）
- LOCATION: 地点（如 北京、会议室 A）
- TIME: 时间、周期（如 2026-Q1、每周一）
- POLICY: 政策、制度条款
- RESOURCE: 文件、工具、设备（如 Docker、培训课件）

## 关系类型
- HAS_PART: 组成、包含
- BELONGS_TO: 归属
- RELATED_TO: 泛关联（兜底）
- DEFINES: 定义、解释
- REQUIRES: 前置条件、依赖
- USES: 使用
- RESPONSIBLE_FOR: 负责
- PARTICIPATES_IN: 参与
- LOCATED_IN: 位于
- OCCURS_AT: 发生于（时间）
- CAUSES: 导致、因果
- CONFLICTS_WITH: 冲突、例外

只返回 JSON，不要 markdown 或其它说明。关系对象的字段名是 relation（不要写成 type）。示例：
{"entities":[{"name":"财务部","type":"ORGANIZATION","description":"","aliases":[]}],"relations":[{"source":"财务部","target":"差旅报销","relation":"RESPONSIBLE_FOR","weight":0.8}]}`;
}
