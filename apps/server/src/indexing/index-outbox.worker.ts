import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentService } from '../document/document.service.js';
import { GraphBuildService } from '../kg/graph-build.service.js';
import { KgBuildPublisher } from '../kg/kg-build.publisher.js';
import { RagOrchestrator } from '../rag/rag.orchestrator.js';
import { SearchIndexService } from '../search/search-index.service.js';
import type { IndexOutboxEntity } from './entities/index-outbox.entity.js';
import { IndexOutboxService } from './index-outbox.service.js';

export const DEFAULT_SCAN_INTERVAL_MS = 60_000;
export const DEFAULT_BATCH_SIZE = 20;

export interface OutboxScanResult {
  processed: number;
  succeeded: number;
  failed: number;
}

/**
 * 索引失败补偿 Worker：定时扫 kh_index_outbox，按 target 重放失败操作。
 *
 * 设计取舍：
 * - **轮询而非队列**：失败写入本身可能发生在 Redis 不可用时，若再走 BullMQ
 *   会陷入"队列挂了→无法补偿队列故障"的死循环，用 PG 表轮询反而更可靠；
 * - **单实例串行**：补偿是低频动作，串行避免同一文档被并发重建；
 * - **失败计数留在表里**：达到上限转 dead 并 error 告警，人工介入入口是
 *   `GET /tasks/:id` 与 outbox 统计接口。
 */
@Injectable()
export class IndexOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexOutboxWorker.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly outbox: IndexOutboxService,
    private readonly documents: DocumentService,
    private readonly rag: RagOrchestrator,
    private readonly search: SearchIndexService,
    private readonly graph: GraphBuildService,
    private readonly kgPublisher: KgBuildPublisher,
  ) {
    this.enabled =
      config.get<string>('INDEX_OUTBOX_ENABLED', 'true') !== 'false';
    this.intervalMs = Math.max(
      5_000,
      Number(
        config.get(
          'INDEX_OUTBOX_SCAN_INTERVAL_MS',
          String(DEFAULT_SCAN_INTERVAL_MS),
        ),
      ),
    );
    this.batchSize = Math.max(
      1,
      Number(
        config.get('INDEX_OUTBOX_BATCH_SIZE', String(DEFAULT_BATCH_SIZE)),
      ),
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('索引补偿已禁用（INDEX_OUTBOX_ENABLED=false）');
      return;
    }
    this.timer = setInterval(() => {
      void this.scanOnce().catch((error: unknown) => {
        this.logger.error(
          `索引补偿扫描失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref();
    this.logger.log(
      `索引补偿已启动：interval=${this.intervalMs}ms, batch=${this.batchSize}`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 执行一轮补偿；供定时器与单测共用 */
  async scanOnce(): Promise<OutboxScanResult> {
    if (this.running) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }
    this.running = true;

    try {
      const tasks = await this.outbox.findDue(this.batchSize);
      let succeeded = 0;
      let failed = 0;

      for (const task of tasks) {
        try {
          await this.execute(task);
          await this.outbox.markSucceeded(task);
          succeeded += 1;
        } catch (error) {
          failed += 1;
          await this.outbox.markFailed(task, error);
          this.logger.warn(
            `索引补偿失败：documentId=${task.documentId}, target=${task.target}, ${describeError(error)}`,
          );
        }
      }

      if (tasks.length) {
        this.logger.log(
          `索引补偿完成：processed=${tasks.length}, succeeded=${succeeded}, failed=${failed}`,
        );
      }
      return { processed: tasks.length, succeeded, failed };
    } finally {
      this.running = false;
    }
  }

  private async execute(task: IndexOutboxEntity): Promise<void> {
    switch (task.target) {
      case 'rag':
        await this.rebuildRag(task);
        return;
      case 'search':
        await this.rebuildSearch(task);
        return;
      case 'kg':
        await this.requeueKg(task);
        return;
      case 'visibility':
        await this.syncVisibility(task);
        return;
      default:
        throw new Error(`未知补偿目标：${String(task.target)}`);
    }
  }

  private async rebuildRag(task: IndexOutboxEntity): Promise<void> {
    if (task.operation === 'delete') {
      await this.rag.deleteDocument(task.documentId);
      return;
    }
    const doc = await this.loadDocument(task.documentId);
    await this.rag.indexDocument(doc);
  }

  private async rebuildSearch(task: IndexOutboxEntity): Promise<void> {
    if (task.operation === 'delete') {
      await this.search.deleteDocument(task.documentId);
      return;
    }
    const doc = await this.loadDocument(task.documentId);
    await this.search.indexDocument(doc);
  }

  private async requeueKg(task: IndexOutboxEntity): Promise<void> {
    const jobId =
      task.operation === 'delete'
        ? await this.kgPublisher.enqueueDeleteByDocIds([task.documentId])
        : await this.kgPublisher.enqueueBuildByDocIds([task.documentId]);
    if (jobId == null) {
      throw new Error('KG 队列不可用，留待下次重试');
    }
  }

  private async syncVisibility(task: IndexOutboxEntity): Promise<void> {
    const doc = await this.loadDocument(task.documentId);
    const vis = {
      isPublic: doc.isPublic ?? false,
      teamId: doc.teamId ?? null,
      authorId: doc.authorId ?? null,
    };
    await Promise.all([
      this.search.updateVisibility(doc.id, vis),
      this.rag.updateVisibility(doc.id, vis),
      this.graph.updateVisibility(doc.id, vis),
    ]);
  }

  private async loadDocument(documentId: string) {
    const [doc] = await this.documents.loadForIndex([documentId]);
    if (!doc) {
      throw new Error(
        `文档不存在或已删除，无法补偿：documentId=${documentId}`,
      );
    }
    return doc;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
