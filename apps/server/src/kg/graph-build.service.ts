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
  GraphChatHit,
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
import { splitGraphKeywords } from './chat-graph.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import type { DocumentAccessScope } from '../document/document-access.js';
import {
  neo4jAccessParams,
  neo4jDocumentAccessWhere,
  neo4jRelationAccessWhere,
} from '../document/document-access.js';

/** 单篇建图最多参与的块数：按实测单块 19~57s，30 块 ≈ 10~30 分钟（并发 3 后 ≈ 4~10 分钟） */
const DEFAULT_MAX_CHUNKS = 30;

/** 图谱全景空骨架：Neo4j 不可用 / 查询异常时静默降级返回，前端渲染空画布 */
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
 * 图模型：
 * ```
 * (KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
 * (KnowledgeEntity)-[:RELATED_TO {relation, weight, sourceChunkIds}]->(KnowledgeEntity)
 * ```
 * ⚠️ 实体间**边类型恒为 RELATED_TO**，语义在 `relation` 属性上。
 *
 * 【核心性能与可靠性设计】
 * - **启动即建唯一约束**：`KnowledgeEntity.name` / `DocumentChunk.chunkId` /
 *   `KnowledgeDocument.id` 建立唯一索引约束，防止 MERGE 退化为全表扫描。
 * - **批量并发抽取（`extractBatch`）**：支持多块并行 LLM 抽取，大幅提升抽取吞吐。
 * - **块数上限 `KG_MAX_CHUNKS`**：超长文档按序截断，防止单篇耗时不可控。
 * - **写图使用 UNWIND 批量写入**：一条 Cypher 提交整个批次，消除频繁往返开销。
 * - **全部块抽取失败视为整篇失败并抛错**：触发异步队列重试，防止生成残缺知识图谱。
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

  /** 配置层面是否启用（与连接是否可用区分，供健康检查与巡检标记 disabled） */
  isEnabled(): boolean {
    return this.enabled;
  }

  isAvailable(): boolean {
    return this.driver !== null;
  }

  /** 主动探活：重新校验 Bolt 连接；失败由健康检查统一降级 */
  async ping(): Promise<void> {
    if (!this.driver) {
      throw new Error('Neo4j 未启用或连接不可用');
    }
    await this.driver.verifyConnectivity();
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
             d.authorId = $authorId, d.teamId = $teamId, d.isPublic = $isPublic,
             d.status = $status, d.tags = $tags, d.updatedAt = datetime(),
             d.createdAt = coalesce(d.createdAt, datetime())`,
        {
          id: doc.id,
          title: doc.title,
          summary: doc.summary ?? '',
          categoryId: doc.categoryId ?? null,
          authorId: doc.authorId ?? null,
          teamId: doc.teamId ?? null,
          isPublic: doc.isPublic ?? false,
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
        isPublic: doc.isPublic,
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
        {
          source: string;
          target: string;
          relation: string;
          weight: number;
          sourceChunkIds: Set<string>;
        }
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
          // 图存储每对实体只有一条 RELATED_TO，同对多语义时保留权重最高的一条；
          // 来源块必须与最终保留的 relation 语义一致，避免权限过滤串语义。
          const weight = r.weight ?? 0.5;
          const key = `${r.source}|${r.target}`;
          const existing = relations.get(key);
          if (!existing) {
            relations.set(key, {
              source: r.source,
              target: r.target,
              relation: r.relation,
              weight,
              sourceChunkIds: new Set([o.chunkId]),
            });
          } else if (weight > existing.weight) {
            existing.relation = r.relation;
            existing.weight = weight;
            existing.sourceChunkIds = new Set([o.chunkId]);
          } else if (existing.relation === r.relation) {
            existing.weight = Math.max(existing.weight, weight);
            existing.sourceChunkIds.add(o.chunkId);
          }
        }
      }

      await this.writeEntities(session, [...entityMap.values()]);
      await this.writeMentions(session, mentions);
      await this.writeRelations(
        session,
        [...relations.values()].map(({ sourceChunkIds, ...relation }) => ({
          ...relation,
          sourceChunkIds: [...sourceChunkIds],
        })),
      );

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
      // 先剔除关系边来源中属于本文件的块；来源被清空说明这条边不再有可见依据
      await session.run(
        `MATCH (d:KnowledgeDocument {id: $id})-[:HAS_CHUNK]->(c:DocumentChunk)
         WITH collect(c.chunkId) AS chunkIds
         MATCH ()-[r:RELATED_TO]->()
         WHERE any(cid IN coalesce(r.sourceChunkIds, []) WHERE cid IN chunkIds)
         SET r.sourceChunkIds = [
           cid IN coalesce(r.sourceChunkIds, []) WHERE NOT cid IN chunkIds
         ]
         WITH r WHERE size(r.sourceChunkIds) = 0
         DELETE r`,
        { id: documentId },
      );
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

  /**
   * 原地更新知识图谱中文档节点的可见性（isPublic, teamId, authorId）
   * 供文档更新或存量回填时调用，避免重新抽取图谱
   */
  async updateVisibility(
    documentId: string,
    vis: {
      isPublic: boolean;
      teamId?: string | null;
      authorId?: string | null;
    },
  ): Promise<void> {
    if (!this.isAvailable()) return;
    const session = this.driver!.session();
    try {
      await session.run(
        `MATCH (d:KnowledgeDocument {id: $id})
         SET d.isPublic = $isPublic, d.teamId = $teamId, d.authorId = $authorId, d.updatedAt = datetime()`,
        {
          id: documentId,
          isPublic: vis.isPublic,
          teamId: vis.teamId ?? null,
          authorId: vis.authorId ?? null,
        },
      );
      this.logger.log(
        `KG 文档节点可见性已更新：documentId=${documentId}, isPublic=${vis.isPublic}, teamId=${vis.teamId ?? '-'}`,
      );
    } finally {
      await session.close();
    }
  }

  /** 统计缺 isPublic 属性的图谱文档节点数量（存量缺口探测） */
  async countMissingVisibilityDocs(): Promise<number> {
    if (!this.isAvailable()) return 0;
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (d:KnowledgeDocument) WHERE d.isPublic IS NULL RETURN count(d) AS cnt`,
      );
      return toNum(result.records[0]?.get('cnt'));
    } catch {
      return 0;
    } finally {
      await session.close();
    }
  }

  /** 实体检索：按关键词（大小写不敏感的包含匹配）+ 提及次数排序 */
  async listEntities(keyword = '', limit = 20, scope?: DocumentAccessScope): Promise<GraphEntity[]> {
    if (!this.isAvailable()) return [];
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[m:MENTIONS]->(e:KnowledgeEntity)
         WHERE (${neo4jDocumentAccessWhere('d')})
           AND ($keyword = '' OR toLower(e.name) CONTAINS toLower($keyword))
         RETURN e.name AS name, e.type AS type, e.description AS description,
                count(m) AS mentions
         ORDER BY mentions DESC, name
         LIMIT $limit`,
        { keyword, limit: neo4j.int(limit), ...neo4jAccessParams(scope) },
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
  async getNeighbors(name: string, limit = 20, scope?: DocumentAccessScope): Promise<GraphNeighbor[]> {
    if (!this.isAvailable()) return [];
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (a:KnowledgeEntity {name: $name})-[r:RELATED_TO]-(b:KnowledgeEntity)
         WHERE ${neo4jRelationAccessWhere('r')}
         RETURN b.name AS name, b.type AS type, b.description AS description,
                r.relation AS relation, r.weight AS weight,
                r.sourceChunkIds AS sourceChunkIds,
                (startNode(r) = a) AS outbound
         ORDER BY r.weight DESC
         LIMIT $limit`,
        { name, limit: neo4j.int(limit), ...neo4jAccessParams(scope) },
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
        sourceChunkIds: (r.get('sourceChunkIds') as string[] | null) ?? [],
        direction: r.get('outbound') ? 'out' : 'in',
      }));
    } finally {
      await session.close();
    }
  }

  /** 图规模统计（管理 / 排查用） */
  async getStats(scope?: DocumentAccessScope): Promise<{
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
        `OPTIONAL MATCH (d:KnowledgeDocument)
         WHERE ${neo4jDocumentAccessWhere('d')}
         WITH count(DISTINCT d) AS documents
         OPTIONAL MATCH (d2:KnowledgeDocument)-[:HAS_CHUNK]->(c:DocumentChunk)
         WHERE ${neo4jDocumentAccessWhere('d2')}
         WITH documents, count(DISTINCT c) AS chunks
         OPTIONAL MATCH (d3:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
         WHERE ${neo4jDocumentAccessWhere('d3')}
         WITH documents, chunks, count(DISTINCT e) AS entities
         OPTIONAL MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
         WHERE ${neo4jRelationAccessWhere('r')}
         RETURN documents, chunks, entities, count(DISTINCT r) AS relations`,
        neo4jAccessParams(scope),
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
  async searchGraph(keyword: string, limit = 50, scope?: DocumentAccessScope): Promise<GraphSearchHit[]> {
    if (!this.isAvailable()) return [];
    const kw = keyword.trim();
    if (!kw) return [];
    const cap = Math.min(Math.max(limit, 1), 200);
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE (toLower(coalesce(n.name, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.title, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.heading, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.description, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.summary, '')) CONTAINS toLower($kw)
            OR toLower(coalesce(n.content, '')) CONTAINS toLower($kw))
           AND ($unrestricted OR (
             (n:KnowledgeDocument AND (${neo4jDocumentAccessWhere('n')}))
             OR (n:DocumentChunk AND EXISTS {
               MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(n)
               WHERE ${neo4jDocumentAccessWhere('d')}
             })
             OR (n:KnowledgeEntity AND EXISTS {
               MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(n)
               WHERE ${neo4jDocumentAccessWhere('d')}
             })
           ))
         RETURN labels(n)[0] AS label,
                coalesce(n.name, n.title, n.heading, n.id, n.chunkId) AS name,
                coalesce(n.id, n.chunkId, n.name) AS id,
                n.type AS type, n.title AS title, n.description AS description,
                n.heading AS heading, n.documentId AS documentId, n.summary AS summary,
                CASE WHEN n.content IS NULL THEN null
                     ELSE substring(n.content, 0, 160) END AS snippet
         ORDER BY label, name
         LIMIT $limit`,
        { kw, limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
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
   * 对话 RAG：按短实体名找可见实体，再查这些实体之间的关系与来源文档。
   * 只做相等 / 前缀 / 后缀，避免「发票」CONTAINS 命中整篇制度标题。
   * 关系、文档用同一 session 顺序查，避免并发共用 session 丢边。
   */
  async retrieveForChat(
    keyword: string | string[],
    limit = 8,
    scope?: DocumentAccessScope,
  ): Promise<GraphChatHit> {
    const kws = splitGraphKeywords(keyword);
    const empty: GraphChatHit = {
      query: kws.join(' / '),
      entities: [],
      relations: [],
      documents: [],
    };
    if (!this.isAvailable()) {
      this.logger.warn('跳过图谱对话检索（Neo4j 不可用）');
      return empty;
    }
    if (!kws.length) return empty;

    const cap = Math.min(Math.max(limit, 1), 20);
    const vis = neo4jAccessParams(scope);
    const session = this.driver!.session();
    try {
      // 先找实体：短词对 name/aliases 做相等、前缀、后缀（不用 CONTAINS，避免「发票」命中长标题）
      const entResult = await session.run(
        `MATCH (e:KnowledgeEntity)
         WHERE any(kw IN $kws WHERE
           toLower(e.name) = toLower(kw)
           OR toLower(replace(replace(e.name, '《', ''), '》', '')) STARTS WITH toLower(kw)
           OR toLower(e.name) ENDS WITH toLower(kw)
           OR any(a IN coalesce(e.aliases, []) WHERE
             toLower(toString(a)) = toLower(kw)
             OR toLower(toString(a)) STARTS WITH toLower(kw)
             OR toLower(toString(a)) ENDS WITH toLower(kw)
           )
         )
         AND (
           $unrestricted OR EXISTS {
             MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e)
             WHERE ${neo4jDocumentAccessWhere('d')}
           }
         )
         RETURN e.name AS name, e.type AS type, e.description AS description
         ORDER BY
           CASE
             WHEN any(kw IN $kws WHERE toLower(e.name) = toLower(kw)) THEN 0
             WHEN any(kw IN $kws WHERE toLower(e.name) STARTS WITH toLower(kw)
               OR toLower(e.name) ENDS WITH toLower(kw)) THEN 1
             ELSE 2
           END,
           size(e.name)
         LIMIT $limit`,
        { kws, limit: neo4j.int(cap), ...vis },
      );
      const entities: GraphChatHit['entities'] = entResult.records.map((r) => ({
        name: r.get('name') as string,
        type: (r.get('type') as string) ?? null,
        description: (r.get('description') as string) ?? null,
      }));
      const names = entities.map((entity) => entity.name);
      if (!names.length) {
        this.logger.log(`图谱对话检索无实体：kws=${kws.join('/')}`);
        return empty;
      }

      // 只取本轮命中实体之间的边，不要扩到图上其它节点
      const relResult = await session.run(
        `MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
         WHERE a.name IN $names AND b.name IN $names
           AND ${neo4jRelationAccessWhere('r')}
         RETURN a.name AS source,
                CASE
                  WHEN r.relation IS NULL OR r.relation = ''
                    OR r.relation = 'RELATED_TO' THEN '关联'
                  ELSE r.relation
                END AS relation,
                b.name AS target,
                r.sourceChunkIds AS sourceChunkIds`,
        { names, ...vis },
      );
      const seen = new Set<string>();
      const relations: GraphChatHit['relations'] = [];
      for (const record of relResult.records) {
        const source = record.get('source') as string;
        const relation = record.get('relation') as string;
        const target = record.get('target') as string;
        const key = `${source}\t${relation}\t${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({
          source,
          relation,
          target,
          sourceChunkIds: (record.get('sourceChunkIds') as string[] | null) ?? [],
        });
      }

      // 这些实体来自哪些当前用户可见的文档（给前端/模型当来源，不当制度原文）
      const docResult = await session.run(
        `MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
         WHERE e.name IN $names
           AND ${neo4jDocumentAccessWhere('d')}
         RETURN DISTINCT d.id AS documentId, d.title AS title
         LIMIT $limit`,
        { names, limit: neo4j.int(cap), ...vis },
      );
      const documents: GraphChatHit['documents'] = docResult.records.map((r) => ({
        documentId: r.get('documentId') as string,
        title: (r.get('title') as string) ?? '',
      }));

      this.logger.log(
        `图谱对话检索：kws=${kws.join('/')} entities=${entities.length} rels=${relations.length}`,
      );
      return { query: kws.join(' / '), entities, relations, documents };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`图谱对话检索失败：${message}`);
      return { ...empty, error: message };
    } finally {
      await session.close();
    }
  }

  /**
   * 图谱可视化（feat-v10）：实体节点全量列表，按提及次数倒序。
   * `listEntities` 的可视化版——不返回 mentions 计数、上限放宽到 500。
   */
  async listNodes(type?: string, limit = 200, scope?: DocumentAccessScope): Promise<GraphNode[]> {
    if (!this.isAvailable()) return [];
    const cap = Math.min(Math.max(limit, 1), 500);
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[m:MENTIONS]->(e:KnowledgeEntity)
         WHERE (${neo4jDocumentAccessWhere('d')})
           AND ($type IS NULL OR $type = '' OR e.type = $type)
         RETURN e.name AS name, e.type AS type, e.description AS description,
                count(m) AS mentions
         ORDER BY mentions DESC, name
         LIMIT $limit`,
        { type: type ?? null, limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
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
  async listEdges(limit = 500, scope?: DocumentAccessScope): Promise<GraphEdge[]> {
    if (!this.isAvailable()) return [];
    const cap = Math.min(Math.max(limit, 1), 1000);
    const session = this.driver!.session();
    try {
      const result = await session.run(
        `MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
         WHERE ${neo4jRelationAccessWhere('r')}
         RETURN a.name AS source, b.name AS target,
                r.relation AS relation, r.weight AS weight,
                r.sourceChunkIds AS sourceChunkIds
         ORDER BY r.weight DESC
         LIMIT $limit`,
        { limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
      );
      return result.records.map((r) => ({
        source: r.get('source'),
        target: r.get('target'),
        relation: r.get('relation') ?? 'RELATED_TO',
        weight: toNum(r.get('weight')) || 0.5,
        sourceChunkIds: (r.get('sourceChunkIds') as string[] | null) ?? [],
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
   * 容错兜底：Neo4j 不可用或查询异常时静默降级返回空骨架，
   * 前端可正常渲染空画布，不因图库故障白屏。
   */
  async getOverview(params: {
    keyword?: string;
    entityType?: string;
    from?: string;
    to?: string;
    docLimit?: number;
  }, scope?: DocumentAccessScope): Promise<GraphOverview> {
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
        WHERE ${neo4jDocumentAccessWhere('d')}
        WITH count(DISTINCT d) AS documentCount
        OPTIONAL MATCH (d2:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d2')}
        WITH documentCount, count(DISTINCT e) AS entityCount
        OPTIONAL MATCH (a:KnowledgeEntity)-[rel:RELATED_TO]->(b:KnowledgeEntity)
        WHERE ${neo4jRelationAccessWhere('rel')}
        WITH documentCount, entityCount, count(DISTINCT rel) AS relatedCount
        OPTIONAL MATCH (d3:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[m:MENTIONS]->(e0:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d3')}
        RETURN documentCount, entityCount, relatedCount, count(m) AS mentionCount
        `,
        neo4jAccessParams(scope),
      );
      const statsRow = statsResult.records[0];
      const documentCount = toNum(statsRow?.get('documentCount'));
      const entityCount = toNum(statsRow?.get('entityCount'));
      const relatedCount = toNum(statsRow?.get('relatedCount'));
      const mentionCount = toNum(statsRow?.get('mentionCount'));

      // 2. 按实体 type 分组计数，供前端类型过滤器呈现
      const typeRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE (${neo4jDocumentAccessWhere('d')})
          AND e.type IS NOT NULL AND e.type <> ''
        RETURN e.type AS type, count(DISTINCT e.name) AS count
        ORDER BY count DESC
        `,
        neo4jAccessParams(scope),
      );
      const entityTypes = typeRows.records.map((record) => ({
        type: String(record.get('type')),
        count: toNum(record.get('count')),
      }));

      // 3. 被文档块 MENTIONS 最多的 5 个实体（degree = 提及次数）
      const topRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[m:MENTIONS]->(e:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d')}
        RETURN e.name AS name, e.type AS type, count(m) AS degree
        ORDER BY degree DESC
        LIMIT 5
        `,
        neo4jAccessParams(scope),
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
        WHERE ${neo4jDocumentAccessWhere('d')}
        RETURN d.id AS id, d.title AS name, toString(d.updatedAt) AS updatedAt
        ORDER BY d.updatedAt DESC
        LIMIT 8
        `,
        neo4jAccessParams(scope),
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
        WHERE (${neo4jDocumentAccessWhere('d')})
          AND ($kw = '' OR toLower(coalesce(d.title, '')) CONTAINS toLower($kw)
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
          ...neo4jAccessParams(scope),
        },
      );

      const docRecords = [...docRows.records];

      // 6. 关键词命中实体但标题未命中时，把提及该实体的文档补进来
      if (kw) {
        const extra = await session.run(
          `
          MATCH (e:KnowledgeEntity)<-[:MENTIONS]-(:DocumentChunk)<-[:HAS_CHUNK]-(d:KnowledgeDocument)
          WHERE (${neo4jDocumentAccessWhere('d')})
            AND (toLower(coalesce(e.name, '')) CONTAINS toLower($kw)
             OR toLower(coalesce(e.description, '')) CONTAINS toLower($kw))
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
          { kw, entityType, from, to, docLimit: neo4j.int(docLimit), ...neo4jAccessParams(scope) },
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
            AND ${neo4jRelationAccessWhere('r')}
          RETURN a.name AS source, b.name AS target,
                 r.relation AS relation, r.weight AS weight
          LIMIT 400
          `,
          { names: [...entityNames], ...neo4jAccessParams(scope) },
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

  /** 唯一约束：没有约束时 MERGE 会退化为全表扫描，导致图越大建图越慢 */
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
      sourceChunkIds: string[];
    }>,
  ): Promise<void> {
    if (!relations.length) return;
    await session.run(
      `UNWIND $rels AS r
       MATCH (a:KnowledgeEntity {name: r.source})
       MATCH (b:KnowledgeEntity {name: r.target})
       MERGE (a)-[e:RELATED_TO]->(b)
       WITH e, r, (e.relation IS NULL OR e.relation = r.relation) AS compatible
       SET e.relation = coalesce(e.relation, r.relation),
           e.weight = CASE
             WHEN compatible AND (e.weight IS NULL OR r.weight > e.weight)
             THEN r.weight ELSE e.weight
           END,
           e.sourceChunkIds = CASE
             WHEN compatible THEN reduce(
               acc = [],
               cid IN coalesce(e.sourceChunkIds, []) + r.sourceChunkIds |
               CASE WHEN cid IN acc THEN acc ELSE acc + cid END
             )
             ELSE coalesce(e.sourceChunkIds, [])
           END,
           e.createdAt = coalesce(e.createdAt, datetime())`,
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
