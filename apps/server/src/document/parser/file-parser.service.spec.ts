import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileParserService } from './file-parser.service.js';
import type { MineruParser } from './mineru.parser.js';
import { parseImageWithVlm } from './parsers/image.parser.js';
import { parseXlsx } from './parsers/xlsx.parser.js';

vi.mock('./parsers/image.parser.js', () => ({ parseImageWithVlm: vi.fn() }));
vi.mock('./parsers/xlsx.parser.js', () => ({ parseXlsx: vi.fn() }));

const png = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001',
  'hex',
);
async function office(kind: 'word' | 'ppt' | 'xl'): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file(
    `${kind}/${kind === 'word' ? 'document' : kind === 'ppt' ? 'presentation' : 'workbook'}.xml`,
    '<root/>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('file routing and signatures', () => {
  const parse = vi.fn();
  const config = new ConfigService({ VLM_API_KEY: 'offline-key' });
  const service = new FileParserService(config, {
    parse,
  } as unknown as MineruParser);
  beforeEach(() => {
    vi.clearAllMocks();
    parse.mockResolvedValue({
      markdown: 'OCR text',
      images: [],
      warnings: [],
      parser: 'mineru',
    });
    vi.mocked(parseImageWithVlm).mockResolvedValue('VLM text');
    vi.mocked(parseXlsx).mockResolvedValue('| cell |');
  });

  it('returns the structured contract for local UTF-8 text and Markdown', async () => {
    for (const extension of ['txt', 'MD']) {
      expect(
        await service.parse({
          originalname: `a.${extension}`,
          buffer: Buffer.from('Hello'),
        }),
      ).toEqual({
        markdown: 'Hello',
        images: [],
        warnings: [],
        parser: 'text',
      });
    }
  });

  it('routes PDF/DOCX/PPTX to MinerU with unchanged options', async () => {
    const options = {
      checkpoint: {
        batchId: 'batch',
        uploadUrl: 'https://oss.aliyuncs.com/a',
        uploaded: true,
      },
    };
    for (const [extension, buffer] of [
      ['pdf', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF')],
      ['docx', await office('word')],
      ['pptx', await office('ppt')],
    ] as const) {
      const file = { originalname: `a.${extension}`, buffer };
      expect((await service.parse(file, options)).parser).toBe('mineru');
      expect(parse).toHaveBeenLastCalledWith(file, options);
    }
  });

  it('keeps XLSX local and raster images on the existing VLM path', async () => {
    expect(
      (
        await service.parse({
          originalname: 'a.xlsx',
          buffer: await office('xl'),
        })
      ).parser,
    ).toBe('xlsx');
    expect(
      (await service.parse({ originalname: 'a.png', buffer: png })).markdown,
    ).toBe('VLM text');
    expect(parseImageWithVlm).toHaveBeenCalledWith(
      png,
      'png',
      expect.objectContaining({ apiKey: 'offline-key' }),
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it('rejects renamed binary payloads and the wrong OOXML format before routing', async () => {
    for (const extension of [
      'pdf',
      'docx',
      'pptx',
      'xlsx',
      'png',
      'jpg',
      'jpeg',
      'webp',
    ]) {
      await expect(
        service.parse({
          originalname: `a.${extension}`,
          buffer: Buffer.from('renamed text'),
        }),
      ).rejects.toThrow(/signature|格式/i);
    }
    await expect(
      service.parse({ originalname: 'a.docx', buffer: await office('xl') }),
    ).rejects.toThrow(/signature|格式/i);
    expect(parse).not.toHaveBeenCalled();
    expect(parseImageWithVlm).not.toHaveBeenCalled();
  });

  it('retains empty-file, blank-result and supported-format guards', async () => {
    await expect(
      service.parse({ originalname: 'a.txt', buffer: Buffer.alloc(0) }),
    ).rejects.toThrow(/为空/);
    await expect(
      service.parse({ originalname: 'a.md', buffer: Buffer.from('  ') }),
    ).rejects.toThrow(/为空/);
    for (const extension of ['doc', 'ppt', 'xls', 'gif'])
      expect(service.isSupported(extension)).toBe(false);
  });
});
