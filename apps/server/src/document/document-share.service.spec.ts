import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { hash } from 'bcryptjs';
import { RoleCode } from '../common/constants/roles.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import { DocumentShareService } from './document-share.service.js';
import { DocumentEntity } from './entities/document.entity.js';
import { DocumentShareEntity } from './entities/document-share.entity.js';
import { DocumentContentEntity } from './entities/document-content.entity.js';
import { DocumentResourceEntity } from './entities/document-resource.entity.js';
import { encryptResource } from '../storage/resource-crypto.js';

const author: AuthUser = {
  userId: '100',
  username: 'alice',
  roles: [RoleCode.USER],
  permissions: ['document:list', 'document:edit'],
  teamIds: [],
};

const reader: AuthUser = {
  userId: '200',
  username: 'bob',
  roles: [RoleCode.USER],
  permissions: ['document:list'],
  teamIds: [],
};

const resourceKey = 'b'.repeat(64);

function makeService(opts: {
  doc?: Record<string, unknown> | null;
  shares?: Array<Record<string, unknown>>;
  content?: string;
  withAsset?: boolean;
  redisDown?: boolean;
} = {}) {
  const doc = {
    id: '1',
    title: '员工手册',
    summary: '摘要',
    authorId: '100',
    status: 1,
    isPublic: true,
    teamId: null,
    deleted: false,
    ...(opts.doc ?? {}),
  } as Record<string, unknown>;
  const shares = [...(opts.shares ?? [])];
  const plain = Buffer.from('image-bytes');
  const encrypted = encryptResource(plain, resourceKey);

  const manager = {
    findOne: async (entity: unknown, o: { where?: Record<string, unknown> }) => {
      const where = o?.where ?? {};
      if (entity === DocumentEntity) {
        return where.id === doc.id ? doc : null;
      }
      if (entity === DocumentShareEntity) {
        if (where.token !== undefined) {
          return (
            shares.find(
              (row) =>
                row.token === where.token &&
                (where.revoked === undefined || row.revoked === where.revoked),
            ) ?? null
          );
        }
        return (
          shares.find(
            (row) =>
              (where.id === undefined || row.id === where.id) &&
              (where.documentId === undefined || row.documentId === where.documentId),
          ) ?? null
        );
      }
      if (entity === DocumentContentEntity) {
        return { documentId: doc.id, content: opts.content ?? '正文' };
      }
      return null;
    },
    findOneBy: async (entity: unknown, where: Record<string, unknown>) => {
      if (entity === DocumentResourceEntity && opts.withAsset) {
        return {
          id: where.id ?? '900',
          documentId: doc.id,
          path: 'images/a.jpg',
          driver: 'rustfs',
          objectKey: 'kh/asset',
          encryptionKey: resourceKey,
          contentType: 'image/jpeg',
          byteLength: plain.length,
          ready: true,
        };
      }
      return null;
    },
    find: async (entity: unknown) => (entity === DocumentShareEntity ? shares : []),
    create: (_entity: unknown, data: Record<string, unknown>) => data,
    save: async (row: Record<string, unknown>) => {
      const index = shares.findIndex((item) => item.id === row.id);
      if (index >= 0) shares[index] = row;
      else shares.push(row);
      return row;
    },
  };

  const counters = new Map<string, number>();
  const redis = {
    get: async (key: string) => {
      if (opts.redisDown) throw new ServiceUnavailableException('redis down');
      return counters.has(key) ? String(counters.get(key)) : null;
    },
    incrementWithTtl: async (key: string) => {
      if (opts.redisDown) throw new ServiceUnavailableException('redis down');
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    del: async (key: string) => {
      if (opts.redisDown) throw new ServiceUnavailableException('redis down');
      counters.delete(key);
    },
  };

  const storage = {
    readBytes: async () => encrypted,
  };

  const config = {
    get: (key: string, fallback?: unknown) => {
      const values: Record<string, string> = {
        JWT_ACCESS_SECRET: 'test-share-secret',
        SHARE_ASSET_TTL_SECONDS: '900',
        SHARE_MAX_ATTEMPTS: '10',
        SHARE_ATTEMPT_WINDOW_SECONDS: '600',
      };
      return values[key] ?? fallback;
    },
  };

  const service = new DocumentShareService(
    manager as never,
    config as never,
    redis as never,
    storage as never,
  );
  return { service, shares, doc, plain, counters, redis };
}

function shareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    documentId: '1',
    token: 'abc',
    requirePassword: false,
    passwordHash: null,
    revoked: false,
    expireAt: null,
    ...overrides,
  };
}

