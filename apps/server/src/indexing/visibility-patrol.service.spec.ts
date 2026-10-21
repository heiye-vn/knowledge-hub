import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from 'typeorm';
import type { GraphBuildService } from '../kg/graph-build.service.js';
import type { ElasticsearchService } from '../rag/elasticsearch.service.js';
import type { RagOrchestrator } from '../rag/rag.orchestrator.js';
import type { SearchIndexService } from '../search/search-index.service.js';
import type { IndexOutboxService } from './index-outbox.service.js';
import { VisibilityPatrolService } from './visibility-patrol.service.js';

function config(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function makePatrol(
  docs: Array<{ id: string; isPublic: boolean; teamId: string | null; authorId: string | null }>,
) {
  let call = 0;
  const em = {
    find: vi.fn(async () => {
      call += 1;
      return call === 1 ? docs : [];
    }),
  };
  const es = { isEnabled: () => true };
  const rag = { updateVisibility: vi.fn(async () => 1) };
  const search = { isAvailable: () => true, updateVisibility: vi.fn(async () => 1) };
  const graph = {
    isEnabled: () => true,
    isAvailable: () => true,
    updateVisibility: vi.fn(async () => undefined),
  };
  const outbox = { record: vi.fn(async () => 'outbox-1') };

  const patrol = new VisibilityPatrolService(
    em as unknown as EntityManager,
    es as unknown as ElasticsearchService,
    rag as unknown as RagOrchestrator,
    search as unknown as SearchIndexService,
    graph as unknown as GraphBuildService,
    outbox as unknown as IndexOutboxService,
    config({ VISIBILITY_PATROL_BATCH_SIZE: '200' }),
  );

  return { patrol, em, rag, search, graph, outbox };
}

describe('VisibilityPatrolService', () => {
  it('对已发布文档刷三套索引可见性并返回统计', async () => {
    const { patrol, rag, search, graph } = makePatrol([
      { id: '1001', isPublic: true, teamId: 't1', authorId: 'u1' },
    ]);

    const result = await patrol.run();

    const expected = { isPublic: true, teamId: 't1', authorId: 'u1' };
    expect(search.updateVisibility).toHaveBeenCalledWith('1001', expected);
    expect(rag.updateVisibility).toHaveBeenCalledWith('1001', expected);
    expect(graph.updateVisibility).toHaveBeenCalledWith('1001', expected);
    expect(result).toEqual({ scanned: 1, synced: 1, failed: 0 });
  });

  it('单篇失败写入 outbox 并计入 failed，不中断整轮', async () => {
    const { patrol, graph, outbox } = makePatrol([
      { id: '1001', isPublic: false, teamId: null, authorId: 'u1' },
      { id: '1002', isPublic: true, teamId: null, authorId: 'u1' },
    ]);
    graph.updateVisibility
      .mockRejectedValueOnce(new Error('neo4j down'))
      .mockResolvedValueOnce(undefined);

    const result = await patrol.run();

    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect(outbox.record).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: '1001',
        target: 'visibility',
        operation: 'visibility',
      }),
    );
    expect(result).toEqual({ scanned: 2, synced: 1, failed: 1 });
  });
});
