import { Module } from '@nestjs/common';
import { RagModule } from '../rag/rag.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { AiChatService } from './ai-chat.service.js';
import { AiStreamService } from './ai-stream.service.js';
import { ChatSessionService } from './chat-session.service.js';
import { ChatShortMemoryService } from './chat-short-memory.service.js';
import { ChatLongMemoryService } from './chat-long-memory.service.js';
import { ChatQueryRewriteService } from './chat-query-rewrite.service.js';
import { WebSearchService } from './web-search.service.js';
import { AiController } from './ai.controller.js';

/**
 * AI 对话模块（feat-v11 对话 + feat-v13 会话持久化 + feat-v14 流式 + feat-v16 双层记忆）
 *
 * 对应基线实现 v11/v13/v14/v16 `ai/ai.module.ts`。rerank 精排内聚在 RagModule
 * （检索链路组件），本模块承载「检索 → 生成 → 溯源」的对话编排
 * 与会话/消息的持久化、短期/长期记忆与检索改写；流式版经 UI Message Stream
 * 协议输出，web_search 工具无 Key 时自动降级为纯知识库问答。
 *
 * 短期记忆复用全局薄封装的 RedisService（RedisModule 非全局，需显式导入）。
 */
@Module({
  imports: [RagModule, RedisModule],
  controllers: [AiController],
  providers: [
    AiChatService,
    AiStreamService,
    ChatSessionService,
    ChatShortMemoryService,
    ChatLongMemoryService,
    ChatQueryRewriteService,
    WebSearchService,
  ],
})
export class AiModule {}
