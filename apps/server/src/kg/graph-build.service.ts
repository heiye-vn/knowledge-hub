import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { ChunkingService } from '../rag/chunking.service.js';
import { ExtractionService } from './extraction.service.js';
import type {
  ExtractionOutcome,
} from './extraction.service.js';
import type {
  GraphEdge,
  GraphEntity,
  GraphNeighbor,
  GraphNode,
  GraphOverview,
  GraphSearchHit,
  GraphViewEdge,
  GraphViewNode,
  KgBuildResult,
} from './types/kg.types.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';

/** 单篇建图最多参与的块数：按实测单块 19~57s，30 块 ≈ 10~30 分钟（并发 3 后 ≈ 4~10 分钟） */
const DEFAULT_MAX_CHUNKS = 30;

/** 图谱全景空骨架：Neo4j 不可用 / 查询异常时静默降级返回，前端渲染空画布（对齐基线 v12） */
function emptyOverview(): GraphOverview {
  return {
    nodes: [],
    edges: [],
    stats: {
      nodeCount: 0,
      edgeCount: 0,
      documentCount: 0,
      entityCount: 0,
      tagCount: 0,
      mentionCount: 0,
      relatedCount: 0,
      entityTypes: [],
    },
    topEntities: [],
    recentNodes: [],
    entityTypes: [],
  };
}

/**
 * KG 知识图谱构建（Neo4j）
 *
 * 对应基线实现 v5 `pipeline/graph-build.service.ts`。
 *
 * 图模型：
 * ```
 * (KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
 * (KnowledgeEntity)-[:RELATED_TO {relation, weight}]->(KnowledgeEntity)
 * ```
 * ⚠️ 实体间**边类型恒为 RELATED_TO**，语义在 `relation` 属性上。
 *
 * ✅ 相对基线实现的改进：
 * - **启动即建唯一约束**（基线实现没建）：`KnowledgeEntity.name` / `DocumentChunk.chunkId` /
 *   `KnowledgeDocument.id` 没有约束时 MERGE 靠全表扫描，图越大越慢。
 * - **批量抽取（extractBatch，并发 `KG_EXTRACT_CONCURRENCY`）**：基线实现串行逐块调用，
 *   实测单块 19~57s，100 块的文档串行就是小时级。
 * - **块数上限 `KG_MAX_CHUNKS`**：超长文档按序截断，防止单篇建图跑小时级。
 * - **写图用 UNWIND 批量**：基线实现逐条 `session.run`，一块 30 实体就是 60+ 次往返。
 * - **全部块抽取失败视为整篇失败并抛错**：基线实现单块失败只打日志，
 *   图静默不完整且无感知。部分失败保留成果并计数返回。
 *
 * 降级：Neo4j 不可用时跳过写入（不抛错阻断发布）。
 */
