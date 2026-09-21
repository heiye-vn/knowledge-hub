import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { ChunkingService } from '../rag/chunking.service.js';
import { ExtractionService } from './extraction.service.js';
import type {
  ExtractionOutcome,
} from './extraction.service.js';
import type { GraphEntity, GraphNeighbor, KgBuildResult } from './types/kg.types.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';

/** 单篇建图最多参与的块数：按实测单块 19~57s，30 块 ≈ 10~30 分钟（并发 3 后 ≈ 4~10 分钟） */
const DEFAULT_MAX_CHUNKS = 30;

/**
 * KG 知识图谱构建（Neo4j）
 *
 * 对应参考项目 v5 `pipeline/graph-build.service.ts`。
 *
 * 图模型：
 * ```
 * (KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
 * (KnowledgeEntity)-[:RELATED_TO {relation, weight}]->(KnowledgeEntity)
 * ```
 * ⚠️ 实体间**边类型恒为 RELATED_TO**，语义在 `relation` 属性上。
 *
 * ✅ 相对参考项目的改进：
 * - **启动即建唯一约束**（参考项目没建）：`KnowledgeEntity.name` / `DocumentChunk.chunkId` /
 *   `KnowledgeDocument.id` 没有约束时 MERGE 靠全表扫描，图越大越慢。
 * - **批量抽取（extractBatch，并发 `KG_EXTRACT_CONCURRENCY`）**：参考项目串行逐块调用，
 *   实测单块 19~57s，100 块的文档串行就是小时级。
 * - **块数上限 `KG_MAX_CHUNKS`**：超长文档按序截断，防止单篇建图跑小时级。
 * - **写图用 UNWIND 批量**：参考项目逐条 `session.run`，一块 30 实体就是 60+ 次往返。
 * - **全部块抽取失败视为整篇失败并抛错**：参考项目单块失败只打日志，
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
             d.authorId = $authorId, d.status = $status, d.updatedAt = datetime(),
             d.createdAt = coalesce(d.createdAt, datetime())`,
        {
          id: doc.id,
          title: doc.title,
          summary: doc.summary ?? '',
          categoryId: doc.categoryId ?? null,
          authorId: doc.authorId ?? null,
          status: doc.status,
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

  /** 唯一约束：没有它 MERGE 退化为全表扫描，图越大建图越慢（参考项目踩坑） */
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
