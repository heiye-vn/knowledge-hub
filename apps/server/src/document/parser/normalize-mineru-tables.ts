import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import rehypeParse from 'rehype-parse';
import { visit } from 'unist-util-visit';
import { toMarkdownTable } from './utils/markdown.util.js';

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const htmlParser = unified().use(rehypeParse, { fragment: true });

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

type TableSpan = {
  start: number;
  end: number;
  node: HastNode;
};

type CellData = {
  tagName: 'th' | 'td';
  colSpan: number;
  rowSpan: number;
  hasRowSpanAttr: boolean;
  plainText: string;
  htmlContent: string;
  isSimple: boolean;
};

type RowData = {
  section: 'thead' | 'tbody' | 'tfoot' | 'direct';
  cells: CellData[];
};

const COMMON_RIGHT_HEADER_PATTERN =
  /^(说明|描述|内容|规则|要求|含义|备注|值|取值|默认值|示例|类型|处理方式|审批流程|定义|详情|结果|标准|措施|范围|条件|口径|用途|功能|作用|名称|状态|级别|优先级|时间|日期|负责人|部门|对象|方式|路径|参数|配置|选项|字段|指标|金额|比例|期限|上限|下限)(?:[（(][^）)]*[）)])?$/;

const COMMON_LEFT_HEADER_PATTERN =
  /^(参数|字段|名称|项目|类别|类型|情形|指标|步骤|阶段|序号|编号)(?:[（(][^）)]*[）)])?$/;

function range(node: HastNode): [number, number] | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start !== undefined && end !== undefined ? [start, end] : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parsePositiveSpan(raw: unknown, allowZero = false): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return 1;
  if (allowZero && parsed === 0) return 0;
  return parsed > 1 ? parsed : 1;
}

function maskCodeBlocks(markdown: string): string {
  const codeRanges: Array<[number, number]> = [];
  visit(markdownParser.parse(markdown), (node) => {
    if (node.type !== 'code') return;
    const offsets = range(node as HastNode);
    if (offsets) codeRanges.push(offsets);
  });
  if (!codeRanges.length) return markdown;

  const chars = markdown.split('');
  for (const [start, end] of codeRanges) {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}

function collectTopLevelTables(masked: string): TableSpan[] {
  const rawSpans: TableSpan[] = [];
  visit(htmlParser.parse(masked), (node: HastNode) => {
    if (node.tagName !== 'table') return;
    const offsets = range(node);
    if (offsets) {
      rawSpans.push({ start: offsets[0], end: offsets[1], node });
    }
  });
  rawSpans.sort((a, b) => a.start - b.start || b.end - a.end);

  const topLevel: TableSpan[] = [];
  let cursor = 0;
  for (const span of rawSpans) {
    if (span.start < cursor) continue;
    topLevel.push(span);
    cursor = span.end;
  }
  return topLevel;
}

function serializeCell(cell: HastNode, source: string): CellData {
  const colSpan = parsePositiveSpan(
    cell.properties?.colSpan ?? cell.properties?.colspan,
  );
  const rawRowSpan = cell.properties?.rowSpan ?? cell.properties?.rowspan;
  const rowSpan = parsePositiveSpan(rawRowSpan, true);
  const hasRowSpanAttr =
    (typeof rawRowSpan === 'number' ||
      (typeof rawRowSpan === 'string' && rawRowSpan.trim() !== '')) &&
    (rowSpan === 0 || rowSpan > 1);

  let isSimple = true;
  const plainParts: string[] = [];
  const htmlParts: string[] = [];

  for (const child of cell.children ?? []) {
    if (child.type === 'text') {
      const value = child.value ?? '';
      plainParts.push(value);
      htmlParts.push(escapeHtml(value));
    } else if (child.type === 'element' && child.tagName === 'br') {
      plainParts.push(' ');
      htmlParts.push('<br>');
    } else {
      isSimple = false;
      const offsets = range(child);
      if (offsets) {
        htmlParts.push(source.slice(offsets[0], offsets[1]));
      }
      plainParts.push(extractPlainText(child));
    }
  }

  return {
    tagName: cell.tagName === 'th' ? 'th' : 'td',
    colSpan,
    rowSpan,
    hasRowSpanAttr,
    plainText: plainParts.join('').replace(/\s+/g, ' ').trim(),
    htmlContent: htmlParts.join('').trim(),
    isSimple,
  };
}

function extractPlainText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type === 'element' && node.tagName === 'br') return ' ';
  return (node.children ?? []).map(extractPlainText).join('');
}

