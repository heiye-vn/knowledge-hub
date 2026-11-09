import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, LessThan } from 'typeorm';
import type { Memory } from 'mem0ai';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { AiMemoryEntity } from './entities/ai-memory.entity.js';

export type MemoryMirrorStats = {
  user: number;
  session: number;
  archived: number;
};

/**
 * 长期记忆本地镜像（feat-v22）。
 *
 * 目的不是替代 Mem0，而是让「外部 SaaS 里的记忆」在本地可统计、可审计、
 * 可批量归档。所有方法都是尽力而为：镜像失败只告警，绝不阻断问答或
 * 记忆写入 —— 镜像本身是派生数据，丢一条不影响正确性。
 *
 * 默认关闭（CHAT_MEMORY_MIRROR_ENABLED=false）：在拿到真实条目量与增长
 * 速度之前，不引入额外写放大。开启后按 memory_id 幂等 upsert。
 */
@Injectable()
export class ChatMemoryMirrorService {
  private readonly logger = new Logger(ChatMemoryMirrorService.name);
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {
    this.enabled =
      config.get<string>('CHAT_MEMORY_MIRROR_ENABLED', 'false') === 'true';
  }

  get active() {
    return this.enabled;
  }

  /** 同步一批 Mem0 条目：按 memory_id 幂等 upsert，已存在则刷新正文与时间 */
  async upsert(
    userId: string,
    sessionId: string | null,
    layer: 'user' | 'session',
    memories: Memory[],
  ): Promise<void> {
    if (!this.enabled || !memories.length) return;
    try {
      for (const memory of memories) {
        const content = memory.memory ?? memory.data?.memory ?? '';
        if (!content.trim()) continue;
        const existing = await this.em.findOne(AiMemoryEntity, {
          where: { memoryId: memory.id },
        });
        if (existing) {
          // 【易错】em.update 不走实体生命周期，不会自动刷新 @UpdateDateColumn
          await this.em.update(
            AiMemoryEntity,
            { id: existing.id },
            { content, status: 'active', updatedAt: new Date() },
          );
          continue;
        }
        await this.em.save(
          this.em.create(AiMemoryEntity, {
            id: nextSnowflakeId(),
            memoryId: memory.id,
            userId,
            sessionId,
            layer,
            content,
            status: 'active',
            sourceCreatedAt: memory.createdAt ? new Date(memory.createdAt) : null,
          }),
        );
      }
    } catch (error) {
      this.logger.warn(
        `记忆镜像写入失败 userId=${userId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 删会话时清掉该会话的镜像条目 */
  async removeSession(userId: string, sessionId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.em.delete(AiMemoryEntity, { userId, sessionId });
    } catch (error) {
      this.logger.warn(
        `记忆镜像会话清理失败 sessionId=${sessionId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 全清时清掉该用户全部镜像条目 */
  async removeAll(userId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.em.delete(AiMemoryEntity, { userId });
    } catch (error) {
      this.logger.warn(
        `记忆镜像全量清理失败 userId=${userId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 删除单条时同步删镜像 */
  async removeByMemoryId(memoryId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.em.delete(AiMemoryEntity, { memoryId });
    } catch (error) {
      this.logger.warn(
        `记忆镜像单条删除失败 memoryId=${memoryId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 把超过 N 天未更新的 active 条目标记为 archived，返回影响行数。
   *
   * 注意：只改本地状态。要让它真正退出检索，还需在 Mem0 侧删除对应条目
   * （调用方负责，见 docs/dev-notes/chat-memory.md 的归档流程）。
   */
  async archiveStale(userId: string, days: number): Promise<number> {
    if (!this.enabled || days <= 0) return 0;
    try {
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const result = await this.em.update(
        AiMemoryEntity,
        { userId, status: 'active', updatedAt: LessThan(cutoff) },
        { status: 'archived', updatedAt: new Date() },
      );
      return result.affected ?? 0;
    } catch (error) {
      this.logger.warn(
        `记忆镜像归档失败 userId=${userId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /** 分层的活跃/归档计数，供治理页与容量评估 */
  async stats(userId: string): Promise<MemoryMirrorStats> {
    if (!this.enabled) return { user: 0, session: 0, archived: 0 };
    try {
      const [user, session, archived] = await Promise.all([
        this.em.count(AiMemoryEntity, {
          where: { userId, layer: 'user', status: 'active' },
        }),
        this.em.count(AiMemoryEntity, {
          where: { userId, layer: 'session', status: 'active' },
        }),
        this.em.count(AiMemoryEntity, { where: { userId, status: 'archived' } }),
      ]);
      return { user, session, archived };
    } catch (error) {
      this.logger.warn(
        `记忆镜像统计失败 userId=${userId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return { user: 0, session: 0, archived: 0 };
    }
  }
}
