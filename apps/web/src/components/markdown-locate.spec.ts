import { describe, expect, it, vi } from 'vitest'
import {
  extractLocatePhrases,
  locateAndHighlightInMarkdown,
} from './markdown-locate'

function buildContainer(html: string): HTMLElement {
  const listeners = new Map<string, unknown>()
  const makeEl = (tag: string, text: string, id: string): HTMLElement => {
    let classes = new Set<string>()
    return {
      tagName: tag.toUpperCase(),
      textContent: text,
      dataset: { id },
      classList: {
        add: (c: string) => classes.add(c),
        remove: (c: string) => classes.delete(c),
        contains: (c: string) => classes.has(c),
      },
      contains: () => false,
      scrollIntoView: vi.fn(),
    } as unknown as HTMLElement
  }

  // 解析简单测试 HTML 片段：<tag data-id="...">text</tag>
  const elements: HTMLElement[] = []
  const re = /<(h[1-6]|p|li|tr|blockquote|pre)(?:\s+data-id="([^"]*)")?[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const [, tag, id = '', inner] = m
    const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    elements.push(makeEl(tag, plain, id))
  }
  void listeners

  return {
    querySelectorAll: (selector: string) => {
      if (selector === '.kh-locate-highlight') {
        return elements.filter((el) => el.classList.contains('kh-locate-highlight'))
      }
      const allowed = new Set(
        selector
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      )
      return elements.filter((el) => allowed.has(el.tagName))
    },
  } as unknown as HTMLElement
}

describe('markdown-locate', () => {
  it('strips markdown markup and heading duplicates when extracting phrases', () => {
    const phrases = extractLocatePhrases({
      heading: '二、认识你的对接人',
      chunkContent: [
        '## 二、认识你的对接人',
        '',
        '| 角色 | 职责 | 对接方式 |',
        '| --- | --- | --- |',
        '| **Buddy** | 日常答疑、带你熟悉流程 | 入职当天由 HR 指定 |',
      ].join('\n'),
    })

    expect(phrases.length).toBeGreaterThan(0)
    expect(phrases.some((p) => p.includes('认识你的对接人'))).toBe(false)
    expect(phrases.some((p) => p.includes('日常答疑'))).toBe(true)
  })

  it('scopes matching to the target heading when duplicate paragraphs exist', () => {
    const container = buildContainer(`
      <h2>第一章 试用期规定</h2>
      <p data-id="p1">员工应当按时提交审批单并由直属主管确认。</p>
      <h2>第四章 请假审批</h2>
      <p data-id="p2">员工应当按时提交审批单并由直属主管确认。</p>
    `)

    const res = locateAndHighlightInMarkdown(container, {
      heading: '第四章 请假审批',
      excerpt: '员工应当按时提交审批单并由直属主管确认...',
    })

    expect(res.matched).toBe(true)
    const highlighted = Array.from(
      container.querySelectorAll<HTMLElement>('.kh-locate-highlight'),
    )
    expect(highlighted).toHaveLength(1)
    expect(highlighted[0].dataset.id).toBe('p2')
    expect(highlighted[0].scrollIntoView).toHaveBeenCalled()
  })

  it('highlights matching table row and falls back to heading when only heading matches', () => {
    const container = buildContainer(`
      <h2>第二章 考勤记录</h2>
      <tr><td>迟到</td><td>超过本人适用弹性上班截止时间仍未打卡</td><td>系统记录迟到</td></tr>
      <tr><td>外勤/出差</td><td>经批准在非固定办公地点履职</td><td>按审批单核验</td></tr>
    `)

    const rowMatch = locateAndHighlightInMarkdown(container, {
      heading: '第二章 考勤记录',
      chunkContent: '外勤/出差 | 经批准在非固定办公地点履职 | 按审批单核验',
    })
    expect(rowMatch.matched).toBe(true)
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.kh-locate-highlight'),
    )
    expect(rows[0].textContent).toContain('外勤/出差')

    const headingFallback = locateAndHighlightInMarkdown(container, {
      heading: '第二章 考勤记录',
      excerpt: '一段完全找不到的额外摘要描述',
    })
    expect(headingFallback.matched).toBe(true)
    const heads = Array.from(
      container.querySelectorAll<HTMLElement>('.kh-locate-highlight'),
    )
    expect(heads[0].tagName).toBe('H2')
  })
})

