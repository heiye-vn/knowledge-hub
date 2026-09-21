import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import {
  DEFAULT_KG_BUILD_ATTEMPTS,
  DEFAULT_KG_BUILD_BACKOFF_MS,
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
  KG_GRAPH_QUEUE,
  REDIS_CONNECT_TIMEOUT_MS,
} from '../mq/mq.constants.js';
import type { KgBuildMessage, KgBuildType } from '../mq/messages/pipeline.messages.js';
import { describeError, logThrottled, waitUntilReady } from '../mq/mq-error.util.js';

/**
 * KG 建图任务的「生产者」（BullMQ）
 *
 * 职责对应参考项目 v5 `mq/document-pipeline.publisher.ts` 的 triggerKgBuild / triggerKgDelete。
 * 实现层分叉（沿用既有登记）：RabbitMQ topic 交换机 → BullMQ 单队列，路由语义由 `job.data.type` 承担。
 *
 * 降级：Redis 不可用时 `isAvailable()` 为 false，发布 / 删除照常执行，只是不建图。
 */
@Injectable()
export class KgBuildPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KgBuildPublisher.name);
  private queue: Queue<KgBuildMessage> | null = null;
  private readonly enabled: boolean;
  private readonly errorLogState = new Map<string, number>();

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<string>('REDIS_ENABLED', 'true') !== 'false';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Redis 已禁用，KG 建图队列不可用（不影响发布与检索）');
      return;
    }

    const host = this.config.get<string>('REDIS_HOST', DEFAULT_REDIS_HOST);
    const port = Number(this.config.get('REDIS_PORT', DEFAULT_REDIS_PORT));
    const attempts = Number(
      this.config.get('KG_BUILD_ATTEMPTS', DEFAULT_KG_BUILD_ATTEMPTS),
    );
    const backoffMs = Number(
      this.config.get('KG_BUILD_BACKOFF_MS', DEFAULT_KG_BUILD_BACKOFF_MS),
    );

    try {
      this.queue = new Queue<KgBuildMessage>(KG_GRAPH_QUEUE, {
        connection: { host, port },
        defaultJobOptions: {
          attempts,
          // KG 单块抽取 19~57s，失败重试等更久再退避
          backoff: { type: 'exponential', delay: backoffMs },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });
      this.queue.on('error', (err) => {
        logThrottled(
          this.logger,
          'error',
          'kg-publisher-connection',
          `KG 建图队列连接异常：${describeError(err)}`,
          this.errorLogState,
        );
      });
      // 【易错】new Queue() 连不上也返回实例，必须显式探测
      await waitUntilReady(
        this.queue,
        Number(
          this.config.get('REDIS_CONNECT_TIMEOUT_MS', REDIS_CONNECT_TIMEOUT_MS),
        ),
      );
      this.logger.log(
        `KG 建图队列已就绪：queue=${KG_GRAPH_QUEUE}, redis=${host}:${port}, attempts=${attempts}`,
      );
    } catch (err) {
      const message = describeError(err);
      this.logger.error(`KG 建图队列初始化失败，建图不可用：${message}`);
      await this.queue?.close().catch(() => undefined);
      this.queue = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }

  isAvailable(): boolean {
    return this.queue !== null;
  }

  /** 发布后调用：按文档 ID 建图 */
  async enqueueBuildByDocIds(documentIds: string[]): Promise<string | null> {
    if (!documentIds.length) return null;
    return this.enqueue('BUILD_BY_DOC_IDS', documentIds);
  }

  /** 手动全量建图（`POST /kg/build` 不传 documentIds），换模型 / 修 bug 后重跑用 */
  async enqueueBuildAll(): Promise<string | null> {
    return this.enqueue('BUILD_ALL');
  }

  /** 删除后调用：清理该文档的图谱 */
  async enqueueDeleteByDocIds(documentIds: string[]): Promise<string | null> {
    if (!documentIds.length) return null;
    return this.enqueue('DELETE_BY_DOC_IDS', documentIds);
  }

  private async enqueue(
    type: KgBuildType,
    documentIds?: string[],
  ): Promise<string | null> {
    if (!this.queue) {
      this.logger.warn(
        `KG 建图队列不可用，跳过投递：type=${type}（检查 REDIS_ENABLED 与 Redis 是否启动）`,
      );
      return null;
    }

    const message: KgBuildMessage = {
      taskId: randomUUID(),
      type,
      documentIds,
    };
    await this.queue.add(KG_GRAPH_QUEUE, message, { jobId: message.taskId });
    this.logger.log(
      `KG 任务已入队：type=${type}, taskId=${message.taskId}, count=${documentIds?.length ?? 'all'}`,
    );
    return message.taskId;
  }
}
