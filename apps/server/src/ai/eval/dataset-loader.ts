import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CHAT_INTENTS } from '../chat-query-rewrite.service.js';
import type { GoldenItem } from './eval.types.js';
import { buildGoldenDataset, withAclCase } from './golden-dataset.js';

const expectedSchema = z
  .object({
    intent: z.enum(CHAT_INTENTS),
    requireRetrieve: z.boolean().optional(),
    requireGraph: z.boolean().optional(),
    requireWeb: z.boolean().optional(),
    forbidRetrieve: z.boolean().optional(),
    forbidGraph: z.boolean().optional(),
    forbidWeb: z.boolean().optional(),
    expectRewrite: z.boolean().optional(),
    expectRefusal: z.boolean().optional(),
    relevantDocTitles: z.array(z.string()).optional(),
    keyPoints: z.array(z.string()).optional(),
    mustNotContain: z.array(z.string()).optional(),
    judgeGroundedness: z.boolean().optional(),
  })
  .strict();

const itemSchema = z
  .object({
    input: z.object({ question: z.string().trim().min(1) }).strict(),
    expectedOutput: expectedSchema,
    metadata: z
      .object({
        id: z.string().trim().min(1),
        suite: z.string().trim().min(1),
        access: z.enum(['admin', 'restricted']).optional(),
      })
      .strict(),
  })
  .strict();

const datasetSchema = z
  .object({
    version: z.string().trim().min(1),
    description: z.string().optional(),
    items: z.array(itemSchema).min(1),
  })
  .strict();

export type LoadedDataset = {
  version: string;
  items: GoldenItem[];
  source: string;
};

/** 解析并校验外部数据集；重复 ID 会直接失败，避免覆盖实验缓存或报告。 */
export function parseGoldenDataset(
  raw: unknown,
  source = 'inline',
): LoadedDataset {
  const parsed = datasetSchema.parse(raw);
  const ids = parsed.items.map((item) => item.metadata.id);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicated.length) {
    throw new Error(
      `数据集存在重复用例 ID：${[...new Set(duplicated)].join('、')}（${source}）`,
    );
  }
  return {
    version: parsed.version,
    items: parsed.items as GoldenItem[],
    source,
  };
}

/**
 * 未配置 EVAL_DATASET_PATH 时使用内置冒烟集；
 * 配置后从 JSON 文件加载，路径相对 apps/server 工作目录。
 */
export async function loadGoldenDataset(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedDataset> {
  const configuredPath = env.EVAL_DATASET_PATH?.trim();
  if (!configuredPath) {
    return {
      version: env.EVAL_DATASET_VERSION?.trim() || 'golden-v1',
      items: buildGoldenDataset(env),
      source: 'builtin',
    };
  }

  const absolutePath = resolve(process.cwd(), configuredPath);
  const text = await readFile(absolutePath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `评测数据集不是合法 JSON：${absolutePath}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const loaded = parseGoldenDataset(raw, absolutePath);
  return {
    ...loaded,
    version: env.EVAL_DATASET_VERSION?.trim() || loaded.version,
    items: withAclCase(loaded.items, env),
  };
}
