import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { DocumentSocialService } from './document-social.service.js';
import { DocumentEntity } from './entities/document.entity.js';
import { DocumentLikeEntity } from './entities/document-like.entity.js';
import { DocumentFavoriteEntity } from './entities/document-favorite.entity.js';
import { CommentEntity } from './entities/comment.entity.js';

type StoredComment = Partial<CommentEntity> & { id: string; documentId: string; userId: string };

function makeService(opts: {
  doc?: Record<string, unknown> | null;
  likes?: Array<{ id: string; documentId: string; userId: string }>;
  favorites?: Array<{ id: string; documentId: string; userId: string }>;
  comments?: StoredComment[];
} = {}) {
  const doc = {
    id: '1',
    title: '文档',
    authorId: '100',
    status: 1,
    isPublic: true,
    teamId: null,
    likeCount: 0,
    favouriteCount: 0,
    commentCount: 0,
    deleted: false,
    ...(opts.doc ?? {}),
  } as Record<string, unknown>;
  const likes = [...(opts.likes ?? [])];
  const favorites = [...(opts.favorites ?? [])];
  const comments = [...(opts.comments ?? [])];
  const notifications: Array<Record<string, unknown>> = [];

  const manager = {
    findOne: async (entity: unknown, o: { where?: Record<string, unknown> }) => {
      const where = o?.where ?? {};
      if (entity === DocumentEntity) {
        return doc.deleted ? null : doc;
      }
      if (entity === DocumentLikeEntity) {
        return (
          likes.find(
            (row) =>
              (where.id === undefined || row.id === where.id) &&
              (where.documentId === undefined || row.documentId === where.documentId) &&
              (where.userId === undefined || row.userId === where.userId),
          ) ?? null
        );
      }
      if (entity === DocumentFavoriteEntity) {
        return (
          favorites.find(
            (row) =>
              (where.id === undefined || row.id === where.id) &&
              (where.documentId === undefined || row.documentId === where.documentId) &&
              (where.userId === undefined || row.userId === where.userId),
          ) ?? null
        );
      }
      if (entity === CommentEntity) {
        return (
          comments.find(
            (row) =>
              (where.id === undefined || row.id === where.id) &&
              (where.documentId === undefined || row.documentId === where.documentId) &&
              (where.parentId === undefined || row.parentId === where.parentId) &&
              (where.deleted === undefined || (row.deleted ?? false) === where.deleted),
          ) ?? null
        );
      }
      return null;
    },
    find: async (entity: unknown, o: { where?: Record<string, unknown> }) => {
      if (entity === CommentEntity) {
        const where = o?.where ?? {};
        return comments.filter(
          (row) =>
            (where.documentId === undefined || row.documentId === where.documentId) &&
            (where.parentId === undefined || row.parentId === where.parentId) &&
            (where.deleted === undefined || (row.deleted ?? false) === where.deleted),
        );
      }
      return [];
    },
    save: async (row: Record<string, unknown>) => {
      if (row === doc) return row;
      if ('content' in row) {
        comments.push(row as unknown as StoredComment);
        return row;
      }
      return row;
    },
    create: (_entity: unknown, data: Record<string, unknown>) => data,
    delete: async (entity: unknown, where: { id: string }) => {
      const list =
        entity === DocumentLikeEntity
          ? likes
          : entity === DocumentFavoriteEntity
            ? favorites
            : [];
      const index = list.findIndex((row) => row.id === where.id);
      if (index >= 0) list.splice(index, 1);
    },
    update: async (
      entity: unknown,
      where: { id?: string; idList?: string[] },
      patch: Record<string, unknown>,
    ) => {
      if (entity !== CommentEntity) return;
      for (const row of comments) {
        if (row.id === where.id || (where.idList ?? []).includes(row.id)) {
          Object.assign(row, patch);
        }
      }
    },
    transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
      callback(manager),
  };

  const notificationsStub = {
    notify: vi.fn(async (input: Record<string, unknown>) => {
      notifications.push(input);
      return input;
    }),
    notifyLikeOnce: vi.fn(async (input: Record<string, unknown>) => {
      const row = { ...input, type: 'like' };
      notifications.push(row);
      return row;
    }),
  };

  const service = new DocumentSocialService(manager as never, notificationsStub as never);
  return { service, doc, likes, favorites, comments, notifications, notificationsStub };
}

const author: AuthUser = {
  userId: '100',
  username: 'alice',
  roles: [RoleCode.USER],
  permissions: [],
  teamIds: [],
};

const reader: AuthUser = {
  userId: '200',
  username: 'bob',
  roles: [RoleCode.USER],
  permissions: [],
  teamIds: [],
};

describe('DocumentSocialService', () => {
  it('首次点赞计数 +1 并通知作者', async () => {
    const { service, doc, notifications } = makeService();
    const result = await service.toggleLike('1', reader);
    expect(result).toEqual({ liked: true, likeCount: 1 });
    expect(doc.likeCount).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ userId: '100', type: 'like' });
  });

  it('再次点赞取消，计数回落且不再通知', async () => {
    const { service, doc, notifications } = makeService({
      likes: [{ id: 'l1', documentId: '1', userId: '200' }],
    });
    doc.likeCount = 1;
    const result = await service.toggleLike('1', reader);
    expect(result).toEqual({ liked: false, likeCount: 0 });
    expect(doc.likeCount).toBe(0);
    expect(notifications).toHaveLength(0);
  });

  it('自己点赞自己的文档不产生通知', async () => {
    const { service, notifications } = makeService();
    await service.toggleLike('1', author);
    expect(notifications).toHaveLength(0);
  });

  it('收藏切换不发送通知', async () => {
    const { service, doc, notifications } = makeService();
    await expect(service.toggleFavorite('1', reader)).resolves.toEqual({
      favorited: true,
      favouriteCount: 1,
    });
    expect(doc.favouriteCount).toBe(1);
    expect(notifications).toHaveLength(0);
  });

  it('只能回复顶层评论', async () => {
    const { service } = makeService({
      comments: [
        { id: 'c1', documentId: '1', userId: '200', parentId: null, content: '顶层' },
        { id: 'c2', documentId: '1', userId: '200', parentId: 'c1', content: '回复' },
      ],
    });
    await expect(
      service.addComment('1', { content: '再回复', parentId: 'c2' }, reader),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('回复评论会同时通知文档作者与被回复者', async () => {
    const { service, notifications } = makeService({
      comments: [
        { id: 'c1', documentId: '1', userId: '200', userName: 'bob', parentId: null, content: '顶层' },
      ],
    });
    await service.addComment('1', { content: '回复你', parentId: 'c1' }, {
      ...reader,
      userId: '300',
      username: 'carol',
    });
    expect(notifications.map((row) => row.userId).sort()).toEqual(['100', '200']);
  });

  it('删除父评论会连带删除回复并回退计数', async () => {
    const { service, doc, comments } = makeService({
      comments: [
        { id: 'c1', documentId: '1', userId: '100', parentId: null, content: '顶层' },
        { id: 'c2', documentId: '1', userId: '200', parentId: 'c1', content: '回复' },
      ],
    });
    doc.commentCount = 2;
    const result = await service.removeComment('1', 'c1', author);
    expect(result).toEqual({ commentCount: 0 });
    expect(comments.every((row) => row.deleted)).toBe(true);
  });

  it('非作者不能删除他人评论', async () => {
    const { service } = makeService({
      comments: [
        { id: 'c1', documentId: '1', userId: '100', parentId: null, content: '顶层' },
      ],
    });
    await expect(
      service.removeComment('1', 'c1', reader),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
