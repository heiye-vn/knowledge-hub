import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import { DocumentService } from '../document/document.service.js';
import { RagOrchestrator } from '../rag/rag.orchestrator.js';
import { SearchIndexService } from '../search/search-index.service.js';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
  DEFAULT_REINDEX_CONCURRENCY,
  RAG_REINDEX_QUEUE,
  REDIS_CONNECT_TIMEOUT_MS,
} from './mq.constants.js';
import type { ReindexMessage } from './messages/pipeline.messages.js';
import { describeError, logThrottled, waitUntilReady } from './mq-error.util.js';

/**
 * RAG 重建索引任务的「消费者」（BullMQ Worker）
 *
 * 职责对应参考项目 `mq/document-pipeline.consumer.ts` → `PipelineOrchestrator.handleRagReindex`。
 * 相同点：按文档 ID 批量加载 → 走同一条管线（清旧块 → 分块 → 嵌入 → 写 ES）。
 *
 * 🔴 相对参考项目的修复：
 * - 参考项目失败即 `nack(requeue=false)`，消息永久丢失且无感知；
 *   这里失败会抛出 → BullMQ 按 attempts + 指数退避自动重试（配置在 Publisher 的 defaultJobOptions）。
 * - 参考项目单篇失败只打日志就继续，整体仍算成功；
 *   这里把失败明细汇总后抛出，让整批重试（`indexDocuments` 内部单篇失败已隔离，重试是幂等的）。
 *
 * 🟡 实现层分叉：加载文档的动作放在 Worker（调用 `DocumentService.loadForIndex`），
 * 而不是像参考项目那样放进 Orchestrator —— 本项目 Orchestrator 接收已加载的 `PipelineDocument`，
 * 保持「编排器不管数据源」的职责边界。
 */
@Injectable()
export class RagReindexWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagReindexWorker.name);
  private worker: Worker | null = null;
  private readonly enabled: boolean;
  /** 连接错误节流状态 */
  private readonly errorLogState = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly orchestrator: RagOrchestrator,
    private readonly documentService: DocumentService,
    /** 重建时同步刷新文档级搜索索引，避免 /rag/reindex 后两侧不一致 */
    private readonly searchIndexService: SearchIndexService,
  ) {
    this.enabled = this.config.get<string>('REDIS_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Redis 已禁用，不启动重建索引 Worker');
      return;
    }

    const host = this.config.get<string>('REDIS_HOST', DEFAULT_REDIS_HOST);
    const port = Number(this.config.get('REDIS_PORT', DEFAULT_REDIS_PORT));
    const concurrency = Number(
      this.config.get('RAG_REINDEX_CONCURRENCY', DEFAULT_REINDEX_CONCURRENCY),
    );

    try {
      this.worker = new Worker(RAG_REINDEX_QUEUE, (job) => this.handle(job), {
        // BullMQ 要求 Worker 连接关闭重试上限，否则长时间阻塞任务会被连接超时打断
        connection: { host, port, maxRetriesPerRequest: null },
        concurrency,
      });

      this.worker.on('failed', (job, err) => {
        this.logger.error(
          `重建任务失败：taskId=${job?.data?.taskId ?? '-'}, attempts=${job?.attemptsMade}, ${err.message}`,
        );
      });
      this.worker.on('completed', (job) => {
        this.logger.log(`重建任务完成：taskId=${job?.data?.taskId ?? '-'}`);
      });
      // 同 Publisher：Redis 不可达时 BullMQ 会持续重连，日志需节流
      this.worker.on('error', (err) => {
        logThrottled(
          this.logger,
          'error',
          'worker-connection',
          `重建 Worker 连接异常：${describeError(err)}`,
          this.errorLogState,
        );
      });

      // 同 Publisher：对象创建成功 ≠ 连得上，显式探测后再认定可用
      await waitUntilReady(
        this.worker,
        Number(this.config.get('REDIS_CONNECT_TIMEOUT_MS', REDIS_CONNECT_TIMEOUT_MS)),
      );

      this.logger.log(
        `重建索引 Worker 已启动：queue=${RAG_REINDEX_QUEUE}, concurrency=${concurrency}`,
      );
    } catch (err) {
      const message = describeError(err);
      this.logger.error(`重建索引 Worker 启动失败：${message}`);
      await this.worker?.close().catch(() => undefined);
      this.worker = null;
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  /** BullMQ 回调：转成消息后交给 processMessage，抛错即触发重试 */
  private async handle(job: Job<ReindexMessage>): Promise<void> {
    return this.processMessage(job.data ?? ({} as ReindexMessage));
  }

  /**
   * 处理单条重建消息（与 BullMQ 的 Job 对象解耦，便于单测）
   * 抛错即触发 BullMQ 重试
   */
  async processMessage(data: ReindexMessage): Promise<void> {
    const { taskId, type, documentIds } = data;

    if (type !== 'BY_DOC_IDS' || !documentIds?.length) {
      this.logger.warn(`忽略未支持的重建消息：taskId=${taskId}, type=${type}`);
      return;
    }

    this.logger.log(
      `[RAG] 开始重建：taskId=${taskId}, count=${documentIds.length}`,
    );

    const docs = await this.documentService.loadForIndex(documentIds);
    if (!docs.length) {
      this.logger.warn(
        `重建任务无有效文档：taskId=${taskId}（文档可能已被删除）`,
      );
      return;
    }

    const { succeeded, failed } = await this.orchestrator.indexDocuments(docs);

    // 文档级搜索索引与向量索引一起重建：
    // 只重建一侧会导致「语义检索有新数据、全文搜索还是旧的」。
    let searchFailed: string[] = [];
    if (this.searchIndexService.isAvailable()) {
      try {
        // 批量场景不逐条 refresh，减少 ES 开销
        await this.searchIndexService.indexDocuments(docs, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        searchFailed = docs.map((d) => d.id);
        this.logger.error(
          `[Search] 重建失败：taskId=${taskId}, count=${docs.length}, ${message}`,
        );
      }
    } else {
      this.logger.warn(`[Search] 跳过重建（ES 不可用）：taskId=${taskId}`);
    }

    const failedIds = [
      ...new Set([...failed.map((f) => f.documentId), ...searchFailed]),
    ];

    if (failedIds.length) {
      // 抛出以触发重试；管线幂等（先删旧块再覆盖写 / _id 覆盖写），重试安全
      throw new Error(
        `重建部分失败：成功 ${succeeded.length} 篇，失败 ${failedIds.length} 篇（${failedIds.join(', ')}）`,
      );
    }

    this.logger.log(
      `[RAG+Search] 重建完成：taskId=${taskId}, 成功 ${succeeded.length} 篇`,
    );
  }
}
