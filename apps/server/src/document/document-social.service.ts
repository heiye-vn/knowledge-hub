import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, In } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { RoleCode } from '../common/constants/roles.js';
import { accessFromUser, canReadDocument } from './document-access.js';
import { DocumentStatus } from './document-status.js';
import { DocumentEntity } from './entities/document.entity.js';
import { CommentEntity } from './entities/comment.entity.js';
import { DocumentLikeEntity } from './entities/document-like.entity.js';
import { DocumentFavoriteEntity } from './entities/document-favorite.entity.js';
import { CreateCommentDto } from './dto/social.dto.js';
import { NotificationService } from '../notification/notification.service.js';

/**
 * 文档互动：点赞、收藏、评论。
 *
 * 计数列与互动行同库，全部放在一个事务里，并对文档行加行锁：
 * 同一篇文档的并发点赞/评论串行化，避免"读-算-写"丢更新与双击撞唯一键。
 * 通知在事务提交后发送，失败不影响互动结果。
 */
@Injectable()
export class DocumentSocialService {
  private readonly logger = new Logger(DocumentSocialService.name);

  constructor(
    @InjectEntityManager() private readonly em: EntityManager,
    private readonly notifications: NotificationService,
  ) {}

  async flags(documentId: string, userId: string) {
    const [likeRow, favoriteRow] = await Promise.all([
      this.em.findOne(DocumentLikeEntity, { where: { documentId, userId } }),
      this.em.findOne(DocumentFavoriteEntity, { where: { documentId, userId } }),
    ]);
    return { liked: Boolean(likeRow), favorited: Boolean(favoriteRow) };
  }

  async toggleLike(documentId: string, user: AuthUser) {
    const outcome = await this.em.transaction(async (tx) => {
      const doc = await this.requireReadable(documentId, user, tx, true);
      const existing = await tx.findOne(DocumentLikeEntity, {
        where: { documentId, userId: user.userId },
      });
      if (existing) {
        await tx.delete(DocumentLikeEntity, { id: existing.id });
        doc.likeCount = Math.max(0, (doc.likeCount ?? 0) - 1);
      } else {
        await tx.save(
          tx.create(DocumentLikeEntity, {
            id: nextSnowflakeId(),
            documentId,
            userId: user.userId,
          }),
        );
        doc.likeCount = (doc.likeCount ?? 0) + 1;
      }
      await tx.save(doc);
      return { liked: !existing, likeCount: doc.likeCount, doc };
    });

    if (outcome.liked) {
      await this.notifyAuthor(outcome.doc, user, 'like');
    }
    return { liked: outcome.liked, likeCount: outcome.likeCount };
  }

  async toggleFavorite(documentId: string, user: AuthUser) {
    return this.em.transaction(async (tx) => {
      const doc = await this.requireReadable(documentId, user, tx, true);
      const existing = await tx.findOne(DocumentFavoriteEntity, {
        where: { documentId, userId: user.userId },
      });
      if (existing) {
        await tx.delete(DocumentFavoriteEntity, { id: existing.id });
        doc.favouriteCount = Math.max(0, (doc.favouriteCount ?? 0) - 1);
      } else {
        await tx.save(
          tx.create(DocumentFavoriteEntity, {
            id: nextSnowflakeId(),
            documentId,
            userId: user.userId,
          }),
        );
        doc.favouriteCount = (doc.favouriteCount ?? 0) + 1;
      }
      await tx.save(doc);
      return { favorited: !existing, favouriteCount: doc.favouriteCount };
    });
  }

  /** 收藏列表：可见性条件下推到 SQL，先取当页 ID 再回表，避免全量收藏在内存里过滤 */
  async listFavorites(user: AuthUser, page = 1, pageSize = 20) {
    const base = () => {
      const qb = this.em
        .createQueryBuilder(DocumentEntity, 'doc')
        .innerJoin(
          'kh_document_favorite',
          'fav',
          'fav.document_id = doc.id AND fav.user_id = :favUserId',
          { favUserId: user.userId },
        )
        .where('doc.deleted = false');

      const scope = accessFromUser(user);
      if (!scope.unrestricted) {
        const params: Record<string, unknown> = {
          me: scope.userId,
          published: DocumentStatus.Published,
        };
        let visibility = `(doc.author_id = :me OR (doc.status = :published AND doc.is_public = true`;
        if (scope.teamIds.length) {
          visibility += ' OR doc.team_id IN (:...teamIds)';
          params.teamIds = scope.teamIds;
        }
        visibility += '))';
        qb.andWhere(visibility, params);
      }
      return qb;
    };

    const rows = await base()
      .select('doc.id', 'id')
      .addSelect('fav.created_at', 'fav_created_at')
      .orderBy('fav_created_at', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize)
      .getRawMany<{ id: string }>();
    const total = await base().getCount();
    if (!rows.length) return { items: [], total, page, pageSize };

    const docs = await this.em.find(DocumentEntity, {
      where: { id: In(rows.map((row) => row.id)) },
    });
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    const items = rows
      .map((row) => byId.get(row.id))
      .filter((doc): doc is DocumentEntity => Boolean(doc));
    return { items, total, page, pageSize };
  }

