import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import {
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
  DEFAULT_REINDEX_ATTEMPTS,
  DEFAULT_REINDEX_BACKOFF_MS,
  RAG_REINDEX_QUEUE,
  REDIS_CONNECT_TIMEOUT_MS,
} from './mq.constants.js';
import type { ReindexMessage } from './messages/pipeline.messages.js';
import { describeError, logThrottled, waitUntilReady } from './mq-error.util.js';

/**
 * RAG 重建索引任务的「生产者」
 *
 * 职责对应基线实现 `mq/document-pipeline.publisher.ts`：把重建任务投递到队列。
 * 区别：基线实现是发布后自动投递（异步化 publish），本项目按**方案 B** 保持 publish 同步，
 * 队列只服务于「批量重建」（典型场景：换 embedding 模型后全量重索引）。
 *
 * 降级：Redis 不可用时 `isAvailable()` 返回 false，不阻断应用启动。
 */
@Injectable()
export class RagReindexPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagReindexPublisher.name);
  private queue: Queue | null = null;
  private readonly enabled: boolean;
  /** 连接错误节流状态 */
  private readonly errorLogState = new Map<string, number>();

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<string>('REDIS_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Redis 已禁用，重建索引队列不可用（不影响发布与检索）');
      return;
    }

    const host = this.config.get<string>('REDIS_HOST', DEFAULT_REDIS_HOST);
    const port = Number(this.config.get('REDIS_PORT', DEFAULT_REDIS_PORT));
    const attempts = Number(
      this.config.get('RAG_REINDEX_ATTEMPTS', DEFAULT_REINDEX_ATTEMPTS),
    );
    const backoffMs = Number(
      this.config.get('RAG_REINDEX_BACKOFF_MS', DEFAULT_REINDEX_BACKOFF_MS),
    );

    try {
      this.queue = new Queue(RAG_REINDEX_QUEUE, {
        connection: { host, port },
        defaultJobOptions: {
          attempts,
          // 指数退避：backoffMs → 2×backoffMs → 4×backoffMs
          backoff: { type: 'exponential', delay: backoffMs },
          removeOnComplete: true,
          removeOnFail: false, // 失败任务保留，便于排查
        },
      });
      // 不挂 error 监听时，连接错误会以 unhandled 'error' 事件抛出并拖垮进程。
      // Redis 不可达时 BullMQ 会持续重连，故日志做节流，避免刷屏淹没业务日志。
      this.queue.on('error', (err) => {
        logThrottled(
          this.logger,
          'error',
          'publisher-connection',
          `重建队列连接异常：${describeError(err)}`,
          this.errorLogState,
        );
      });
      // 对象创建成功 ≠ 连得上：显式探测一次，连不上就判定不可用并关闭，
      // 避免「接口假装可用、入队时挂住」
      await waitUntilReady(
        this.queue,
        Number(this.config.get('REDIS_CONNECT_TIMEOUT_MS', REDIS_CONNECT_TIMEOUT_MS)),
      );

      this.logger.log(
        `重建索引队列已就绪：queue=${RAG_REINDEX_QUEUE}, redis=${host}:${port}, attempts=${attempts}`,
      );
    } catch (err) {
      const message = describeError(err);
      this.logger.error(`重建索引队列初始化失败，批量重建不可用：${message}`);
      await this.queue?.close().catch(() => undefined);
      this.queue = null;
    }
  }

  async onModuleDestroy() {
    await this.queue?.close();
  }

  /** 队列是否可用（Redis 启用且客户端创建成功） */
  isAvailable(): boolean {
    return this.queue !== null;
  }

  /**
   * 投递一批文档的重建任务
   * @param documentIds 待重建的文档 ID；为空不投递
   * @returns taskId 用于日志追踪
   */
  async enqueue(documentIds: string[]): Promise<{ taskId: string; queued: number }> {
    if (!documentIds.length) {
      throw new Error('documentIds 不能为空');
    }
    if (!this.queue) {
      throw new Error('重建索引队列不可用（检查 REDIS_ENABLED 与 Redis 是否启动）');
    }

    const message: ReindexMessage = {
      taskId: randomUUID(),
      type: 'BY_DOC_IDS',
      documentIds,
    };

    await this.queue.add(RAG_REINDEX_QUEUE, message, { jobId: message.taskId });

    this.logger.log(
      `重建索引任务已入队：taskId=${message.taskId}, count=${documentIds.length}`,
    );

    return { taskId: message.taskId, queued: documentIds.length };
  }
}
