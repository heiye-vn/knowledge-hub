import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DocumentStatusGuideContent } from './DocumentStatusGuide'

describe('DocumentStatusGuideContent', () => {
  it('渲染全部 4 种文档状态与可检索范围标识', () => {
    const html = renderToStaticMarkup(createElement(DocumentStatusGuideContent))
    expect(html).toContain('草稿')
    expect(html).toContain('待审核')
    expect(html).toContain('已发布')
    expect(html).toContain('已归档')

    expect(html.match(/可搜索 \/ AI 问答/g)).toHaveLength(1)
    expect(html.match(/不进搜索与问答/g)).toHaveLength(3)
  })

  it('包含面向业务人员的状态流转路径指引', () => {
    const html = renderToStaticMarkup(createElement(DocumentStatusGuideContent))
    expect(html).toContain('下架编辑')
    expect(html).toContain('归档')
    expect(html).toContain('流转路径')
  })
})
