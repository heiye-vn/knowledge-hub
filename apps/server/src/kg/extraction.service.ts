import { ChatOpenAI } from '@langchain/openai';
import { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  KgExtractionLlmOutput,
  buildExtractionSystemPrompt,
  kgExtractionResultSchema,
  normalizeEntityType,
  normalizeRelationType,
} from './constants/kg-schema.js';
import type { ExtractionResult } from './types/kg.types.js';

/** 单个 chunk 的抽取输入 */
export interface ExtractionInput {
  chunkId: string;
  content: string;
  heading?: string | null;
}

/** 抽取结果；失败时 error 有值且 entities/relations 为空 */
export interface ExtractionOutcome {
  chunkId: string;
  result: ExtractionResult;
  error?: string;
}

/** 送进 LLM 的正文上限（防超上下文，基线实现同为 4000） */
const MAX_CONTENT_CHARS = 4000;

/**
 * 实体名匹配 key：NFKC 规范化 + 去空白 + 小写。
 * NFKC 会把「⼯」(U+2F2F) 这类兼容字符折叠成「工」(U+5DE5)，
 * 解决 LLM 在实体与关系里用不同字形导致关系被误杀的问题。
 */
function entityKey(raw: string): string {
  return raw.trim().normalize('NFKC').toLowerCase();
}

