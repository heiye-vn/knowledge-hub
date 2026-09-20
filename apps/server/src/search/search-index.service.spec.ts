import { Client } from '@elastic/elasticsearch';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ElasticsearchService } from '../rag/elasticsearch.service.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import {
  KH_DOCUMENT_INDEX,
  buildKhDocumentIndexBody,
} from './constants/kh-document.mapping.js';
import { SearchIndexService } from './search-index.service.js';

/**
 * 文档级搜索索引单测 + 集成用例
 *
 * 【易错】与 `rag/*.spec.ts` 同一写法：ES 不可达时集成用例整体 skipIf，
 * 纯函数用例（mapping 断言）始终执行，保证 CI 无容器也能跑。
 */

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

function fakeDoc(overrides: Partial<PipelineDocument> = {}): PipelineDocument {
  return {
    id: 'test-doc-1',
    title: '差旅费报销管理办法',
    content:
      '员工出差前应提交出差申请单，经部门负责人审批后方可出行。报销标准按城市等级划分，一线城市住宿费上限为每晚五百元。',
    summary: '差旅费报销标准与审批流程',
    status: 1,
    tags: '财务,制度,差旅',
    isPublic: true,
    categoryId: 'cat-1',
    authorId: 'author-1',
    viewCount: 10,
    likeCount: 2,
    commentCount: 0,
    publishTime: new Date('2026-09-20T00:00:00Z'),
    ...overrides,
  };
}

describe('buildKhDocumentIndexBody', () => {
  it('title / summary / content 显式指定 IK（避免退化成 standard 单字切分）', () => {
    const body = buildKhDocumentIndexBody();
    for (const field of ['title', 'summary', 'content']) {
      const prop = body.mappings.properties[field] as Record<string, string>;
      expect(prop.analyzer).toBe('ik_max_word');
      expect(prop.search_analyzer).toBe('ik_smart');
    }
  });

  it('tags 为 keyword：PG 逗号分隔字符串写入前拆分，便于精确过滤', () => {
    const body = buildKhDocumentIndexBody();
    expect((body.mappings.properties.tags as Record<string, string>).type).toBe(
      'keyword',
    );
  });

  it('默认索引名与参考项目 v4 保持一致', () => {
    expect(KH_DOCUMENT_INDEX).toBe('kh_document');
  });
});

describe.skipIf(!esUp)('SearchIndexService 集成（需要本地 ES + IK）', () => {
  const indexName = 'test_kh_document';
  let client: Client;
  let service: SearchIndexService;

  beforeAll(async () => {
    client = new Client({ node: 'http://localhost:9200' });
    const es = {
      isEnabled: () => true,
      getClient: () => client,
    } as unknown as ElasticsearchService;
    service = new SearchIndexService(
      fakeConfig({ ELASTICSEARCH_DOC_INDEX: indexName }),
      es,
    );
    await service.ensureIndex();
  });

  afterAll(async () => {
    await client.indices
      .delete({ index: indexName })
      .catch(() => undefined);
    await client.close().catch(() => undefined);
  });

  it('写入后可按中文关键词检索到，并返回高亮片段', async () => {
    await service.indexDocument(fakeDoc());
    // refresh=true 已保证立即可读
    const result = await service.search({
      query: '差旅费报销',
      page: 1,
      pageSize: 10,
      status: 1,
    });

    expect(result.total).toBeGreaterThan(0);
    const hit = result.hits[0];
    expect(hit.id).toBe('test-doc-1');
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.highlight).toBeTruthy();
  });

  it('默认只召回已发布文档：status 过滤生效', async () => {
    await service.indexDocument(fakeDoc({ id: 'test-doc-2', status: 0 }));
    const result = await service.search({
      query: '差旅费',
      page: 1,
      pageSize: 10,
      status: 1,
    });
    expect(result.hits.map((h) => h.id)).not.toContain('test-doc-2');
  });

  it('删除后不再被检索到（幂等，重复删除不抛错）', async () => {
    await service.deleteDocument('test-doc-1');
    await expect(service.deleteDocument('test-doc-1')).resolves.toBeUndefined();

    const result = await service.search({
      query: '差旅费报销',
      page: 1,
      pageSize: 10,
      status: 1,
    });
    expect(result.hits.map((h) => h.id)).not.toContain('test-doc-1');
  });
});
