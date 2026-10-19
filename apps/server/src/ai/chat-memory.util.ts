import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AiMessageEntity } from './entities/ai-message.entity.js';

/** 提取消息纯文本：兼容字符串与多段 content（文本段拼接） */
export function messageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return String(content ?? '').trim();
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part) {
        return String((part as { text?: string }).text ?? '');
      }
      return '';
    })
    .join('')
    .trim();
}

/**
 * 工作消息 = 只保留 user / assistant 原文。
 * 检索资料、思考过程、记忆系统消息都不进短期窗口。
 */
export function isWorkingMessage(message: BaseMessage): boolean {
  return HumanMessage.isInstance(message) || AIMessage.isInstance(message);
}

/** Postgres 会话消息行 → LangChain 消息（空内容跳过） */
export function dbRowsToMessages(rows: AiMessageEntity[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const row of rows) {
    const text = row.content?.trim();
    if (!text) continue;
    if (row.role === 'user') out.push(new HumanMessage(text));
    if (row.role === 'assistant') out.push(new AIMessage(text));
  }
  return out;
}

/**
 * 给检索改写器用的紧凑上下文：最近 4 条，助手只留短摘要，
 * 避免制度原文污染改写后的 query。
 */
export function compactRewriteContext(history: BaseMessage[]): string {
  if (!history.length) return '';
  const lines: string[] = [];
  for (const message of history.slice(-4)) {
    const text = messageText(message);
    if (!text) continue;
    if (HumanMessage.isInstance(message)) {
      lines.push(`用户：${text.slice(0, 200)}`);
    } else if (AIMessage.isInstance(message)) {
      lines.push(`助手：${text.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}
