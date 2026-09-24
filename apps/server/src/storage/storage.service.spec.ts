import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service.js';
import type { StorageDriver } from './storage.interface.js';

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

    const mockOssDriver: StorageDriver = {
      isEnabled: vi.fn(() => ossEnabled),
      uploadBytes: vi.fn().mockResolvedValue({
        url: 'https://oss.example.com/doc.pdf',
        key: 'documents/doc.pdf',
      }),
    };

    const mockRustfsDriver: StorageDriver = {
      isEnabled: vi.fn(() => rustfsEnabled),
      uploadBytes: vi.fn().mockResolvedValue({
        url: 'http://rustfs/doc.pdf',
        key: 'documents/doc.pdf',
      }),
    };

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
});
