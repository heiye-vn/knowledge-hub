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

  it.each([
    [
      'fenced code',
      '```ts\n# not a heading\n' + 'const x = 1;\n'.repeat(95) + '```',
    ],
    ['tilde fence', '~~~~python\n' + 'print(42)\n'.repeat(125) + '~~~~'],
    ['display math', '$$\n' + 'a_{i} + b_{i} = c_{i} \\\\\n'.repeat(60) + '$$'],
    [
      'HTML table',
      '<table><tr><th>Rule</th></tr><tr><td>' +
        'evidence '.repeat(135) +
        '</td></tr></table>',
    ],
  ])(
    'keeps a reasonably sized %s whole, inheriting only real headings',
    async (_kind, block) => {
      const svc = new ChunkingService(fakeConfig());
      const chunks = await svc.chunk({
        content: '# Policy\n\n' + block + '\n\nAfter the block.',
        documentId: 'protected',
        documentTitle: 'Policy',
      });
      expect(chunks.some((chunk) => chunk.content.includes(block))).toBe(true);
      expect(chunks.every((chunk) => chunk.heading === 'Policy')).toBe(true);
      expect(chunks.at(-1)?.content).toContain('After the block.');
    },
  );

  it('splits long HTML tables by rows, repeating headers without losing late cells', async () => {
    const svc = new ChunkingService(fakeConfig({ RAG_CHUNK_SIZE: '128' }));
    const rows = Array.from(
      { length: 30 },
      (_, i) => `<tr><td>ROW_${i}</td><td>${'value '.repeat(10)}</td></tr>`,
    );
    const header = '<thead><tr><th>Key</th><th>Value</th></tr></thead>';
    const chunks = await svc.chunk({
      content:
        '# Rules\n\n<table>' +
        header +
        '<tbody>' +
        rows.join('\n') +
        '</tbody></table>',
      documentId: 'html',
      documentTitle: 't',
    });
    const tables = chunks.filter((chunk) => chunk.content.includes('<table>'));
    expect(tables.length).toBeGreaterThan(1);
    for (const chunk of tables) {
      expect(chunk.content).toContain(header);
      expect(chunk.content).toContain('<tbody>');
      expect(chunk.content).toContain('</tbody></table>');
      expect(chunk.content.length).toBeLessThanOrEqual(256);
      expect(chunk.heading).toBe('Rules');
    }
    for (const row of rows)
      expect(
        tables.filter((chunk) => chunk.content.includes(row)),
      ).toHaveLength(1);
  });

  it('splits GFM rows with the original alignment header and escaped pipes intact', async () => {
    const svc = new ChunkingService(fakeConfig({ RAG_CHUNK_SIZE: '80' }));
    const header = '| Key | Value |\n| :--- | ---: |';
    const rows = Array.from(
      { length: 30 },
      (_, i) => `| ROW_${i} | escaped \\| ${'value '.repeat(6)} |`,
    );
    const chunks = await svc.chunk({
      content: header + '\n' + rows.join('\n'),
      documentId: 'gfm',
      documentTitle: 't',
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.startsWith(header + '\n')).toBe(true);
      expect(chunk.content.length).toBeLessThanOrEqual(160);
    }
    for (const row of rows)
      expect(
        chunks.filter((chunk) => chunk.content.includes(row)),
      ).toHaveLength(1);
  });

  it('keeps merged rowspan groups together while splitting other rows', async () => {
    const svc = new ChunkingService(fakeConfig({ RAG_CHUNK_SIZE: '128' }));
    const group =
      '<tr><td rowspan="2">MERGED</td><td>first</td></tr>\n<tr><td>second</td></tr>';
    const extra = Array.from(
      { length: 20 },
      (_, i) => `<tr><td>${i}</td><td>${'value '.repeat(8)}</td></tr>`,
    ).join('\n');
    const chunks = await svc.chunk({
      content:
        '<table><tr><th>Key</th><th>Value</th></tr>' +
        group +
        extra +
        '</table>',
      documentId: 'merged',
      documentTitle: 't',
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.filter((chunk) => chunk.content.includes(group)),
    ).toHaveLength(1);
    expect(
      chunks.every(
        (chunk) =>
          chunk.content.startsWith('<table>') &&
          chunk.content.endsWith('</table>'),
      ),
    ).toBe(true);
  });

  it.each([
    '<table><tr><th>Key</th></tr><tr><td>' +
      'x'.repeat(7000) +
      '</td></tr></table>',
    '| Key |\n| --- |\n| ' + 'x'.repeat(7000) + ' |',
    '$$\n' + 'x'.repeat(7000) + '\n$$',
    '```\n' + 'x'.repeat(7000) + '\n```',
  ])(
    'rejects an atomic unit beyond the embedding safe bound instead of truncating it',
    async (content) => {
      const svc = new ChunkingService(fakeConfig());
      await expect(
        svc.chunk({ content, documentId: 'huge', documentTitle: 't' }),
      ).rejects.toThrow(/atomic|embedding|safe bound/i);
    },
  );

  it('bounds prose including inherited heading prefixes with large configured budgets', async () => {
    const svc = new ChunkingService(
      fakeConfig({ RAG_CHUNK_SIZE: '100000', RAG_CHUNK_OVERLAP: '0' }),
    );
    const chunks = await svc.chunk({
      content: '# Heading\n\n' + '汉'.repeat(6000),
      documentId: 'bounded',
      documentTitle: 't',
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(Buffer.byteLength(chunk.content, 'utf8')).toBeLessThanOrEqual(
        6000,
      );
  });

  it('keeps ordinary prose byte-for-byte when it fits the target', async () => {
    const svc = new ChunkingService(fakeConfig());
    const content =
      'A plain paragraph.\n\nAnother paragraph with 中文 and punctuation.';
    const chunks = await svc.chunk({
      content,
      documentId: 'prose',
      documentTitle: 't',
    });
    expect(chunks.map((chunk) => chunk.content)).toEqual([content]);
  });

  it('inherits the latest real heading, not headings inside formulas or fences', async () => {
    const svc = new ChunkingService(fakeConfig({ RAG_CHUNK_SIZE: '128' }));
    const content =
      '# First\n\nText.\n\n## Second\n\n$$\n# formula label\nx = y\n$$\n\n```md\n# code label\n```\n\n' +
      'After '.repeat(100);
    const chunks = await svc.chunk({
      content,
      documentId: 'heading',
      documentTitle: 't',
    });
    expect(chunks[0].heading).toBe('First');
    expect(chunks.slice(1).every((chunk) => chunk.heading === 'Second')).toBe(
      true,
    );
  });

  it('keeps transitive rowspan groups together and repeats multi-row column headers', async () => {
    const svc = new ChunkingService(fakeConfig({ RAG_CHUNK_SIZE: '180' }));
    const header =
      '<thead><tr><th rowspan="2">Key</th><th>Group</th></tr><tr><th>Value</th></tr></thead>';
    const group =
      '<tr><td rowspan="2">A</td><td>B</td></tr>\n<tr><td rowspan="2">C</td></tr>\n<tr><td>D</td></tr>';
    const rows = Array.from(
      { length: 20 },
      (_, i) => `<tr><td>ROW_${i}</td><td>${'data '.repeat(10)}</td></tr>`,
    ).join('\n');
    const content =
      '<table>' + header + '<tbody>' + group + '\n' + rows + '</tbody></table>';
    const chunks = await svc.chunk({
      content,
      documentId: 'transitive',
      documentTitle: 't',
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.filter((chunk) => chunk.content.includes(group)),
    ).toHaveLength(1);
    expect(chunks.every((chunk) => chunk.content.includes(header))).toBe(true);
  });

  it('refuses an oversized rowspan=0 group instead of cutting the merged cells', async () => {
    const svc = new ChunkingService(fakeConfig());
    const rows = Array.from(
      { length: 100 },
      (_, i) => `<tr><td>${i} ${'data '.repeat(20)}</td></tr>`,
    ).join('\n');
    const content =
      '<table><tbody><tr><td rowspan="0">All</td><td>First</td></tr>' +
      rows +
      '</tbody></table>';
    await expect(
      svc.chunk({ content, documentId: 'rowspan0', documentTitle: 't' }),
    ).rejects.toThrow(/rowspan.*safe bound/i);
  });

  it('does not drop an oversized GFM header-only table', async () => {
    const svc = new ChunkingService(fakeConfig());
    const content = '| ' + 'Header '.repeat(180) + ' |\n| --- |';
    const chunks = await svc.chunk({
      content,
      documentId: 'header-only',
      documentTitle: 't',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
  });

  it('does not emit malformed HTML when a table has an omitted end tag', async () => {
    const svc = new ChunkingService(fakeConfig({ RAG_CHUNK_SIZE: '128' }));
    const content =
      '<table><tr><th>Key</th></tr>' +
      Array.from(
        { length: 15 },
        (_, i) => `<tr><td>${i} ${'value '.repeat(8)}</td></tr>`,
      ).join('');
    await expect(
      svc.chunk({ content, documentId: 'unclosed', documentTitle: 't' }),
    ).rejects.toThrow(/HTML table.*closed/i);
  });

  it('does not lose surrogate pairs while splitting ordinary Unicode prose', async () => {
    const svc = new ChunkingService(
      fakeConfig({ RAG_CHUNK_SIZE: '8', RAG_CHUNK_OVERLAP: '0' }),
    );
    const content = 'a' + '\u{1D400}'.repeat(24);
    const chunks = await svc.chunk({
      content,
      documentId: 'unicode',
      documentTitle: 't',
    });
    expect(chunks.map((chunk) => chunk.content).join('')).toBe(content);
    expect(
      chunks.every(
        (chunk) =>
          Buffer.from(chunk.content, 'utf8').toString('utf8') === chunk.content,
      ),
    ).toBe(true);
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
