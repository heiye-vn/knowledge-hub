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
import { fitMessagesToBudget, isWorkingMessage } from './chat-memory.util.js';

/** List 结构版本：从「整串 JSON 覆盖写」改为「逐条 RPUSH」，旧 key 靠 TTL 自然过期 */
const KEY_STRUCTURE_VERSION = 'v2';

/**
 * 对话短期记忆：Redis 热窗口（feat-v16，feat-v22 改追加写 + 预算闸）。
 *
 * 只存当前会话最近 N 条 user / assistant 原文，不含检索资料、思考过程、
 * 记忆系统消息。miss 或 Redis 故障时由调用方从 Postgres 回填再 save ——
 * Redis 只是热缓存，历史真源仍是 kh_ai_message。
 *
 * 存储为 Redis List：一轮问答用单条 Lua 追加两条并 LTRIM + EXPIRE。
 * 旧实现是「读窗口 → 拼历史 → 整体覆盖写」，两个并发请求会各自基于同一份
 * 过期快照回写，后写者把先写者的轮次整段抹掉；追加写没有这个问题。
 * 代价是追加时算不出全窗口 token，预算收敛挪到读取路径（幂等，晚一轮无害）。
 *
 * 两道容量闸：条数（maxMessages，由 LTRIM 保证）与估算 token
 * （maxEstimatedTokens，读取时收敛）。条数管不住长文本，预算管不住碎消息。
 *
 * 长对话的上下文压缩不在这里做：由 Agent 的 summarizationMiddleware
 * 在运行期折叠，窗口本身仍按条数与预算滑动。
 */
@Injectable()
export class ChatShortMemoryService {
  private readonly logger = new Logger(ChatShortMemoryService.name);
  private readonly ttlSeconds: number;
  private readonly maxMessages: number;
  private readonly maxEstimatedTokens: number;
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
    this.maxEstimatedTokens = Number(
      config.get('CHAT_SHORT_MEMORY_MAX_ESTIMATED_TOKENS', 12000),
    );
    this.keyPrefix = config.get('CHAT_SHORT_MEMORY_KEY_PREFIX', 'kh:chat');
  }

  /** 工作窗口容量：Redis miss 回填 Postgres 时取同样条数 */
  get windowSize() {
    return this.maxMessages;
  }

  /**
   * 命中返回消息；key 不存在、空 List 或 Redis 故障返回 null（调用方回源数据库）。
   *
   * 命中后顺手做一次预算收敛：追加写只保证条数，token 总量要读完才知道，
   * 超限时重写窗口（幂等）。这样模型看到的历史一定在预算内。
   */
  async tryLoad(
    userId: string,
    sessionId: string,
  ): Promise<BaseMessage[] | null> {
    try {
      const raw = await this.redis.listRange(this.key(userId, sessionId));
      if (!raw.length) return null;
      const messages = mapStoredMessagesToChatMessages(
        raw.map((item) => JSON.parse(item) as never),
      ).filter(isWorkingMessage);
      if (!messages.length) return null;

      const fitted = this.fit(messages);
      if (fitted.length !== messages.length) {
        this.logger.log(
          `短期记忆预算收敛：sessionId=${sessionId}, ${messages.length} → ${fitted.length} 条`,
        );
        void this.save(userId, sessionId, fitted);
      }
      return fitted;
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 读取失败，改走数据库：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 应用窗口闸门：先按条数截尾，再按估算 token 预算收紧。
   * 回填路径也要用同一套闸门，否则模型拿到的是未裁剪的历史。
   */
  fit(messages: BaseMessage[]): BaseMessage[] {
    return fitMessagesToBudget(
      messages.filter(isWorkingMessage).slice(-this.maxMessages),
      this.maxEstimatedTokens,
    );
  }

  /**
   * 覆盖写入工作窗口（回填与预算收敛用），返回实际落库的窗口。
   * 调用方拿返回值作为本轮 history，避免「Redis 里裁过、模型看到没裁」的不一致。
   */
  async save(
    userId: string,
    sessionId: string,
    messages: BaseMessage[],
  ): Promise<BaseMessage[]> {
    const working = this.fit(messages);
    try {
      await this.redis.replaceListWindow(
        this.key(userId, sessionId),
        working.map(serializeMessage),
        this.maxMessages,
        this.ttlSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return working;
  }

  /**
   * 一轮问答后只追加本轮两条（不重写整个窗口）。
   * 不需要调用方传 history：共享快照回写正是并发丢轮次的根因。
   */
  async appendTurn(
    userId: string,
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    try {
      await this.redis.appendListWindow(
        this.key(userId, sessionId),
        [
          serializeMessage(new HumanMessage(question)),
          serializeMessage(new AIMessage(answer)),
        ],
        this.maxMessages,
        this.ttlSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 追加失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 删会话时清窗口 */
  async clear(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId, sessionId));
    } catch (error) {
      this.logger.warn(
        `短期记忆 Redis 删除失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private key(userId: string, sessionId: string) {
    return `${this.keyPrefix}:${userId}:${sessionId}:${KEY_STRUCTURE_VERSION}:messages`;
  }
}

/** 单条消息序列化为 StoredMessage JSON，作为 List 的一个元素 */
function serializeMessage(message: BaseMessage): string {
  return JSON.stringify(mapChatMessagesToStoredMessages([message])[0]);
}
