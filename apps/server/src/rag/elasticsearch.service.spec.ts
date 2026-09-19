import { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KH_CHUNK_EMBEDDING_DIMS,
  KH_CHUNK_INDEX,
  buildKhChunkIndexBody,
} from './constants/kh-chunk.mapping.js';
import { ElasticsearchService } from './elasticsearch.service.js';

/** 本地 ES 是否可达；不可达则跳过集成用例（纯单测仍会执行） */
async function isEsUp(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:9200/_cluster/health', {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const esUp = await isEsUp();

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

describe('buildKhChunkIndexBody', () => {
  it('content 显式指定 IK 分析器（避免退化成 standard 单字切分）', () => {
    const body = buildKhChunkIndexBody();
    const content = body.mappings.properties.content as Record<string, string>;

    expect(content.analyzer).toBe('ik_max_word');
    expect(content.search_analyzer).toBe('ik_smart');
  });

  it('document_title 同时具备 IK 全文与 keyword 子字段', () => {
    const body = buildKhChunkIndexBody();
    const title = body.mappings.properties.document_title as Record<string, any>;

    expect(title.analyzer).toBe('ik_max_word');
    expect(title.search_analyzer).toBe('ik_smart');
    expect(title.fields.keyword.type).toBe('keyword');
  });

  it('embedding 为 cosine dense_vector，维度可通过参数注入', () => {
    const body = buildKhChunkIndexBody(768);
    const embedding = body.mappings.properties.embedding as Record<string, any>;

    expect(embedding.type).toBe('dense_vector');
    expect(embedding.similarity).toBe('cosine');
    expect(embedding.index).toBe(true);
    expect(embedding.dims).toBe(768);
    expect(buildKhChunkIndexBody().mappings.properties.embedding).toHaveProperty(
      'dims',
      KH_CHUNK_EMBEDDING_DIMS,
    );
  });
});

describe.skipIf(!esUp)('ElasticsearchService（集成，依赖 localhost:9200）', () => {
  let service: ElasticsearchService;

  beforeAll(async () => {
    service = new ElasticsearchService(
      fakeConfig({
        ELASTICSEARCH_ENABLED: 'true',
        ELASTICSEARCH_NODE: 'http://localhost:9200',
        ELASTICSEARCH_INDEX: KH_CHUNK_INDEX,
        EMBEDDING_DIMENSION: String(KH_CHUNK_EMBEDDING_DIMS),
      }),
    );
    await service.onModuleInit();
    await service.ensureIndex();
  });

  afterAll(async () => {
    await service?.getClient().close().catch(() => undefined);
  });

  it('启用后客户端可用', () => {
    expect(service.isEnabled()).toBe(true);
    expect(service.getIndexName()).toBe(KH_CHUNK_INDEX);
  });

  it('ensureIndex 幂等：重复调用不报错', async () => {
    await expect(service.ensureIndex()).resolves.toBeUndefined();
  });

  it('索引 mapping 的向量维度与配置一致', async () => {
    const mapping = await service
      .getClient()
      .indices.getMapping({ index: service.getIndexName() });
    const properties = (mapping as any)[service.getIndexName()].mappings
      .properties as Record<string, any>;

    expect(properties.embedding.dims).toBe(KH_CHUNK_EMBEDDING_DIMS);
    expect(properties.content.analyzer).toBe('ik_max_word');
  });

  it('中文分词不是单字切分（IK 生效，而非默认 standard）', async () => {
    const text = '企业级知识库检索系统支持中文分词';

    const ik = await service.getClient().indices.analyze({
      index: service.getIndexName(),
      body: { analyzer: 'ik_smart', text },
    });
    const ikTokens = (ik as any).tokens.map((t: any) => t.token as string);

    // 切出的是词，不是逐字
    expect(ikTokens).toContain('知识库');
    expect(ikTokens).toContain('检索系统');
    expect(ikTokens.length).toBeLessThan(text.length);

    const standard = await service.getClient().indices.analyze({
      body: { analyzer: 'standard', text },
    });
    const standardTokens = (standard as any).tokens.map(
      (t: any) => t.token as string,
    );

    // 对照：standard 会逐字切分，长度等于字数
    expect(standardTokens.length).toBe(text.length);
  });
});

describe('ElasticsearchService（禁用场景）', () => {
  it('ELASTICSEARCH_ENABLED=false 时不建客户端，不阻断启动', async () => {
    const service = new ElasticsearchService(
      fakeConfig({ ELASTICSEARCH_ENABLED: 'false' }),
    );
    await service.onModuleInit();

    expect(service.isEnabled()).toBe(false);
    expect(() => service.getClient()).toThrow(/未启用/);
  });
});
