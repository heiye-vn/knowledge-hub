import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { createHash } from 'crypto';
import type { DocumentChunk } from './types/rag.types.js';

export interface ChunkParams {
  /** Markdown 正文 */
  content: string;
  /** 文档雪花 ID（写入 chunk 元数据，供按文档删除） */
  documentId: string;
  /** 文档标题（检索展示用） */
  documentTitle: string;
  categoryId?: string | null;
  authorId?: string | null;
  teamId?: string | null;
  docStatus?: number | null;
  publishTime?: string | null;
}

/**
 * 文档分块服务（LangChain RecursiveCharacterTextSplitter / markdown 感知）
 *
 * 为什么要分块：
 * - Embedding 有长度上限，超长会被截断丢信息
 * - 检索需要「段落级」命中，整篇召回噪声太大
 *
 * 策略（与基线实现 完全一致，便于对照）：
 * 1. Markdown 感知分隔符（标题 / 代码块 / 段落…）递归切分
 * 2. chunkSize / chunkOverlap 控制块大小与重叠
 * 3. 从块内标题行推断 heading，跨块继承上一标题并前缀补全
 *
 * 配置：RAG_CHUNK_SIZE / RAG_CHUNK_OVERLAP，单位 token，
 * 按 CHARS_PER_TOKEN=2 换算为字符（512 token ≈ 1024 字符）。
 */
@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);
  private readonly splitter: RecursiveCharacterTextSplitter;

  /** token → 字符的粗略换算系数：中英文混合场景约 1 token ≈ 2 字符 */
  private static readonly CHARS_PER_TOKEN = 2.0;

  /** 匹配块内 Markdown ATX 标题行 */
  private static readonly HEADING_LINE = /^(#{1,6})\s+(.+)$/m;

  constructor(config: ConfigService) {
    const chunkSizeTokens = Number(config.get('RAG_CHUNK_SIZE', 512));
    const chunkOverlapTokens = Number(config.get('RAG_CHUNK_OVERLAP', 64));
    const chunkSize = Math.floor(
      chunkSizeTokens * ChunkingService.CHARS_PER_TOKEN,
    );
    const chunkOverlap = Math.floor(
      chunkOverlapTokens * ChunkingService.CHARS_PER_TOKEN,
    );

    // 内置 markdown 分隔符未含 H1（\n# ），补上以免一级标题不切分
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      keepSeparator: true,
      separators: [
        '\n# ',
        ...RecursiveCharacterTextSplitter.getSeparatorsForLanguage('markdown'),
      ],
    });
  }

  /** 将一篇文档正文切成可索引的 DocumentChunk 列表；内容为空时返回 [] */
  async chunk(params: ChunkParams): Promise<DocumentChunk[]> {
    const { content, documentId, documentTitle } = params;

    if (!content?.trim()) {
      this.logger.warn(`文档内容为空，跳过分块：documentId=${documentId}`);
      return [];
    }

    const texts = await this.splitter.splitText(content);
    const chunks: DocumentChunk[] = [];
    let currentHeading: string | null = null;

    for (const text of texts) {
      const trimmed = text.trim();
      if (!trimmed) continue;

      const headingInChunk = this.extractHeading(trimmed);
      if (headingInChunk) {
        currentHeading = headingInChunk;
      }

      // 同章节后续块通常不含标题行：前缀补上，便于检索命中时带上下文
      let chunkContent = trimmed;
      if (currentHeading && !ChunkingService.HEADING_LINE.test(trimmed)) {
        chunkContent = `${currentHeading}\n\n${trimmed}`;
      }

      chunks.push({
        chunkId: this.buildChunkId(documentId, chunks.length),
        documentId,
        documentTitle,
        content: chunkContent,
        heading: currentHeading,
        chunkIndex: chunks.length,
        totalChunks: 0,
        categoryId: params.categoryId ?? null,
        authorId: params.authorId ?? null,
        teamId: params.teamId ?? null,
        docStatus: params.docStatus ?? null,
        publishTime: params.publishTime ?? null,
      });
    }

    const total = chunks.length;
    chunks.forEach((c) => {
      c.totalChunks = total;
    });

    this.logger.debug(
      `文档分块完成：documentId=${documentId}, totalChunks=${total}`,
    );
    return chunks;
  }

  /** 稳定 ID：sha256(documentId:index)，重建时可覆盖写，保证幂等 */
  private buildChunkId(documentId: string, index: number): string {
    return createHash('sha256')
      .update(`${documentId}:${index}`)
      .digest('hex')
      .slice(0, 64);
  }

  /** 取块内第一个 ATX 标题文案（不含 #） */
  private extractHeading(text: string): string | null {
    const match = text.match(ChunkingService.HEADING_LINE);
    return match?.[2]?.trim() || null;
  }
}
