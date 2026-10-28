import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { createHash } from 'crypto';
import type { DocumentChunk } from './types/rag.types.js';
import {
  assertAtomicFits,
  EMBEDDING_SAFE_BYTES,
  markdownBlocks,
  splitStructuredBlock,
} from './markdown-structure.js';

/** LangChain's empty-separator fallback otherwise cuts UTF-16 surrogate pairs. */
class UnicodeProseSplitter extends RecursiveCharacterTextSplitter {
  protected override splitOnSeparator(
    text: string,
    separator: string,
  ): string[] {
    return separator
      ? super.splitOnSeparator(text, separator)
      : Array.from(text);
  }
}

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
  isPublic?: boolean;
  docStatus?: number | null;
  publishTime?: string | null;
}

/**
 * Structure-aware Markdown chunks: recursive splitting/overlap for prose only;
 * fences/math stay atomic and large tables split by rows with repeated headers.
 * RAG_CHUNK_SIZE / RAG_CHUNK_OVERLAP retain the historical estimated-token units
 * (2 characters per token). The target includes inherited headings; indivisible
 * structures may use up to 4x that target, never above 6000 UTF-8 bytes.
 */
@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);
  private readonly chunkSizeChars: number;
  private readonly chunkOverlapChars: number;

  constructor(config: ConfigService) {
    const size = Number(config.get('RAG_CHUNK_SIZE', 512));
    const overlap = Number(config.get('RAG_CHUNK_OVERLAP', 64));
    if (
      !Number.isFinite(size) ||
      size < 1 ||
      !Number.isFinite(overlap) ||
      overlap < 0
    ) {
      throw new RangeError(
        'RAG_CHUNK_SIZE must be positive and RAG_CHUNK_OVERLAP non-negative',
      );
    }
    this.chunkSizeChars = Math.min(Math.floor(size * 2), EMBEDDING_SAFE_BYTES);
    this.chunkOverlapChars = Math.min(
      Math.floor(overlap * 2),
      this.chunkSizeChars - 1,
    );
  }

  private async splitProse(text: string, prefix: string): Promise<string[]> {
    // A UTF-16 code unit needs at most three UTF-8 bytes. Reserve both heading
    // characters and bytes before recursive splitting, not after producing chunks.
    const chunkSize = Math.min(
      this.chunkSizeChars - prefix.length,
      Math.floor(
        (EMBEDDING_SAFE_BYTES - Buffer.byteLength(prefix, 'utf8')) / 3,
      ),
    );
    if (chunkSize < 1) {
      throw new RangeError(
        'Heading leaves no prose budget within chunk/embedding safe bound',
      );
    }
    const splitter = new UnicodeProseSplitter({
      chunkSize,
      chunkOverlap: Math.min(this.chunkOverlapChars, chunkSize - 1),
      keepSeparator: true,
      separators: [
        '\n# ',
        ...RecursiveCharacterTextSplitter.getSeparatorsForLanguage('markdown'),
      ],
    });
    return splitter.splitText(text);
  }

  /** 将一篇文档正文切成可索引的 DocumentChunk 列表；内容为空时返回 [] */
  async chunk(params: ChunkParams): Promise<DocumentChunk[]> {
    const { content, documentId, documentTitle } = params;

    if (!content?.trim()) {
      this.logger.warn(`文档内容为空，跳过分块：documentId=${documentId}`);
      return [];
    }

    const chunks: DocumentChunk[] = [];
    let currentHeading: string | null = null;
    let pending = '';
    let pendingHeading: string | null = null;

    const emit = (chunkContent: string, heading: string | null) => {
      assertAtomicFits(chunkContent, this.chunkSizeChars, 'Chunk');
      chunks.push({
        chunkId: this.buildChunkId(documentId, chunks.length),
        documentId,
        documentTitle,
        content: chunkContent,
        heading,
        chunkIndex: chunks.length,
        totalChunks: 0,
        categoryId: params.categoryId ?? null,
        authorId: params.authorId ?? null,
        teamId: params.teamId ?? null,
        isPublic: params.isPublic ?? false,
        docStatus: params.docStatus ?? null,
        publishTime: params.publishTime ?? null,
      });
    };
    const flush = () => {
      if (pending) emit(pending, pendingHeading);
      pending = '';
    };

    for (const block of markdownBlocks(content)) {
      const text = block.text.trim();
      if (!text) continue;
      if (block.kind === 'heading') {
        flush();
        currentHeading = block.heading ?? null;
        assertAtomicFits(text, this.chunkSizeChars, 'Heading');
        pending = text;
        pendingHeading = currentHeading;
        continue;
      }
      const prefix = currentHeading ? `${currentHeading}\n\n` : '';
      const pieces =
        block.kind === 'prose'
          ? await this.splitProse(text, prefix)
          : splitStructuredBlock(block, prefix, this.chunkSizeChars);
      for (const piece of pieces) {
        const candidate = pending ? `${pending}\n\n${piece}` : prefix + piece;
        if (
          candidate.length <= this.chunkSizeChars &&
          Buffer.byteLength(candidate, 'utf8') <= EMBEDDING_SAFE_BYTES
        ) {
          pending = candidate;
          pendingHeading = currentHeading;
        } else {
          flush();
          pending = prefix + piece;
          pendingHeading = currentHeading;
          if (pending.length > this.chunkSizeChars) flush();
        }
      }
    }
    flush();

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
}
