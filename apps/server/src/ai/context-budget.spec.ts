import { describe, expect, it } from 'vitest';
import { estimateContextTokens, packHitContext } from './context-budget.js';
import type { SearchHit } from '../rag/types/rag.types.js';

function hit(content: string, title = 'T'): SearchHit {
  return {
    chunkId: 'c',
    documentId: 'd',
    documentTitle: title,
    content,
    heading: null,
    chunkIndex: 0,
    totalChunks: 1,
    score: 1,
    scores: { vector: 1, keyword: null },
  };
}

describe('whole-chunk context budget', () => {
  it('counts multibyte text conservatively and deterministically', () => {
    expect(estimateContextTokens('A汉\n')).toBe(5);
    expect(estimateContextTokens('\u{1D400}')).toBe(4);
  });

  it('accounts for titles, citation indexes and separators in the total', () => {
    // Each entry is eight bytes; separator adds two. Exactly two fit at 18.
    const hits = [hit('aa'), hit('bb'), hit('cc')];
    expect(packHitContext(hits, { budgetEstimatedTokens: 18 })).toBe(
      '[1] T\naa\n\n[2] T\nbb',
    );
    expect(packHitContext(hits, { budgetEstimatedTokens: 17 })).toBe(
      '[1] T\naa',
    );
    expect(
      packHitContext([hit('a', 'Long title')], { budgetEstimatedTokens: 10 }),
    ).toBe('');
  });

  it('skips rather than truncates tables and formulae, preserving original ranks', () => {
    const table = '<table><tr><td>complete</td></tr></table>';
    const formula = '$$\na^2 + b^2 = c^2\n$$';
    const hits = [hit(table), hit(formula), hit('ok')];
    expect(packHitContext(hits, { budgetEstimatedTokens: 30 })).toBe(
      '[2] T\n' + formula,
    );
    expect(
      packHitContext(hits, { budgetEstimatedTokens: 12, indexOffset: 7 }),
    ).toBe('[10] T\nok');
    expect(hits.map((item) => item.content)).toEqual([table, formula, 'ok']);
  });

  it('keeps top-N selection before budgeting and ignores empty content', () => {
    expect(
      packHitContext([hit('x'.repeat(40)), hit('  '), hit('third')], {
        limit: 2,
        budgetEstimatedTokens: 20,
      }),
    ).toBe('');
  });

  it('accepts zero budget but rejects invalid limits rather than allowing unbounded output', () => {
    expect(packHitContext([hit('body')], { budgetEstimatedTokens: 0 })).toBe(
      '',
    );
    for (const budget of [-1, NaN, Infinity]) {
      expect(() =>
        packHitContext([hit('body')], { budgetEstimatedTokens: budget }),
      ).toThrow(RangeError);
    }
  });
});
