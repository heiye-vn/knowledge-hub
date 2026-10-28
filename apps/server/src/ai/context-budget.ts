import type { SearchHit } from '../rag/types/rag.types.js';

/** Per retrieval/assessment payload, excluding system prompts, history and tools. */
export const DEFAULT_CONTEXT_BUDGET_ESTIMATED_TOKENS = 6000;

/**
 * No model tokenizer is available here. One estimated token per UTF-8 byte is
 * deliberately pessimistic (including CJK, punctuation and markup), rather than
 * the optimistic chars/4 heuristic. These are budget units, not billed tokens.
 */
export function estimateContextTokens(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Whole chunks only, in retrieval order. Skipped hits retain their original IDs. */
export function packHitContext(
  hits: SearchHit[],
  options: {
    budgetEstimatedTokens?: number;
    limit?: number;
    indexOffset?: number;
    format?: (hit: SearchHit, citationIndex: number) => string;
    separator?: string;
  } = {},
): string {
  const budget =
    options.budgetEstimatedTokens ?? DEFAULT_CONTEXT_BUDGET_ESTIMATED_TOKENS;
  if (!Number.isFinite(budget) || budget < 0) {
    throw new RangeError(
      'Context budget must be finite and non-negative (estimated tokens)',
    );
  }
  const separator = options.separator ?? '\n\n';
  const format =
    options.format ??
    ((hit: SearchHit, index: number) => {
      const heading = hit.heading ? ` / ${hit.heading}` : '';
      return `[${index}] ${hit.documentTitle}${heading}\n${hit.content}`;
    });
  const parts: string[] = [];
  let used = 0;
  for (const [index, hit] of hits
    .slice(0, options.limit ?? hits.length)
    .entries()) {
    if (!hit.content.trim()) continue;
    const part = format(hit, (options.indexOffset ?? 0) + index + 1);
    const cost = estimateContextTokens((parts.length ? separator : '') + part);
    if (used + cost > budget) continue;
    parts.push(part);
    used += cost;
  }
  return parts.join(separator);
}
