import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { UserEntity } from '../user/entities/user.entity.js';
import { NotificationEntity } from './notification.entity.js';
import { BroadcastNotificationDto } from './notification.dto.js';

/** 单次 INSERT 的通知条数上限，避免管理员广播时拼出超大 SQL */
const BROADCAST_CHUNK_SIZE = 500;

export type NotifyInput = {
  userId: string;
  type: 'like' | 'comment' | 'system';
  title: string;
  content?: string | null;
  documentId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
};

/** 站内通知：互动通知（点赞/评论）+ 管理员广播 */
@Injectable()
export class NotificationService {
  constructor(@InjectEntityManager() private readonly em: EntityManager) {}

  async notify(input: NotifyInput) {
    if (!input.userId) return null;
    return this.em.save(
      this.em.create(NotificationEntity, {
        id: nextSnowflakeId(),
        userId: input.userId,
        type: input.type,
        title: input.title.slice(0, 100),
        content: input.content?.slice(0, 2000) ?? null,
        documentId: input.documentId ?? null,
        senderId: input.senderId ?? null,
        senderName: input.senderName?.slice(0, 50) ?? null,
        isRead: false,
      }),
    );
  }

  /**
   * 点赞通知去重：同一发送人对同一文档只保留一条未读通知。
   *
   * 点赞切换在文档行锁内串行化，因此这里的「查未读再写」不存在同用户并发穿透；
   * 用户读完通知后再次点赞仍会产生新通知。
   */
  async notifyLikeOnce(input: Omit<NotifyInput, 'type'>) {
    if (!input.userId) return null;
    const where: FindOptionsWhere<NotificationEntity> = {
      userId: input.userId,
      type: 'like',
      isRead: false,
    };
    if (input.documentId) where.documentId = input.documentId;
    if (input.senderId) where.senderId = input.senderId;
    const existing = await this.em.findOne(NotificationEntity, { where });
    if (existing) return null;
    return this.notify({ ...input, type: 'like' });
  }

  async list(userId: string, page = 1, pageSize = 20) {
    const [items, total] = await this.em.findAndCount(NotificationEntity, {
      where: { userId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  async unreadCount(userId: string) {
    const count = await this.em.count(NotificationEntity, {
      where: { userId, isRead: false },
    });
    return { count };
  }

  async markRead(userId: string, id: string) {
    const row = await this.em.findOne(NotificationEntity, {
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('通知不存在');
    if (!row.isRead) {
      row.isRead = true;
      await this.em.save(row);
    }
    return row;
  }

  async markAllRead(userId: string) {
    await this.em.update(
      NotificationEntity,
      { userId, isRead: false },
      { isRead: true },
    );
    return { ok: true };
  }

  async broadcast(
    dto: BroadcastNotificationDto,
    sender: { userId: string; name: string },
  ) {
    const title = dto.title.trim();
    const content = dto.content.trim();
    if (!title || !content) throw new BadRequestException('标题和内容不能为空');

    const users = dto.userIds?.length
      ? await this.em.find(UserEntity, {
          where: { id: In(dto.userIds), deleted: false, status: 1 },
        })
      : await this.em.find(UserEntity, {
          where: { deleted: false, status: 1 },
        });
    if (!users.length) throw new BadRequestException('没有可接收的用户');

    const rows = users.map((user) =>
      this.em.create(NotificationEntity, {
        id: nextSnowflakeId(),
        userId: user.id,
        type: 'system',
        title: title.slice(0, 100),
        content: content.slice(0, 2000),
        documentId: null,
        senderId: sender.userId,
        senderName: sender.name.slice(0, 50),
        isRead: false,
      }),
    );
    for (let index = 0; index < rows.length; index += BROADCAST_CHUNK_SIZE) {
      await this.em.save(rows.slice(index, index + BROADCAST_CHUNK_SIZE));
    }
    return { count: rows.length };
  }
}
