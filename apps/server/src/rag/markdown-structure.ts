import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import rehypeParse from 'rehype-parse';
import { visit } from 'unist-util-visit';

// A byte ceiling is intentionally stricter than chars/token heuristics: UTF-8
// bytes upper-bound byte-fallback tokenizer tokens, even for CJK and markup.
export const EMBEDDING_SAFE_BYTES = 6000;
const markdownParser = unified().use(remarkParse).use(remarkGfm);
const htmlParser = unified().use(rehypeParse, { fragment: true });

type Node = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

export type MarkdownBlock = {
  kind: 'prose' | 'heading' | 'atomic' | 'gfm-table' | 'html-table';
  text: string;
  heading?: string;
};
type Span = { start: number; end: number; block: MarkdownBlock };

function range(node: Node): [number, number] | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start !== undefined && end !== undefined ? [start, end] : null;
}

function plainText(node: Node): string {
  return 'value' in node && typeof node.value === 'string'
    ? node.value
    : (node.children ?? []).map(plainText).join('');
}

/** Source offsets retain original escaping, math and HTML, without reserializing. */
export function markdownBlocks(content: string): MarkdownBlock[] {
  const spans: Span[] = [];
  const add = (node: Node, kind: MarkdownBlock['kind'], heading?: string) => {
    const offsets = range(node);
    if (!offsets) return;
    const [start, end] = offsets;
    spans.push({
      start,
      end,
      block: { kind, text: content.slice(start, end), heading },
    });
  };
  visit(markdownParser.parse(content), (node) => {
    if (node.type === 'code') add(node, 'atomic');
    if (node.type === 'table') add(node, 'gfm-table');
    if (node.type === 'heading') add(node, 'heading', plainText(node));
  });

  // Parse tables across blank lines too (a Markdown HTML block can stop at one).
  // Exclude HTML examples inside fences/indented code before parsing HTML.
  const masked = content.split('');
  for (const span of spans.filter((span) => span.block.kind === 'atomic')) {
    for (let i = span.start; i < span.end; i++) {
      if (masked[i] !== '\n' && masked[i] !== '\r') masked[i] = ' ';
    }
  }
  visit(htmlParser.parse(masked.join('')), (node: Node) => {
    if (node.tagName === 'table') add(node, 'html-table');
  });

  // Display math is not part of CommonMark/GFM. Recognize line-oriented $$
  // blocks, including $$ expression $$, but never interpret fence/table text.
  const math = /^ {0,3}\$\$[^\n]*(?:\n|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = math.exec(content))) {
    const start = match.index;
    if (
      spans.some(
        (span) =>
          span.block.kind !== 'heading' &&
          span.start <= start &&
          span.end > start,
      )
    )
      continue;
    const firstLine = match[0].trimEnd();
    let end = start + firstLine.length;
    if (!/\$\$\s*$/.test(firstLine.slice(firstLine.indexOf('$$') + 2))) {
      const close = /^ {0,3}\$\$\s*$/gm;
      close.lastIndex = math.lastIndex;
      const closing = close.exec(content);
      end = closing
        ? closing.index + closing[0].trimEnd().length
        : content.length;
    }
    spans.push({
      start,
      end,
      block: { kind: 'atomic', text: content.slice(start, end) },
    });
    math.lastIndex = end;
  }

  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue; // nested table/heading belongs to outer block
    if (span.start > cursor)
      blocks.push({ kind: 'prose', text: content.slice(cursor, span.start) });
    blocks.push(span.block);
    cursor = span.end;
  }
  if (cursor < content.length)
    blocks.push({ kind: 'prose', text: content.slice(cursor) });
  return blocks;
}

export function assertAtomicFits(
  text: string,
  targetChars: number,
  label: string,
): void {
  if (
    text.length > targetChars * 4 ||
    Buffer.byteLength(text, 'utf8') > EMBEDDING_SAFE_BYTES
  ) {
    throw new RangeError(
      `${label}: atomic unit exceeds chunk/embedding safe bound (max ${targetChars * 4} characters and ${EMBEDDING_SAFE_BYTES} UTF-8 bytes); split the source unit explicitly`,
    );
  }
}

/** Greedy row groups; only a single indivisible group may exceed the soft target. */
function packRows(
  groups: string[],
  render: (rows: string) => string,
  prefix: string,
  targetChars: number,
  label: string,
): string[] {
  const result: string[] = [];
  let pending: string[] = [];
  const fitsTarget = (text: string) =>
    prefix.length + text.length <= targetChars &&
    Buffer.byteLength(prefix + text, 'utf8') <= EMBEDDING_SAFE_BYTES;
  for (const group of groups) {
    const candidate = render([...pending, group].join('\n'));
    if (pending.length && !fitsTarget(candidate)) {
      result.push(render(pending.join('\n')));
      pending = [];
    }
    assertAtomicFits(prefix + render(group), targetChars, label);
    pending.push(group);
  }
  if (pending.length) result.push(render(pending.join('\n')));
  return result;
}

