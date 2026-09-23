import { ConfigService } from '@nestjs/config';
import { PDFParse } from 'pdf-parse';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChunkingService } from '../rag/chunking.service.js';
import { ExtractionService } from './extraction.service.js';

/**
 * 用真实 PDF 跑一遍实体抽取（**会消耗 token**）
 *
 * 默认跳过；需要实测时显式开启：
 * ```bash
 * KG_E2E=1 pnpm --filter @knowledge-hub/server exec vitest run src/kg/extraction-e2e.spec.ts
 * ```
 *
 * 目的：拿到「块数 / 耗时 / 实体数 / 关系数 / 失败块」的真实数据，
 * 用于标定 `KG_MAX_CHUNKS`、`KG_EXTRACT_CONCURRENCY` 与成本预期
 * —— 对应 AGENTS.md「先衡量再动手」。
 *
 * 语料：基线实现 v5 自带的两个测试 PDF（已复制到 test/fixtures/）：
 * - 01-travel-expense-policy.pdf（差旅费报销制度）
 * - 02-production-release-sop.pdf（生产发布 SOP）
 */

const FIXTURES = resolve(__dirname, '../../test/fixtures');
const PDF_FILES = [
  '01-travel-expense-policy.pdf',
  '02-production-release-sop.pdf',
];

/** 极简 .env 解析：vitest 不加载 NestJS 的 ConfigModule，这里手动读取 */
function loadEnvFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const raw = readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  } catch {
    /* 无 .env 时退回 process.env */
  }
  return env;
}

function realConfig(): ConfigService {
  const fileEnv = loadEnvFile(resolve(__dirname, '../../.env'));
  return {
    get: (key: string, fallback?: unknown) =>
      process.env[key] ?? fileEnv[key] ?? fallback,
  } as unknown as ConfigService;
}

const runReal = process.env.KG_E2E === '1';

describe.skipIf(!runReal)('KG 抽取真实 PDF 实测', () => {
  let extraction: ExtractionService;
  let chunking: ChunkingService;

  beforeAll(() => {
    const config = realConfig();
    extraction = new ExtractionService(config);
    chunking = new ChunkingService(config);
    if (!extraction.isConfigured()) {
      throw new Error(
        `未配置 LLM Key，无法实测：${extraction.getUnavailableReason()}`,
      );
    }
  });

  for (const file of PDF_FILES) {
    it(`${file} 能抽出实体与关系`, async () => {
      const buffer = readFileSync(resolve(FIXTURES, file));

      const parser = new PDFParse({ data: buffer });
      const textResult = await parser.getText();
      const content = (textResult?.pages ?? [])
        .map((p) => p?.text ?? '')
        .join('\n')
        .trim();
      expect(content.length).toBeGreaterThan(0);

      const chunks = await chunking.chunk({
        content,
        documentId: file.replace(/\.pdf$/, ''),
        documentTitle: file.replace(/\.pdf$/, ''),
        docStatus: 1,
      });
      expect(chunks.length).toBeGreaterThan(0);

      const started = Date.now();
      const outcomes = await extraction.extractBatch(
        chunks.map((c) => ({
          chunkId: c.chunkId,
          content: c.content,
          heading: c.heading ?? null,
        })),
        file,
      );
      const elapsed = Date.now() - started;

      const entities = new Map<string, string>();
      let relationCount = 0;
      const failed = outcomes.filter((o) => o.error);
      for (const o of outcomes) {
        for (const e of o.result.entities) {
          entities.set(e.name, e.type);
        }
        relationCount += o.result.relations.length;
      }

      // eslint-disable-next-line no-console
      console.log(
        [
          `【KG 实测】${file}`,
          `字符数=${content.length}`,
          `块数=${chunks.length}`,
          `耗时=${elapsed}ms`,
          `平均每块=${Math.round(elapsed / chunks.length)}ms`,
          `实体=${entities.size}`,
          `关系=${relationCount}`,
          `失败块=${failed.length}`,
          `实体样本=${[...entities.entries()].slice(0, 8).map(([n, t]) => `${n}(${t})`).join('、')}`,
        ].join(' | '),
      );

      expect(failed.length).toBe(0);
      expect(entities.size).toBeGreaterThan(0);
    }, 300_000);
  }
});
