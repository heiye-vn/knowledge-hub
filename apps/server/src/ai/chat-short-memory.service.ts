import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import { RedisService } from '../redis/redis.service.js';
import { isWorkingMessage } from './chat-memory.util.js';

/**
 * 对话短期记忆：Redis 热窗口（feat-v16）。
 *
 * 只存当前会话最近 N 条 user / assistant 原文，不含检索资料、思考过程、
 * 记忆系统消息。miss 或 Redis 故障时由调用方从 Postgres 回填再 save ——
 * Redis 只是热缓存，历史真源仍是 kh_ai_message。
 *
 * 长对话的上下文压缩不在这里做：由 Agent 的 summarizationMiddleware
 * 在运行期折叠，窗口本身仍按 maxMessages 滑动。
 */
@Injectable()
export class ChatShortMemoryService {
  private readonly logger = new Logger(ChatShortMemoryService.name);
  private readonly ttlSeconds: number;
  private readonly maxMessages: number;
  private readonly keyPrefix: string;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.ttlSeconds = Number(
      config.get('CHAT_SHORT_MEMORY_TTL_SECONDS', 86400),
    );
    this.maxMessages = Number(
      config.get('CHAT_SHORT_MEMORY_MAX_MESSAGES', 20),
    );
    this.keyPrefix = config.get('CHAT_SHORT_MEMORY_KEY_PREFIX', 'kh:chat');
  }

  /** 工作窗口容量：Redis miss 回填 Postgres 时取同样条数 */
  get windowSize() {
    return this.maxMessages;
  }

  /** 命中返回消息；key 不存在或 Redis 故障返回 null（调用方回源数据库） */
  async tryLoad(
    userId: string,
    sessionId: string,
  ): Promise<BaseMessage[] | null> {
    try {
      const raw = await this.redis.get(this.key(userId, sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      return mapStoredMessagesToChatMessages(parsed).filter(isWorkingMessage);
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 读取失败，改走数据库：${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  /** 覆盖写入工作窗口（只留 user / assistant，末尾 N 条） */
  async save(
    userId: string,
    sessionId: string,
    messages: BaseMessage[],
  ): Promise<void> {
    const working = messages.filter(isWorkingMessage).slice(-this.maxMessages);
    try {
      const payload = JSON.stringify(mapChatMessagesToStoredMessages(working));
      await this.redis.set(this.key(userId, sessionId), payload, this.ttlSeconds);
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 写入失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** 一轮问答落库后回写窗口 */
  async appendTurn(
    userId: string,
    sessionId: string,
    history: BaseMessage[],
    question: string,
    answer: string,
  ): Promise<void> {
    await this.save(userId, sessionId, [
      ...history,
      new HumanMessage(question),
      new AIMessage(answer),
    ]);
  }

  /** 删会话时清窗口 */
  async clear(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId, sessionId));
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 删除失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private key(userId: string, sessionId: string) {
    return `${this.keyPrefix}:${userId}:${sessionId}:messages`;
  }
}