/** HTML rowspans connect rows transitively; rowspan=0 extends to the group end. */
function rowGroups(rows: Node[], text: string): string[] {
  const groups: string[] = [];
  let start = 0;
  let end = 0;
  for (let i = 0; i < rows.length; i++) {
    end = Math.max(end, i);
    for (const cell of rows[i].children ?? []) {
      const span = Number(cell.properties?.rowSpan ?? 1);
      if (span === 0) end = rows.length - 1;
      else if (Number.isFinite(span) && span > 1)
        end = Math.max(end, Math.min(rows.length - 1, i + span - 1));
    }
    if (i === end) {
      const first = range(rows[start]);
      const last = range(rows[i]);
      if (!first || !last)
        throw new Error('HTML table rows require source positions');
      groups.push(text.slice(first[0], last[1]));
      start = i + 1;
    }
  }
  return groups;
}

function splitHtmlTable(
  text: string,
  prefix: string,
  targetChars: number,
): string[] {
  const tree = htmlParser.parse(text);
  const tables: Node[] = [];
  visit(tree, (node: Node) => {
    if (node.tagName === 'table') tables.push(node);
  });
  const table = tables[0];
  const atomic = (reason: string) => {
    assertAtomicFits(prefix + text, targetChars, `HTML table (${reason})`);
    return [text];
  };
  if (!table || tables.length !== 1)
    return atomic('nested/unsupported layout kept whole');
  const bodies = (table.children ?? []).filter(
    (node) => node.tagName === 'tbody',
  );
  // Multiple body groups, cross-header spans and nested tables stay atomic. Never
  // cut their wrapper tags or invent shortened rowspan attributes to make them fit.
  if (bodies.length !== 1) return atomic('multiple/no tbody groups kept whole');
  let rows = (bodies[0].children ?? []).filter((node) => node.tagName === 'tr');
  if (!rows.length) return atomic('no splittable rows');
  const thead = (table.children ?? []).find((node) => node.tagName === 'thead');
  if (!thead) {
    let headers = 0;
    while (headers < rows.length) {
      const cells = (rows[headers].children ?? []).filter(
        (node) => node.tagName === 'td' || node.tagName === 'th',
      );
      if (!cells.length || cells.some((node) => node.tagName !== 'th')) break;
      headers++;
    }
    for (let i = 0; i < headers; i++) {
      if (
        (rows[i].children ?? []).some((cell) => {
          const span = Number(cell.properties?.rowSpan ?? 1);
          return span === 0 || i + span > headers;
        })
      )
        return atomic('header rowspan crosses into data');
    }
    rows = rows.slice(headers);
  }
  if (!rows.length) return atomic('header-only table');
  const first = range(rows[0]);
  const last = range(rows[rows.length - 1]);
  if (!first || !last) return atomic('missing source positions');
  const before = text.slice(0, first[0]);
  const after = text.slice(last[1]);
  return packRows(
    rowGroups(rows, text),
    (body) => before + body + after,
    prefix,
    targetChars,
    'HTML table row/rowspan group with repeated header',
  );
}

export function splitStructuredBlock(
  block: MarkdownBlock,
  prefix: string,
  targetChars: number,
): string[] {
  const text = block.text.trim();
  if (block.kind === 'html-table' && !/<\/table\s*>$/i.test(text)) {
    throw new Error('HTML table must be explicitly closed before chunking');
  }
  if (
    prefix.length + text.length <= targetChars &&
    Buffer.byteLength(prefix + text, 'utf8') <= EMBEDDING_SAFE_BYTES
  )
    return [text];
  if (block.kind === 'html-table')
    return splitHtmlTable(text, prefix, targetChars);
  if (block.kind === 'gfm-table') {
    const lines = text.split(/\r?\n/);
    const header = lines.slice(0, 2).join('\n');
    if (lines.length <= 2) {
      assertAtomicFits(prefix + text, targetChars, 'GFM table header');
      return [text];
    }
    return packRows(
      lines.slice(2),
      (rows) => `${header}\n${rows}`,
      prefix,
      targetChars,
      'GFM table row with repeated header',
    );
  }
  assertAtomicFits(prefix + text, targetChars, block.kind);
  return [text];
}
