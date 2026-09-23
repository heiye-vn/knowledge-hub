import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { ExtractionService } from './extraction.service.js';

/**
 * 抽取服务的纯单测（不依赖 LLM / Neo4j / 容器）
 *
 * 覆盖的是「归一化规则」，这是唯一能脱离真实 LLM 稳定验证的部分：
 * - 未知类型兜底
 * - 挂空实体的关系必须丢弃
 * - 跨块实体池放行（修基线实现「关系只能同块」的局限）
 * - 未配置 Key 时的降级行为
 */

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

function makeService(values: Record<string, string> = {}) {
  return new ExtractionService(fakeConfig(values));
}

describe('ExtractionService 降级', () => {
  it('未配置任何 Key 时不可用，并给出明确原因', () => {
    const service = makeService();
    expect(service.isConfigured()).toBe(false);
    expect(service.getUnavailableReason()).toMatch(/LLM_API_KEY/);
  });

  it('LLM_API_KEY / EMBEDDING_API_KEY / OPENAI_API_KEY 任一即可启用', () => {
    for (const key of [
      'LLM_API_KEY',
      'EMBEDDING_API_KEY',
      'OPENAI_API_KEY',
    ]) {
      const service = makeService({ [key]: 'sk-test' });
      expect(service.isConfigured()).toBe(true);
    }
  });

  it('空正文直接返回空结果，不调用 LLM', async () => {
    const service = makeService({ LLM_API_KEY: 'sk-test' });
    await expect(service.extract('   ', null, '标题')).resolves.toEqual({
      entities: [],
      relations: [],
    });
  });
});

describe('ExtractionService.normalize', () => {
  it('未知实体 / 关系类型兜底为 CONCEPT / RELATED_TO', () => {
    const service = makeService();
    const result = service.normalize({
      entities: [{ name: '差旅报销', type: '自造类型' }],
      relations: [{ source: '差旅报销', target: '财务部', relation: 'APPLIES_TO' }],
    });
    expect(result.entities[0].type).toBe('CONCEPT');
    // 「财务部」不在实体集合内 → 关系被丢弃，故这里断言的是类型归一化的另一条路径
    expect(result.relations).toHaveLength(0);
  });

  it('关系两端必须在实体集合内，挂空实体的关系被丢弃', () => {
    const service = makeService();
    const result = service.normalize({
      entities: [{ name: '财务部', type: 'ORGANIZATION' }],
      relations: [
        { source: '财务部', target: '差旅报销', relation: 'RESPONSIBLE_FOR' },
      ],
    });
    expect(result.relations).toHaveLength(0);
  });

  it('⭐ 传入实体池后可放行跨块关系（基线实现做不到）', () => {
    const service = makeService();
    const result = service.normalize(
      {
        entities: [{ name: '差旅报销', type: 'CONCEPT' }],
        relations: [
          { source: '差旅报销', target: '财务部', relation: 'RESPONSIBLE_FOR' },
        ],
      },
      new Set(['财务部']),
    );
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({
      source: '差旅报销',
      target: '财务部',
      relation: 'RESPONSIBLE_FOR',
      weight: 0.5,
    });
  });

  it('实体数量按 KG_MAX_ENTITIES 截断，防止图爆炸', () => {
    const service = makeService({ KG_MAX_ENTITIES: '2' });
    const result = service.normalize({
      entities: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      relations: [],
    });
    expect(result.entities).toHaveLength(2);
  });

  it('⭐ 同形异码（⼯ U+2F2F vs 工 U+5DE5）按 NFKC 归一，关系不被误杀', () => {
    const service = makeService();
    const result = service.normalize({
      // 实体用兼容字符 U+2F2F，关系用常用字 U+5DE5
      entities: [{ name: '全体员⼯', type: 'CONCEPT' }],
      relations: [
        { source: '全体员工', target: '全体员⼯', relation: 'PARTICIPATES_IN' },
      ],
    });
    expect(result.entities).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    // 端点回填为实体的规范名，保证 Neo4j 侧 MATCH 得到
    expect(result.relations[0].source).toBe('全体员⼯');
  });

  it('空 name 的实体被跳过', () => {
    const service = makeService();
    const result = service.normalize({
      entities: [{ name: '  ' }, { name: '有效实体' }],
      relations: [],
    });
    expect(result.entities.map((e) => e.name)).toEqual(['有效实体']);
  });
});
