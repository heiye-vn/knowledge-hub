import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import rehypeParse from 'rehype-parse';
import { SKIP, visit } from 'unist-util-visit';

type Node = {
  type: string;
  children?: Node[];
  value?: string;
  url?: string;
  identifier?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: {
    start: { line: number; column: number; offset?: number };
    end: { line: number; column: number; offset?: number };
  };
};
type Reference = {
  url: string;
  start: number;
  end: number;
  html: boolean;
  unquoted?: boolean;
};
const markdownParser = unified().use(remarkParse).use(remarkGfm);
const htmlParser = unified().use(rehypeParse, { fragment: true });

/** Decode URL escaping and harmless leading ./; never collapse traversal segments. */
function key(url: string): string {
  try {
    url = decodeURIComponent(url);
  } catch {
    /* Retain malformed literal keys without broad substitution. */
  }
  return url.replace(/^(?:\.\/)+/, '');
}

function destination(
  raw: string,
  definition: boolean,
): [number, number] | undefined {
  let cursor = definition ? 0 : 1;
  if (raw[cursor] !== '[') return;
  let depth = 0;
  for (; cursor < raw.length; cursor++) {
    if (raw[cursor] === '\\') {
      cursor++;
      continue;
    }
    if (raw[cursor] === '[') depth++;
    if (raw[cursor] === ']' && --depth === 0) break;
  }
  cursor++;
  if (raw[cursor] !== (definition ? ':' : '(')) return;
  cursor++;
  while (/\s/.test(raw[cursor] ?? '') && cursor < raw.length) cursor++;
  if (raw[cursor] === '<') {
    const start = ++cursor;
    while (cursor < raw.length) {
      if (raw[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (raw[cursor] === '>') return [start, cursor];
      cursor++;
    }
    return;
  }
  const start = cursor;
  depth = 0;
  for (; cursor < raw.length; cursor++) {
    const char = raw[cursor];
    if (char === '\\') {
      cursor++;
      continue;
    }
    if (char === '(') depth++;
    if ((char === ')' && depth-- === 0) || /\s/.test(char)) break;
  }
  return [start, cursor];
}

function htmlReferences(raw: string, offset: number): Reference[] {
  const references: Reference[] = [];
  visit(htmlParser.parse(raw) as Node, (node) => {
    if (
      ['pre', 'code', 'script', 'style', 'textarea'].includes(
        node.tagName ?? '',
      )
    )
      return SKIP;
    if (node.tagName !== 'img' || typeof node.properties?.src !== 'string')
      return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const source = raw.slice(start, end);
    const attributes =
      /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    // Skip the tag name; tokenization is confined to an AST-confirmed img node.
    attributes.lastIndex =
      source.match(/^<\s*img\b/i)?.[0].length ?? source.length;
    for (
      let match = attributes.exec(source);
      match;
      match = attributes.exec(source)
    ) {
      if (match[1].toLowerCase() !== 'src' || !match[0].includes('=')) continue;
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      const quote =
        match[2] !== undefined ? '"' : match[3] !== undefined ? "'" : '';
      const afterEquals = match[0].indexOf('=') + 1;
      let valueStart = afterEquals;
      while (
        /\s/.test(match[0][valueStart] ?? '') &&
        valueStart < match[0].length
      )
        valueStart++;
      if (quote) valueStart++;
      references.push({
        url: node.properties.src,
        start: offset + start + match.index + valueStart,
        end: offset + start + match.index + valueStart + value.length,
        html: true,
        unquoted: !quote,
      });
      break;
    }
  });
  return references;
}

function references(markdown: string): Reference[] {
  const root = markdownParser.parse(markdown) as Node;
  const identifiers = new Set<string>();
  visit(root, (node) => {
    if (node.type === 'imageReference' && node.identifier)
      identifiers.add(node.identifier);
  });
  const result: Reference[] = [];
  const definitions = new Set<string>();
  const protectedTags: string[] = [];
  visit(root, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = markdown.slice(start, end);
    if (node.type === 'html') {
      const boundary = raw.match(
        /^<(\/)?(code|pre|script|style|textarea)(?:\s[^>]*)?>$/i,
      );
      if (boundary) {
        const tag = boundary[2].toLowerCase();
        if (boundary[1]) {
          const index = protectedTags.lastIndexOf(tag);
          if (index !== -1) protectedTags.splice(index);
        } else protectedTags.push(tag);
        return;
      }
    }
    if (protectedTags.length) return;
    if (node.type === 'html') {
      result.push(...htmlReferences(raw, start));
    } else if (
      node.type === 'image' ||
      (node.type === 'definition' && identifiers.has(node.identifier ?? ''))
    ) {
      if (node.type === 'definition') {
        if (definitions.has(node.identifier!)) return;
        definitions.add(node.identifier!);
      }
      const range = destination(raw, node.type === 'definition');
      if (range && node.url !== undefined)
        result.push({
          url: node.url,
          start: start + range[0],
          end: start + range[1],
          html: false,
        });
    }
  });
  return result.sort((a, b) => a.start - b.start);
}

export function collectImageReferences(markdown: string): string[] {
  return [...new Set(references(markdown).map((reference) => reference.url))];
}

/** Patch AST-confirmed destination ranges; retain all other source formatting. */
export function rewriteImageUrls(
  markdown: string,
  map: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  const entries = map instanceof Map ? Array.from(map) : Object.entries(map);
  const replacements = new Map<string, string>(
    entries.map(([path, url]) => [key(path), url]),
  );
  const edits = references(markdown).flatMap((reference) => {
    const replacement = replacements.get(key(reference.url));
    if (replacement === undefined) return [];
    let value = reference.html
      ? replacement
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
      : replacement.replace(/[\s<>"()\\]/g, (char) =>
          encodeURIComponent(char).replace(/\(/g, '%28').replace(/\)/g, '%29'),
        );
    if (reference.html && reference.unquoted) value = `"${value}"`;
    return [{ ...reference, value }];
  });
  for (const edit of edits.reverse())
    markdown =
      markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);
  return markdown;
}

/** Image alt text and definition URLs are not evidence of successful OCR. */
export function hasMeaningfulText(markdown: string): boolean {
  let meaningful = false;
  visit(markdownParser.parse(markdown) as Node, (node) => {
    if (
      node.type === 'image' ||
      node.type === 'imageReference' ||
      node.type === 'definition'
    )
      return SKIP;
    if (
      ['text', 'code', 'inlineCode'].includes(node.type) &&
      /[\p{L}\p{N}]/u.test(node.value ?? '')
    )
      meaningful = true;
    if (node.type === 'html') {
      visit(htmlParser.parse(node.value ?? '') as Node, (html) => {
        if (['script', 'style', 'img'].includes(html.tagName ?? ''))
          return SKIP;
        if (html.type === 'text' && /[\p{L}\p{N}]/u.test(html.value ?? ''))
          meaningful = true;
      });
    }
  });
  return meaningful;
}
