import { describe, expect, it } from 'vitest';
import {
  collectImageReferences,
  hasMeaningfulText,
  rewriteImageUrls,
} from './image-references.js';

describe('image references (AST source positions)', () => {
  it('rewrites only image destinations and used definitions, preserving code and ordinary text', () => {
    const markdown =
      'images/a.png\n\n![a](./images/a.png "title")\n\n![b][asset]\n\n[asset]: <images/a.png> "keep"\n\n[link](images/a.png)\n\n`![a](images/a.png)`\n\n```md\n![a](images/a.png)\n```';
    expect(
      rewriteImageUrls(
        markdown,
        new Map([['images/a.png', 'https://assets.example/a.png']]),
      ),
    ).toBe(
      'images/a.png\n\n![a](https://assets.example/a.png "title")\n\n![b][asset]\n\n[asset]: <https://assets.example/a.png> "keep"\n\n[link](images/a.png)\n\n`![a](images/a.png)`\n\n```md\n![a](images/a.png)\n```',
    );
  });

  it('rewrites actual HTML img src only, including nested HTML and escaped destinations', () => {
    const markdown =
      '<div><img alt="images/a.png" src="./images/a.png"></div>\n\n`<img src="images/a.png">`\n\n![x](images/a\\(1\\).png)';
    expect(
      rewriteImageUrls(markdown, {
        'images/a.png': 'https://a.test/a?x=1&y=2',
        'images/a(1).png': 'https://a.test/b.png',
      }),
    ).toBe(
      '<div><img alt="images/a.png" src="https://a.test/a?x=1&amp;y=2"></div>\n\n`<img src="images/a.png">`\n\n![x](https://a.test/b.png)',
    );
  });

  it('collects nested paths without treating code or ordinary links as images', () => {
    expect(
      collectImageReferences(
        '![x](./images/a.png)\n\n![y][id]\n\n[id]: images/b.png\n\n<img src="images/c.png">\n\n[ordinary](z.png)',
      ),
    ).toEqual(['./images/a.png', 'images/b.png', 'images/c.png']);
  });

  it('does not normalize traversal into an allowed replacement', () => {
    expect(
      rewriteImageUrls('![x](../images/a.png)', {
        'images/a.png': 'https://a.test/a',
      }),
    ).toBe('![x](../images/a.png)');
  });

  it('matches encoded image paths to canonical asset keys on the worker rewrite pass', () => {
    expect(
      rewriteImageUrls('![x](result/images/a%20b.png)', {
        'result/images/a b.png': 'https://assets.test/a.png',
      }),
    ).toBe('![x](https://assets.test/a.png)');
  });

  it('keeps images inside inline HTML code and preformatted content unchanged', () => {
    const markdown =
      'Before <code><img src="a.png"></code> after\n\n<pre><img src="a.png"></pre>\n\n<img src="a.png">';
    expect(
      rewriteImageUrls(markdown, { 'a.png': 'https://assets.test/a.png' }),
    ).toBe(
      'Before <code><img src="a.png"></code> after\n\n<pre><img src="a.png"></pre>\n\n<img src="https://assets.test/a.png">',
    );
  });

  it('uses only the first active Markdown definition for an image reference', () => {
    const markdown = '![x][id]\n\n[id]: a.png\n[id]: missing.png';
    expect(collectImageReferences(markdown)).toEqual(['a.png']);
    expect(
      rewriteImageUrls(markdown, {
        'a.png': 'https://assets.test/a.png',
        'missing.png': 'bad',
      }),
    ).toBe('![x][id]\n\n[id]: https://assets.test/a.png\n[id]: missing.png');
  });

  it('does not count image alt text, definitions, markup or punctuation as OCR text', () => {
    expect(
      hasMeaningfulText(
        '![a long image description](images/a.png)\n\n<img alt="words" src="images/b.png">\n\n---',
      ),
    ).toBe(false);
    expect(hasMeaningfulText('# 识别文字\n\n![x](images/a.png)')).toBe(true);
    expect(hasMeaningfulText('<table><tr><td>识别文字</td></tr></table>')).toBe(
      true,
    );
  });
});
