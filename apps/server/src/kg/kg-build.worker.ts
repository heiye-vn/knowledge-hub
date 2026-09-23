import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import { DocumentEntity, DocumentStatus } from '../document/entities/document.entity.js';
import { DocumentContentEntity } from '../document/entities/document-content.entity.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import {
  DEFAULT_KG_BUILD_CONCURRENCY,
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
  KG_GRAPH_QUEUE,
  REDIS_CONNECT_TIMEOUT_MS,
} from '../mq/mq.constants.js';
import type { KgBuildMessage } from '../mq/messages/pipeline.messages.js';
import { describeError, logThrottled, waitUntilReady } from '../mq/mq-error.util.js';
import { GraphBuildService } from './graph-build.service.js';

/**
 * KG 建图任务的「消费者」（BullMQ Worker）
 *
 * 职责对应基线实现 v5 `mq/document-pipeline.consumer.ts` 的 handleKg
 * → `PipelineOrchestrator.handleKgBuild`。
 *
 * 与 RAG 重建 Worker 的分工：KG 只重建图谱（Neo4j），不碰 ES；
 * RAG 重建（`rag.reindex` 队列）只重建 ES 双索引，不碰 Neo4j —— 两条队列互不连累。
 *
 * 🔴 相对基线实现的修复：它单篇失败只打日志、`BUILD_ALL` 无投递入口；
 * 这里失败明细汇总后抛出触发 BullMQ 重试（管线先清后建，重试安全）。
 */
