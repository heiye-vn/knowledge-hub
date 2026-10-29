import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { NotificationService } from './notification.service.js';
import { NotificationEntity } from './notification.entity.js';

function makeService(rows: Array<Record<string, unknown>>, users: Array<Record<string, unknown>> = []) {
  const store = [...rows];
  let nextId = 1;
  const em = {
    create: (_entity: unknown, data: Record<string, unknown>) => data,
    save: async (value: unknown) => {
      if (Array.isArray(value)) {
        for (const row of value) store.push(row as Record<string, unknown>);
        return value;
      }
      const row = value as Record<string, unknown>;
      const index = store.findIndex((item) => item.id === row.id);
      if (index >= 0) store[index] = row;
      else store.push(row);
      return row;
    },
    find: async () => users,
    findOne: async (_entity: unknown, o: { where?: Record<string, unknown> }) => {
      const where = o?.where ?? {};
      return (
        store.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null
      );
    },
    findAndCount: async () => [store.slice(0, 20), store.length],
    count: async (_entity: unknown, o: { where?: Record<string, unknown> }) => {
      const where = o?.where ?? {};
      return store.filter((row) => row.userId === where.userId && row.isRead === where.isRead).length;
    },
    update: async (_entity: unknown, where: Record<string, unknown>, patch: Record<string, unknown>) => {
      for (const row of store) {
        if (row.userId === where.userId && row.isRead === where.isRead) {
          Object.assign(row, patch);
        }
      }
    },
  };
  const service = new NotificationService(em as never);
  return { service, store, next: () => nextId++ };
}

describe('NotificationService', () => {
  it('写入通知时默认未读并截断超长标题', async () => {
    const { service, store } = makeService([]);
    await service.notify({
      userId: '100',
      type: 'system',
      title: 'x'.repeat(200),
      content: 'y'.repeat(3000),
    });
    expect(store[0]).toMatchObject({ userId: '100', type: 'system', isRead: false });
    expect(String(store[0].title)).toHaveLength(100);
    expect(String(store[0].content)).toHaveLength(2000);
  });

  it('不能把别人的通知标为已读', async () => {
    const { service } = makeService([
      { id: 'n1', userId: '100', isRead: false },
    ]);
    await expect(service.markRead('200', 'n1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('全部已读只更新当前用户的未读通知', async () => {
    const { service, store } = makeService([
      { id: 'n1', userId: '100', isRead: false },
      { id: 'n2', userId: '100', isRead: false },
      { id: 'n3', userId: '200', isRead: false },
    ]);
    await service.markAllRead('100');
    expect(store.filter((row) => row.userId === '100').every((row) => row.isRead)).toBe(true);
    expect(store.find((row) => row.userId === '200')?.isRead).toBe(false);
  });

  it('广播不传接收人时发给所有启用用户', async () => {
    const { service, store } = makeService(
      [],
      [
        { id: '100', status: 1 },
        { id: '200', status: 1 },
        { id: '300', status: 1 },
      ],
    );
    const result = await service.broadcast(
      { title: '维护通知', content: '今晚停机' },
      { userId: '1', name: '管理员' },
    );
    expect(result).toEqual({ count: 3 });
    expect(store).toHaveLength(3);
    expect(store[0]).toMatchObject({ type: 'system', senderName: '管理员' });
  });

  it('广播标题为空拒绝', async () => {
    const { service } = makeService([], [{ id: '100' }]);
    await expect(
      service.broadcast({ title: '   ', content: '内容' }, { userId: '1', name: '管理员' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('同一发送人对同一文档的未读点赞通知只保留一条', async () => {
    const { service, store } = makeService([]);
    const input = {
      userId: '100',
      title: '张三 赞了你的文档',
      content: '《文档》',
      documentId: '1',
      senderId: '200',
      senderName: '张三',
    };
    await service.notifyLikeOnce(input);
    await service.notifyLikeOnce(input);
    expect(store).toHaveLength(1);
  });

  it('点赞通知已读后再次点赞可以重新通知', async () => {
    const { service, store } = makeService([
      {
        id: 'n1',
        userId: '100',
        type: 'like',
        documentId: '1',
        senderId: '200',
        isRead: true,
      },
    ]);
    await service.notifyLikeOnce({
      userId: '100',
      title: '张三 赞了你的文档',
      content: '《文档》',
      documentId: '1',
      senderId: '200',
    });
    expect(store).toHaveLength(2);
  });
});
