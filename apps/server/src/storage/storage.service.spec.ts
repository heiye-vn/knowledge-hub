import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service.js';
import type { StorageDriver } from './storage.interface.js';
import { RustfsService } from './rustfs.service.js';

describe('StorageService', () => {
  function createService(
    storageDriverConfig: string | undefined,
    ossEnabled = true,
    rustfsEnabled = true,
  ) {
    const configService = {
      get: vi.fn((key: string, defaultValue?: string) => {
        if (key === 'STORAGE_DRIVER') return storageDriverConfig;
        return defaultValue;
      }),
    } as unknown as ConfigService;

    const mockOssDriver = {
      isEnabled: vi.fn(() => ossEnabled),
      readBytes: vi.fn().mockResolvedValue(Buffer.from('stored bytes')),
      deleteObject: vi.fn().mockResolvedValue(undefined),
      uploadBytes: vi.fn().mockResolvedValue({
        url: 'https://oss.example.com/doc.pdf',
        key: 'documents/doc.pdf',
      }),
    } satisfies StorageDriver;

    const mockRustfsDriver = {
      isEnabled: vi.fn(() => rustfsEnabled),
      readBytes: vi.fn().mockResolvedValue(Buffer.from('stored bytes')),
      deleteObject: vi.fn().mockResolvedValue(undefined),
      uploadBytes: vi.fn().mockResolvedValue({
        url: 'http://rustfs/doc.pdf',
        key: 'documents/doc.pdf',
      }),
    } satisfies StorageDriver;

    const service = new StorageService(
      configService,
      mockRustfsDriver as any,
      mockOssDriver as any,
    );
    service.onModuleInit();

    return { service, mockOssDriver, mockRustfsDriver };
  }

  it('当 STORAGE_DRIVER=oss 时，应委托给 AliyunOssDriver', async () => {
    const { service, mockOssDriver, mockRustfsDriver } = createService('oss');

    expect(service.getActiveDriverName()).toBe('oss');
    expect(service.isEnabled()).toBe(true);

    const res = await service.uploadBytes(Buffer.from('test'), {
      fileName: 'test.pdf',
      contentType: 'application/pdf',
    });

    expect(mockOssDriver.uploadBytes).toHaveBeenCalledOnce();
    expect(mockRustfsDriver.uploadBytes).not.toHaveBeenCalled();
    expect(res.url).toBe('https://oss.example.com/doc.pdf');
  });

  it('当 STORAGE_DRIVER=rustfs 时，应委托给 RustfsDriver', async () => {
    const { service, mockOssDriver, mockRustfsDriver } =
      createService('rustfs');

    expect(service.getActiveDriverName()).toBe('rustfs');
    expect(service.isEnabled()).toBe(true);

    const res = await service.uploadBytes(Buffer.from('test'), {
      fileName: 'test.pdf',
      contentType: 'application/pdf',
    });

    expect(mockRustfsDriver.uploadBytes).toHaveBeenCalledOnce();
    expect(mockOssDriver.uploadBytes).not.toHaveBeenCalled();
    expect(res.url).toBe('http://rustfs/doc.pdf');
  });

  it('当未显式配置 STORAGE_DRIVER 但 OSS 驱动可用时，优先使用 OSS', async () => {
    const { service } = createService(undefined, true, true);
    expect(service.getActiveDriverName()).toBe('oss');
  });

  it('当未显式配置 STORAGE_DRIVER 且 OSS 驱动不可用时，降级使用 RustFS', async () => {
    const { service } = createService(undefined, false, true);
    expect(service.getActiveDriverName()).toBe('rustfs');
  });

  it.each(['oss', 'rustfs'] as const)(
    'routes reads/deletes to the active %s driver by default',
    async (active) => {
      const { service, mockOssDriver, mockRustfsDriver } =
        createService(active);
      const selected = active === 'oss' ? mockOssDriver : mockRustfsDriver;
      const other = active === 'oss' ? mockRustfsDriver : mockOssDriver;
      expect(await service.readBytes('resources/123.enc', 100)).toEqual(
        Buffer.from('stored bytes'),
      );
      await service.deleteObject('resources/123.enc');
      expect(selected.readBytes).toHaveBeenCalledWith('resources/123.enc', 100);
      expect(selected.deleteObject).toHaveBeenCalledWith('resources/123.enc');
      expect(other.readBytes).not.toHaveBeenCalled();
      expect(other.deleteObject).not.toHaveBeenCalled();
    },
  );

  it.each(['oss', 'rustfs'] as const)(
    'uses persisted %s driver despite a different active driver',
    async (persisted) => {
      const active = persisted === 'oss' ? 'rustfs' : 'oss';
      const { service, mockOssDriver, mockRustfsDriver } =
        createService(active);
      const selected = persisted === 'oss' ? mockOssDriver : mockRustfsDriver;
      const uploader = active === 'oss' ? mockOssDriver : mockRustfsDriver;
      expect(
        await service.readBytes('resources/123.enc', 100, persisted),
      ).toEqual(Buffer.from('stored bytes'));
      await service.deleteObject('resources/123.enc', persisted);
      const bytes = Buffer.from('ciphertext');
      const options = {
        fileName: 'original.enc',
        contentType: 'application/octet-stream',
        objectKey: 'resources/123.enc',
      };
      await service.uploadBytes(bytes, options);
      expect(selected.readBytes).toHaveBeenCalledWith('resources/123.enc', 100);
      expect(selected.deleteObject).toHaveBeenCalledWith('resources/123.enc');
      expect(selected.uploadBytes).not.toHaveBeenCalled();
      expect(uploader.uploadBytes).toHaveBeenCalledWith(bytes, options);
      expect(uploader.readBytes).not.toHaveBeenCalled();
      expect(uploader.deleteObject).not.toHaveBeenCalled();
      expect(service.getActiveDriverName()).toBe(active);
    },
  );

  it('explicit driver works even if active driver is null', async () => {
    const { service, mockOssDriver } = createService('rustfs');
    (
      service as unknown as { activeDriver: StorageDriver | null }
    ).activeDriver = null;
    expect(service.isEnabled()).toBe(false);
    expect(await service.readBytes('resources/123.enc', 100, 'oss')).toEqual(
      Buffer.from('stored bytes'),
    );
    await service.deleteObject('resources/123.enc', 'oss');
    expect(mockOssDriver.deleteObject).toHaveBeenCalledWith(
      'resources/123.enc',
    );
    await expect(service.readBytes('resources/123.enc', 100)).rejects.toThrow(
      /rustfs/,
    );
    await expect(service.deleteObject('resources/123.enc')).rejects.toThrow(
      /rustfs/,
    );
    await expect(
      service.uploadBytes(Buffer.alloc(0), {
        fileName: 'a',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow(/rustfs/);
  });

  it('explicit driver works when the active driver is disabled', async () => {
    const { service, mockOssDriver } = createService('rustfs', true, false);
    expect(await service.readBytes('resources/123.enc', 100, 'oss')).toEqual(
      Buffer.from('stored bytes'),
    );
    await service.deleteObject('resources/123.enc', 'oss');
    expect(mockOssDriver.deleteObject).toHaveBeenCalledWith(
      'resources/123.enc',
    );
    await expect(service.readBytes('resources/123.enc', 100)).rejects.toThrow(
      /rustfs/,
    );
    await expect(service.deleteObject('resources/123.enc')).rejects.toThrow(
      /rustfs/,
    );
  });

  it.each(['oss', 'rustfs'] as const)(
    'does not fall back from unavailable persisted %s driver',
    async (persisted) => {
      const active = persisted === 'oss' ? 'rustfs' : 'oss';
      const { service, mockOssDriver, mockRustfsDriver } = createService(
        active,
        persisted !== 'oss',
        persisted !== 'rustfs',
      );
      await expect(
        service.readBytes('resources/123.enc', 100, persisted),
      ).rejects.toThrow(new RegExp(persisted));
      await expect(
        service.deleteObject('resources/123.enc', persisted),
      ).rejects.toThrow(new RegExp(persisted));
      for (const driver of [mockOssDriver, mockRustfsDriver]) {
        expect(driver.readBytes).not.toHaveBeenCalled();
        expect(driver.deleteObject).not.toHaveBeenCalled();
      }
    },
  );

  it('rejects unknown runtime driver values rather than falling back to active storage', async () => {
    const { service, mockOssDriver, mockRustfsDriver } = createService('oss');
    await expect(
      service.readBytes('resources/123.enc', 100, 'unknown' as never),
    ).rejects.toThrow(/driver|驱动/i);
    await expect(
      service.deleteObject('resources/123.enc', 'unknown' as never),
    ).rejects.toThrow(/driver|驱动/i);
    expect(mockOssDriver.readBytes).not.toHaveBeenCalled();
    expect(mockRustfsDriver.deleteObject).not.toHaveBeenCalled();
  });

  it('keeps the legacy facade compatible with driver reads and deletes', async () => {
    const { service, mockOssDriver } = createService('oss');
    const legacy = new RustfsService(service);
    expect(await legacy.readBytes('resources/123.enc', 100)).toEqual(
      Buffer.from('stored bytes'),
    );
    await legacy.deleteObject('resources/123.enc');
    expect(mockOssDriver.readBytes).toHaveBeenCalledWith(
      'resources/123.enc',
      100,
    );
    expect(mockOssDriver.deleteObject).toHaveBeenCalledWith(
      'resources/123.enc',
    );
  });
});