/**
 * 实体 / 关系抽取服务（KG 建图的 LLM 环节）
 *
 * 对应基线实现 v5 `pipeline/extraction.service.ts`。
 *
 * 🟡 与基线实现的分叉：
 * - **Key 回退链**：`LLM_API_KEY` → `EMBEDDING_API_KEY` → `OPENAI_API_KEY`。
 *   百炼的 chat 与 embedding 共用同一个 Key，不强制再配一个。
 * - **提供 `extractBatch` + 并发度**：基线实现是串行逐块调用，
 *   100 块的文档就是 100 次串行 LLM 请求（分钟级）。这里按 `KG_EXTRACT_CONCURRENCY` 并发。
 * - **关系可引用文档级实体池**：基线实现要求 source/target 必须在**同一块**的实体集合内，
 *   跨块 / 跨段的关系建不起来；这里放宽为「已出现过的实体即可」。
 *
 * 降级：未配置 Key 时 `isConfigured()` 为 false，抽取阶段报错但不阻断应用启动。
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  /** 单 chunk 最多实体数，防止图爆炸 */
  private readonly maxEntities: number;
  private readonly maxRelations: number;
  private readonly concurrency: number;
  private structuredLlm: Runnable<
    BaseLanguageModelInput,
    KgExtractionLlmOutput
  > | null = null;
  /** 未配置 Key 时的原因，供日志与接口提示 */
  private readonly unavailableReason: string | null;

  constructor(private readonly config: ConfigService) {
    // 实测 qwen-plus 单块产出 24–38 个实体 / 20+ 条关系（见 test/fixtures 实测），
    // 上限设 12 会大量触发截断。默认取 30 与真实产出一个量级。
    this.maxEntities = Number(config.get('KG_MAX_ENTITIES', 30));
    this.maxRelations = Number(config.get('KG_MAX_RELATIONS', 30));
    this.concurrency = Math.max(
      1,
      Number(config.get('KG_EXTRACT_CONCURRENCY', 3)),
    );

    const apiKey =
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('OPENAI_API_KEY') ||
      '';

    if (!apiKey) {
      this.unavailableReason =
        '未配置 LLM_API_KEY / EMBEDDING_API_KEY / OPENAI_API_KEY';
      return;
    }
    this.unavailableReason = null;

    const baseUrl =
      config.get<string>('LLM_BASE_URL') ||
      config.get<string>('EMBEDDING_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const model = config.get<string>('LLM_MODEL') || 'qwen-plus';
    const timeout = Number(config.get('KG_LLM_TIMEOUT_MS', 60000));
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 60000;

    const llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.1,
      timeout: timeoutMs,
      // 抽取失败由上层（BullMQ 重试 / 跳过该块）处理，SDK 层不重试避免放大耗时
      maxRetries: 0,
      configuration: { baseURL: baseUrl },
    });

    this.structuredLlm = llm.withStructuredOutput(kgExtractionResultSchema, {
      name: 'extract_knowledge_graph',
    });
  }

  /** 是否配置了可用的 LLM */
  isConfigured(): boolean {
    return this.structuredLlm !== null;
  }

  /** 不可用时给出原因，避免调用方只看到一句「抽取失败」 */
  getUnavailableReason(): string | null {
    return this.unavailableReason;
  }

  /**
   * 对单个 chunk 抽取
   * @param knownEntities 文档级实体池；传入后允许关系引用前面块已抽到的实体
   */
  async extract(
    content: string,
    heading: string | null | undefined,
    documentTitle: string,
    knownEntities?: Set<string>,
  ): Promise<ExtractionResult> {
    if (!content?.trim()) return { entities: [], relations: [] };
    if (!this.structuredLlm) {
      throw new Error(`KG 抽取不可用：${this.unavailableReason}`);
    }

    const system = buildExtractionSystemPrompt(
      this.maxEntities,
      this.maxRelations,
    );
    const user = `文档标题: ${documentTitle}\n章节: ${heading ?? '无'}\n\n内容:\n${content.slice(0, MAX_CONTENT_CHARS)}`;

    const started = Date.now();
    const parsed = await this.structuredLlm.invoke([
      new SystemMessage(system),
      new HumanMessage(user),
    ]);
    const result = this.normalize(parsed, knownEntities);
    this.logger.log(
      `KG 抽取完成：elapsed=${Date.now() - started}ms, chars=${content.length}, ` +
        `raw=${parsed.entities?.length ?? 0}实体/${parsed.relations?.length ?? 0}关系, ` +
        `kept=${result.entities.length}实体/${result.relations.length}关系`,
    );

    return result;
  }

  /** 当前是否允许并发抽取 */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * 批量抽取（受并发度限制）。单块失败**不中断**其余块，错误随该块返回。
   *
   * 【易错】基线实现单块失败只打日志并塞空结果，调用方无法区分「这篇文档本来就没实体」
   * 和「LLM 挂了导致整篇没抽到」。这里把 error 一并返回，由上层决定是否重试。
   */
  async extractBatch(
    inputs: ExtractionInput[],
    documentTitle: string,
  ): Promise<ExtractionOutcome[]> {
    if (!inputs.length) return [];
    if (!this.structuredLlm) {
      const reason = this.unavailableReason ?? '未知原因';
      return inputs.map((i) => ({
        chunkId: i.chunkId,
        result: { chunkId: i.chunkId, entities: [], relations: [] },
        error: `KG 抽取不可用：${reason}`,
      }));
    }

    // 文档级实体池：一边抽一边累积，后面的块可以直接引用前面块抽到的实体。
    // 【易错】若只在最后用完整池「补救」，关系在第一次归一化时就已被丢弃，补不回来。
    const knownEntities = new Set<string>();
    const outcomes: ExtractionOutcome[] = Array.from({
      length: inputs.length,
    });
    let cursor = 0;

    const worker = async () => {
      while (cursor < inputs.length) {
        const index = cursor++;
        const input = inputs[index];
        try {
          const result = await this.extract(
            input.content,
            input.heading,
            documentTitle,
            knownEntities,
          );
          for (const e of result.entities) knownEntities.add(e.name);
          outcomes[index] = { chunkId: input.chunkId, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `KG 抽取失败：documentTitle=${documentTitle}, chunkId=${input.chunkId}, ${message}`,
          );
          outcomes[index] = {
            chunkId: input.chunkId,
            result: { chunkId: input.chunkId, entities: [], relations: [] },
            error: message,
          };
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, inputs.length) }, worker),
    );

    return outcomes;
  }

  /**
   * 归一化 LLM 输出：截断数量、规范类型、丢弃挂空实体的关系。
   * 公开以便单测覆盖（无需真实 LLM）。
   */
  normalize(
    parsed: KgExtractionLlmOutput,
    knownEntities?: Set<string>,
  ): ExtractionResult {
    // ① 先建**全量**实体池（不截断、按规范化 key 去重）
    // 🔴 修基线实现（及本实现初版）的顺序 bug：
    // 若先按 KG_MAX_ENTITIES 截断再校验关系，引用「第 N 个之后实体」的关系会被整片误杀。
    // 实测 qwen-plus 单块产出 24–40 个实体，而默认上限曾为 12 —— 结果就是关系数归 0。
    //
    // 🔴 修第二个坑：**同形异码**。实测样本里出现过「全体员⼯」（⼯ = U+2F2F 兼容字符），
    // 而关系里可能写成「员工」（工 = U+5DE5）。直接字符串比对会匹配不上、关系被丢弃。
    // 这里用 NFKC 规范化 + 小写作为匹配 key，并把关系端点回填为实体的规范名。
    const allEntities: ExtractionResult['entities'] = [];
    /** 规范化 key → 实体规范名 */
    const canonical = new Map<string, string>();

    for (const e of parsed.entities ?? []) {
      const name = (e.name ?? '').trim();
      if (!name) continue;
      const key = entityKey(name);
      if (canonical.has(key)) continue; // 同形异码去重
      canonical.set(key, name);
      allEntities.push({
        name,
        type: normalizeEntityType(e.type),
        description: (e.description ?? '').trim(),
        aliases: (e.aliases ?? [])
          .map((a) => String(a).trim())
          .filter(Boolean),
      });
    }

    if (knownEntities) {
      for (const name of knownEntities) {
        const key = entityKey(name);
        if (!canonical.has(key)) canonical.set(key, name);
      }
    }

    // ② 关系用全量池校验，不会因实体截断而丢；端点回填规范名，保证 Neo4j MATCH 得到
    const relations: ExtractionResult['relations'] = [];
    for (const r of (parsed.relations ?? []).slice(0, this.maxRelations)) {
      const source = canonical.get(entityKey(r.source ?? ''));
      const target = canonical.get(entityKey(r.target ?? ''));
      if (!source || !target) continue;
      relations.push({
        source,
        target,
        relation: normalizeRelationType(r.relation ?? r.type),
        weight: typeof r.weight === 'number' ? r.weight : 0.5,
      });
    }

    // ③ 实体写入上限仍生效，但被保留关系引用到的实体**必须补回来**，
    //    否则 Neo4j 侧 MATCH 不到节点，关系会静默写不进去。
    const referenced = new Set<string>();
    for (const r of relations) {
      referenced.add(r.source);
      referenced.add(r.target);
    }
    const entities = allEntities.filter(
      (e, i) => i < this.maxEntities || referenced.has(e.name),
    );

    return { entities, relations };
  }

}
