import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import {
  DocumentImports,
  DocumentImportsSidebar,
  ImportJobList,
} from './DocumentImports'
import { ImportJobs } from '../document-imports'
import type { ImportTaskView } from '../types'

const task: ImportTaskView = {
  id: '123', fileName: '原文件.pdf', state: 'processing', stage: 'ocr',
  documentId: null, warnings: ['部分图片未识别'], error: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
}
const render = (items: ImportTaskView[], error: string | null = null) => renderToStaticMarkup(
  createElement(MemoryRouter, null, createElement(ImportJobList, {
    items, error, loading: false, retrying: [], onRefresh: () => {}, onRetry: () => {},
  })),
)

describe('recent imports UI', () => {
  it('does not show import controls without create permission', () => {
    expect(renderToStaticMarkup(createElement(DocumentImports, { canUpload: false }))).toBe('')
  })

  it('starts collapsed when nothing needs attention so the document list stays on top', () => {
    const html = renderToStaticMarkup(createElement(DocumentImports, { canUpload: true }))
    expect(html).toContain('展开导入记录')
    expect(html).toContain('清空记录')
    expect(html).not.toContain('我的最近导入')
    expect(html).not.toContain('在线新建文档')
  })

  it('renders secondary create-document card when onCreateClick is provided', () => {
    const html = renderToStaticMarkup(
      createElement(DocumentImports, { canUpload: true, onCreateClick: () => {} }),
    )
    expect(html).toContain('上传文件，后台自动解析')
    expect(html).toContain('在线新建文档')
  })

  it.each([['uploading', '接收文件'], ['storing', '存储资源'], ['downloading', '下载解析结果']])('labels backend stage %s', (stage, label) => {
    expect(render([{ ...task, stage }])).toContain(`阶段：${label}`)
  })

  it('shows stage labels, warnings, failures and retries without fake progress', () => {
    const html = render([task, { ...task, id: '456', state: 'failed', error: '文件损坏' }])
    expect(html).toContain('原文件.pdf')
    expect(html).toContain('文字识别')
    expect(html).toContain('部分图片未识别')
    expect(html).toContain('文件损坏')
    expect(html).toContain('重试解析')
    expect(html).not.toContain('progressbar')
    expect(html).not.toContain('%')
  })

  it('keeps warnings visible with a completed-document link and poll recovery action', () => {
    const html = render([{ ...task, state: 'completed', documentId: '9007199254740993' }], '状态更新失败')
    expect(html).toContain('href="/documents/9007199254740993"')
    expect(html).toContain('查看文档')
    expect(html).toContain('部分图片未识别')
    expect(html).toContain('状态更新失败')
    expect(html).toContain('刷新任务')
  })

  it('offers per-record dismiss only for finished tasks', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ImportJobList, {
        items: [task, { ...task, id: '456', state: 'completed', documentId: '1' }],
        error: null, loading: false, retrying: [],
        onRefresh: () => {}, onRetry: () => {}, onDismiss: () => {},
      })),
    )
    expect(html.match(/删除记录/g)).toHaveLength(1)
  })

  it('falls back to the raw state label for unknown states instead of crashing', () => {
    const html = render([{ ...task, state: 'paused' as unknown as ImportTaskView['state'] }])
    expect(html).toContain('paused')
  })

  it('renders right-side imports panel with compact cards and empty guidance', () => {
    const jobs = new ImportJobs()
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(DocumentImportsSidebar, {
          controller: {
            jobs,
            state: {
              items: [task],
              loading: false,
              error: null,
              submitting: false,
              uploadError: null,
              canRetryUpload: false,
              retrying: [],
            },
            activeCount: 1,
            failedCount: 0,
            finishedCount: 0,
          },
        }),
      ),
    )
    expect(html).toContain('导入记录')
    expect(html).toContain('处理中 1')
    expect(html).toContain('原文件.pdf')
    expect(html).toContain('阶段：文字识别')
  })
})
