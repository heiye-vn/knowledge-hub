import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { MemoryClient, type Memory } from 'mem0ai';
import { ChatMemoryMirrorService } from './chat-memory-mirror.service.js';

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

export type MemoryLayer = 'user' | 'session';

export type LongMemoryItem = {
  id: string;
  memory: string;
  layer: MemoryLayer;
  createdAt: string | null;
  updatedAt: string | null;
};

export type LongMemoryPage = {
  items: LongMemoryItem[];
  total: number;
  page: number;
  pageSize: number;
};

/** Mem0 的 add 是外部 SaaS 调用，瞬时失败重试一次即可，不再放大重试风暴 */
const WRITE_RETRY_DELAY_MS = 200;

/**
 * 对话长期记忆（feat-v16，feat-v22 加治理）：Mem0 存抽取后的事实，不存聊天原文。
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
 *
 * feat-v22 治理三件套：
 * - 注入闸门：每层条数与字符双上限，防止 user 层永久累积撑爆 prompt；
 * - 写入重试：add 失败退避重试一次，仍失败落 `memory_write_failed` 结构化日志；
 * - 时间衰减：score × exp(-ageDays / halfLife) 重排（默认关闭，平台 decay 优先）。
 */
@Injectable()
export class ChatLongMemoryService {
  private readonly logger = new Logger(ChatLongMemoryService.name);
  private readonly client?: MemoryClient;
  private readonly classifier?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof memorySchema>>;
  };
  private readonly topK: number;
  private readonly injectMaxItems: number;
  private readonly injectMaxChars: number;
  private readonly decayHalfLifeDays: number;

  constructor(
    config: ConfigService,
    private readonly mirror?: ChatMemoryMirrorService,
  ) {
    this.topK = Number(config.get('MEM0_TOP_K', 5));
    this.injectMaxItems = Number(config.get('CHAT_MEMORY_INJECT_MAX_ITEMS', 8));
    this.injectMaxChars = Number(config.get('CHAT_MEMORY_INJECT_MAX_CHARS', 1200));
    // 0 = 关闭本地重排，交给 Mem0 平台 project 级 decay
    this.decayHalfLifeDays = Number(
      config.get('CHAT_MEMORY_DECAY_HALF_LIFE_DAYS', 0),
    );

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
    // 分类能力与存储能力解耦：没有 MEM0_API_KEY 也要能初始化分类器，
    // 否则离线评测（只测判定正确性、不写 Mem0）无法复用线上同一套提示词。
    if (!apiKey) return;

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
    // 开了本地衰减就要更大的候选集，否则重排只在 topK 内部换序，等于没衰减
    const candidateK = this.decayHalfLifeDays > 0 ? this.topK * 2 : this.topK;
    try {
      const userRes = await this.client.search(query, {
        filters: { user_id: userId },
        topK: candidateK,
      });
      const sessionRes = sessionId
        ? await this.client.search(query, {
            filters: {
              AND: [{ user_id: userId }, { run_id: sessionId }],
            },
            topK: candidateK,
          })
        : { results: [] };
      return {
        user: this.textsOf(userRes.results),
        session: this.textsOf(sessionRes.results),
      };
    } catch (error) {
      this.logger.warn(
        `长期记忆检索失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return empty;
    }
  }

  /** 两层记忆拼成系统消息；无命中返回 null */
  buildSystemMessage(hits: LongMemoryHits): SystemMessage | null {
    const blocks = [
      this.formatBlock('【用户长期记忆】', hits.user),
      this.formatBlock('【当前会话记忆】', hits.session),
    ].filter((block): block is string => Boolean(block));
    if (!blocks.length) return null;
    return new SystemMessage(
      `${blocks.join('\n\n')}\n\n以上仅作背景，制度/流程以本轮检索资料为准，不要用记忆替代文档。`,
    );
  }

  /**
   * 记忆分类：本轮是否产生需要跨轮/跨会话保留的事实。
   *
   * 线上写入与离线评测共用此入口，保证评测的就是线上判定口径。
   * 分类器未初始化（缺 LLM Key）时返回 null。
   */
  async classify(
    question: string,
    answer: string,
  ): Promise<z.infer<typeof memorySchema> | null> {
    if (!this.classifier) return null;
    return this.classifier.invoke([
      new SystemMessage(CLASSIFIER_PROMPT),
      new HumanMessage(
        `用户：${question}\n助手（仅供判断，不要当作用户事实）：${answer.slice(0, 300)}`,
      ),
    ]);
  }

  /**
   * 一轮问答后异步抽取事实写入 Mem0。
   * 分类器只从用户提问抽（answer 仅截断后供判断），避免把文档内容当画像。
   * user / session 各自独立重试，user 层失败不阻止 session 层写入。
   */
  async rememberTurn(
    userId: string,
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    if (!this.client || !this.classifier) return;
    const extractFrom = [{ role: 'user' as const, content: question }];

    let decision: z.infer<typeof memorySchema> | null;
    try {
      decision = await this.classify(question, answer);
    } catch (error) {
      this.logger.warn(
        `长期记忆分类失败 sessionId=${sessionId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!decision) return;

    const { write_user, write_session, reason } = decision;
    const addOpts = {
      customInstructions:
        '只用用户说的话抽取记忆，一句完整中文。' +
        '只保存身份、岗位、偏好、约束，或用户声明的本轮任务。' +
        '不要保存制度条文、流程、时限、负责人、系统名、引用编号。' +
        '不要译成英文。',
    };
    const written: string[] = [];
    if (write_user) {
      const created = await this.addWithRetry('user', sessionId, () =>
        this.client!.add(extractFrom, { userId, ...addOpts }),
      );
      if (created) {
        written.push('user');
        // 镜像默认关闭，active 为 false 时内部直接返回
        await this.mirror?.upsert(userId, null, 'user', created);
      }
    }
    if (write_session) {
      const created = await this.addWithRetry('session', sessionId, () =>
        this.client!.add(extractFrom, {
          userId,
          runId: sessionId,
          ...addOpts,
        }),
      );
      if (created) {
        written.push('session');
        await this.mirror?.upsert(userId, sessionId, 'session', created);
      }
    }
    this.logger.log(
      `长期记忆分类：${reason}；写入=${written.join(',') || '无'}`,
    );
  }

  /** 删会话只清会话层，用户层画像保留 */
  async clearSession(userId: string, sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.deleteAll({ userId, runId: sessionId });
      await this.mirror?.removeSession(userId, sessionId);
    } catch (error) {
      this.logger.warn(
        `长期记忆会话层清理失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 单层记忆分页（管理页用）。
   * session 层必须带 sessionId，否则无法定位 runId 过滤条件，返回空页。
   */
  async list(
    userId: string,
    layer: MemoryLayer,
    sessionId: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<LongMemoryPage> {
    const empty: LongMemoryPage = { items: [], total: 0, page, pageSize };
    if (!this.client) return empty;
    const filters =
      layer === 'session'
        ? sessionId
          ? { AND: [{ user_id: userId }, { run_id: sessionId }] }
          : null
        : { user_id: userId };
    if (!filters) return empty;
    try {
      const res = await this.client.getAll({ filters, page, pageSize });
      return {
        items: (res.results ?? []).map((memory) => this.toItem(memory, layer)),
        total: res.count ?? 0,
        page,
        pageSize,
      };
    } catch (error) {
      this.logger.warn(
        `长期记忆列表查询失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return empty;
    }
  }

  /**
   * 删除单条记忆。
   * Mem0 的 delete(memoryId) 不校验归属，必须先 get 再比对 userId，
   * 否则拿到任意 id 就能删别人的记忆。越权与不存在统一返回 false（调用方 404）。
   */
  async remove(userId: string, memoryId: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const memory = await this.client.get(memoryId);
      if (!memory || memory.userId !== userId) return false;
      await this.client.delete(memoryId);
      await this.mirror?.removeByMemoryId(memoryId);
      return true;
    } catch (error) {
      this.logger.warn(
        `长期记忆删除失败 memoryId=${memoryId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * 清空该用户全部长期记忆（含各会话上下文）。
   * 语义刻意定为「全清」：Mem0 的 deleteAll 无法表达「只删 runId 为空」，
   * 自行分页筛 runId 会在删除过程中出现页码偏移漏删，不如把语义说清楚。
   */
  async clearAll(userId: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.deleteAll({ userId });
      await this.mirror?.removeAll(userId);
      return true;
    } catch (error) {
      this.logger.warn(
        `长期记忆全量清理失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /** 每层两道收敛：条数上限 + 字符上限 */
  private formatBlock(title: string, lines: string[]): string | null {
    const usable = lines
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, Math.max(this.injectMaxItems, 1));
    if (!usable.length) return null;

    const rendered: string[] = [];
    let used = 0;
    let truncated = false;
    for (const line of usable) {
      const cost = Buffer.byteLength(line, 'utf8') + 2;
      if (used + cost > this.injectMaxChars) {
        truncated = true;
        break;
      }
      rendered.push(`- ${line}`);
      used += cost;
    }
    // 首条就超限时至少保留它（按字符粗截），否则整块记忆会凭空消失
    if (!rendered.length) {
      rendered.push(`- ${usable[0].slice(0, Math.max(this.injectMaxChars - 2, 1))}`);
      truncated = true;
    }
    if (truncated) rendered.push('- （已截断）');
    return `${title}\n${rendered.join('\n')}`;
  }

  /** 衰减重排后只取 topK 条，转成纯文本 */
  private textsOf(results: Memory[] | undefined): string[] {
    return this.decayRank(results ?? [])
      .slice(0, this.topK)
      .map((memory) => memory.memory ?? memory.data?.memory ?? '')
      .filter((text): text is string => Boolean(text));
  }

  /**
   * 时间衰减重排：rank = score × exp(-ageDays / halfLife)。
   * 缺 score 或缺时间戳的条目保持原始相对顺序排在其后，不做降权猜测。
   */
  private decayRank(results: Memory[]): Memory[] {
    const halfLife = this.decayHalfLifeDays;
    if (!halfLife || halfLife <= 0 || results.length <= 1) return results;
    const now = Date.now();
    return results
      .map((memory, index) => {
        const score = typeof memory.score === 'number' ? memory.score : null;
        const stamp = memory.updatedAt ?? memory.createdAt;
        const time = stamp ? new Date(stamp).getTime() : Number.NaN;
        if (score === null || !Number.isFinite(time)) {
          return { memory, rank: Number.NEGATIVE_INFINITY, index };
        }
        const ageDays = Math.max((now - time) / 86_400_000, 0);
        return { memory, rank: score * Math.exp(-ageDays / halfLife), index };
      })
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
      .map((entry) => entry.memory);
  }

  private toItem(memory: Memory, layer: MemoryLayer): LongMemoryItem {
    return {
      id: memory.id,
      memory: memory.memory ?? memory.data?.memory ?? '',
      layer,
      createdAt: toIso(memory.createdAt),
      updatedAt: toIso(memory.updatedAt),
    };
  }

  /**
   * add 失败退避重试一次；仍失败落结构化日志供告警聚合。
   * 成功时返回 Mem0 落库条目（含 memory id），供本地镜像同步；
   * 本轮记忆放弃也不影响问答 —— 记忆是派生数据。
   */
  private async addWithRetry(
    layer: MemoryLayer,
    sessionId: string,
    run: () => Promise<Memory[]>,
  ): Promise<Memory[] | null> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 2) {
          this.logger.warn(
            `memory_write_failed layer=${layer} sessionId=${sessionId} attempt=${attempt} error=${message}`,
          );
          return null;
        }
        this.logger.warn(
          `长期记忆写入失败（${layer} 层），${WRITE_RETRY_DELAY_MS}ms 后重试：${message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_DELAY_MS));
      }
    }
    return null;
  }
}

/** Mem0 的日期字段可能是 Date 或 ISO 字符串，统一成 ISO；非法值返回 null */
function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
