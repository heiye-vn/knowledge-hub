import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AiChatService } from './ai-chat.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatDto } from './dto/chat.dto.js';
import {
  CreateSessionDto,
  QuerySessionDto,
  UpdateSessionDto,
} from './dto/session.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * AI 对话接口（feat-v11 对话 + feat-v13 会话持久化）
 *
 * RAG 混合检索（含 rerank 精排）→ LLM 生成回答 → [n] 引用溯源；
 * feat-v13 起每轮问答写入本人会话（kh_ai_session / kh_ai_message），
 * 支持会话列表、历史消息、重命名与删除（越权统一 404）。
 *
 * 鉴权：全部接口挂 search 权限码（与文档级全文搜索同码）。
 */
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiChat: AiChatService,
    private readonly sessions: ChatSessionService,
  ) {}

  /**
   * RAG 对话：检索 → 生成 → 引用溯源 → 落库本人会话。
   * 传 sessionId 续聊，不传则新建会话并在响应体回传 sessionId。
   */
  @Post('chat')
  @RequirePermission('search')
  chat(@Body() dto: ChatDto, @CurrentUser() user: AuthUser) {
    return this.aiChat.chat(dto.content, dto.topK ?? 5, user, dto.sessionId);
  }

  /** 本人会话分页，最近活跃在前 */
  @Get('sessions')
  @RequirePermission('search')
  listSessions(@Query() query: QuerySessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.pageMine(user.userId, query);
  }

  /** 新建空会话（可先建后聊，也可直接 chat 不传 sessionId 自动建） */
  @Post('sessions')
  @RequirePermission('search')
  createSession(@Body() dto: CreateSessionDto, @CurrentUser() user: AuthUser) {
    return this.sessions.create(user.userId, dto);
  }

  /** 会话历史消息，时间正序 */
  @Get('sessions/:id/messages')
  @RequirePermission('search')
  listMessages(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.listMessages(user.userId, id);
  }

  @Patch('sessions/:id')
  @RequirePermission('search')
  renameSession(
    @Param('id') id: string,
    @Body() dto: UpdateSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.rename(user.userId, id, dto);
  }

  @Delete('sessions/:id')
  @RequirePermission('search')
  removeSession(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.remove(user.userId, id);
  }
}
