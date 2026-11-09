import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiChatService } from './ai-chat.service.js';
import { AiStreamService } from './ai-stream.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import { ChatDto } from './dto/chat.dto.js';
import { ChatStreamDto } from './dto/chat-stream.dto.js';
import { QueryMemoryDto } from './dto/memory.dto.js';
import {
  CreateSessionDto,
  QuerySessionDto,
  UpdateSessionDto,
} from './dto/session.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-user.interface.js';

/**
 * AI 对话接口（v11 对话 + v13 会话持久化 + v17 Agentic RAG + v22 记忆治理）
 *
 * 意图路由 → 检索评估 → 不足时改写再查 → 按需联网 → [n] 引用溯源；
 * 每轮问答写入本人会话（kh_ai_session / kh_ai_message），支持会话列表、
 * 历史消息、重命名与删除（越权统一 404）。
 *
 * 记忆治理（feat-v22）：长期记忆可查、可删、可全清。删除单条必须先由
 * 服务层比对 userId（Mem0 的 delete 本身不校验归属），越权与不存在统一 404。
 *
 * 鉴权：全部接口挂 search 权限码（与文档级全文搜索同码）。
 */
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiChat: AiChatService,
    private readonly aiStream: AiStreamService,
    private readonly sessions: ChatSessionService,
    private readonly memory: ChatLongMemoryService,
  ) {}

  /**
   * RAG 对话：Agentic RAG（意图路由 → 检索评估 → 不足改写再查 → 按需联网）。
   * 传 sessionId 续聊，不传则新建会话并在响应体回传 sessionId。
   */
  @Post('chat')
  @RequirePermission('search')
  chat(@Body() dto: ChatDto, @CurrentUser() user: AuthUser) {
    return this.aiChat.chat(
      dto.content,
      dto.topK ?? 5,
      user,
      dto.sessionId,
      dto.mode,
    );
  }

  /**
   * 流式 Agentic RAG：按意图挂载 retrieve_knowledge / rewrite_query / web_search，
   * Agent 自主循环后经 UI Message Stream 协议（SSE）写回；前端 useChat 消费。
   */
  @Post('chat/stream')
  @RequirePermission('search')
  streamChat(
    @Body() dto: ChatStreamDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    return this.aiStream.streamChat(dto, user, res);
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

  /**
   * 我的长期记忆分页。默认查跨会话的 user 层；
   * 传 layer=session 时必须同时给 sessionId，否则返回空页。
   */
  @Get('memory')
  @RequirePermission('search')
  listMemory(@Query() query: QueryMemoryDto, @CurrentUser() user: AuthUser) {
    return this.memory.list(
      user.userId,
      query.layer ?? 'user',
      query.sessionId,
      query.page ?? 1,
      query.pageSize ?? 20,
    );
  }

  /**
   * 删除单条长期记忆。
   * 归属校验在服务层完成（先 get 再比对 userId），越权与不存在统一 404，
   * 不泄漏「这条记忆存在但不是你的」。
   */
  @Delete('memory/:memoryId')
  @RequirePermission('search')
  async removeMemory(
    @Param('memoryId') memoryId: string,
    @CurrentUser() user: AuthUser,
  ) {
    if (!this.memory.enabled) {
      throw new ServiceUnavailableException('长期记忆未启用');
    }
    const removed = await this.memory.remove(user.userId, memoryId);
    if (!removed) {
      throw new NotFoundException('记忆不存在');
    }
    return { message: '已删除' };
  }

  /**
   * 清空我的全部长期记忆（含各会话上下文）。
   *
   * 语义刻意定为「全清」：Mem0 的 deleteAll 无法表达「只删 runId 为空」，
   * 自行分页筛 runId 会因删除导致页码偏移而漏删，不如把语义说清楚。
   */
  @Delete('memory')
  @RequirePermission('search')
  async clearMemory(@CurrentUser() user: AuthUser) {
    if (!this.memory.enabled) {
      throw new ServiceUnavailableException('长期记忆未启用');
    }
    const cleared = await this.memory.clearAll(user.userId);
    if (!cleared) {
      throw new ServiceUnavailableException('长期记忆清理失败，请稍后重试');
    }
    return { message: '已清空全部长期记忆' };
  }
}
