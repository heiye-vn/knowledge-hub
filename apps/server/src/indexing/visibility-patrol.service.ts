import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { DocumentStatus } from '../document/document-status.js';
import { GraphBuildService } from '../kg/graph-build.service.js';
import { ElasticsearchService } from '../rag/elasticsearch.service.js';
import { RagOrchestrator } from '../rag/rag.orchestrator.js';
import { SearchIndexService } from '../search/search-index.service.js';
import { IndexOutboxService } from './index-outbox.service.js';

export interface VisibilityPatrolResult {
  scanned: number;
  synced: number;
  failed: number;
}

const DEFAULT_PATROL_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_PATROL_BATCH_SIZE = 200;

/**
 * ES / KG 可见性巡检（幂等校正）。
 *
 * 每轮按 published 文档分页，把 PostgreSQL 的 is_public / team_id / author_id
 * 重新写回 kh_chunk、kh_document 与 Neo4j 文档节点。它不是"只查差异"的只读巡检，
 * 而是以写代检：操作幂等、实现简单，代价是每轮会产生 N 次索引更新。
 *
 * 失败文档写入 outbox，由 IndexOutboxWorker 按退避重试。
 * 定时任务可用 VISIBILITY_PATROL_ENABLED=false 关闭，管理员仍可手动触发。
 */
@Injectable()
export class VisibilityPatrolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VisibilityPatrolService.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    private readonly es: ElasticsearchService,
    private readonly rag: RagOrchestrator,
    private readonly search: SearchIndexService,
    private readonly graph: GraphBuildService,
    private readonly outbox: IndexOutboxService,
    config: ConfigService,
  ) {
    this.enabled =
      config.get<string>('VISIBILITY_PATROL_ENABLED', 'true') !== 'false';
    this.intervalMs = Math.max(
      60_000,
      Number(
        config.get(
          'VISIBILITY_PATROL_INTERVAL_MS',
          String(DEFAULT_PATROL_INTERVAL_MS),
        ),
      ),
    );
    this.batchSize = Math.max(
      1,
      Number(
        config.get(
          'VISIBILITY_PATROL_BATCH_SIZE',
          String(DEFAULT_PATROL_BATCH_SIZE),
        ),
      ),
    );
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.warn('可见性巡检已禁用（VISIBILITY_PATROL_ENABLED=false）');
      return;
    }
    this.timer = setInterval(() => {
      void this.run().catch((error: unknown) => {
        this.logger.error(
          `可见性巡检失败：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref();
    this.logger.log(
      `可见性巡检已启动：interval=${this.intervalMs}ms, batch=${this.batchSize}`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 执行一轮全量可见性校正；供定时器与管理员手动触发共用 */
  async run(): Promise<VisibilityPatrolResult> {
    if (this.running) {
      return { scanned: 0, synced: 0, failed: 0 };
    }
    this.running = true;

    try {
      let scanned = 0;
      let synced = 0;
      let failed = 0;
      let offset = 0;

      while (true) {
        const docs = await this.em.find(DocumentEntity, {
          where: {
            deleted: false,
            status: DocumentStatus.Published,
          },
          select: {
            id: true,
            isPublic: true,
            teamId: true,
            authorId: true,
          },
          order: { id: 'ASC' },
          skip: offset,
          take: this.batchSize,
        });

        if (!docs.length) break;

        for (const doc of docs) {
          try {
            await this.syncDocument(doc);
            synced += 1;
          } catch (error) {
            failed += 1;
            await this.outbox.record({
              documentId: doc.id,
              target: 'visibility',
              operation: 'visibility',
              error,
            });
          }
        }

        scanned += docs.length;
        if (docs.length < this.batchSize) break;
        offset += docs.length;
      }

      this.logger.log(
        `可见性巡检完成：scanned=${scanned}, synced=${synced}, failed=${failed}`,
      );
      return { scanned, synced, failed };
    } finally {
      this.running = false;
    }
  }

  private async syncDocument(
    doc: Pick<DocumentEntity, 'id' | 'isPublic' | 'teamId' | 'authorId'>,
  ): Promise<void> {
    const esEnabled = this.es.isEnabled();
    if (esEnabled && !this.search.isAvailable()) {
      throw new Error('Elasticsearch 不可用');
    }
    if (this.graph.isEnabled() && !this.graph.isAvailable()) {
      throw new Error('Neo4j 不可用');
    }

    const vis = {
      isPublic: doc.isPublic ?? false,
      teamId: doc.teamId ?? null,
      authorId: doc.authorId ?? null,
    };

    const tasks: Array<Promise<unknown>> = [];
    if (esEnabled) {
      tasks.push(this.search.updateVisibility(doc.id, vis));
      tasks.push(this.rag.updateVisibility(doc.id, vis));
    }
    if (this.graph.isAvailable()) {
      tasks.push(this.graph.updateVisibility(doc.id, vis));
    }
    await Promise.all(tasks);
  }
}
