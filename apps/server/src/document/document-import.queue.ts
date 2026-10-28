import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { DocumentImportService } from './document-import.service.js';
import { logThrottled, waitUntilReady } from '../mq/mq-error.util.js';

const QUEUE_NAME = 'document.import';

@Injectable()
export class DocumentImportQueue implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private readonly logger = new Logger(DocumentImportQueue.name);
  private readonly errors = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly imports: DocumentImportService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.config.get('REDIS_ENABLED', 'true') === 'false') return;
    const connection = {
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: Number(this.config.get('REDIS_PORT', 6379)),
    };
    const timeout = Number(this.config.get('REDIS_CONNECT_TIMEOUT_MS', 5000));
    try {
      this.queue = new Queue(QUEUE_NAME, {
        connection: {
          ...connection,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      });
      this.queue.on('error', () => this.warn('queue'));
      await waitUntilReady(this.queue, timeout);
      await this.queue.setGlobalConcurrency(2);
      this.worker = new Worker<{ id: string }>(
        QUEUE_NAME,
        async (job) => {
          await this.imports.process(job.data.id);
        },
        {
          connection: { ...connection, maxRetriesPerRequest: null },
          concurrency: 2,
          limiter: { max: 20, duration: 60_000 },
        },
      );
      this.worker.on('error', () => this.warn('worker'));
      this.worker.on('failed', () => this.warn('job'));
      await waitUntilReady(this.worker, timeout);
      await this.dispatch();
      this.timer = setInterval(() => {
        void this.dispatch();
      }, 5000);
      this.timer.unref();
    } catch {
      this.warn('initialization');
      await this.worker?.close(true).catch(() => undefined);
      await this.queue?.close().catch(() => undefined);
      this.worker = null;
      this.queue = null;
    }
  }

  async dispatch(): Promise<void> {
    if (!this.queue || this.dispatching) return;
    this.dispatching = true;
    try {
      for (const task of await this.imports.pending()) {
        await this.queue.add(
          'parse',
          { id: task.id },
          { jobId: `${task.id}-${task.attempt}` },
        );
      }
    } catch {
      this.warn('dispatch');
    } finally {
      this.dispatching = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
  }

  /** 队列与 Worker 均初始化成功才认为可接单；Redis 启动失败时为 false。 */
  isReady(): boolean {
    return this.queue !== null && this.worker !== null;
  }

  private warn(key: string): void {
    logThrottled(
      this.logger,
      'warn',
      key,
      '导入队列暂时不可用；持久化任务将在队列恢复后继续',
      this.errors,
    );
  }
}