@Injectable()
export class KgBuildWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KgBuildWorker.name);
  private worker: Worker<KgBuildMessage> | null = null;
  private readonly enabled: boolean;
  private readonly errorLogState = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly graphBuildService: GraphBuildService,
    /** Postgres 实体管理器：按 ID 加载文档元数据与正文（kh_document / kh_document_content） */
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {
    this.enabled = this.config.get<string>('REDIS_ENABLED', 'true') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Redis 已禁用，不启动 KG 建图 Worker');
      return;
    }
    if (!this.graphBuildService.isAvailable()) {
      this.logger.warn('Neo4j 不可用，不启动 KG 建图 Worker（入队任务会堆积）');
      return;
    }

    const host = this.config.get<string>('REDIS_HOST', DEFAULT_REDIS_HOST);
    const port = Number(this.config.get('REDIS_PORT', DEFAULT_REDIS_PORT));
    const concurrency = Math.max(
      1,
      Number(this.config.get('KG_BUILD_CONCURRENCY', DEFAULT_KG_BUILD_CONCURRENCY)),
    );

    try {
      this.worker = new Worker<KgBuildMessage>(
        KG_GRAPH_QUEUE,
        (job) => this.handle(job),
        {
          // BullMQ 要求 Worker 连接关闭重试上限，否则长时间任务会被连接超时打断
          connection: { host, port, maxRetriesPerRequest: null },
          concurrency,
        },
      );
      this.worker.on('failed', (job, err) => {
        this.logger.error(
          `KG 任务失败：taskId=${job?.data?.taskId ?? '-'}, attempts=${job?.attemptsMade}, ${err.message}`,
        );
      });
      this.worker.on('completed', (job) => {
        this.logger.log(`KG 任务完成：taskId=${job?.data?.taskId ?? '-'}`);
      });
      this.worker.on('error', (err) => {
        logThrottled(
          this.logger,
          'error',
          'kg-worker-connection',
          `KG Worker 连接异常：${describeError(err)}`,
          this.errorLogState,
        );
      });
      await waitUntilReady(
        this.worker,
        Number(
          this.config.get('REDIS_CONNECT_TIMEOUT_MS', REDIS_CONNECT_TIMEOUT_MS),
        ),
      );
      this.logger.log(
        `KG 建图 Worker 已启动：queue=${KG_GRAPH_QUEUE}, concurrency=${concurrency}`,
      );
    } catch (err) {
      const message = describeError(err);
      this.logger.error(`KG 建图 Worker 启动失败：${message}`);
      await this.worker?.close().catch(() => undefined);
      this.worker = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private async handle(job: Job<KgBuildMessage>): Promise<void> {
    return this.processMessage(job.data ?? ({} as KgBuildMessage));
  }

  /** 与 BullMQ 的 Job 对象解耦，便于单测；抛错即触发重试 */
  async processMessage(data: KgBuildMessage): Promise<void> {
    const { taskId, type, documentIds } = data;

    if (type === 'DELETE_BY_DOC_IDS') {
      if (!documentIds?.length) {
        this.logger.warn(`忽略空的 KG 删除消息：taskId=${taskId}`);
        return;
      }
      for (const id of documentIds) {
        await this.graphBuildService.deleteForDocument(id);
      }
      return;
    }

    if (type === 'BUILD_BY_DOC_IDS') {
      if (!documentIds?.length) {
        this.logger.warn(`忽略空的 KG 建图消息：taskId=${taskId}`);
        return;
      }
      await this.buildAndReport(
        taskId,
        await this.loadDocumentsByIds(documentIds),
      );
      return;
    }

    if (type === 'BUILD_ALL') {
      await this.buildAndReport(
        taskId,
        await this.loadAllPublishedDocuments(),
      );
      return;
    }

    this.logger.warn(
      `忽略未支持的 KG 消息：taskId=${taskId}, type=${String(type)}`,
    );
  }

  private async buildAndReport(
    taskId: string,
    docs: PipelineDocument[],
  ): Promise<void> {
    if (!docs.length) {
      this.logger.warn(`KG 任务无有效文档：taskId=${taskId}`);
      return;
    }
    this.logger.log(`[KG] 开始建图：taskId=${taskId}, count=${docs.length}`);
    const { succeeded, failed } = await this.graphBuildService.buildBatch(docs);

    if (failed.length) {
      // 抛出以触发重试；建图先清后建 + MERGE 幂等，重试安全
      throw new Error(
        `KG 建图部分失败：成功 ${succeeded.length} 篇，失败 ${failed.length} 篇（${failed
          .map((f) => f.documentId)
          .join(', ')}）`,
      );
    }
    this.logger.log(`[KG] 建图完成：taskId=${taskId}, 成功 ${succeeded.length} 篇`);
  }

  /**
   * 按 ID 加载文档（元数据 + Mongo 正文）。
   * 🟡 与基线实现一致由消费侧自己加载；但本项目刻意**不复用 DocumentService.loadForIndex**——
   * DocumentModule 导入了 KgModule（发布时投递建图任务），反向导入会形成模块环。
   */
  private async loadDocumentsByIds(ids: string[]): Promise<PipelineDocument[]> {
    const result: PipelineDocument[] = [];
    for (const id of ids) {
      const doc = await this.em.findOne(DocumentEntity, {
        where: { id, deleted: false },
      });
      if (!doc) {
        this.logger.warn(`KG 跳过：文档不存在或已删除 documentId=${id}`);
        continue;
      }
      result.push(await this.toPipelineDocument(doc));
    }
    return result;
  }

  private async loadAllPublishedDocuments(): Promise<PipelineDocument[]> {
    const docs = await this.em.find(DocumentEntity, {
      where: { deleted: false, status: DocumentStatus.Published },
    });
    const result: PipelineDocument[] = [];
    for (const doc of docs) {
      result.push(await this.toPipelineDocument(doc));
    }
    return result;
  }

  /** Postgres 元数据 + 正文（kh_document_content）→ 管线统一 DTO（与 DocumentService.toPipelineDocument 同形） */
  private async toPipelineDocument(doc: DocumentEntity): Promise<PipelineDocument> {
    const contentRow = await this.em.findOne(DocumentContentEntity, {
      where: { documentId: doc.id, deleted: false },
    });
    return {
      id: doc.id,
      title: doc.title,
      content: contentRow?.content ?? '',
      summary: doc.summary,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      status: doc.status,
      tags: doc.tags,
      isPublic: doc.isPublic,
      publishTime: doc.publishTime,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
