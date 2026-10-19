import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { MemoryClient } from 'mem0ai';

const memorySchema = z.object({
  write_user: z
    .boolean()
    .describe(
      '写入用户层：换会话仍应保留的身份、岗位、回答偏好、长期约束。不含本轮任务、不含知识库条文。',
    ),
  write_session: z
    .boolean()
    .describe('写入会话层：仅当前会话的任务、进度、待办、临时约定。'),
  reason: z.string().describe('分类理由，一句话'),
});

const CLASSIFIER_PROMPT =
  '你是企业知识库助手的记忆分类器。判断本轮是否有「新事实」要写入长期记忆。\n' +
  '\n' +
  '## user 层（跨会话）\n' +
  '- 用户身份、岗位、所在团队自称\n' +
  '- 长期偏好：答短一点、只要本团队制度、技术回答带示例\n' +
  '- 持久约束：过敏、语言、称呼\n' +
  '\n' +
  '## session 层（仅当前会话）\n' +
  '- 正在排查的问题、本次要写的文档、已确认的下一步\n' +
  '- 用户说「这次」「本轮」的工作上下文\n' +
  '\n' +
  '## 均不写入\n' +
  '- 寒暄、致谢、纯确认\n' +
  '- 助手根据知识库/检索资料说出的制度、流程、负责人、系统名（那是文档事实，不是用户记忆）\n' +
  '- 联网搜索结果、引用编号 [n]\n' +
  '- 无信息增量的复述\n' +
  '\n' +
  '## 原则\n' +
  '1. 知识库内容永远不要写成 user 记忆\n' +
  '2. 「这次先看差旅制度第三节」→ session，不要标成 user\n' +
  '3. user 与 session 可同时为 true\n' +
  '4. 一次性提问且未产生需跨轮记住的约定 → 均为 false';

export type LongMemoryHits = {
  user: string[];
  session: string[];
};

/**
 * 对话长期记忆（feat-v16）：Mem0 存抽取后的事实，不存聊天原文。
 *
 * 两层归属：user 层跨会话保留（身份/岗位/偏好/约束），session 层以
 * runId=sessionId 隔离（本轮任务/进度/待办）；删会话只清会话层。
 *
 * 写入边界（分类器 + customInstructions 双重约束）：只从用户提问抽事实，
 * 助手依据检索资料说出的制度、流程、人名、系统名一律不写 —— 知识库内容
 * 不是用户画像。
 *
 * 降级：未配置 MEM0_API_KEY 或分类器 LLM 不可用时全部跳过，
 * 问答链路不感知；检索/写入失败只告警，不影响当轮回答。
 */
@Injectable()
export class ChatLongMemoryService {
  private readonly logger = new Logger(ChatLongMemoryService.name);
  private readonly client?: MemoryClient;
  private readonly classifier?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof memorySchema>>;
  };
  private readonly topK: number;

  constructor(config: ConfigService) {
    this.topK = Number(config.get('MEM0_TOP_K', 5));
    const mem0Key = config.get<string>('MEM0_API_KEY') || '';
    const host = config.get<string>('MEM0_HOST') || undefined;
    if (mem0Key) {
      this.client = new MemoryClient({
        apiKey: mem0Key,
        ...(host ? { host } : {}),
      });
    } else {
      this.logger.warn('未配置 MEM0_API_KEY，跳过长期记忆');
    }

    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      '';
    if (!apiKey || !this.client) return;

    const baseURL = config.get<string>(
      'LLM_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const modelName = config.get<string>('LLM_MODEL', 'qwen3.8-flash');

    // 分类是结构化输出，关思考更容易稳
    const llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.classifier = llm.withStructuredOutput(
      memorySchema,
    ) as ChatLongMemoryService['classifier'];
  }

  get enabled() {
    return Boolean(this.client);
  }

  /** 按当前问题检索两层记忆；失败返回空（记忆只作背景，不阻断问答） */
  async search(
    userId: string,
    sessionId: string | undefined,
    query: string,
  ): Promise<LongMemoryHits> {
    const empty: LongMemoryHits = { user: [], session: [] };
    if (!this.client) return empty;
    try {
      const userRes = await this.client.search(query, {
        filters: { user_id: userId },
        topK: this.topK,
      });
      const sessionRes = sessionId
        ? await this.client.search(query, {
            filters: {
              AND: [{ user_id: userId }, { run_id: sessionId }],
            },
            topK: this.topK,
          })
        : { results: [] };
      return {
        user: (userRes.results ?? [])
          .map((m) => m.memory)
          .filter((text): text is string => Boolean(text)),
        session: (sessionRes.results ?? [])
          .map((m) => m.memory)
          .filter((text): text is string => Boolean(text)),
      };
    } catch (error) {
      this.logger.warn(
        `长期记忆检索失败：${error instanceof Error ? error.message : error}`,
      );
      return empty;
    }
  }

  /** 两层记忆拼成系统消息；无命中返回 null */
  buildSystemMessage(hits: LongMemoryHits): SystemMessage | null {
    const blocks: string[] = [];
    if (hits.user.length) {
      blocks.push(
        `【用户长期记忆】\n${hits.user.map((line) => `- ${line}`).join('\n')}`,
      );
    }
    if (hits.session.length) {
      blocks.push(
        `【当前会话记忆】\n${hits.session.map((line) => `- ${line}`).join('\n')}`,
      );
    }
    if (!blocks.length) return null;
    return new SystemMessage(
      `${blocks.join('\n\n')}\n\n以上仅作背景，制度/流程以本轮检索资料为准，不要用记忆替代文档。`,
    );
  }

  /**
   * 一轮问答后异步抽取事实写入 Mem0。
   * 分类器只从用户提问抽（answer 仅截断后供判断），避免把文档内容当画像。
   */
  async rememberTurn(
    userId: string,
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    if (!this.client || !this.classifier) return;
    const extractFrom = [{ role: 'user' as const, content: question }];
    try {
      const { write_user, write_session, reason } =
        await this.classifier.invoke([
          new SystemMessage(CLASSIFIER_PROMPT),
          new HumanMessage(
            `用户：${question}\n助手（仅供判断，不要当作用户事实）：${answer.slice(0, 300)}`,
          ),
        ]);

      const written: string[] = [];
      const addOpts = {
        customInstructions:
          '只用用户说的话抽取记忆，一句完整中文。' +
          '只保存身份、岗位、偏好、约束，或用户声明的本轮任务。' +
          '不要保存制度条文、流程、时限、负责人、系统名、引用编号。' +
          '不要译成英文。',
      };
      if (write_user) {
        await this.client.add(extractFrom, { userId, ...addOpts });
        written.push('user');
      }
      if (write_session) {
        await this.client.add(extractFrom, {
          userId,
          runId: sessionId,
          ...addOpts,
        });
        written.push('session');
      }
      this.logger.log(
        `长期记忆分类：${reason}；写入=${written.join(',') || '无'}`,
      );
    } catch (error) {
      this.logger.warn(
        `长期记忆写入失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** 删会话只清会话层，用户层画像保留 */
  async clearSession(userId: string, sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.deleteAll({ userId, runId: sessionId });
    } catch (error) {
      this.logger.warn(
        `长期记忆会话层清理失败：${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
