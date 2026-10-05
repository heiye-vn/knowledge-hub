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

describe('GraphBuildService.getOverview (纯单测)', () => {
  it('Neo4j 未启用或不可用时静默降级，返回空骨架而非抛异常', async () => {
    const config = fakeConfig({ NEO4J_ENABLED: 'false' });
    const service = new GraphBuildService(
      config,
      {} as ChunkingService,
      {} as ExtractionService,
    );
    await service.onModuleInit();

    expect(service.isAvailable()).toBe(false);
    const overview = await service.getOverview({});

    expect(overview.nodes).toEqual([]);
    expect(overview.edges).toEqual([]);
    expect(overview.stats).toEqual({
      nodeCount: 0,
      edgeCount: 0,
      documentCount: 0,
      entityCount: 0,
      tagCount: 0,
      mentionCount: 0,
      relatedCount: 0,
      entityTypes: [],
    });
    expect(overview.topEntities).toEqual([]);
    expect(overview.recentNodes).toEqual([]);
    expect(overview.entityTypes).toEqual([]);
  });
});
