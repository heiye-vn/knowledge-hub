import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id.js';
import { AiSessionEntity } from './entities/ai-session.entity.js';
import { AiMessageEntity } from './entities/ai-message.entity.js';
import type { ChatSource } from './chat.types.js';
import {
  CreateSessionDto,
  QuerySessionDto,
  UpdateSessionDto,
} from './dto/session.dto.js';

const DEFAULT_TITLE = '新对话';
const TITLE_MAX_LEN = 80;
const AUTO_TITLE_LEN = 30;

/**
 * AI 会话服务（feat-v13）：会话 CRUD + 一轮问答落库。
 *
 * 所有权收敛在 getOwned：查询条件同时带 id 与 userId，
 * 越权访问与不存在统一 404（不泄漏「会话存在但不是你的」）。
 *
 * 🟡 与基线实现的分叉：
 * - 删除会话不先删消息：kh_ai_message 外键 ON DELETE CASCADE，
 *   库里一条 DELETE 即可（基线在应用层手动删两表）。
 * - appendTurn 的落库为尽力而为：会话写入失败只记日志不抛错，
 *   回答已经生成，不能因持久化故障让用户拿不到答案（基线直接向上抛）。
 */
@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
  ) {}

  /** 本人的会话分页，最近活跃在前 */
  async pageMine(userId: string, query: QuerySessionDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const [items, total] = await this.em.findAndCount(AiSessionEntity, {
      where: { userId },
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { items, total, page, pageSize };
  }

  /** 新建空会话；未传标题用默认名（首轮问答时会自动覆盖） */
  async create(userId: string, dto: CreateSessionDto) {
    const title =
      (dto.title?.trim() || DEFAULT_TITLE).slice(0, TITLE_MAX_LEN);
    const session = this.em.create(AiSessionEntity, {
      id: nextSnowflakeId(),
      userId,
      title,
    });
    return this.em.save(session);
  }

  async rename(userId: string, id: string, dto: UpdateSessionDto) {
    const session = await this.getOwned(userId, id);
    session.title = dto.title.trim().slice(0, TITLE_MAX_LEN);
    return this.em.save(session);
  }

  /** 删除会话；消息经外键级联清理 */
  async remove(userId: string, id: string) {
    const session = await this.getOwned(userId, id);
    await this.em.remove(session);
    return { message: '已删除' };
  }

  /** 会话历史消息，时间正序（同毫秒并发时按 ID 兜底） */
  async listMessages(userId: string, sessionId: string) {
    await this.getOwned(userId, sessionId);
    return this.em.find(AiMessageEntity, {
      where: { sessionId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * 一轮问答落库：无 sessionId 则新建会话；标题仍是默认名时用首问覆盖。
   * 返回会话（含最终 id），供响应体回传 sessionId 供前端续聊。
   */
  async appendTurn(
    userId: string,
    sessionId: string | undefined,
    question: string,
    answer: string,
    sources: ChatSource[],
  ): Promise<AiSessionEntity> {
    const session = sessionId
      ? await this.getOwned(userId, sessionId)
      : await this.create(userId, { title: titleFromQuestion(question) });

    if (session.title === DEFAULT_TITLE) {
      session.title = titleFromQuestion(question);
    }
    session.updatedAt = new Date();
    await this.em.save(session);

    const userMsg = this.em.create(AiMessageEntity, {
      id: nextSnowflakeId(),
      sessionId: session.id,
      role: 'user',
      content: question,
    });
    const assistantMsg = this.em.create(AiMessageEntity, {
      id: nextSnowflakeId(),
      sessionId: session.id,
      role: 'assistant',
      content: answer,
      sources: sources.length ? sources : null,
    });
    await this.em.save([userMsg, assistantMsg]);
    return session;
  }

  /** 越权与不存在统一 404，查询条件同时带 id 与 userId */
  private async getOwned(userId: string, id: string) {
    const session = await this.em.findOne(AiSessionEntity, {
      where: { id, userId },
    });
    if (!session) {
      throw new NotFoundException('会话不存在');
    }
    return session;
  }
}

/** 首问生成会话标题：压缩空白后截 30 字 */
function titleFromQuestion(question: string) {
  const text = question.replace(/\s+/g, ' ').trim();
  if (!text) return DEFAULT_TITLE;
  return text.length > AUTO_TITLE_LEN
    ? `${text.slice(0, AUTO_TITLE_LEN)}…`
    : text;
}
