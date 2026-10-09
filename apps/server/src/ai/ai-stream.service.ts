import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
} from 'ai';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import {
  createAgent,
  modelCallLimitMiddleware,
  tool,
} from 'langchain';
import { z } from 'zod';
import type { Response } from 'express';
import { RetrievalService } from '../rag/retrieval.service.js';
import type { SearchHit } from '../rag/types/rag.types.js';
import { ChatSessionService } from './chat-session.service.js';
import { WebSearchService } from './web-search.service.js';
import type { AuthUser } from '../auth/auth-user.interface.js';
import type { ChatSource } from './chat.types.js';
import type { ChatStreamDto } from './dto/chat-stream.dto.js';

const EXCERPT_LEN = 200;
const CONTEXT_SNIPPET_LEN = 800;
const CITATION_RE = /\[(\d+)\]/g;

const SYSTEM =
  '你是企业知识库助手。优先根据「检索到的资料」回答。' +
  '资料不足、需要时效性或外部公开信息时，调用 web_search。' +
  '依据资料的陈述句末标 [n]，与资料编号一致。' +
  '联网结果用标题+链接说明，不要编造。资料不够就明确说不知道。';

/** 流式消息上叠加的自定义事件（data-*），前端按 type 渲染过程组件 */
type KhUIMessage = UIMessage<
  unknown,
  {
    status: { stage: string; text: string };
    think: { text: string };
    sources: ChatSource[];
    retrieve: {
      query: string;
      items: Array<{
        index: number;
        documentId: string;
        documentTitle: string;
        heading: string | null;
      }>;
    };
    session: { sessionId: string };
  }
>;

/**
 * 流式 RAG 对话服务：LangChain Agent 流式作答，经 @ai-sdk/langchain
 * 转成 UI Message Stream 协议（SSE）写回。
 *
 * 协议编排（execute 内）：自定义事件先行（session / 检索状态 / 召回明细 /
 * source-document），再合并 Agent 的思考与正文流；start/finish 由外层统一
 * 收口，适配层 sendStart/sendFinish 关闭避免重复。
 *
 * 落库：onFinish 里从最终 parts 拼回答、按 [n] 抽被引用的资料，
 * 复用 ChatSessionService.appendTurn（尽力而为，失败不影响已流出的回答）。
 *
 * 🟡 与基线实现 v14 的分叉：
 * - Key 回退链与模型默认值对齐本服务 ai-chat.service（LLM_API_KEY →
 *   EMBEDDING_API_KEY → OPENAI_API_KEY；LLM_MODEL 同源配置）。
 * - 传入 sessionId 时开场即校验归属（assertOwned），越权当场 404，
 *   不等答完落库才发现；无 sessionId 时直接以首问标题建会话。
 */
@Injectable()
export class AiStreamService {
  private readonly logger = new Logger(AiStreamService.name);
  private readonly agent?: ReturnType<typeof createAgent>;

