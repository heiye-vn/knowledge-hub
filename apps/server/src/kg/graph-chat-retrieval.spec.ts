import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { GraphBuildService } from './graph-build.service.js';
import type { ChunkingService } from '../rag/chunking.service.js';
import type { ExtractionService } from './extraction.service.js';

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function makeService(): GraphBuildService {
  const service = new GraphBuildService(
    fakeConfig({ NEO4J_ENABLED: 'false' }),
    {} as ChunkingService,
    {} as ExtractionService,
  );
  return service;
}

describe('GraphBuildService.retrieveForChat（无 Neo4j 降级）', () => {
  it('Neo4j 未启用时返回空图谱，不抛异常', async () => {
    const service = makeService();
    await service.onModuleInit();

    const result = await service.retrieveForChat(['发票', '报销'], 8);

    expect(result).toEqual({
      query: '发票 / 报销',
      entities: [],
      relations: [],
      documents: [],
    });
  });

  it('关键词为空时直接返回空图谱', async () => {
    const service = makeService();
    await service.onModuleInit();

    const result = await service.retrieveForChat('   ', 8);

    expect(result.query).toBe('');
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
    expect(result.documents).toEqual([]);
  });
});