  async listComments(documentId: string, user: AuthUser) {
    await this.requireReadable(documentId, user);
    return this.em.find(CommentEntity, {
      where: { documentId, deleted: false },
      order: { createdAt: 'ASC' },
    });
  }

  async addComment(documentId: string, dto: CreateCommentDto, user: AuthUser) {
    const content = dto.content.trim();
    if (!content) throw new BadRequestException('评论不能为空');

    const outcome = await this.em.transaction(async (tx) => {
      const doc = await this.requireReadable(documentId, user, tx, true);
      let parent: CommentEntity | null = null;
      if (dto.parentId) {
        parent = await tx.findOne(CommentEntity, {
          where: { id: dto.parentId, documentId, deleted: false },
        });
        if (!parent) throw new BadRequestException('回复的评论不存在');
        if (parent.parentId) throw new BadRequestException('只能回复顶层评论');
      }

      const comment = await tx.save(
        tx.create(CommentEntity, {
          id: nextSnowflakeId(),
          documentId,
          userId: user.userId,
          userName: (user.realName || user.username).slice(0, 50),
          content,
          parentId: parent?.id ?? null,
          deleted: false,
        }),
      );
      doc.commentCount = (doc.commentCount ?? 0) + 1;
      await tx.save(doc);
      return { comment, commentCount: doc.commentCount, doc, parent };
    });

    await this.notifyAuthor(outcome.doc, user, 'comment', content);
    const parent = outcome.parent;
    if (
      parent &&
      parent.userId !== user.userId &&
      parent.userId !== outcome.doc.authorId
    ) {
      await this.notifyPerson(parent.userId, user, {
        title: `${user.realName || user.username} 回复了你的评论`,
        content: `《${outcome.doc.title}》${content.slice(0, 80)}`,
        documentId,
      });
    }
    return {
      comment: outcome.comment,
      commentCount: outcome.commentCount,
    };
  }

  async removeComment(documentId: string, commentId: string, user: AuthUser) {
    return this.em.transaction(async (tx) => {
      const doc = await this.requireReadable(documentId, user, tx, true);
      const comment = await tx.findOne(CommentEntity, {
        where: { id: commentId, documentId, deleted: false },
      });
      if (!comment) throw new NotFoundException('评论不存在');
      const isAdmin = user.roles?.includes(RoleCode.ADMIN);
      if (!isAdmin && comment.userId !== user.userId) {
        throw new ForbiddenException('只能删除自己的评论');
      }

      const replies = await tx.find(CommentEntity, {
        where: { documentId, parentId: comment.id, deleted: false },
      });
      const ids = [comment.id, ...replies.map((row) => row.id)];
      for (const id of ids) {
        await tx.update(CommentEntity, { id }, { deleted: true });
      }
      doc.commentCount = Math.max(0, (doc.commentCount ?? 0) - ids.length);
      await tx.save(doc);
      return { commentCount: doc.commentCount };
    });
  }

  private async notifyAuthor(
    doc: DocumentEntity,
    actor: AuthUser,
    type: 'like' | 'comment',
    comment?: string,
  ) {
    if (!doc.authorId || doc.authorId === actor.userId) return;
    const name = actor.realName || actor.username;
    const title = doc.title || '文档';
    const excerpt = comment ? comment.replace(/\s+/g, ' ').slice(0, 80) : '';
    await this.notifyPerson(doc.authorId, actor, {
      type,
      title: type === 'like' ? `${name} 赞了你的文档` : `${name} 评论了你的文档`,
      content:
        type === 'like'
          ? `《${title}》`
          : `《${title}》${excerpt ? `：${excerpt}` : ''}`,
      documentId: doc.id,
    });
  }

  private async notifyPerson(
    userId: string,
    actor: AuthUser,
    input: {
      type?: 'like' | 'comment';
      title: string;
      content: string;
      documentId: string;
    },
  ) {
    const payload = {
      userId,
      title: input.title,
      content: input.content,
      documentId: input.documentId,
      senderId: actor.userId,
      senderName: actor.realName || actor.username,
    };
    try {
      if (input.type === 'like') {
        await this.notifications.notifyLikeOnce(payload);
      } else {
        await this.notifications.notify({ ...payload, type: 'comment' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `写入通知失败：documentId=${input.documentId}, ${message}`,
      );
    }
  }

  private async requireReadable(
    documentId: string,
    user: AuthUser,
    manager: EntityManager = this.em,
    lock = false,
  ) {
    const doc = await manager.findOne(DocumentEntity, {
      where: { id: documentId, deleted: false },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!doc) throw new NotFoundException('文档不存在');
    if (!canReadDocument(doc, accessFromUser(user))) {
      throw new ForbiddenException('无权查看该文档');
    }
    return doc;
  }
}
