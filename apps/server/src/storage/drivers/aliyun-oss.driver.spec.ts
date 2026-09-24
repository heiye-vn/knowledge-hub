import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { AliyunOssDriver } from './aliyun-oss.driver.js';

describe('AliyunOssDriver', () => {
  function createDriver(configMap: Record<string, string | undefined>) {
    const configService = {
      get: vi.fn((key: string, defaultValue?: string) => {
        return configMap[key] !== undefined ? configMap[key] : defaultValue;
      }),
    } as unknown as ConfigService;

    const driver = new AliyunOssDriver(configService);
    return { driver, configService };
  }

  it('当 OSS_ENABLED=false 时，isEnabled 应为 false', () => {
    const { driver } = createDriver({
      OSS_ENABLED: 'false',
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_BUCKET: 'my-bucket',
      OSS_ACCESS_KEY_ID: 'LTAI5test',
      OSS_ACCESS_KEY_SECRET: 'testsecret',
    });

    driver.onModuleInit();
    expect(driver.isEnabled()).toBe(false);
  });

  it('当缺少必要凭证（如 AccessKey 或 Bucket）时，isEnabled 应为 false', () => {
    const { driver } = createDriver({
      OSS_ENABLED: 'true',
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_BUCKET: '',
      OSS_ACCESS_KEY_ID: '',
    });

    driver.onModuleInit();
    expect(driver.isEnabled()).toBe(false);
  });

  it('未启用时调用 uploadBytes 抛出 ServiceUnavailableException', async () => {
    const { driver } = createDriver({
      OSS_ENABLED: 'false',
    });
    driver.onModuleInit();

    await expect(
      driver.uploadBytes(Buffer.from('hello'), {
        fileName: 'test.png',
        contentType: 'image/png',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('成功上传并生成标准阿里云 OSS Virtual-Hosted 格式直链', async () => {
    const { driver } = createDriver({
      OSS_ENABLED: 'true',
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_BUCKET: 'my-bucket',
      OSS_ACCESS_KEY_ID: 'LTAI5test',
      OSS_ACCESS_KEY_SECRET: 'testsecret',
    });

    driver.onModuleInit();
    expect(driver.isEnabled()).toBe(true);

    // Mock S3Client.send
    const mockSend = vi.fn().mockResolvedValue({});
    (driver as unknown as { client: { send: typeof mockSend } }).client = {
      send: mockSend,
    };

    const result = await driver.uploadBytes(Buffer.from('image content'), {
      fileName: 'architecture.png',
      contentType: 'image/png',
      prefix: 'documents',
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const sentCommand = mockSend.mock.calls[0][0];
    expect(sentCommand.input.Bucket).toBe('my-bucket');
    expect(sentCommand.input.ContentType).toBe('image/png');
    expect(sentCommand.input.Key).toMatch(
      /^documents\/\d{4}\/\d{2}\/\d{2}\/architecture-[\da-f-]+\.png$/,
    );

    // 标准 OSS 直链
    expect(result.url).toMatch(
      /^https:\/\/my-bucket\.oss-cn-hangzhou\.aliyuncs\.com\/documents\/\d{4}\/\d{2}\/\d{2}\/architecture-[\da-f-]+\.png$/,
    );
    expect(result.key).toBe(sentCommand.input.Key);
  });

  it('配置 OSS_CUSTOM_DOMAIN 时，直链应优先使用自定义 CDN 域名', async () => {
    const { driver } = createDriver({
      OSS_ENABLED: 'true',
      OSS_REGION: 'oss-cn-hangzhou',
      OSS_BUCKET: 'my-bucket',
      OSS_ACCESS_KEY_ID: 'LTAI5test',
      OSS_ACCESS_KEY_SECRET: 'testsecret',
      OSS_CUSTOM_DOMAIN: 'https://cdn.myknowledge.com',
    });

    driver.onModuleInit();

    const mockSend = vi.fn().mockResolvedValue({});
    (driver as unknown as { client: { send: typeof mockSend } }).client = {
      send: mockSend,
    };

    const result = await driver.uploadBytes(Buffer.from('image content'), {
      fileName: 'avatar.webp',
      contentType: 'image/webp',
    });

    expect(result.url).toMatch(
      /^https:\/\/cdn\.myknowledge\.com\/documents\/\d{4}\/\d{2}\/\d{2}\/avatar-[\da-f-]+\.webp$/,
    );
  });
});
