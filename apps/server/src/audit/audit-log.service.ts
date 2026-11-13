import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { DocumentEntity } from '../document/entities/document.entity.js';
import { AuditLogEntity } from './audit-log.entity.js';

/** 对外返回的操作记录（前端首页「近期操作记录」直接消费） */
export interface AuditLogView {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  targetName: string | null;
  detail: string | null;
  createdAt: Date;
  /** 相关文档当前是否仍存在（软删的文档不该给可点链接，否则点进去 404） */
  targetExists: boolean;
}

/**
 * 审计日志
 *
 * - `record` 是 fire-and-forget：写失败只静默丢弃，绝不影响业务主流程
 *   （与通知「尽力而为」的处理一致，审计是旁路能力）；
 * - 查询按角色收口：管理员看全部，普通用户只看自己的操作，
 *   避免通过操作记录推断他人私有文档的存在。
 */
@Injectable()
export class AuditLogService {
  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 记录一条审计日志（不 await，调用方无需处理失败） */
  record(params: {
    actor: Pick<AuthUser, 'userId' | 'username' | 'realName'>;
    action: string;
    targetType: string;
    targetId?: string | null;
    targetName?: string | null;
    detail?: string | null;
  }): void {
    void this.em
      .insert(AuditLogEntity, {
        id: nextSnowflakeId(),
        actorId: params.actor.userId,
        actorName: params.actor.realName ?? params.actor.username,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId ?? null,
        targetName: params.targetName ?? null,
        detail: params.detail ?? null,
      })
      .catch(() => undefined);
  }

  /** 最近操作记录（管理员看全部；普通用户只看自己的） */
  async recent(user: AuthUser, limit = 10): Promise<AuditLogView[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const qb = this.em
      .createQueryBuilder(AuditLogEntity, 'log')
      .orderBy('log.created_at', 'DESC')
      .take(safeLimit);

    if (!user.roles.includes(RoleCode.ADMIN)) {
      qb.where('log.actor_id = :actorId', { actorId: user.userId });
    }

    const rows = await qb.getMany();

    // 判断「相关文档」是否仍存在：审计记录必须保留（含删除操作的记录），
    // 但软删文档不再给可点链接，避免用户点进去看到 404。
    const docIds = [
      ...new Set(
        rows
          .filter(
            (row) => row.targetType === 'document' && Boolean(row.targetId),
          )
          .map((row) => row.targetId as string),
      ),
    ];
    const aliveIds = docIds.length
      ? new Set(
          (
            await this.em.find(DocumentEntity, {
              where: { id: In(docIds), deleted: false },
              select: { id: true },
            })
          ).map((doc) => doc.id),
        )
      : new Set<string>();

    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorName: row.actorName,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      targetName: row.targetName,
      detail: row.detail,
      createdAt: row.createdAt,
      targetExists:
        row.targetType === 'document' && row.targetId
          ? aliveIds.has(row.targetId)
          : false,
    }));
  }
}
