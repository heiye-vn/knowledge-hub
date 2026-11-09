import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { messageText } from './chat-memory.util.js';

/**
 * 摘要指令：流式 middleware 与非流式压缩器共用同一段语义。
 * 明确「不要写入知识库条文」，避免摘要本身把文档内容固化成对话事实。
 */
export const HISTORY_SUMMARY_INSTRUCTION =
  '用中文简洁总结对话：话题、已确认结论、待办。不要写入知识库条文。';

/** 摘要输入的硬上限（UTF-8 字节）；超了从最早的消息开始丢 */
const SUMMARY_INPUT_MAX_BYTES = 6000;
/** 单条消息进摘要前的截断长度（字符） */
const SUMMARY_MESSAGE_MAX_CHARS = 800;

/**
 * 历史上下文压缩（feat-v22）。
 *
 * 流式链路由 Agent 的 summarizationMiddleware 在运行期折叠；非流式是
 * 一次性 invoke，没有 agent 循环，因此需要在这里预压缩。两者共用
 * trigger / keep 配置与摘要指令，避免同一个会话在两条接口上表现不一致。
 *
 * 只在消息条数超过 trigger 时触发，短会话零额外调用。
 * 压缩失败退回原始窗口 —— 上下文变长可以接受，问答失败不可接受。
 */
@Injectable()
export class ChatHistoryCompressor {
  private readonly logger = new Logger(ChatHistoryCompressor.name);
  private readonly enabled: boolean;
  private readonly triggerMessages: number;
  private readonly keepMessages: number;
  private readonly compactLlm?: ChatOpenAI;

  constructor(config: ConfigService) {
    this.enabled =
      config.get<string>('CHAT_HISTORY_SUMMARY_ENABLED', 'true') !== 'false';
    this.triggerMessages = Number(
      config.get('CHAT_HISTORY_SUMMARY_TRIGGER_MESSAGES', 12),
    );
    this.keepMessages = Number(
      config.get('CHAT_HISTORY_SUMMARY_KEEP_MESSAGES', 6),
    );

    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      '';
    if (!apiKey) return;

    const baseURL = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    // 摘要用独立实例：temperature 0、不开启 thinking，输出更稳更短
    this.compactLlm = new ChatOpenAI({
      apiKey,
      model: config.get<string>('LLM_MODEL', 'qwen3.8-flash'),
      temperature: 0,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
  }

  /** 供流式 summarizationMiddleware 复用的阈值，保证两条链路同一口径 */
  get trigger() {
    return { messages: this.triggerMessages };
  }

  get keep() {
    return { messages: this.keepMessages };
  }

  /**
   * 超过 trigger 条时把较早的消息折叠成一条摘要 SystemMessage，
   * 保留最近 keep 条原文。未超阈值或压缩失败原样返回。
   */
  async maybeCompress(history: BaseMessage[]): Promise<BaseMessage[]> {
    if (!this.enabled || !this.compactLlm) return history;
    if (history.length <= this.triggerMessages) return history;

    const cut = Math.max(history.length - this.keepMessages, 0);
    const older = history.slice(0, cut);
    const recent = history.slice(cut);
    if (!older.length) return history;

    try {
      const summary = await this.compactLlm.invoke([
        new SystemMessage(HISTORY_SUMMARY_INSTRUCTION),
        new HumanMessage(this.render(older)),
      ]);
      const text =
        typeof summary.content === 'string'
          ? summary.content.trim()
          : JSON.stringify(summary.content);
      if (!text) return history;
      return [
        new SystemMessage(`【历史对话摘要】\n${text}`),
        ...recent,
      ];
    } catch (error) {
      this.logger.warn(
        `历史压缩失败，退回原始窗口：${error instanceof Error ? error.message : String(error)}`,
      );
      return history;
    }
  }

  /**
   * 渲染待摘要消息：从最近往前累加，触顶即停。
   * 从后往前而不是从前往后，是因为更近的历史对「当前在做什么」更重要。
   */
  private render(messages: BaseMessage[]): string {
    const lines: string[] = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const text = messageText(messages[index]).slice(
        0,
        SUMMARY_MESSAGE_MAX_CHARS,
      );
      if (!text) continue;
      const line = `${HumanMessage.isInstance(messages[index]) ? '用户' : '助手'}：${text}`;
      const cost = Buffer.byteLength(line, 'utf8');
      if (lines.length && used + cost > SUMMARY_INPUT_MAX_BYTES) break;
      lines.push(line);
      used += cost;
    }
    return lines.reverse().join('\n');
  }
}