describe('DocumentShareService', () => {
  it('非作者不能创建分享链接（防止读者把团队/私有文档公开出去）', async () => {
    const { service } = makeService();
    await expect(
      service.create('1', {}, reader),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('草稿文档不能分享', async () => {
    const { service } = makeService({ doc: { status: 0 } });
    await expect(
      service.create('1', {}, author),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('创建分享返回短码并标记是否需要密码', async () => {
    const { service, shares } = makeService();
    const created = await service.create('1', { password: 'secret1', expireDays: 7 }, author);
    expect(created.code).toBeTruthy();
    expect(created.needPassword).toBe(true);
    expect(shares[0].passwordHash).toBeTruthy();
    expect(shares[0].expireAt).toBeInstanceOf(Date);
  });

  it('带密码的分享在预览阶段不返回标题', async () => {
    const passwordHash = await hash('secret1', 4);
    const { service } = makeService({
      shares: [shareRow({ requirePassword: true, passwordHash })],
    });
    const preview = await service.preview('abc');
    expect(preview.needPassword).toBe(true);
    expect(preview.title).toBeNull();
  });

  it('无密码分享可直接预览并读取正文', async () => {
    const { service } = makeService({
      content: '# 员工手册',
      shares: [shareRow()],
    });
    await expect(service.preview('abc')).resolves.toMatchObject({
      needPassword: false,
      title: '员工手册',
    });
    await expect(service.access('abc', {})).resolves.toMatchObject({
      title: '员工手册',
      content: '# 员工手册',
    });
  });

  it('密码错误拒绝访问，正确密码后清零失败计数', async () => {
    const passwordHash = await hash('secret1', 4);
    const { service, counters } = makeService({
      shares: [shareRow({ requirePassword: true, passwordHash })],
    });
    await expect(service.access('abc', { password: 'wrong' }, '1.1.1.1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(counters.size).toBe(1);
    await expect(
      service.access('abc', { password: 'secret1' }, '1.1.1.1'),
    ).resolves.toMatchObject({ title: '员工手册' });
    expect(counters.size).toBe(0);
  });

  it('同一 IP 连续失败超过上限后返回 429', async () => {
    const passwordHash = await hash('secret1', 4);
    const { service } = makeService({
      shares: [shareRow({ requirePassword: true, passwordHash })],
    });
    for (let i = 0; i < 10; i += 1) {
      await expect(
        service.access('abc', { password: 'wrong' }, '1.1.1.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    await expect(
      service.access('abc', { password: 'wrong' }, '1.1.1.1'),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      service.access('abc', { password: 'secret1' }, '1.1.1.1'),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('Redis 不可用时密码链接 fail-closed', async () => {
    const passwordHash = await hash('secret1', 4);
    const { service } = makeService({
      shares: [shareRow({ requirePassword: true, passwordHash })],
      redisDown: true,
    });
    await expect(
      service.access('abc', { password: 'secret1' }, '1.1.1.1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('免密链接不依赖 Redis', async () => {
    const { service } = makeService({
      shares: [shareRow()],
      redisDown: true,
    });
    await expect(service.access('abc', {})).resolves.toMatchObject({
      title: '员工手册',
    });
  });

  it('分享正文中的私有图片重写为签名 URL，并可读取资源', async () => {
    const { service, plain } = makeService({
      shares: [shareRow()],
      content: '![图](/documents/1/assets/900)',
      withAsset: true,
    });
    const doc = await service.access('abc', {});
    const matched = doc.content.match(
      /\/shares\/abc\/assets\/900\?exp=(\d+)&sig=([a-f0-9]{64})/,
    );
    expect(matched).not.toBeNull();
    const [, exp, sig] = matched!;
    const asset = await service.readSharedAsset('abc', '900', exp, sig);
    expect(asset.bytes.equals(plain)).toBe(true);
    expect(asset.contentType).toBe('image/jpeg');
  });

  it('签名过期或被篡改时拒绝读取资源', async () => {
    const { service } = makeService({
      shares: [shareRow()],
      content: '![图](/documents/1/assets/900)',
      withAsset: true,
    });
    const doc = await service.access('abc', {});
    const [, exp, sig] = doc.content.match(
      /\/shares\/abc\/assets\/900\?exp=(\d+)&sig=([a-f0-9]{64})/,
    )!;

    await expect(
      service.readSharedAsset('abc', '900', String(Number(exp) - 3600), sig),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.readSharedAsset('abc', '900', exp, 'f'.repeat(64)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('已关闭的链接提示不存在', async () => {
    const { service } = makeService({
      shares: [shareRow({ revoked: true })],
    });
    await expect(service.preview('abc')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('过期链接拒绝访问', async () => {
    const { service } = makeService({
      shares: [shareRow({ expireAt: new Date(Date.now() - 1000) })],
    });
    await expect(service.preview('abc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('列表只给作者看并标记已过期', async () => {
    const { service } = makeService({
      shares: [shareRow({ expireAt: new Date(Date.now() - 1000), createdAt: new Date() })],
    });
    await expect(service.list('1', reader)).rejects.toBeInstanceOf(ForbiddenException);
    const rows = await service.list('1', author);
    expect(rows[0].expired).toBe(true);
  });
});