function extractRows(
  tableNode: HastNode,
  source: string,
): { rows: RowData[]; hasThead: boolean; hasNestedTable: boolean } {
  const rows: RowData[] = [];
  let hasThead = false;
  let hasNestedTable = false;

  const inspectRow = (
    trNode: HastNode,
    section: RowData['section'],
  ): void => {
    const cells: CellData[] = [];
    for (const child of trNode.children ?? []) {
      if (child.type !== 'element') continue;
      if (child.tagName === 'td' || child.tagName === 'th') {
        if (containsTable(child)) hasNestedTable = true;
        cells.push(serializeCell(child, source));
      }
    }
    if (cells.length) rows.push({ section, cells });
  };

  for (const child of tableNode.children ?? []) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'thead') {
      hasThead = true;
      for (const item of child.children ?? []) {
        if (item.type === 'element' && item.tagName === 'tr') {
          inspectRow(item, 'thead');
        }
      }
    } else if (child.tagName === 'tbody' || child.tagName === 'tfoot') {
      const section = child.tagName;
      for (const item of child.children ?? []) {
        if (item.type === 'element' && item.tagName === 'tr') {
          inspectRow(item, section);
        }
      }
    } else if (child.tagName === 'tr') {
      inspectRow(child, 'direct');
    }
  }

  return { rows, hasThead, hasNestedTable };
}

function containsTable(node: HastNode): boolean {
  for (const child of node.children ?? []) {
    if (child.type === 'element' && child.tagName === 'table') return true;
    if (containsTable(child)) return true;
  }
  return false;
}

function isKeyValueTable(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  if (!rows.every((row) => row.length === 2)) return false;

  const firstColValid = rows.every((row) => {
    const label = row[0].trim();
    return label.length > 0 && label.length <= 16 && !/[。！？；;]/.test(label);
  });
  if (!firstColValid) return false;

  const firstLeft = rows[0][0].trim();
  const firstRight = rows[0][1].trim();
  if (!firstRight || COMMON_RIGHT_HEADER_PATTERN.test(firstRight)) {
    return false;
  }

  if (/\d/.test(firstRight)) return true;

  const maxRightLength = rows.reduce(
    (max, row) => Math.max(max, row[1].trim().length),
    0,
  );
  return maxRightLength >= 18 && !COMMON_LEFT_HEADER_PATTERN.test(firstLeft);
}

