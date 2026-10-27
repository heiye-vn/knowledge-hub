import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  Logger,
  type INestApplicationContext,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LangfuseClient } from '@langfuse/client';
import { AppModule } from '../../app.module.js';
import { AiStreamService } from '../ai-stream.service.js';
import { RoleCode } from '../../common/constants/roles.js';
import type { AuthUser } from '../../auth/auth-user.interface.js';
import {
  isLangfuseEnabled,
  isTraceContentEnabled,
  startLangfuseTracing,
  shutdownLangfuseTracing,
} from '../../observability/langfuse.js';
import { loadGoldenDataset, type LoadedDataset } from './dataset-loader.js';
import {
  buildExperimentData,
  toExperimentOutput,
} from './experiment-privacy.js';
import {
  BASE_EVALUATORS,
  runEvaluators,
  type EvalArgs,
  type EvalScore,
} from './evaluators.js';
import {
  buildExperimentReport,
  compareReports,
  type ExperimentReport,
} from './experiment-report.js';
import type { ChatEvalSnapshot, GoldenItem } from './eval.types.js';

const logger = new Logger('EvalRag');

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function evalUser(item: GoldenItem): AuthUser {
  if (item.metadata.access === 'restricted') {
    const userId = process.env.EVAL_ACL_USER_ID?.trim();
    if (!userId) throw new Error('restricted 用例缺少 EVAL_ACL_USER_ID');
    return {
      userId,
      username: 'eval-restricted',
      roles: [RoleCode.USER],
      permissions: [],
      teamIds: (process.env.EVAL_ACL_TEAM_IDS ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }
  return {
    userId: process.env.EVAL_USER_ID?.trim() || 'eval-admin',
    username: 'eval',
    roles: [RoleCode.ADMIN],
    permissions: [],
    teamIds: [],
  };
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    }).trim();
  } catch {
    return 'unknown';
  }
}

async function selectDataset(): Promise<LoadedDataset> {
  const filter = process.env.EVAL_FILTER?.trim();
  const dataset = await loadGoldenDataset();
  return {
    ...dataset,
    items: filter
      ? dataset.items.filter(
          (item) =>
            item.metadata.id === filter || item.metadata.suite === filter,
        )
      : dataset.items,
  };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await run(items[index], index);
      }
    },
  );
  await Promise.all(workers);
}

async function main(): Promise<void> {
  loadDotEnv();
  startLangfuseTracing();

  let app: INestApplicationContext | undefined;
  let langfuse: LangfuseClient | undefined;
  try {
    const context = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });
    app = context;
    const stream = context.get(AiStreamService);
    const dataset = await selectDataset();
    const items = dataset.items;
    if (!items.length) throw new Error('EVAL_FILTER 没有匹配任何用例');
    logger.log(
      `数据集：version=${dataset.version}, source=${dataset.source}, cases=${items.length}`,
    );
    const concurrency = Math.max(
      1,
      Number(process.env.EVAL_CONCURRENCY ?? 2) || 2,
    );
    const outputs = new Map<string, ChatEvalSnapshot>();
    const scores = new Map<string, EvalScore[]>();

    const runItem = async (item: GoldenItem) => {
      const id = item.metadata.id;
      logger.log(`评测：${id} ${item.input.question}`);
      const output = await stream.runForEval(
        item.input.question,
        5,
        evalUser(item),
        'hybrid',
      );
      const args: EvalArgs = {
        input: item.input,
        output,
        expectedOutput: item.expectedOutput,
      };
      const itemScores = await runEvaluators(args);
      outputs.set(id, output);
      scores.set(id, itemScores);
    };

    if (isLangfuseEnabled()) {
      langfuse = new LangfuseClient();
      // 评估器只回放 task 阶段已算好的分数，不再用脱敏后的 output 重跑 Judge。
      const replayEvaluators = BASE_EVALUATORS.map(
        (_evaluator, index) =>
          async (args: EvalArgs) => {
            const id = (args.metadata as { id?: string } | undefined)?.id;
            const score = id ? scores.get(id)?.[index] : undefined;
            if (!score) {
              logger.warn(
                `评测分数缓存缺失：id=${id ?? '-'}, index=${index}`,
              );
              return [];
            }
            if (score.value == null) return [];
            return {
              name: score.name,
              value: score.value,
              ...(isTraceContentEnabled() ? { comment: score.comment } : {}),
            };
          },
      );
      const experimentData = buildExperimentData(items);
      const result = await langfuse.experiment.run({
        name: 'agentic-rag',
        description:
          'Agent 路由 / 工具 / 全轮次检索 / 改写收益 / 拒答与忠实度',
        data: experimentData,
        task: ((params: {
          input: { question: string };
          metadata?: { id?: string };
        }) => {
          const id = params.metadata?.id;
          const item = items.find((candidate) => candidate.metadata.id === id);
          if (!item) throw new Error('实验任务收到未知用例');
          return runItem(item).then(() => {
            const output = outputs.get(item.metadata.id);
            if (!output) throw new Error(`用例未产出快照：${item.metadata.id}`);
            return toExperimentOutput(output);
          });
        }) as never,
        evaluators: replayEvaluators as never,
        maxConcurrency: concurrency,
        metadata: {
          datasetVersion: dataset.version,
          datasetSource: dataset.source,
        },
      });
      console.log(await result.format());
      await langfuse.flush();
    } else {
      logger.warn('未配置 LANGFUSE_*，只生成本地报告');
      await runWithConcurrency(items, concurrency, runItem);
    }

    const orderedOutputs = items.map((item) => {
      const output = outputs.get(item.metadata.id);
      if (!output) throw new Error(`用例未产出快照：${item.metadata.id}`);
      return output;
    });
    const orderedScores = items.map(
      (item) => scores.get(item.metadata.id) ?? [],
    );
    const report = buildExperimentReport({
      items,
      outputs: orderedOutputs,
      scores: orderedScores,
      generatedAt: new Date().toISOString(),
      gitCommit: gitCommit(),
      datasetVersion: dataset.version,
      modelConfig: {
        llmModel: process.env.LLM_MODEL ?? 'qwen3.8-flash',
        embeddingModel:
          process.env.EMBEDDING_MODEL ?? 'qwen3.7-text-embedding-flash',
        judgeModel: process.env.EVAL_JUDGE_MODEL ?? process.env.LLM_MODEL ?? '',
        topK: 5,
        mode: 'hybrid',
        ragMinScore: process.env.RAG_MIN_SCORE ?? '',
      },
    });

    const reportPath = resolve(
      process.env.EVAL_REPORT_PATH ??
        'eval-reports/agentic-rag-latest.json',
    );
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n本地报告：${reportPath}`);

    const baselinePath = process.env.EVAL_BASELINE_REPORT?.trim();
    if (baselinePath) {
      const baseline = JSON.parse(
        await readFile(resolve(baselinePath), 'utf8'),
      ) as ExperimentReport;
      const comparison = compareReports(baseline, report);
      console.log('\n与基线对比：');
      for (const [name, metric] of Object.entries(comparison.metrics)) {
        console.log(
          `  ${name}: ${metric.baseline ?? '-'} → ${metric.current ?? '-'} (${metric.delta == null ? '-' : metric.delta.toFixed(3)})`,
        );
      }
      for (const item of comparison.cases.filter(
        (entry) => entry.status !== 'unchanged',
      )) {
        console.log(`  用例 ${item.id}: ${item.status}`, item.scoreDeltas);
      }
    }
  } finally {
    await langfuse?.flush().catch(() => undefined);
    await shutdownLangfuseTracing();
    await app?.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
