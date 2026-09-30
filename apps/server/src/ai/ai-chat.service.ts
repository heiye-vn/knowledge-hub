import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { RetrievalService } from '../rag/retrieval.service.js';
import type { SearchHit } from '../rag/types/rag.types.js';

const EXCERPT_LEN = 200;
const CONTEXT_SNIPPET_LEN = 800;
const CITATION_RE = /\[(\d+)\]/g;

/** 返给前端的溯源条目（摘录，不含整块正文） */
export interface ChatSource {
  /** 资料编号，与回答中的 [n] 对应 */
  index: number;
  documentId: string;
  documentTitle: string;
  heading: string | null;
  excerpt: string;
  score: number;
}

/**
 * RAG 对话服务（feat-v11）：混合检索 → LLM 作答 → 引用溯源。
 *
 * 对应基线实现 v11 `ai/ai-chat.service.ts`。
 *
 * 🟡 与基线实现的分叉：
 * - **复用主项目 RetrievalService**：继承其 RAG_MIN_SCORE 低分过滤与
 *   PG 一致性兜底（基线实现无这两层，无关查询的硬凑结果会进上下文）。
 * - **Key 回退链对齐 extraction.service**：LLM_API_KEY → EMBEDDING_API_KEY
 *   → OPENAI_API_KEY（基线是 DASHSCOPE/OPENAI）。
 *
 * 引用溯源设计（与基线一致）：system prompt 强制句末标 [n] → 生成后
 * 正则抽出实际引用的编号 → sources 只返回被引用条目（未标注时回退全部），
 * 每条带 200 字 excerpt 而非整块正文。
 *
 * 降级：检索无命中直接返回固定话术，不调用 LLM；未配置 Key 时
 * 检索有结果才抛 503（无结果时无需 LLM）。
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly llm: ChatOpenAI | null = null;

  constructor(
    config: ConfigService,
    private readonly retrieval: RetrievalService,
  ) {
    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      undefined;
    if (!apiKey) return;

    const baseUrl = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const model = config.get<string>('LLM_MODEL', 'qwen-plus');

    this.llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      configuration: { baseURL: baseUrl },
    });
  }

  async chat(question: string, topK = 5): Promise<{
    answer: string;
    sources: ChatSource[];
  }> {
    const trimmed = question.trim();
    if (!trimmed) {
      return { answer: '请输入问题。', sources: [] };
    }

    const hits = await this.retrieval.search({ query: trimmed, topK });
    if (!hits.length) {
      return { answer: '知识库里没有相关内容。', sources: [] };
    }

    if (!this.llm) {
      throw new ServiceUnavailableException(
        '未配置 LLM_API_KEY / EMBEDDING_API_KEY / OPENAI_API_KEY，无法生成回答',
      );
    }

    const context = this.buildContext(hits);
    const response = await this.llm.invoke([
      new SystemMessage(
        '你是企业知识库助手。只根据「检索到的资料」回答用户问题。' +
          '若资料不足以回答，明确说不知道，不要编造。' +
          '凡是依据某条资料作出的陈述，必须在句末标注对应编号，如 [1]、[2]。' +
          '编号必须与资料列表一致，不要标注未使用的编号，不要编造文档标题或链接。' +
          '回答简洁，必要时列出条目。',
      ),
      new HumanMessage(
        `检索到的资料：\n${context}\n\n用户问题：${trimmed}`,
      ),
    ]);

    const answer =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    const sources = this.toCitedSources(answer, hits);
    this.logger.log(
      `RAG 对话完成：hits=${hits.length}, cited=${sources.length}, answerLength=${answer.length}`,
    );
    return { answer, sources };
  }

  /** 从回答中抽出 [n]，只返回实际引用的资料；未标注时回退为全部召回（摘录） */
  private toCitedSources(answer: string, hits: SearchHit[]): ChatSource[] {
    const cited = new Set<number>();
    for (const match of answer.matchAll(CITATION_RE)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= hits.length) cited.add(n);
    }

    const indexes =
      cited.size > 0
        ? [...cited].sort((a, b) => a - b)
        : hits.map((_, i) => i + 1);

    return indexes.map((index) => this.toSource(index, hits[index - 1]));
  }

  private toSource(index: number, hit: SearchHit): ChatSource {
    return {
      index,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: this.excerpt(hit.content),
      score: hit.score,
    };
  }

  private excerpt(content: string): string {
    const text = content.replace(/\s+/g, ' ').trim();
    if (text.length <= EXCERPT_LEN) return text;
    return `${text.slice(0, EXCERPT_LEN)}...`;
  }

  private buildContext(hits: SearchHit[]): string {
    return hits
      .map((src, i) => {
        const heading = src.heading ? ` / ${src.heading}` : '';
        const snippet =
          src.content.length > CONTEXT_SNIPPET_LEN
            ? `${src.content.slice(0, CONTEXT_SNIPPET_LEN)}...`
            : src.content;
        return `[${i + 1}] ${src.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n');
  }
}
