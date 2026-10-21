import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In, LessThanOrEqual } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import {
  IndexOutboxEntity,
  type IndexOperation,
  type IndexTarget,
} from './entities/index-outbox.entity.js';

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 8;
export const DEFAULT_OUTBOX_BACKOFF_MS = 30_000;
const MAX_ERROR_LENGTH = 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface RecordIndexFailureInput {
  documentId: string;
  target: IndexTarget;
  operation: IndexOperation;
  error: unknown;
}

/**
 * 索引失败 outbox：
 * - 记录失败时按 (document_id, target, operation) 合并未完成任务，避免重复堆积；
 * - 重试由 IndexOutboxWorker 负责，本服务只读写表；
 * - 记录失败本身不能让原始业务失败，因此所有写入异常只告警。
 */
@Injectable()
export class IndexOutboxService {
  private readonly logger = new Logger(IndexOutboxService.name);
  private readonly enabled: boolean;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<string>('INDEX_OUTBOX_ENABLED', 'true') !== 'false';
    this.maxAttempts = Math.max(
      1,
      Number(
        config.get(
          'INDEX_OUTBOX_MAX_ATTEMPTS',
          String(DEFAULT_OUTBOX_MAX_ATTEMPTS),
        ),
      ),
    );
    this.backoffMs = Math.max(
      1000,
      Number(
        config.get('INDEX_OUTBOX_BACKOFF_MS', String(DEFAULT_OUTBOX_BACKOFF_MS)),
      ),
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 记录一次索引失败；未启用的环境直接跳过 */
  async record(input: RecordIndexFailureInput): Promise<string | null> {
    if (!this.enabled) return null;

    const message = describeError(input.error).slice(0, MAX_ERROR_LENGTH);
    try {
      const rows = (await this.em.query(
        `INSERT INTO kh_index_outbox
           (id, document_id, target, operation, status, attempts, last_error,
            next_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', 0, $5, NOW(), NOW(), NOW())
         ON CONFLICT (document_id, target, operation)
           WHERE status IN ('pending', 'retry')
         DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = NOW()
         RETURNING id`,
        [
          nextSnowflakeId(),
          input.documentId,
          input.target,
          input.operation,
          message,
        ],
      )) as Array<{ id: string }>;
      return rows[0]?.id ? String(rows[0].id) : null;
    } catch (error) {
      this.logger.warn(`索引失败任务写入 outbox 失败：${describeError(error)}`);
      return null;
    }
  }

  /** 取出到期的待重试任务 */
  async findDue(limit: number): Promise<IndexOutboxEntity[]> {
    if (!this.enabled) return [];
    return this.em.find(IndexOutboxEntity, {
      where: {
        status: In(['pending', 'retry']),
        nextRunAt: LessThanOrEqual(new Date()),
      },
      order: { nextRunAt: 'ASC' },
      take: Math.max(1, limit),
    });
  }

  async markSucceeded(task: IndexOutboxEntity): Promise<void> {
    await this.em.update(
      IndexOutboxEntity,
      { id: task.id },
      {
        status: 'succeeded',
        attempts: task.attempts + 1,
        lastError: null,
        updatedAt: new Date(),
      },
    );
  }

  async markFailed(
    task: IndexOutboxEntity,
    error: unknown,
  ): Promise<void> {
    const attempts = task.attempts + 1;
    const dead = attempts >= this.maxAttempts;
    await this.em.update(
      IndexOutboxEntity,
      { id: task.id },
      {
        status: dead ? 'dead' : 'retry',
        attempts,
        lastError: describeError(error).slice(0, MAX_ERROR_LENGTH),
        nextRunAt: dead
          ? new Date()
          : new Date(Date.now() + this.backoffFor(attempts)),
        updatedAt: new Date(),
      },
    );

    if (dead) {
      this.logger.error(
        `索引补偿任务达到上限，停止重试：id=${task.id}, documentId=${task.documentId}, target=${task.target}`,
      );
    }
  }

  async stats(): Promise<Record<string, number>> {
    if (!this.enabled) return {};
    const rows = (await this.em.query(
      `SELECT status, count(*)::int AS count
       FROM kh_index_outbox
       GROUP BY status`,
    )) as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  private backoffFor(attempts: number): number {
    const exponent = Math.min(Math.max(attempts - 1, 0), 10);
    return Math.min(this.backoffMs * 2 ** exponent, MAX_BACKOFF_MS);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