@Injectable()
export class GraphBuildService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphBuildService.name);
  private driver: Driver | null = null;
  private readonly enabled: boolean;
  private readonly maxChunks: number;
  /** 约束只需建一次；并发调用复用同一次初始化 */
  private constraintsReady: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly chunkingService: ChunkingService,
    private readonly extractionService: ExtractionService,
  ) {
    this.enabled = this.config.get<string>('NEO4J_ENABLED', 'true') !== 'false';
    this.maxChunks = Math.max(
      1,
      Number(config.get('KG_MAX_CHUNKS', DEFAULT_MAX_CHUNKS)),
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Neo4j 已禁用（NEO4J_ENABLED=false），KG 功能不可用');
      return;
    }
    const uri = this.config.get('NEO4J_URI', 'bolt://localhost:7687');
    const user = this.config.get('NEO4J_USER', 'neo4j');
    const password = this.config.get('NEO4J_PASSWORD', '');

    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    try {
      await this.driver.verifyConnectivity();
      this.logger.log(`Neo4j 已连接：${uri}`);
      void this.ensureConstraints().catch((err) => {
        this.logger.warn(
          `Neo4j 约束创建失败（首次建图时重试）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j 不可用，KG 写入将跳过：${message}`);
      await this.driver.close().catch(() => undefined);
      this.driver = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.driver?.close();
  }

  isAvailable(): boolean {
    return this.driver !== null;
  }

  /**
   * 为单篇文档全量重建图谱（先清后建，幂等）。
   * @returns 建图结果；全部块抽取失败时抛错（由调用方决定是否重试）
   */
  async buildForDocument(doc: PipelineDocument): Promise<KgBuildResult> {
    if (!this.isAvailable()) {
      throw new Error('Neo4j 不可用（NEO4J_ENABLED / NEO4J_URI）');
    }
    if (!doc.content?.trim()) {
      this.logger.log(`文档内容为空，跳过 KG：documentId=${doc.id}`);
      return {
        documentId: doc.id,
        chunks: 0,
        entities: 0,
        relations: 0,
        failedChunks: 0,
      };
    }

    // 先清再建，避免重复发布导致节点/边翻倍
    await this.deleteForDocument(doc.id);
    await this.ensureConstraints();

    const session = this.driver!.session();
    try {
      // ① 文档节点：id 为唯一键，重建时刷新可变元数据、保留首次 createdAt
      await session.run(
        `MERGE (d:KnowledgeDocument {id: $id})
         SET d.title = $title, d.summary = $summary, d.categoryId = $categoryId,
             d.authorId = $authorId, d.status = $status, d.tags = $tags, d.updatedAt = datetime(),
             d.createdAt = coalesce(d.createdAt, datetime())`,
        {
          id: doc.id,
          title: doc.title,
          summary: doc.summary ?? '',
          categoryId: doc.categoryId ?? null,
          authorId: doc.authorId ?? null,
          status: doc.status,
          tags: doc.tags ?? null,
        },
      );

      // ② 复用 RAG 同款分块，保证图谱粒度与向量块一致（chunkId 可互查）
      const allChunks = await this.chunkingService.chunk({
        content: doc.content,
        documentId: doc.id,
        documentTitle: doc.title,
        categoryId: doc.categoryId,
        authorId: doc.authorId,
        teamId: doc.teamId,
        docStatus: doc.status,
        publishTime: toIso(doc.publishTime),
      });
      const chunks = allChunks.slice(0, this.maxChunks);
      if (allChunks.length > chunks.length) {
        this.logger.warn(
          `文档块数超上限，KG 仅处理前 ${chunks.length}/${allChunks.length} 块：documentId=${doc.id}`,
        );
      }

      // ③ 批量抽取（并发受 KG_EXTRACT_CONCURRENCY 控制）
      const outcomes = await this.extractionService.extractBatch(
        chunks.map((c) => ({
          chunkId: c.chunkId,
          content: c.content,
          heading: c.heading ?? null,
        })),
        doc.title,
      );
      const failedChunks = outcomes.filter((o) => o.error).length;
      for (const o of outcomes) {
        if (o.error) {
          this.logger.warn(
            `KG 抽取失败，跳过该块：documentId=${doc.id}, chunkId=${o.chunkId}, ${o.error}`,
          );
        }
      }

      // ④ 块节点 + HAS_CHUNK 边
      await session.run(
        `UNWIND $chunks AS c
         MERGE (k:DocumentChunk {chunkId: c.chunkId})
         SET k.documentId = c.documentId, k.content = c.content, k.heading = c.heading,
             k.chunkIndex = c.chunkIndex, k.totalChunks = c.totalChunks,
             k.updatedAt = datetime()
         WITH k, c
         MATCH (d:KnowledgeDocument {id: c.documentId})
         MERGE (d)-[r:HAS_CHUNK]->(k)
         SET r.chunkIndex = c.chunkIndex`,
        {
          chunks: chunks.map((c) => ({
            chunkId: c.chunkId,
            documentId: doc.id,
            content: c.content,
            heading: c.heading ?? null,
            chunkIndex: c.chunkIndex,
            totalChunks: c.totalChunks,
          })),
        },
      );

      // ⑤ 实体 / MENTIONS / RELATED_TO（合并抽取结果后批量写）
      const entityMap = new Map<string, ExtractionOutcome['result']['entities'][number]>();
      const mentions: Array<{ chunkId: string; name: string }> = [];
      const relations = new Map<
        string,
        { source: string; target: string; relation: string; weight: number }
      >();

      for (const o of outcomes) {
        for (const e of o.result.entities) {
          // 同名实体跨块合并：description 取先出现的非空值
          const existing = entityMap.get(e.name);
          if (existing) {
            if (!existing.description && e.description) existing.description = e.description;
          } else {
            entityMap.set(e.name, e);
          }
          mentions.push({ chunkId: o.chunkId, name: e.name });
        }
        for (const r of o.result.relations) {
          // 去重键：source|target|relation；同一对实体同语义只保留一条，权重取较大值
          const key = `${r.source}|${r.target}|${r.relation}`;
          const existing = relations.get(key);
          if (existing) {
            existing.weight = Math.max(existing.weight, r.weight ?? 0.5);
          } else {
            relations.set(key, {
              source: r.source,
              target: r.target,
              relation: r.relation,
              weight: r.weight ?? 0.5,
            });
          }
        }
      }

      await this.writeEntities(session, [...entityMap.values()]);
      await this.writeMentions(session, mentions);
      await this.writeRelations(session, [...relations.values()]);

      const result: KgBuildResult = {
        documentId: doc.id,
        chunks: chunks.length,
        entities: entityMap.size,
        relations: relations.size,
        failedChunks,
      };
      this.logger.log(
        `KG 建图完成：documentId=${doc.id}, chunks=${chunks.length}, ` +
          `entities=${entityMap.size}, relations=${relations.size}, failedChunks=${failedChunks}`,
      );

      // 全部块都失败 → 视为整篇失败，抛错让队列重试（BullMQ 有退避与次数上限）
      if (chunks.length > 0 && failedChunks === chunks.length) {
        throw new Error(
          `KG 抽取全部失败：documentId=${doc.id}, chunks=${chunks.length}`,
        );
      }
      return result;
    } finally {
      await session.close();
    }
  }

  /** 批量建图：单篇失败不影响其余，失败明细随汇总返回 */
  async buildBatch(docs: PipelineDocument[]): Promise<{
    succeeded: KgBuildResult[];
    failed: Array<{ documentId: string; message: string }>;
  }> {
    const succeeded: KgBuildResult[] = [];
    const failed: Array<{ documentId: string; message: string }> = [];
    for (const doc of docs) {
      try {
        succeeded.push(await this.buildForDocument(doc));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`KG 建图失败：documentId=${doc.id}, ${message}`);
        failed.push({ documentId: doc.id, message });
      }
    }
    return { succeeded, failed };
  }

  /**
   * 删除文档及其块，并清理「已无人提及」的孤儿实体，避免图膨胀。
   * 幂等：文档不存在时等价于空操作。
   */
  async deleteForDocument(documentId: string): Promise<void> {
    if (!this.isAvailable()) return;
    const session = this.driver!.session();
    try {
      // DETACH DELETE 会先拆掉节点上的所有关系边再删节点
      await session.run(
        `MATCH (d:KnowledgeDocument {id: $id})
         OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
         DETACH DELETE c, d`,
        { id: documentId },
      );
      // 孤儿实体：不再被任何块 MENTIONS 的实体整点删除（同时拆掉 RELATED_TO 残留边）
      await session.run(
        `MATCH (e:KnowledgeEntity)
         WHERE NOT (e)<-[:MENTIONS]-()
         DETACH DELETE e`,
      );
      this.logger.log(`KG 图谱已删除：documentId=${documentId}`);
    } finally {
      await session.close();
    }
  }

  /** 实体检索：按关键词（大小写不敏感的包含匹配）+ 提及次数排序 */
  async listEntities(keyword = '', limit = 20): Promise<GraphEntity[]> {
    if (!this.isAvailable()) return [];
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (e:KnowledgeEntity)
         WHERE $keyword = '' OR toLower(e.name) CONTAINS toLower($keyword)
         OPTIONAL MATCH (e)<-[m:MENTIONS]-()
         RETURN e.name AS name, e.type AS type, e.description AS description,
                count(m) AS mentions
         ORDER BY mentions DESC, name
         LIMIT $limit`,
        { keyword, limit: neo4j.int(limit) },
      );
      return result.records.map((r) => ({
        name: r.get('name'),
        type: r.get('type') ?? 'CONCEPT',
        description: r.get('description') ?? null,
        mentions: toNum(r.get('mentions')),
      }));
    } finally {
      await session.close();
    }
  }

  /** 邻居查询：某实体的全部 RELATED_TO 关系（不分方向），按权重倒序 */
  async getNeighbors(name: string, limit = 20): Promise<GraphNeighbor[]> {
    if (!this.isAvailable()) return [];
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (a:KnowledgeEntity {name: $name})-[r:RELATED_TO]-(b:KnowledgeEntity)
         RETURN b.name AS name, b.type AS type, b.description AS description,
                r.relation AS relation, r.weight AS weight,
                (startNode(r) = a) AS outbound
         ORDER BY r.weight DESC
         LIMIT $limit`,
        { name, limit: neo4j.int(limit) },
      );
      return result.records.map((r) => ({
        entity: {
          name: r.get('name'),
          type: r.get('type') ?? 'CONCEPT',
          description: r.get('description') ?? null,
          mentions: 0,
        },
        relation: r.get('relation') ?? 'RELATED_TO',
        weight: r.get('weight') ?? 0.5,
        direction: r.get('outbound') ? 'out' : 'in',
      }));
    } finally {
      await session.close();
    }
  }

  /** 图规模统计（管理 / 排查用） */
  async getStats(): Promise<{
    documents: number;
    chunks: number;
    entities: number;
    relations: number;
  }> {
    if (!this.isAvailable()) {
      return { documents: 0, chunks: 0, entities: 0, relations: 0 };
    }
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (d:KnowledgeDocument) WITH count(d) AS documents
         MATCH (c:DocumentChunk) WITH documents, count(c) AS chunks
         MATCH (e:KnowledgeEntity) WITH documents, chunks, count(e) AS entities
         MATCH ()-[r:RELATED_TO]->()
         RETURN documents, chunks, entities, count(r) AS relations`,
      );
      const record = result.records[0];
      return {
        documents: toNum(record?.get('documents')),
        chunks: toNum(record?.get('chunks')),
        entities: toNum(record?.get('entities')),
        relations: toNum(record?.get('relations')),
      };
    } finally {
      await session.close();
    }
  }

  /**
   * 图谱关键词检索（feat-v10）：跨三类节点全属性匹配。
   *
   * 与 `listEntities` 的区别：那只搜 KnowledgeEntity.name 一种属性；
   * 这里把关键词打到文档（title/summary）、块（heading/content）、
   * 实体（name/description）六种属性上，前端「图谱检索」页的
   * 主查询。`coalesce` 兜底缺属性，`toLower` 大小写不敏感包含匹配。
   */
  async searchGraph(keyword: string, limit = 50): Promise<GraphSearchHit[]> {
    if (!this.isAvailable()) return [];
    const kw = keyword.trim();
    if (!kw) return [];
    const cap = Math.min(Math.max(limit, 1), 200);
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE toLower(coalesce(n.name, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.title, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.heading, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.description, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.summary, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.content, '')) CONTAINS toLower($kw)
         RETURN labels(n)[0] AS label,
                coalesce(n.name, n.title, n.heading, n.id, n.chunkId) AS name,
                coalesce(n.id, n.chunkId, n.name) AS id,
                n.type AS type, n.title AS title, n.description AS description,
                n.heading AS heading, n.documentId AS documentId, n.summary AS summary,
                CASE WHEN n.content IS NULL THEN null
                     ELSE substring(n.content, 0, 160) END AS snippet
         ORDER BY label, name
         LIMIT $limit`,
        { kw, limit: neo4j.int(cap) },
      );
      return result.records.map((r) => ({
        id: r.get('id'),
        name: r.get('name'),
        label: r.get('label'),
        type: r.get('type') ?? null,
        title: r.get('title') ?? null,
        description: r.get('description') ?? null,
        heading: r.get('heading') ?? null,
        documentId: r.get('documentId') ?? null,
        summary: r.get('summary') ?? null,
        snippet: r.get('snippet') ?? null,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * 图谱可视化（feat-v10）：实体节点全量列表，按提及次数倒序。
   * `listEntities` 的可视化版——不返回 mentions 计数、上限放宽到 500。
   */
  async listNodes(type?: string, limit = 200): Promise<GraphNode[]> {
    if (!this.isAvailable()) return [];
    const cap = Math.min(Math.max(limit, 1), 500);
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (e:KnowledgeEntity)
         WHERE $type IS NULL OR $type = '' OR e.type = $type
         OPTIONAL MATCH (e)<-[m:MENTIONS]-()
         RETURN e.name AS name, e.type AS type, e.description AS description,
                count(m) AS mentions
         ORDER BY mentions DESC, name
         LIMIT $limit`,
        { type: type ?? null, limit: neo4j.int(cap) },
      );
      return result.records.map((r) => ({
        id: r.get('name'),
        name: r.get('name'),
        type: r.get('type') ?? 'CONCEPT',
        description: r.get('description') ?? null,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * 图谱可视化（feat-v10）：实体间 RELATED_TO 边全量列表，按权重倒序。
   * 节点 + 边拼起来即画图首屏的初始视图。
   */
  async listEdges(limit = 500): Promise<GraphEdge[]> {
    if (!this.isAvailable()) return [];
    const cap = Math.min(Math.max(limit, 1), 1000);
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
         RETURN a.name AS source, b.name AS target,
                r.relation AS relation, r.weight AS weight
         ORDER BY r.weight DESC
         LIMIT $limit`,
        { limit: neo4j.int(cap) },
      );
      return result.records.map((r) => ({
        source: r.get('source'),
        target: r.get('target'),
        relation: r.get('relation') ?? 'RELATED_TO',
        weight: toNum(r.get('weight')) || 0.5,
      }));
    } finally {
      await session.close();
    }
  }

  /**
   * 图谱全景数据查询（GET /kg/overview，feat-v12）
   *
   * 返回包含文档节点、实体节点、标签节点及关联边的完整拓扑，
   * 同时带出规模统计、高频实体、最新文档列表，直接供前端力导向图呈现。
   *
   * 容错对齐基线：Neo4j 不可用或查询异常时静默降级返回空骨架，
   * 前端可正常渲染空画布，不因图库故障白屏。
   */
  async getOverview(params: {
    keyword?: string;
    entityType?: string;
    from?: string;
    to?: string;
    docLimit?: number;
  }): Promise<GraphOverview> {
    if (!this.isAvailable()) {
      this.logger.warn('跳过图谱全景查询（Neo4j 不可用），返回空骨架');
      return emptyOverview();
    }

    const kw = params.keyword?.trim() ?? '';
    const entityType = params.entityType?.trim() || null;
    const from = params.from?.trim() || null;
    const to = params.to?.trim() || null;
    const docLimit = Math.min(Math.max(params.docLimit ?? 24, 1), 80);
    const session = this.driver!.session();

    try {
      // 1. 全库统计：文档数、实体数、RELATED_TO 边数、MENTIONS 提及次数（分段 WITH 避免笛卡尔积）
      const statsResult = await session.run(
        `
        OPTIONAL MATCH (d:KnowledgeDocument)
        WITH count(d) AS documentCount
        OPTIONAL MATCH (e:KnowledgeEntity)
        WITH documentCount, count(e) AS entityCount
        OPTIONAL MATCH ()-[rel:RELATED_TO]->()
        WITH documentCount, entityCount, count(rel) AS relatedCount
        OPTIONAL MATCH (:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e0:KnowledgeEntity)
        RETURN documentCount, entityCount, relatedCount, count(e0) AS mentionCount
        `,
      );
      const statsRow = statsResult.records[0];
      const documentCount = toNum(statsRow?.get('documentCount'));
      const entityCount = toNum(statsRow?.get('entityCount'));
      const relatedCount = toNum(statsRow?.get('relatedCount'));
      const mentionCount = toNum(statsRow?.get('mentionCount'));

      // 2. 按实体 type 分组计数，供前端类型过滤器呈现
      const typeRows = await session.run(
        `
        MATCH (e:KnowledgeEntity)
        WHERE e.type IS NOT NULL AND e.type <> ''
        RETURN e.type AS type, count(*) AS count
        ORDER BY count DESC
        `,
      );
      const entityTypes = typeRows.records.map((record) => ({
        type: String(record.get('type')),
        count: toNum(record.get('count')),
      }));

      // 3. 被文档块 MENTIONS 最多的 5 个实体（degree = 提及次数）
      const topRows = await session.run(
        `
        MATCH (e:KnowledgeEntity)<-[:MENTIONS]-(:DocumentChunk)
        RETURN e.name AS name, e.type AS type, count(*) AS degree
        ORDER BY degree DESC
        LIMIT 5
        `,
      );
      const topEntities = topRows.records.map((record) => ({
        name: String(record.get('name')),
        type: (record.get('type') as string) ?? null,
        degree: toNum(record.get('degree')),
      }));

      // 4. 最近更新的 8 篇文档（不受 keyword / 时间 / 类型过滤）
      const recentRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)
        RETURN d.id AS id, d.title AS name, toString(d.updatedAt) AS updatedAt
        ORDER BY d.updatedAt DESC
        LIMIT 8
        `,
      );
      const recentNodes = recentRows.records.map((record) => ({
        id: `doc:${record.get('id') as string}`,
        name: String(record.get('name') ?? ''),
        kind: 'document',
        updatedAt: (record.get('updatedAt') as string) ?? null,
      }));

      // 5. 主查询：按标题/摘要/标签 + 时间筛文档，LIMIT 后挂上 MENTIONS 实体（可按 entityType 再筛）
      const docRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)
        WHERE ($kw = '' OR toLower(coalesce(d.title, '')) CONTAINS toLower($kw)
              OR toLower(coalesce(d.summary, '')) CONTAINS toLower($kw)
              OR toLower(coalesce(d.tags, '')) CONTAINS toLower($kw))
          AND ($from IS NULL OR toString(d.updatedAt) >= $from)
          AND ($to IS NULL OR toString(d.updatedAt) <= $to)
        WITH d ORDER BY d.updatedAt DESC LIMIT $docLimit
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE $entityType IS NULL OR e.type = $entityType
        RETURN d.id AS docId, d.title AS docTitle, d.summary AS summary,
               d.tags AS tags, toString(d.updatedAt) AS updatedAt,
               collect(DISTINCT CASE WHEN e IS NULL THEN NULL ELSE {
                 name: e.name, type: e.type, description: e.description
               } END) AS entities
        `,
        {
          kw,
          entityType,
          from,
          to,
          docLimit: neo4j.int(docLimit),
        },
      );

      const docRecords = [...docRows.records];

      // 6. 关键词命中实体但标题未命中时，把提及该实体的文档补进来
      if (kw) {
        const extra = await session.run(
          `
          MATCH (e:KnowledgeEntity)<-[:MENTIONS]-(:DocumentChunk)<-[:HAS_CHUNK]-(d:KnowledgeDocument)
          WHERE toLower(coalesce(e.name, '')) CONTAINS toLower($kw)
             OR toLower(coalesce(e.description, '')) CONTAINS toLower($kw)
          WITH DISTINCT d
          WHERE ($from IS NULL OR toString(d.updatedAt) >= $from)
            AND ($to IS NULL OR toString(d.updatedAt) <= $to)
          OPTIONAL MATCH (d)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e2:KnowledgeEntity)
          WHERE $entityType IS NULL OR e2.type = $entityType
          RETURN d.id AS docId, d.title AS docTitle, d.summary AS summary,
                 d.tags AS tags, toString(d.updatedAt) AS updatedAt,
                 collect(DISTINCT CASE WHEN e2 IS NULL THEN NULL ELSE {
                   name: e2.name, type: e2.type, description: e2.description
                 } END) AS entities
          LIMIT $docLimit
          `,
          { kw, entityType, from, to, docLimit: neo4j.int(docLimit) },
        );
        const seen = new Set(docRecords.map((r) => String(r.get('docId'))));
        for (const record of extra.records) {
          const id = String(record.get('docId'));
          if (!seen.has(id)) docRecords.push(record);
        }
      }

      const nodeMap = new Map<string, GraphViewNode>();
      const edgeMap = new Map<string, GraphViewEdge>();
      const entityNames = new Set<string>();

      const addEdge = (
        source: string,
        target: string,
        relation: string,
        kind: 'mentions' | 'related' | 'tagged',
      ) => {
        const key = `${kind}|${source}|${target}|${relation}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { source, target, relation, kind });
        }
      };

      const splitTags = (raw: unknown): string[] => {
        if (!raw) return [];
        const str =
          typeof raw === 'string'
            ? raw
            : Array.isArray(raw)
              ? raw.map((item) => String(item ?? '')).join(',')
              : '';
        return str
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);
      };

      for (const record of docRecords) {
        const docId = String(record.get('docId'));
        const docNodeId = `doc:${docId}`;
        nodeMap.set(docNodeId, {
          id: docNodeId,
          name: String(record.get('docTitle') ?? ''),
          kind: 'document',
          type: 'DOCUMENT',
          documentId: docId,
          updatedAt: (record.get('updatedAt') as string) ?? null,
          description: (record.get('summary') as string) ?? null,
        });

        for (const tag of splitTags(record.get('tags'))) {
          const tagId = `tag:${tag}`;
          nodeMap.set(tagId, {
            id: tagId,
            name: tag,
            kind: 'tag',
            type: 'TAG',
          });
          addEdge(docNodeId, tagId, '标注', 'tagged');
        }

        const entities = record.get('entities') as Array<{
          name?: string;
          type?: string;
          description?: string;
        } | null>;

        for (const entity of entities ?? []) {
          if (!entity?.name) continue;
          const entityId = `entity:${entity.name}`;
          entityNames.add(entity.name);
          nodeMap.set(entityId, {
            id: entityId,
            name: entity.name,
            kind: 'entity',
            type: entity.type ?? 'CONCEPT',
            description: entity.description ?? null,
          });
          addEdge(docNodeId, entityId, '提及', 'mentions');
        }
      }

      if (entityNames.size > 0) {
        // 只取当前画布上实体之间的 RELATED_TO，避免拉全库关系导致性能下降
        const relatedRows = await session.run(
          `
          MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
          WHERE a.name IN $names AND b.name IN $names
          RETURN a.name AS source, b.name AS target,
                 r.relation AS relation, r.weight AS weight
          LIMIT 400
          `,
          { names: [...entityNames] },
        );
        for (const record of relatedRows.records) {
          const source = `entity:${record.get('source') as string}`;
          const target = `entity:${record.get('target') as string}`;
          const relation = (record.get('relation') as string) || '关联';
          addEdge(source, target, relation, 'related');
        }
      }

      const nodes = [...nodeMap.values()];
      const edges = [...edgeMap.values()];
      const tagCount = nodes.filter((n) => n.kind === 'tag').length;

      return {
        nodes,
        edges,
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          documentCount,
          entityCount,
          tagCount,
          mentionCount,
          relatedCount,
          entityTypes,
        },
        topEntities,
        recentNodes,
        entityTypes: entityTypes.map((t) => t.type),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`图谱全景查询失败，返回空骨架：${message}`);
      return emptyOverview();
    } finally {
      await session.close();
    }
  }

  /** 唯一约束：没有它 MERGE 退化为全表扫描，图越大建图越慢（基线实现踩坑） */
  private async ensureConstraints(): Promise<void> {
    if (!this.constraintsReady) {
      this.constraintsReady = this.doEnsureConstraints().catch((err) => {
        this.constraintsReady = null;
        throw err;
      });
    }
    return this.constraintsReady;
  }

  private async doEnsureConstraints(): Promise<void> {
    const session = this.driver!.session();
    try {
      await session.run(
        'CREATE CONSTRAINT kh_entity_name IF NOT EXISTS FOR (e:KnowledgeEntity) REQUIRE e.name IS UNIQUE',
      );
      await session.run(
        'CREATE CONSTRAINT kh_chunk_chunkid IF NOT EXISTS FOR (c:DocumentChunk) REQUIRE c.chunkId IS UNIQUE',
      );
      await session.run(
        'CREATE CONSTRAINT kh_document_id IF NOT EXISTS FOR (d:KnowledgeDocument) REQUIRE d.id IS UNIQUE',
      );
      this.logger.log('Neo4j 唯一约束已就绪（entity.name / chunk.chunkId / document.id）');
    } finally {
      await session.close();
    }
  }

  private async writeEntities(
    session: Session,
    entities: Array<{
      name: string;
      type: string;
      description?: string;
      aliases?: string[];
    }>,
  ): Promise<void> {
    if (!entities.length) return;
    await session.run(
      `UNWIND $entities AS e
       MERGE (x:KnowledgeEntity {name: e.name})
       ON CREATE SET x.type = e.type, x.description = e.description,
                     x.aliases = e.aliases, x.createdAt = datetime(),
                     x.updatedAt = datetime()
       ON MATCH SET x.updatedAt = datetime()`,
      { entities },
    );
  }

  private async writeMentions(
    session: Session,
    mentions: Array<{ chunkId: string; name: string }>,
  ): Promise<void> {
    if (!mentions.length) return;
    await session.run(
      `UNWIND $rows AS row
       MATCH (c:DocumentChunk {chunkId: row.chunkId})
       MATCH (e:KnowledgeEntity {name: row.name})
       MERGE (c)-[:MENTIONS]->(e)`,
      { rows: mentions },
    );
  }

  private async writeRelations(
    session: Session,
    relations: Array<{
      source: string;
      target: string;
      relation: string;
      weight: number;
    }>,
  ): Promise<void> {
    if (!relations.length) return;
    await session.run(
      `UNWIND $rels AS r
       MATCH (a:KnowledgeEntity {name: r.source})
       MATCH (b:KnowledgeEntity {name: r.target})
       MERGE (a)-[e:RELATED_TO]->(b)
       ON CREATE SET e.relation = r.relation, e.weight = r.weight,
                     e.createdAt = datetime()
       ON MATCH SET e.weight = CASE WHEN r.weight > e.weight THEN r.weight ELSE e.weight END`,
      { rels: relations },
    );
  }
}

/** ES / Neo4j 的 date/datetime 字段需要 ISO-8601 */
function toIso(value?: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** neo4j-driver 返回 Integer 类型，直接当 number 用会出精度/比较问题 */
function toNum(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && 'toNumber' in (value as object)) {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value) || 0;
}
