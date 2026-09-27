import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { KgBuildPublisher } from '../kg/kg-build.publisher.js';
import { RagReindexPublisher } from './rag-reindex.publisher.js';
import { REDIS_CONNECT_TIMEOUT_MS } from './mq.constants.js';
import { describeError } from './mq-error.util.js';

/** 任务状态视图（`GET /tasks/:taskId` 的返回结构） */
export interface TaskStatusView {
  taskId: string;
  /** 所属队列名：`kg.graph` / `rag.reindex` */
  queue: string;
  /** 消息类型：BUILD_ALL / BUILD_BY_DOC_IDS / DELETE_BY_DOC_IDS / BY_DOC_IDS */
  type: string | null;
  /** 消息携带的文档 ID 列表（全量任务为 null） */
  documentIds: string[] | null;
  /** BullMQ 状态：waiting / active / completed / failed / delayed / unknown */
  state: string;
  attemptsMade: number;
  maxAttempts: number | null;
  /** 失败原因（failed 时有值） */
  failedReason: string | null;
  /** Worker 处理结果（completed 时有值） */
  result: unknown;
  enqueuedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/**
 * 给单次 Redis 查询加超时。
 *
 * 【易错】连接断开时 BullMQ 会把命令缓存在离线队列里**无限等待**（自动重连设计），
 * 不加超时的话，Redis 一挂查询接口就跟着挂死。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`查询超时（${timeoutMs}ms）`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 队列任务状态查询（`kg.graph` 与 `rag.reindex` 共用）
 *
 * 🔵 **相对基线实现的新增**：异步任务此前只有入队响应里的 taskId，
 * 建图 / 批量重建跑到哪一步只能翻日志。本服务把「按 taskId 查状态」
 * 收口成一个统一入口，前端 / 运维凭 taskId 即可轮询
 * 「排队中 / 执行中 / 完成 / 失败」。
 *
 * 设计要点：
 * - jobId 全局唯一（randomUUID），两个队列各查一次，先命中先用；
 * - completed 任务按保留期（COMPLETED_JOB_RETENTION_MS）保留，过期清理后查询 404；
 * - failed 任务永久保留（removeOnFail: false），失败原因可随时追溯；
 * - 两个队列都不可用（Redis 禁用）→ 503；单次查询超时 → 503，绝不挂死请求。
 */
@Injectable()
export class TaskStatusService {
  private readonly logger = new Logger(TaskStatusService.name);
  private readonly queryTimeoutMs: number;

  constructor(
    private readonly reindexPublisher: RagReindexPublisher,
    private readonly kgBuildPublisher: KgBuildPublisher,
    config: ConfigService,
  ) {
    this.queryTimeoutMs = Number(
      config.get('REDIS_CONNECT_TIMEOUT_MS', REDIS_CONNECT_TIMEOUT_MS),
    );
  }

  async getTaskStatus(taskId: string): Promise<TaskStatusView> {
    if (
      !this.reindexPublisher.isAvailable() &&
      !this.kgBuildPublisher.isAvailable()
    ) {
      throw new ServiceUnavailableException(
        '任务队列不可用（检查 REDIS_ENABLED 与 Redis 是否已启动）',
      );
    }

    const [reindexJob, kgJob] = await Promise.all([
      this.findJobOrUnavailable(this.reindexPublisher, taskId),
      this.findJobOrUnavailable(this.kgBuildPublisher, taskId),
    ]);
    const job = reindexJob ?? kgJob;
    if (!job) {
      throw new NotFoundException(
        `任务不存在：${taskId}（taskId 有误，或任务已完成且超出保留期被清理）`,
      );
    }
    return this.toView(job);
  }

  private async findJobOrUnavailable(
    publisher: {
      isAvailable(): boolean;
      findJob(jobId: string): Promise<Job | null>;
    },
    taskId: string,
  ): Promise<Job | null> {
    if (!publisher.isAvailable()) return null;
    try {
      return await withTimeout(publisher.findJob(taskId), this.queryTimeoutMs);
    } catch (err) {
      const message = `任务状态查询失败（Redis 异常）：${describeError(err)}`;
      this.logger.error(message);
      throw new ServiceUnavailableException(message);
    }
  }

  private async toView(job: Job): Promise<TaskStatusView> {
    const data = (job.data ?? {}) as { type?: unknown; documentIds?: unknown };
    return {
      taskId: job.id ?? '',
      queue: job.queueName,
      type: typeof data.type === 'string' ? data.type : null,
      documentIds: Array.isArray(data.documentIds)
        ? data.documentIds.filter((v): v is string => typeof v === 'string')
        : null,
      state: await job.getState(),
      attemptsMade: job.attemptsMade,
      maxAttempts:
        typeof job.opts?.attempts === 'number' ? job.opts.attempts : null,
      failedReason: job.failedReason ?? null,
      result: job.returnvalue ?? null,
      enqueuedAt: job.timestamp ?? null,
      startedAt: job.processedOn ?? null,
      finishedAt: job.finishedOn ?? null,
    };
  }
}
