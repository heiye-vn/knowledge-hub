import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module.js';
import { AiChatService } from './ai-chat.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { AiController } from './ai.controller.js';

/**
 * AI 对话模块（feat-v11 对话 + feat-v13 会话持久化）
 *
 * 对应基线实现 v11/v13 `ai/ai.module.ts`。rerank 精排内聚在 RagModule
 * （检索链路组件），本模块承载「检索 → 生成 → 溯源」的对话编排
 * 与会话/消息的持久化。
 */
@Module({
  imports: [RagModule],
  controllers: [AiController],
  providers: [AiChatService, ChatSessionService],
})
export class AiModule {}
