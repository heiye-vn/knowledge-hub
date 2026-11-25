import { describe, expect, it } from 'vitest';
import {
  markdownBlocks,
  splitStructuredBlock,
} from '../../rag/markdown-structure.js';
import { normalizeMineruTables } from './normalize-mineru-tables.js';

describe('normalizeMineruTables', () => {
  it('converts multi-column td-only tables to GFM Markdown tables and escapes pipes', () => {
    const input = [
      '说明段落',
      '',
      '<table><tr><td>考勤情形</td><td>认定规则</td><td>处理方式</td></tr><tr><td>迟到</td><td>超过弹性截止时间</td><td>系统记录;每月允许1次|不豁免</td></tr><tr><td>外勤/出差</td><td>非固定地点<br>履职</td><td>按审批单核验</td></tr></table>',
      '',
      '后续段落',
    ].join('\n');

    const result = normalizeMineruTables(input);

    expect(result).toContain(
      '| 考勤情形 | 认定规则 | 处理方式 |\n| --- | --- | --- |\n| 迟到 | 超过弹性截止时间 | 系统记录;每月允许1次\\|不豁免 |\n| 外勤/出差 | 非固定地点 履职 | 按审批单核验 |',
    );
    expect(result).toContain('说明段落\n\n| 考勤情形');
    expect(result).toContain('按审批单核验 |\n\n后续段落');
  });

  it('keeps 2-column key-value metadata tables as formatted HTML with th scope=row', () => {
    const input =
      '<table><tr><td>制度编号</td><td>YL-HR-002</td></tr><tr><td>版本号</td><td>1.1</td></tr><tr><td>发布日期</td><td>2026年11月13日</td></tr><tr><td>归口部门</td><td>人力资源部</td></tr><tr><td>适用范围</td><td>与公司建立劳动关系的员工;实习人员按协议执行</td></tr></table>';

    const result = normalizeMineruTables(input);

    expect(result).toBe(
      [
        '<table>',
        '  <tbody>',
        '    <tr><th scope="row">制度编号</th><td>YL-HR-002</td></tr>',
        '    <tr><th scope="row">版本号</th><td>1.1</td></tr>',
        '    <tr><th scope="row">发布日期</th><td>2026年11月13日</td></tr>',
        '    <tr><th scope="row">归口部门</th><td>人力资源部</td></tr>',
        '    <tr><th scope="row">适用范围</th><td>与公司建立劳动关系的员工;实习人员按协议执行</td></tr>',
        '  </tbody>',
        '</table>',
      ].join('\n'),
    );
  });

  it('converts 2-column data tables with header labels into GFM tables', () => {
    const paramTable =
      '<table><tr><td>参数</td><td>说明</td></tr><tr><td>RAG_TOP_K</td><td>返回给生成阶段的最大检索块数量，默认值为 5</td></tr></table>';
    const fieldTable =
      '<table><tr><td>字段</td><td>默认值</td></tr><tr><td>status</td><td>0（草稿状态，等待发布或审核）</td></tr></table>';

    expect(normalizeMineruTables(paramTable)).toBe(
      '| 参数 | 说明 |\n| --- | --- |\n| RAG_TOP_K | 返回给生成阶段的最大检索块数量，默认值为 5 |',
    );
    expect(normalizeMineruTables(fieldTable)).toBe(
      '| 字段 | 默认值 |\n| --- | --- |\n| status | 0（草稿状态，等待发布或审核） |',
    );
  });

  it('adds thead and th to td-only tables with colspan/rowspan and supports RAG table splitting', () => {
    const input =
      '<table><tr><td rowspan="2">类别</td><td colspan="2">指标</td></tr><tr><td>下限</td><td>上限</td></tr><tr><td>延迟</td><td>10ms</td><td>50ms</td></tr><tr><td>吞吐</td><td>100rps</td><td>500rps</td></tr></table>';

    const result = normalizeMineruTables(input);

    expect(result).toBe(
      [
        '<table>',
        '  <thead>',
        '    <tr><th rowspan="2">类别</th><th colspan="2">指标</th></tr>',
        '    <tr><th>下限</th><th>上限</th></tr>',
        '  </thead>',
        '  <tbody>',
        '    <tr><td>延迟</td><td>10ms</td><td>50ms</td></tr>',
        '    <tr><td>吞吐</td><td>100rps</td><td>500rps</td></tr>',
        '  </tbody>',
        '</table>',
      ].join('\n'),
    );

    const blocks = markdownBlocks(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('html-table');

    const chunks = splitStructuredBlock(blocks[0], '', 230);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).toContain('<thead>');
      expect(chunk).toContain('<th rowspan="2">类别</th>');
    }
  });

  it('preserves tables that already contain thead or th', () => {
    const input =
      '<table><thead><tr><th>列A</th><th>列B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';

    expect(normalizeMineruTables(input)).toBe(input);
  });

  it('does not touch tables inside fenced code blocks', () => {
    const input = [
      '示例：',
      '',
      '```html',
      '<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>',
      '```',
      '',
      '<table><tr><td>列1</td><td>列2</td><td>列3</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>',
    ].join('\n');

    const result = normalizeMineruTables(input);

    expect(result).toContain(
      '```html\n<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>\n```',
    );
    expect(result).toContain('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| a | b | c |');
  });

  it('returns markdown without tables unchanged', () => {
    const input = '# 标题\n\n普通正文内容，没有表格。';
    expect(normalizeMineruTables(input)).toBe(input);
  });
});

