import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { ChatLongMemoryService } from '../chat-long-memory.service.js';
import {
  evaluateMemoryCases,
  formatMemoryEvalSummary,
  type MemoryCase,
  type MemoryPrediction,
} from './memory-eval.js';

/**
 * 记忆抽取离线评测（feat-v22）。
 *
 * 只跑分类器，不写 Mem0、不建会话、不检索知识库 —— 评定的是「判定口径」，
 * 不是存储链路。分类器与存储已在 ChatLongMemoryService 内解耦，因此
 * 没有 MEM0_API_KEY 也能跑，只需要 LLM Key。
 *
 * 核心指标是「陷阱样本误写数」：把知识库条文 / 助手结论写成用户画像。
 * 这是红线，非 0 即退出码 1 —— 画像一旦被文档内容污染，后续所有轮次
 * 都会把它当用户事实注入，且用户无从察觉。
 *
 * 运行：pnpm eval:memory（在仓库根目录，cwd 落到 apps/server）
 */

type MemoryDataset = {
  name: string;
  description: string;
  cases: MemoryCase[];
};

/** 只读 .env 补充缺失项，不覆盖已有环境变量（与 eval:rag 同语义） */
function loadDotEnv(): void {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentStart = value.indexOf(' #');
      if (commentStart !== -1) value = value.slice(0, commentStart).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function flag(value: boolean): string {
  return value ? 'true' : 'false';
}

async function main(): Promise<void> {
  loadDotEnv();
  const datasetPath = resolve(
    process.cwd(),
    'eval/datasets/memory-extraction-20.json',
  );
  const dataset = JSON.parse(
    readFileSync(datasetPath, 'utf8'),
  ) as MemoryDataset;

  const service = new ChatLongMemoryService({
    get: (key: string, fallback?: unknown) => process.env[key] ?? fallback,
  } as unknown as ConfigService);

  const predictions: MemoryPrediction[] = [];
  for (const item of dataset.cases) {
    try {
      const result = await service.classify(item.question, item.answerSnippet);
      if (!result) {
        console.error(
          '分类器未初始化：缺少 LLM_API_KEY（或 LLM_BASE_URL / LLM_MODEL 配置有误）',
        );
        process.exitCode = 1;
        return;
      }
      predictions.push({
        writeUser: result.write_user,
        writeSession: result.write_session,
        reason: result.reason,
      });
    } catch (error) {
      console.error(
        `第 ${item.id} 条分类调用失败：${error instanceof Error ? error.message : error}`,
      );
      console.error(
        '请检查 LLM_API_KEY 是否有效、LLM_BASE_URL / LLM_MODEL 是否与供应商匹配。',
      );
      process.exitCode = 1;
      return;
    }
  }

  const summary = evaluateMemoryCases(dataset.cases, predictions);
  console.log(`\n=== 记忆抽取评测：${dataset.name} ===`);
  console.log(formatMemoryEvalSummary(summary));

  if (summary.failures.length) {
    console.log('\n不一致样本：');
    for (const failure of summary.failures) {
      console.log(
        `- ${failure.id} [${failure.tag}] 期望 user=${flag(failure.expected.writeUser)} session=${flag(failure.expected.writeSession)}` +
          `｜实际 user=${flag(failure.predicted.writeUser)} session=${flag(failure.predicted.writeSession)}` +
          `｜理由：${failure.predicted.reason ?? '-'}`,
      );
    }
  } else {
    console.log('\n所有样本判定与期望一致。');
  }

  if (summary.trapViolations > 0) {
    console.error(
      '\n存在知识库/助手事实被写入用户画像，评测不通过（红线指标非 0）。',
    );
    process.exitCode = 1;
  }
}

void main();
