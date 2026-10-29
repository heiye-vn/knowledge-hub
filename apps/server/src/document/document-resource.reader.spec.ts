import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { encryptResource } from '../storage/resource-crypto.js';
import { readDocumentResource } from './document-resource.reader.js';

const key = 'a'.repeat(64);

function makeReader(opts: {
  resource?: Record<string, unknown> | null;
  assetId?: string | null;
}) {
  const plain = Buffer.from('image-bytes');
  const encrypted = encryptResource(plain, key);
  const resource =
    opts.resource === undefined
      ? {
          id: '900',
          documentId: '100',
          path: 'images/a.jpg',
          driver: 'rustfs',
          objectKey: 'kh/asset',
          encryptionKey: key,
          contentType: 'image/jpeg',
          byteLength: plain.length,
          ready: true,
        }
      : opts.resource;
  const em = {
    findOneBy: vi.fn(async () => resource),
  };
  const storage = {
    readBytes: vi.fn(async () => encrypted),
  };
  return { em, storage, plain };
}

describe('readDocumentResource', () => {
  it('按资源 ID 读取并解密图片', async () => {
    const { em, storage, plain } = makeReader({ assetId: '900' });
    const loaded = await readDocumentResource(
      em as never,
      storage as never,
      '100',
      '900',
      1024,
    );
    expect(loaded.bytes.equals(plain)).toBe(true);
    expect(loaded.contentType).toBe('image/jpeg');
    expect(loaded.path).toBe('images/a.jpg');
    expect(storage.readBytes).toHaveBeenCalledWith('kh/asset', plain.length + 128, 'rustfs');
  });

  it('资源不存在时 404', async () => {
    const { em, storage } = makeReader({ resource: null, assetId: '900' });
    await expect(
      readDocumentResource(em as never, storage as never, '100', '900', 1024),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('assetId 命中源文件记录时视为不存在', async () => {
    const { em, storage } = makeReader({
      assetId: '900',
      resource: {
        id: '900',
        documentId: '100',
        path: '$source',
        driver: 'rustfs',
        objectKey: 'kh/source',
        encryptionKey: key,
        contentType: 'application/pdf',
        byteLength: 10,
        ready: true,
      },
    });
    await expect(
      readDocumentResource(em as never, storage as never, '100', '900', 1024),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