  constructor(
    config: ConfigService,
    private readonly retrieval: RetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly webSearch: WebSearchService,
  ) {
    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      '';
    const baseURL = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const modelName = config.get<string>('LLM_MODEL', 'qwen3.8-flash');
    const enableThinking =
      config.get<string>('LLM_ENABLE_THINKING') !== 'false';

    if (!apiKey) return;

    const llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      streamUsage: false,
      configuration: { baseURL },
      modelKwargs: enableThinking ? { enable_thinking: true } : undefined,
    });

    const search = this.webSearch;
    this.agent = createAgent({
      model: llm,
      tools: [
        tool(
          async (input: { query: string; count?: number }) =>
            search.search(input.query, input.count ?? 5),
          {
            name: 'web_search',
            description:
              '联网搜索（Bocha）。知识库不足、需要最新公开信息或外部资料时再调用。不要用它替代知识库已有内容。',
            schema: z.object({
              query: z.string().min(1).describe('搜索关键词'),
              count: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe('条数，默认 5'),
            }),
          },
        ),
      ],
      systemPrompt: SYSTEM,
      middleware: [
        // 单次对话最多 4 次模型调用，防 web_search 循环打爆；超限正常收流
        modelCallLimitMiddleware({ runLimit: 4, exitBehavior: 'end' }),
      ],
    });
  }

  async streamChat(dto: ChatStreamDto, user: AuthUser, res: Response) {
    const question = lastUserText(dto.messages);
    const topK = dto.topK ?? 5;
    let persistSessionId = dto.sessionId;
    let persistSources: ChatSource[] = [];

    // 归属校验必须在流外：execute 内抛错只会降级成 SSE error 事件（HTTP 200），
    // 出不了 404 语义；流前抛出走全局异常拦截器正常返回
    if (dto.sessionId) {
      await this.sessions.assertOwned(user.userId, dto.sessionId);
    }

    // SDK 只提供协议管线；会话、检索与 Agent 流的编排全在 execute 里
    const stream = createUIMessageStream<KhUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });

        if (!question) {
          writer.write({ type: 'text-start', id: 'empty' });
          writer.write({
            type: 'text-delta',
            id: 'empty',
            delta: '请输入问题。',
          });
          writer.write({ type: 'text-end', id: 'empty' });
          writer.write({ type: 'finish' });
          return;
        }

        // 开场即定会话：归属已在流前校验，这里只负责新建
        const sessionId = dto.sessionId
          ? dto.sessionId
          : (
              await this.sessions.create(user.userId, {
                title: titleFromQuestion(question),
              })
            ).id;
        persistSessionId = sessionId;
        writer.write({
          type: 'data-session',
          data: { sessionId },
        });

        writer.write({
          type: 'data-status',
          data: { stage: 'retrieve', text: '正在检索知识库…' },
        });

        let hits: SearchHit[] = [];
        try {
          hits = await this.retrieval.search({ query: question, topK });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.logger.warn(`RAG 检索失败：${detail}`);
        }

        const sources = this.toSources(hits);
        persistSources = sources;
        writer.write({
          type: 'data-retrieve',
          data: {
            query: question,
            items: sources.map((src) => ({
              index: src.index,
              documentId: src.documentId,
              documentTitle: src.documentTitle,
              heading: src.heading,
            })),
          },
        });
        writer.write({ type: 'data-sources', data: sources });
        for (const src of sources) {
          writer.write({
            type: 'source-document',
            sourceId: src.documentId,
            mediaType: 'text/markdown',
            title: `[${src.index}] ${src.documentTitle}`,
          });
        }

        if (!this.agent) {
          writer.write({
            type: 'error',
            errorText: '未配置 LLM Key，无法生成回答',
          });
          writer.write({ type: 'finish' });
          return;
        }

        const prompt = hits.length
          ? `检索到的资料：\n${this.buildContext(hits)}\n\n用户问题：${question}`
          : `知识库没有召回到相关内容。\n\n用户问题：${question}`;

        const langchainStream = await this.agent.stream(
          { messages: [new HumanMessage(prompt)] },
          // messages：模型 token/思考；tools：web_search 调用，交适配层转 tool-* 事件
          { streamMode: ['messages', 'tools'] },
        );

        writer.merge(
          toUIMessageStream(mapReasoningStream(langchainStream) as never, {
            // 外层 execute 已写 start，finish 由 createUIMessageStream 收口
            sendStart: false,
            sendFinish: false,
            onError: (error) => {
              this.logger.warn(`LangChain 流失败：${error.message}`);
            },
          }) as never,
        );
      },
      onFinish: async ({ responseMessage }) => {
        const parts = responseMessage?.parts ?? [];
        const answer = parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('')
          .trim();
        const used = new Set(
          [...answer.matchAll(CITATION_RE)].map((m) => Number(m[1])),
        );
        const sources = used.size
          ? persistSources.filter((s) => used.has(s.index))
          : [];
        if (!question || !persistSessionId) return;
        try {
          await this.sessions.appendTurn(
            user.userId,
            persistSessionId,
            question,
            answer || '未能生成回答。',
            sources,
          );
        } catch (error) {
          this.logger.warn(
            `流式对话落库失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      onError: (error) =>
        error instanceof Error ? error.message : String(error),
    });

    await pipeUIMessageStreamToResponse({ response: res, stream });
  }

  private toSources(hits: SearchHit[]): ChatSource[] {
    return hits.map((hit, i) => ({
      index: i + 1,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: excerpt(hit.content),
      score: hit.score,
    }));
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

/**
 * 百炼兼容口把思考放在 additional_kwargs.reasoning_content；适配层只认
 * additional_kwargs.reasoning.summary，这里在流上原位改写。
 */
async function* mapReasoningStream(
  stream: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const event of stream) {
    attachDashScopeReasoning(event);
    yield event;
  }
}

/** 递归找 additional_kwargs.reasoning_content 并改写成适配层要的 reasoning.summary；seen 防循环引用 */
function attachDashScopeReasoning(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) attachDashScopeReasoning(item, seen);
    return;
  }
  const obj = value as Record<string, unknown>;
  const kwargs = obj.additional_kwargs as Record<string, unknown> | undefined;
  if (typeof kwargs?.reasoning_content === 'string' && kwargs.reasoning_content) {
    kwargs.reasoning = {
      summary: [{ type: 'summary_text', text: kwargs.reasoning_content }],
    };
  }
  attachDashScopeReasoning(obj.chunk, seen);
  attachDashScopeReasoning(obj.data, seen);
  attachDashScopeReasoning(obj.kwargs, seen);
  attachDashScopeReasoning(obj.messages, seen);
}

function lastUserText(
  messages: ChatStreamDto['messages'] | undefined,
): string {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('');
    return text.trim();
  }
  return '';
}

function titleFromQuestion(question: string) {
  const text = question.replace(/\s+/g, ' ').trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

function excerpt(content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= EXCERPT_LEN) return text;
  return `${text.slice(0, EXCERPT_LEN)}...`;
}
