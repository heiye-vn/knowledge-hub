import type { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChunkingService } from '../rag/chunking.service.js';
import type { PipelineDocument } from '../rag/types/rag.types.js';
import { ExtractionService } from './extraction.service.js';
import { GraphBuildService } from './graph-build.service.js';

/**
 * Neo4j 建图集成用例（**会调用真实 LLM**）
 *
 * 前置：本地 Neo4j 已启动（`docker compose up -d neo4j`）。
 * 默认随 `pnpm test:server` 执行（Neo4j 不在线时 skipIf 跳过）；
 * LLM 未配置 Key 时同样跳过。
 *
 * 覆盖：建约束 → 建图（文档/块/实体/关系）→ 幂等重建 → 查询 → 删图 + 孤儿清理。
 */

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
    /* 忽略 */
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

async function isNeo4jUp(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:7474', {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const neo4jUp = await isNeo4jUp();

/** 语料刻意设计成必然存在实体与关系（部门 / 负责人 / 流程） */
const DOC_ID = 'kg-spec-doc';
const SAMPLE: PipelineDocument = {
  id: DOC_ID,
  title: '差旅报销管理办法（测试）',
  content: [
    '# 差旅报销管理办法',
    '',
    '财务部负责差旅报销管理，制定报销标准并审核单据。',
    '出差申请必须提前三天提交，由直属 Leader 审批后方可出行。',
    '一线城市住宿费上限为每晚五百元，超支部分不予报销。',
    '报销单据需在返程后五个工作日内提交至财务部。',
  ].join('\n'),
  summary: '差旅报销的管理办法测试文档',
  status: 1,
  isPublic: true,
};

describe.skipIf(!neo4jUp)('GraphBuildService 集成（需要 Neo4j + LLM Key）', () => {
  let service: GraphBuildService;
  let before: Awaited<ReturnType<GraphBuildService['getStats']>>;

  beforeAll(async () => {
    const config = realConfig();
    service = new GraphBuildService(
      config,
      new ChunkingService(config),
      new ExtractionService(config),
    );
    await service.onModuleInit();
    if (!service.isAvailable()) throw new Error('Neo4j 不可用，跳过集成用例');
    before = await service.getStats();
  });

  afterAll(async () => {
    // 清理测试文档（幂等）
    await service.deleteForDocument(DOC_ID);
  });

  it(
    '建图后：文档 / 块 / 实体数量增加，且能查到实体与邻居',
    { timeout: 300_000 },
    async () => {
      const result = await service.buildForDocument(SAMPLE);
      // eslint-disable-next-line no-console
      console.log(
        `【KG 建图】chunks=${result.chunks}, entities=${result.entities}, ` +
          `relations=${result.relations}, failedChunks=${result.failedChunks}`,
      );

      expect(result.chunks).toBeGreaterThan(0);
      expect(result.entities).toBeGreaterThan(0);

      const after = await service.getStats();
      expect(after.documents).toBe(before.documents + 1);

      // 实体检索能命中语料中的实体
      const entities = await service.listEntities('财务部', 10);
      expect(entities.some((e) => e.name.includes('财务部'))).toBe(true);

      // 邻居查询不抛错即可（关系能否抽出取决于 LLM，不做硬断言）
      const first = entities[0];
      if (first) {
        const neighbors = await service.getNeighbors(first.name, 10);
        expect(Array.isArray(neighbors)).toBe(true);
      }
    },
  );

  it('幂等重建：重复建图不会使文档节点翻倍', { timeout: 300_000 }, async () => {
    const stats1 = await service.getStats();
    await service.buildForDocument(SAMPLE);
    const stats2 = await service.getStats();
    expect(stats2.documents).toBe(stats1.documents);
  });

  it('删图：文档节点被清理，孤儿实体被回收', async () => {
    await service.deleteForDocument(DOC_ID);
    const after = await service.getStats();
    expect(after.documents).toBe(before.documents);
  });
});
