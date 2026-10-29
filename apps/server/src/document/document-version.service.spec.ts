import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { DocumentVersionService } from './document-version.service.js';

type Inserted = Record<string, unknown>;

function makeManager(opts: {
  versionRows?: Array<Record<string, unknown>>;
  doc?: Record<string, unknown> | null;
  versionCount?: number;
} = {}) {
  const inserted: Inserted[] = [];
  const rows = [...(opts.versionRows ?? [])];
  let versionCount = opts.versionCount ?? rows.length;

  const manager = {
    count: async () => versionCount,
    createQueryBuilder: () => ({
      insert: () => ({
        into: () => ({
          values: (value: Inserted) => ({
            orIgnore: () => ({
              execute: async () => {
                inserted.push(value);
                rows.push(value);
                versionCount += 1;
                return undefined;
              },
            }),
          }),
        }),
      }),
    }),
    find: async () => rows,
    findOne: async (_entity: unknown, o: { where?: Record<string, unknown> }) => {
      if (o?.where && 'id' in o.where) {
        if (opts.doc && opts.doc.id === o.where.id) return opts.doc;
        return rows.find((row) => row.id === o.where?.id) ?? null;
      }
      if (o?.where && 'documentId' in o.where) {
        return opts.doc ?? null;
      }
      return null;
    },
  };
  return { manager, inserted };
}

const author: AuthUser = {
  userId: '100',
  username: 'alice',
  roles: [RoleCode.USER],
  permissions: ['document:edit'],
  teamIds: [],
};

const other: AuthUser = {
  userId: '200',
  username: 'bob',
  roles: [RoleCode.USER],
  permissions: ['document:list'],
  teamIds: [],
};

const snapshot = (version: number, content = `v${version}`) => ({
  documentId: '1',
  version,
  title: '文档',
  content,
  summary: null,
  userId: '100',
});

describe('DocumentVersionService', () => {
  it('首改补记旧稿，然后记录新版本', async () => {
    const { manager, inserted } = makeManager({ versionCount: 0 });
    const service = new DocumentVersionService(manager as never);

    await service.recordContentChange({
      previous: snapshot(4, '旧稿'),
      next: snapshot(5, '新稿'),
    });

    expect(inserted.map((row) => row.version)).toEqual([4, 5]);
    expect(inserted.map((row) => row.content)).toEqual(['旧稿', '新稿']);
  });

  it('已有历史时只记录新版本', async () => {
    const { manager, inserted } = makeManager({ versionCount: 2 });
    const service = new DocumentVersionService(manager as never);

    await service.recordContentChange({
      previous: snapshot(2),
      next: snapshot(3),
    });

    expect(inserted.map((row) => row.version)).toEqual([3]);
  });

  it('列表只返回元数据，不返回正文', async () => {
    const { manager } = makeManager({
      versionRows: [
        { id: 'v2', documentId: '1', version: 2, title: '文档', content: '正文', createdAt: new Date() },
      ],
      doc: { id: '1', authorId: '100' },
    });
    const service = new DocumentVersionService(manager as never);

    const list = await service.list('1', author);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'v2', version: 2, title: '文档' });
    expect((list[0] as { content?: string }).content).toBeUndefined();
  });

  it('非作者不能查看版本', async () => {
    const { manager } = makeManager({ doc: { id: '1', authorId: '100' } });
    const service = new DocumentVersionService(manager as never);
    await expect(service.list('1', other)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('版本不存在时抛 404', async () => {
    const { manager } = makeManager({ doc: { id: '1', authorId: '100' } });
    const service = new DocumentVersionService(manager as never);
    await expect(service.get('1', 'nope', author)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
