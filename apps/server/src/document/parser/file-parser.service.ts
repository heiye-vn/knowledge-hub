import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateFileSignature } from './file-signature.js';
import { MineruParser } from './mineru.parser.js';
import type { ParsedDocument, ParseOptions } from './parse-result.js';
import { parseImageWithVlm } from './parsers/image.parser.js';
import { parsePlainText } from './parsers/plain-text.parser.js';
import { parseXlsx } from './parsers/xlsx.parser.js';
import { getExtension } from './utils/markdown.util.js';

const SUPPORTED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'txt',
  'md',
  'png',
  'jpg',
  'jpeg',
  'webp',
]);

export interface ParseInput {
  originalname: string;
  buffer: Buffer;
  size?: number;
}

/** File routing only. Asset persistence belongs to the import worker. */
@Injectable()
export class FileParserService {
  private readonly logger = new Logger(FileParserService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly mineru: MineruParser,
  ) {}

  isSupported(extension: string): boolean {
    return SUPPORTED_EXTENSIONS.has(extension?.toLowerCase());
  }

  supportedList(): string {
    return [...SUPPORTED_EXTENSIONS].join(', ');
  }

  async parse(
    file: ParseInput,
    options?: ParseOptions,
  ): Promise<ParsedDocument> {
    const extension = getExtension(file.originalname);
    if (!this.isSupported(extension))
      throw new BadRequestException(
        `不支持的文件格式，支持的格式: ${this.supportedList()}`,
      );
    if (!Buffer.isBuffer(file.buffer) || !file.buffer.length)
      throw new BadRequestException('文件内容为空，无法解析');
    validateFileSignature(file.buffer, extension);
    if (['pdf', 'docx', 'pptx'].includes(extension))
      return this.mineru.parse(file, options);

    let markdown: string;
    let parser: string;
    switch (extension) {
      case 'xlsx':
        markdown = await this.parseXlsxWithFallback(file.buffer);
        parser = 'xlsx';
        break;
      case 'txt':
      case 'md':
        markdown = parsePlainText(file.buffer);
        parser = 'text';
        break;
      default:
        markdown = await parseImageWithVlm(file.buffer, extension, {
          apiKey: this.config.get<string>('VLM_API_KEY'),
          model: this.config.get<string>('VLM_MODEL') || 'qwen3.8-flash',
          baseUrl: this.config.get<string>('VLM_BASE_URL'),
          timeoutMs: Number(this.config.get('VLM_TIMEOUT_MS', 60000)),
        });
        parser = 'vlm';
    }
    if (!markdown?.trim())
      throw new BadRequestException(
        '文件解析结果为空，请确认文件包含可提取的文本内容',
      );
    return { markdown, images: [], warnings: [], parser };
  }

  private async parseXlsxWithFallback(buffer: Buffer): Promise<string> {
    try {
      return await parseXlsx(buffer);
    } catch {
      this.logger.warn('XLSX(exceljs) 解析失败，降级 officeparser');
      try {
        const { parseOffice } = await import('officeparser');
        const ast = await parseOffice(buffer, { fileType: 'xlsx' });
        const { value } = await ast.to('md');
        return value ?? '';
      } catch {
        throw new BadRequestException('XLSX 文件解析失败，请检查文件格式');
      }
    }
  }
}
