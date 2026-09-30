import { Body, Controller, Post } from '@nestjs/common';
import { AiChatService } from './ai-chat.service.js';
import { ChatDto } from './dto/chat.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';

/**
 * AI 对话接口（feat-v11）
 *
 * RAG 混合检索（含 rerank 精排）→ LLM 生成回答 → [n] 引用溯源。
 * 对应基线实现 v11 `ai/ai.controller.ts` 的 POST /ai/chat；
 * 只做检索不生成的接口是 rag/search.controller 的 POST /search（本项目分叉，见 reference-mapping）。
 *
 * 鉴权：search 权限码（与文档级全文搜索同码，基线 v11 同款）。
 */
@Controller('ai')
export class AiController {
  constructor(private readonly aiChat: AiChatService) {}

  /** RAG 对话：检索 → 生成 → 引用溯源（同步返回，SSE 版后续讲次再做） */
  @Post('chat')
  @RequirePermission('search')
  chat(@Body() dto: ChatDto) {
    return this.aiChat.chat(dto.content, dto.topK ?? 5);
  }
}