function formatCellAttrs(cell: CellData, extraAttrs = ''): string {
  const attrs: string[] = [];
  if (extraAttrs) attrs.push(extraAttrs);
  if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`);
  if (cell.hasRowSpanAttr) attrs.push(`rowspan="${cell.rowSpan}"`);
  return attrs.length ? ` ${attrs.join(' ')}` : '';
}

function computeHeaderRowCount(rows: RowData[]): number {
  if (rows.length < 2) return 0;
  let end = 0;
  for (let i = 0; i <= end && i < rows.length; i++) {
    for (const cell of rows[i].cells) {
      if (cell.rowSpan === 0) return 0;
      if (cell.rowSpan > 1) {
        end = Math.max(end, Math.min(rows.length - 1, i + cell.rowSpan - 1));
      }
    }
  }
  const headerCount = end + 1;
  return headerCount < rows.length ? headerCount : 0;
}

function renderStructuredHtmlTable(rows: RowData[]): string {
  const headerCount = computeHeaderRowCount(rows);
  const headerRows = rows.slice(0, headerCount);
  const bodyRows = rows.slice(headerCount);

  const renderRow = (row: RowData, tag: 'th' | 'td') => {
    const cells = row.cells
      .map((cell) => `<${tag}${formatCellAttrs(cell)}>${cell.htmlContent}</${tag}>`)
      .join('');
    return `    <tr>${cells}</tr>`;
  };

  const parts = ['<table>'];
  if (headerRows.length) {
    parts.push('  <thead>');
    for (const row of headerRows) parts.push(renderRow(row, 'th'));
    parts.push('  </thead>');
  }
  if (bodyRows.length) {
    parts.push('  <tbody>');
    for (const row of bodyRows) parts.push(renderRow(row, 'td'));
    parts.push('  </tbody>');
  }
  parts.push('</table>');
  return parts.join('\n');
}

function renderKeyValueHtmlTable(rows: RowData[]): string {
  const parts = ['<table>', '  <tbody>'];
  for (const row of rows) {
    const [keyCell, valueCell] = row.cells;
    parts.push(
      `    <tr><th scope="row">${keyCell.htmlContent}</th><td>${valueCell.htmlContent}</td></tr>`,
    );
  }
  parts.push('  </tbody>', '</table>');
  return parts.join('\n');
}

function normalizeSingleTable(
  span: TableSpan,
  source: string,
): { replacement: string; isGfm: boolean } {
  const raw = source.slice(span.start, span.end);
  const { rows, hasThead, hasNestedTable } = extractRows(span.node, source);
  if (!rows.length) return { replacement: raw, isGfm: false };

  const hasTh = rows.some((row) =>
    row.cells.some((cell) => cell.tagName === 'th'),
  );
  if (hasThead || hasTh) {
    return { replacement: raw, isGfm: false };
  }

  const hasSpanOrComplex =
    hasNestedTable ||
    rows.some((row) =>
      row.cells.some(
        (cell) =>
          cell.colSpan > 1 ||
          cell.rowSpan > 1 ||
          cell.hasRowSpanAttr ||
          !cell.isSimple,
      ),
    );
  if (hasSpanOrComplex) {
    return { replacement: renderStructuredHtmlTable(rows), isGfm: false };
  }

  const plainRows = rows.map((row) => row.cells.map((cell) => cell.plainText));
  if (isKeyValueTable(plainRows)) {
    return { replacement: renderKeyValueHtmlTable(rows), isGfm: false };
  }

  return {
    replacement: toMarkdownTable(plainRows).trimEnd(),
    isGfm: true,
  };
}

/**
 * 规范化 MinerU 输出中的紧凑全 `<td>` HTML 表格：
 * - 简单数据表转为标准 GFM Markdown 表格；
 * - 2 列键值属性表保留多行 HTML 并将左列升级为 `<th scope="row">`；
 * - 含合并单元格或复杂内嵌元素的表格格式化为多行 HTML 并补齐 `<thead>` / `<th>`。
 */
export function normalizeMineruTables(markdown: string): string {
  if (!markdown || !/<table[\s>]/i.test(markdown)) return markdown;

  const masked = maskCodeBlocks(markdown);
  const tables = collectTopLevelTables(masked);
  if (!tables.length) return markdown;

  const chunks: string[] = [];
  let cursor = 0;

  for (const span of tables) {
    const before = markdown.slice(cursor, span.start);
    const { replacement, isGfm } = normalizeSingleTable(span, markdown);

    if (before) chunks.push(before);

    if (isGfm) {
      const prevTail = chunks.join('');
      if (prevTail.trim().length > 0) {
        if (!prevTail.endsWith('\n')) chunks.push('\n\n');
        else if (!prevTail.endsWith('\n\n')) chunks.push('\n');
      }
    }

    chunks.push(replacement);

    if (isGfm) {
      const afterHead = markdown.slice(span.end);
      if (afterHead.trim().length > 0) {
        if (!afterHead.startsWith('\n')) chunks.push('\n\n');
        else if (!afterHead.startsWith('\n\n')) chunks.push('\n');
      }
    }

    cursor = span.end;
  }

  if (cursor < markdown.length) {
    chunks.push(markdown.slice(cursor));
  }

  return chunks.join('');
}

