import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { extractMineruArchive, inspectZip } from './mineru-archive.js';

const png = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001',
  'hex',
);
async function zip(files: Record<string, string | Buffer>): Promise<Buffer> {
  const archive = new JSZip();
  for (const [name, data] of Object.entries(files)) archive.file(name, data);
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('bounded MinerU archive extraction', () => {
  it('extracts nested full.md and only referenced raster assets with canonical paths', async () => {
    const bytes = await zip({
      'result/full.md': '# OCR text\n\n![x](./images/a.png)',
      'result/images/a.png': png,
      'result/images/unused.png': png,
    });
    expect(extractMineruArchive(bytes)).toEqual({
      markdown: '# OCR text\n\n![x](result/images/a.png)',
      images: [
        { path: 'result/images/a.png', bytes: png, contentType: 'image/png' },
      ],
      warnings: [],
      parser: 'mineru',
    });
  });

  it('rejects an image-only result instead of silently accepting failed OCR', async () => {
    await expect(
      zip({ 'full.md': '![words in alt](a.png)', 'a.png': png }).then(
        extractMineruArchive,
      ),
    ).rejects.toThrow(/text|文本/i);
  });

  it('rejects missing local images, traversal, SVG and renamed image payloads', async () => {
    for (const files of [
      { 'full.md': 'Text\n\n![x](missing.png)' },
      { 'full.md': 'Text\n\n![x](../a.png)', 'a.png': png },
      { 'full.md': 'Text\n\n<img src="a.svg">', 'a.svg': '<svg />' },
      {
        'full.md': 'Text\n\n![x](a.png)',
        'a.png': Buffer.from('not an image'),
      },
    ] as Record<string, string | Buffer>[])
      await expect(zip(files).then(extractMineruArchive)).rejects.toThrow();
  });

  it('rejects unsafe archive entry names before inflation', async () => {
    for (const name of ['../a.png', '/a.png', 'a\\b.png', 'C:/a.png']) {
      await expect(
        zip({ 'full.md': 'Text', [name]: png }).then(extractMineruArchive),
      ).rejects.toThrow();
    }
  });

  it('enforces compressed, entry count, total, markdown and image limits', async () => {
    const bytes = await zip({ 'full.md': 'Meaningful text', 'a.png': png });
    expect(() =>
      extractMineruArchive(bytes, { maxCompressedBytes: 10 }),
    ).toThrow(/limit/i);
    expect(() => extractMineruArchive(bytes, { maxEntries: 1 })).toThrow(
      /limit/i,
    );
    expect(() =>
      extractMineruArchive(bytes, { maxUncompressedBytes: 10 }),
    ).toThrow(/limit/i);
    expect(() => extractMineruArchive(bytes, { maxMarkdownBytes: 2 })).toThrow(
      /limit/i,
    );
    const imageBytes = await zip({
      'full.md': 'Text\n\n![x](a.png)',
      'a.png': png,
    });
    expect(() =>
      extractMineruArchive(imageBytes, { maxImageBytes: 2 }),
    ).toThrow(/limit/i);
  });

  it('bounds actual deflate output even when central and local sizes lie', async () => {
    const bytes = await zip({ 'full.md': 'a'.repeat(100_000) });
    const central = bytes.indexOf(Buffer.from('504b0102', 'hex'));
    bytes.writeUInt32LE(1, central + 24);
    bytes.writeUInt32LE(1, 22);
    expect(() =>
      extractMineruArchive(bytes, { maxMarkdownBytes: 100 }),
    ).toThrow();
  });

  it('rejects duplicate names and ambiguous full.md files', async () => {
    const bytes = await zip({ 'one/full.md': 'Text', 'two/full.md': 'Text' });
    expect(() => extractMineruArchive(bytes)).toThrow();
    const duplicates = await zip({ 'aa.md': 'A', 'bb.md': 'B' });
    for (let index = 0; index < duplicates.length - 5; index++) {
      if (duplicates.subarray(index, index + 5).toString() === 'bb.md')
        duplicates.write('aa.md', index);
    }
    expect(() => inspectZip(duplicates)).toThrow(/duplicate/i);
  });
});
