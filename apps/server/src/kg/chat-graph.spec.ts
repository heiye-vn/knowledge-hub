import { describe, expect, it } from 'vitest';
import {
  formatGraphContext,
  formatGraphSystemText,
  splitGraphKeywords,
} from './chat-graph.js';
import type { GraphChatHit } from './types/kg.types.js';

function hit(overrides: Partial<GraphChatHit> = {}): GraphChatHit {
  return {
    query: '发票 / 报销',
    entities: [
      { name: '发票', type: 'CONCEPT', description: '报销凭证' },
      { name: '报销', type: 'PROCESS', description: null },
    ],
    relations: [{ source: '发票', relation: 'REQUIRES', target: '报销' }],
    documents: [{ documentId: 'doc-1', title: '差旅报销办法' }],
    ...overrides,
  };
}

describe('splitGraphKeywords', () => {
  it('按空白、斜杠和中文标点拆分并去重', () => {
    expect(splitGraphKeywords('发票 报销/差旅、住宿，发票')).toEqual([
      '发票',
      '报销',
      '差旅',
      '住宿',
    ]);
  });

  it('支持数组输入并忽略空项', () => {
    expect(splitGraphKeywords(['发票 / 报销', '  ', '差旅'])).toEqual([
      '发票',
      '报销',
      '差旅',
    ]);
  });

  it('大小写不敏感去重，保留首次出现的写法', () => {
    expect(splitGraphKeywords('CRM crm Crm')).toEqual(['CRM']);
  });

  it('空输入返回空数组', () => {
    expect(splitGraphKeywords('   ')).toEqual([]);
    expect(splitGraphKeywords([])).toEqual([]);
  });
});

describe('formatGraphContext', () => {
  it('输出关系与来源文档，不输出正文', () => {
    const text = formatGraphContext(hit());

    expect(text).toContain('关系：');
    expect(text).toContain('- 发票 → 报销（REQUIRES）');
    expect(text).toContain('来源文档：差旅报销办法');
  });

  it('没有关系时退回实体名列表', () => {
    const text = formatGraphContext(
      hit({
        relations: [],
        entities: [
          { name: '发票', type: 'CONCEPT', description: null },
          { name: '差旅', type: 'CONCEPT', description: null },
        ],
      }),
    );

    expect(text).toContain('实体：发票、差旅');
    expect(text).not.toContain('关系：');
  });

  it('空命中返回空串', () => {
    expect(
      formatGraphContext(
        hit({ entities: [], relations: [], documents: [] }),
      ),
    ).toBe('');
  });
});

describe('formatGraphSystemText', () => {
  it('包含图谱边界提示，明确不能当制度原文', () => {
    const text = formatGraphSystemText(hit());

    expect(text).toContain('【本轮知识图谱】');
    expect(text).toContain('不能当制度原文');
    expect(text).toContain('制度/流程以知识库检索资料为准');
  });

  it('空命中返回空串', () => {
    expect(
      formatGraphSystemText(
        hit({ entities: [], relations: [], documents: [] }),
      ),
    ).toBe('');
  });
});
