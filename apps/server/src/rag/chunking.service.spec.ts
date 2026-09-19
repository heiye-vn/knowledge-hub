import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChunkingService } from './chunking.service.js';

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: string) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

describe('ChunkingService', () => {
  let service: ChunkingService;

  beforeEach(() => {
    // 用小尺寸便于构造多块场景：8 token → 16 字符，overlap 2 token → 4 字符
    service = new ChunkingService(
      fakeConfig({ RAG_CHUNK_SIZE: '8', RAG_CHUNK_OVERLAP: '2' }),
    );
  });

  it('内容为空时返回空数组', async () => {
    await expect(
      service.chunk({ content: '   ', documentId: '1', documentTitle: 't' }),
    ).resolves.toEqual([]);
  });

  it('按标题切分并回填 totalChunks / 连续 chunkIndex', async () => {
    const content = ['# 标题一', '内容A内容A', '## 标题二', '内容B内容B'].join(
      '\n\n',
    );

    const chunks = await service.chunk({
      content,
      documentId: '1001',
      documentTitle: '测试文档',
    });

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.chunkIndex).toBe(i);
      expect(c.totalChunks).toBe(chunks.length);
      expect(c.documentId).toBe('1001');
      expect(c.documentTitle).toBe('测试文档');
    });
  });

  it('跨块继承标题，并在无标题块上前缀补全', async () => {
    const content = [
      '# 报销制度',
      '这是报销制度的第一段说明文字足够长以便被切成多个块内容。',
      '这是同一章节的第二段说明文字同样足够长以便继续切分下去测试。',
    ].join('\n\n');

    const chunks = await service.chunk({
      content,
      documentId: '1002',
      documentTitle: '制度',
    });

    // 首块含标题行
    expect(chunks[0].heading).toBe('报销制度');
    expect(chunks[0].content.startsWith('# 报销制度')).toBe(true);

    // 后续块继承 heading，且因为自身无标题行而被前缀补全
    const followings = chunks.slice(1);
    expect(followings.length).toBeGreaterThan(0);
    for (const c of followings) {
      expect(c.heading).toBe('报销制度');
      expect(c.content.startsWith('报销制度\n\n')).toBe(true);
    }
  });

  it('chunkId = sha256(documentId:index)，稳定且唯一', async () => {
    const content = Array.from(
      { length: 6 },
      (_, i) => `段落${i}内容内容内容内容内容内容内容内容`,
    ).join('\n\n');

    const first = await service.chunk({
      content,
      documentId: '2001',
      documentTitle: 't',
    });
    const again = await service.chunk({
      content,
      documentId: '2001',
      documentTitle: 't',
    });

    expect(first.map((c) => c.chunkId)).toEqual(again.map((c) => c.chunkId));
    expect(new Set(first.map((c) => c.chunkId)).size).toBe(first.length);
    // sha256 hex = 64 字符
    expect(first[0].chunkId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('无分隔符的超长单段也能被切分（递归降级到字符级）', async () => {
    // 无任何 markdown 分隔符，splitter 应一路降级切分，而不是整段返回
    const content = '这是一段没有任何分隔符的超长中文文本内容'.repeat(20);

    const chunks = await service.chunk({
      content,
      documentId: '4001',
      documentTitle: 't',
    });

    expect(chunks.length).toBeGreaterThan(1);
    // 每块都应远小于原文长度
    chunks.forEach((c) => {
      expect(c.content.length).toBeLessThan(content.length);
    });
  });

  it('透传元数据字段', async () => {
    const chunks = await service.chunk({
      content: '一段用于测试的正文内容',
      documentId: '3001',
      documentTitle: 't',
      categoryId: 'cat-1',
      authorId: 'user-9',
      teamId: 'team-3',
      docStatus: 2,
      publishTime: '2026-09-19T00:00:00.000Z',
    });

    expect(chunks[0]).toMatchObject({
      categoryId: 'cat-1',
      authorId: 'user-9',
      teamId: 'team-3',
      docStatus: 2,
      publishTime: '2026-09-19T00:00:00.000Z',
    });
  });
});
