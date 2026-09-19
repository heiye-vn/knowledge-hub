import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { EmbeddingService } from './embedding.service.js';

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

describe('EmbeddingService', () => {
  it('缺 API Key 时构造函数不抛异常（延迟初始化，不阻断应用启动）', () => {
    expect(() => new EmbeddingService(fakeConfig())).not.toThrow();
  });

  it('isConfigured 反映 Key 是否存在', () => {
    expect(new EmbeddingService(fakeConfig()).isConfigured()).toBe(false);
    expect(
      new EmbeddingService(
        fakeConfig({ EMBEDDING_API_KEY: 'sk-test' }),
      ).isConfigured(),
    ).toBe(true);
    // 兼容备选变量名
    expect(
      new EmbeddingService(
        fakeConfig({ DASHSCOPE_API_KEY: 'sk-test' }),
      ).isConfigured(),
    ).toBe(true);
  });

  it('首次使用时才抛明确异常，而非构造期', async () => {
    const service = new EmbeddingService(fakeConfig());
    await expect(service.embed('文本')).rejects.toThrow(/未配置 Embedding API Key/);
  });

  it('空输入直接返回空数组，不触发远程调用', async () => {
    const service = new EmbeddingService(fakeConfig());
    await expect(service.embedBatch([])).resolves.toEqual([]);
  });

  it('batchSize 钳制到 DashScope 上限 10', () => {
    const clamped = new EmbeddingService(
      fakeConfig({ EMBEDDING_BATCH_SIZE: '50', EMBEDDING_API_KEY: 'sk-test' }),
    );
    expect((clamped as any).batchSize).toBe(10);

    const invalid = new EmbeddingService(
      fakeConfig({ EMBEDDING_BATCH_SIZE: 'abc', EMBEDDING_API_KEY: 'sk-test' }),
    );
    expect((invalid as any).batchSize).toBe(10);

    const small = new EmbeddingService(
      fakeConfig({ EMBEDDING_BATCH_SIZE: '4', EMBEDDING_API_KEY: 'sk-test' }),
    );
    expect((small as any).batchSize).toBe(4);
  });

  it('维度取配置值，默认 1024', () => {
    expect(new EmbeddingService(fakeConfig()).getDimension()).toBe(1024);
    expect(
      new EmbeddingService(fakeConfig({ EMBEDDING_DIMENSION: '768' })).getDimension(),
    ).toBe(768);
  });
});
