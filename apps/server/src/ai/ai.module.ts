import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module.js';
import { AiChatService } from './ai-chat.service.js';
import { AiController } from './ai.controller.js';

/**
 * AI 对话模块（feat-v11）
 *
 * 对应基线实现 v11 `ai/ai.module.ts`。rerank 精排内聚在 RagModule
 * （检索链路组件），本模块只承载「检索 → 生成 → 溯源」的对话编排。
 */
@Module({
  imports: [RagModule],
  controllers: [AiController],
  providers: [AiChatService],
})
export class AiModule {}
