import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AnswerMarkdown } from './SourceCiteList'
import { DocumentMarkdown } from './DocumentMarkdown'

const sources = [{ index: 1, documentId: '123', documentTitle: '资料' }]
const render = (text: string) => renderToStaticMarkup(
  createElement(AnswerMarkdown, { text, sources, scope: 'test' }),
)

describe('safe answer Markdown', () => {
  it('uses the same safe rendering in document content and protects local asset references', () => {
    const html = renderToStaticMarkup(createElement(DocumentMarkdown, { content: '$x^2$\n\n<table><tr><th colspan="2">Merged</th></tr></table>\n\n<img src="/documents/123/assets/456" alt="私有图片" onerror="alert(1)">\n\n<script>alert(1)</script>' }))
    expect(html).toContain('class="katex"')
    expect(html).toContain('colSpan="2"')
    expect(html).toContain('私有图片')
    expect(html).not.toMatch(/<script|onerror=|<img[^>]*src="\/documents/)
  })

  it('renders real KaTeX for inline, display and HTML math without losing citations', () => {
    const html = render('公式 $x^2$ [1]\n\n$$\n\\frac{a}{b}\n$$\n\n<code class="language-math math-inline">y^2</code>')
    expect(html).toContain('class="katex"')
    expect(html.match(/class="katex-display"/g)).toHaveLength(1)
    expect(html.match(/class="katex"/g)).toHaveLength(3)
    expect(html).toContain('<math')
    expect(html).toContain('class="kh-cite-inline"')
    expect(html).toContain('>[1]</button>')
  })

  it('keeps HTML table spans and GFM tables with citation chips', () => {
    const html = render('<table><tbody><tr><td colspan="2" rowspan="3">合并 [1]</td></tr></tbody></table>\n\n| A | B |\n| - | - |\n| 值 [1] | 2 |')
    expect(html).toContain('colSpan="2"')
    expect(html).toContain('rowSpan="3"')
    expect(html.match(/<table/g)).toHaveLength(2)
    expect(html.match(/class="kh-cite-inline"/g)).toHaveLength(2)
    expect(html).toContain('kh-markdown-table')
  })

  it('removes executable HTML, event handlers, unsafe links and untrusted math commands', () => {
    const html = render('<script>alert(1)</script><iframe src="https://bad.test"></iframe>\n\n<img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)" onclick="alert(4)">link</a>\n\n$\\href{javascript:alert(5)}{evil}$\n\n$\\includegraphics{https://bad.test/track.png}$')
    expect(html).not.toMatch(/<script|<iframe|onerror=|onclick=|href="javascript:|src="javascript:/i)
    expect(html).not.toContain('<img src="https://bad.test/track.png"')
  })

  it('renders malformed math safely and leaves unknown citations unchanged', () => {
    const html = render('$\\frac{$ and [99]\n\n```\ncode [1]\n```')
    expect(html).toContain('katex-error')
    expect(html).toContain('[99]')
    expect(html).toContain('<code>code [1]\n</code>')
  })
})
