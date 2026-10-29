import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CategoryEntity } from './entities/category.entity.js';
import { CategoryService } from './category.service.js';

type Row = Partial<CategoryEntity> & { id: string; name: string; deleted: boolean };

function makeService(rows: Row[], documentsInCategory = 0) {
  const store = new Map(rows.map((row) => [row.id, { ...row }]));
  let nextId = 9000;
  const byParent = (parentId: string) =>
    [...store.values()]
      .filter((row) => !row.deleted && (row.parentId ?? '0') === parentId)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || (a.id > b.id ? 1 : -1));

  const em = {
    find: async () => [...store.values()].filter((row) => !row.deleted),
    findOne: async (_entity: unknown, opts: { where: Record<string, unknown> }) => {
      const where = opts?.where ?? {};
      if (where.id) {
        const row = store.get(String(where.id));
        if (!row) return null;
        if (where.deleted === false && row.deleted) return null;
        if (where.parentId !== undefined && row.parentId !== where.parentId) return null;
        return row;
      }
      if (where.parentId !== undefined) {
        return (
          [...store.values()].find(
            (row) =>
              !row.deleted &&
              row.parentId === where.parentId &&
              (where.deleted === undefined || row.deleted === where.deleted),
          ) ?? null
        );
      }
      return null;
    },
    count: async () => documentsInCategory,
    create: (_entity: unknown, data: Partial<CategoryEntity>) => data,
    save: async (row: Partial<CategoryEntity>) => {
      const saved = { ...row, id: row.id ?? String(nextId++) } as Row;
      store.set(saved.id, saved);
      return saved;
    },
    update: async (_entity: unknown, where: { id: string }, patch: Partial<CategoryEntity>) => {
      const row = store.get(where.id);
      if (row) store.set(where.id, { ...row, ...patch });
    },
    createQueryBuilder: () => ({
      where: () => ({
        andWhere: () => ({
          getMany: async () => [...store.values()].filter((row) => !row.deleted),
        }),
        getMany: async () => [...store.values()].filter((row) => !row.deleted),
      }),
    }),
  };

  const service = new CategoryService(em as never);
  return { service, store, byParent };
}

function row(partial: Partial<Row> & { id: string; name: string }): Row {
  return { parentId: '0', sort: 0, deleted: false, ...partial };
}

describe('CategoryService', () => {
  it('tree 按 parentId 嵌套并按 sort 排序', async () => {
    const { service } = makeService([
      row({ id: '2', name: '技术文档', sort: 2 }),
      row({ id: '1', name: '制度规范', sort: 1 }),
      row({ id: '3', name: '接口规范', parentId: '2', sort: 1 }),
    ]);

    const tree = await service.tree();

    expect(tree.map((node) => node.name)).toEqual(['制度规范', '技术文档']);
    expect(tree[1].children.map((node) => node.name)).toEqual(['接口规范']);
  });

  it('创建时父分类不存在直接拒绝', async () => {
    const { service } = makeService([]);
    await expect(
      service.create({ name: '新分类', parentId: '999' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('不能把分类移动到自己的子孙下面', async () => {
    const { service } = makeService([
      row({ id: '1', name: '根' }),
      row({ id: '2', name: '子', parentId: '1' }),
      row({ id: '3', name: '孙', parentId: '2' }),
    ]);

    await expect(service.update('1', { parentId: '3' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('不能把分类设为自己的父级', async () => {
    const { service } = makeService([row({ id: '1', name: '根' })]);
    await expect(service.update('1', { parentId: '1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('存在子分类时拒绝删除', async () => {
    const { service } = makeService([
      row({ id: '1', name: '根' }),
      row({ id: '2', name: '子', parentId: '1' }),
    ]);
    await expect(service.remove('1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('分类下仍有文档时拒绝删除', async () => {
    const { service } = makeService([row({ id: '1', name: '根' })], 2);
    await expect(service.remove('1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('空分类软删除', async () => {
    const { service, store } = makeService([row({ id: '1', name: '根' })]);
    await expect(service.remove('1')).resolves.toEqual({ id: '1' });
    expect(store.get('1')?.deleted).toBe(true);
  });

  it('normalize 空值返回 null，非法分类拒绝', async () => {
    const { service } = makeService([row({ id: '1', name: '根' })]);
    await expect(service.normalize(undefined)).resolves.toBeNull();
    await expect(service.normalize('1')).resolves.toBe('1');
    await expect(service.normalize('404')).rejects.toBeInstanceOf(BadRequestException);
  });
});
