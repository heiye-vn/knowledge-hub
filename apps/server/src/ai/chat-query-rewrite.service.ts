import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { compactRewriteContext } from './chat-memory.util.js';

const rewriteSchema = z.object({
  standalone_query: z
    .string()
    .describe('可独立检索的一句中文短查询，消解指代和省略，不含寒暄'),
  need_retrieve: z
    .boolean()
    .describe('是否需要查知识库。寒暄、致谢、与制度无关的闲聊为 false'),
});

const REWRITE_PROMPT =
  '你是企业知识库的检索改写器。根据对话把当前问题改写成一条可独立检索的短查询。\n' +
  '\n' +
  '## 要求\n' +
  '- 消解「这个 / 那个 / 谁负责 / 怎么办」等指代，补全省略的主题\n' +
  '- 只保留检索需要的实体、事项、动作，一句中文，尽量不超过 40 字\n' +
  '- 不要编造上文没出现的专有名词、条款号、系统名\n' +
  '- 不要复述助手给出的制度条文、时限、流程细节\n' +
  '- 当前问题已经完整、不依赖上文时，standalone_query 用原问题略作精炼即可\n' +
  '- 寒暄、致谢、与知识库无关 → need_retrieve=false，standalone_query 仍给原问题\n' +
  '- 输出不要解释';

export type RetrieveQueryPlan = {
  query: string;
  needRetrieve: boolean;
};

/**
 * 检索改写（feat-v16）：追问先消解指代再检索。
 *
 * 🟡 与基线实现的分叉：LLM 配置与 ai-chat / ai-stream 同源
 * （LLM_API_KEY → EMBEDDING_API_KEY → OPENAI_API_KEY，LLM_MODEL 统一默认）。
 *
 * 降级：无历史、未配置 LLM 或调用失败 → 原问题直检（needRetrieve=true），
 * 改写是增强不是前置条件，绝不阻断问答。
 */
@Injectable()
export class ChatQueryRewriteService {
  private readonly logger = new Logger(ChatQueryRewriteService.name);
  private readonly rewriter?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof rewriteSchema>>;
  };

  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      '';
    if (!apiKey) return;

    const baseURL = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const modelName = config.get<string>('LLM_MODEL', 'qwen3.8-flash');

    const llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_QUERY_REWRITE_TIMEOUT_MS', 15000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.rewriter =
      llm.withStructuredOutput(rewriteSchema) as ChatQueryRewriteService['rewriter'];
  }

  async rewrite(
    question: string,
    history: BaseMessage[],
  ): Promise<RetrieveQueryPlan> {
    const fallback: RetrieveQueryPlan = { query: question, needRetrieve: true };
    if (!history.length || !this.rewriter) return fallback;

    const context = compactRewriteContext(history);
    if (!context) return fallback;

    try {
      const result = await this.rewriter.invoke([
        new SystemMessage(REWRITE_PROMPT),
        new HumanMessage(`对话：\n${context}\n\n当前问题：${question}`),
      ]);
      const query = result.standalone_query.trim() || question;
      this.logger.log(
        `检索改写：needRetrieve=${result.need_retrieve} query=${query.slice(0, 80)}`,
      );
      return { query, needRetrieve: result.need_retrieve };
    } catch (error) {
      this.logger.warn(
        `检索改写失败，使用原问题：${error instanceof Error ? error.message : error}`,
      );
      return fallback;
    }
  }
}
