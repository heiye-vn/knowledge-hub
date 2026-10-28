import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthenticatedImage, loadPrivateImage } from './AuthenticatedImage'
import { SourceFileAction, downloadDocumentSource } from './SourceFileAction'
import { requestBlob } from '../api/client'

vi.mock('../api/client', async (original) => ({
  ...await original<typeof import('../api/client')>(), requestBlob: vi.fn(),
}))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('private document resources', () => {
  it('never embeds a protected API URL directly in an image and restricts other images to HTTPS', () => {
    const html = renderToStaticMarkup(createElement(AuthenticatedImage, { src: '/documents/1/assets/2', alt: '示意图' }))
    expect(html).not.toContain('<img')
    expect(html).toContain('示意图')
    expect(renderToStaticMarkup(createElement(AuthenticatedImage, { src: 'https://cdn.test/image.png', alt: 'external' })))
      .toContain('src="https://cdn.test/image.png"')
    for (const src of ['http://cdn.test/x', 'javascript:alert(1)', '//evil.test/x', '/documents/1/source']) {
      expect(renderToStaticMarkup(createElement(AuthenticatedImage, { src }))).not.toContain('<img')
    }
    expect(renderToStaticMarkup(createElement(AuthenticatedImage, { src: 'http://localhost:9000/knowledge-hub/pdf-images/a.png', alt: 'legacy' })))
      .toContain('src="http://localhost:9000/knowledge-hub/pdf-images/a.png"')
    expect(requestBlob).not.toHaveBeenCalled()
  })

  it('creates a temporary URL and revokes it on cleanup', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:temporary')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.mocked(requestBlob).mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
    const loaded = vi.fn()
    const failed = vi.fn()
    const stop = loadPrivateImage('/documents/1/assets/2', loaded, failed)
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledWith('blob:temporary'))
    expect(create).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    stop()
    expect(revoke).toHaveBeenCalledWith('blob:temporary')
  })

  it('does not leak an object URL or publish late results after unmount', async () => {
    let resolve!: (blob: Blob) => void
    vi.mocked(requestBlob).mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const create = vi.spyOn(URL, 'createObjectURL')
    const loaded = vi.fn()
    const stop = loadPrivateImage('/documents/1/assets/2', loaded, vi.fn())
    const signal = vi.mocked(requestBlob).mock.calls[0][1]?.signal
    stop()
    expect(signal?.aborted).toBe(true)
    resolve(new Blob(['late']))
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()
    expect(loaded).not.toHaveBeenCalled()
  })

  it('reports forbidden or missing assets with an understandable fallback', async () => {
    const failed = vi.fn()
    const { ApiError } = await import('../api/client')
    for (const status of [403, 404]) {
      vi.mocked(requestBlob).mockRejectedValueOnce(new ApiError(status, 'resource unavailable'))
      const stop = loadPrivateImage('/documents/1/assets/2', vi.fn(), failed)
      await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(expect.stringMatching(/无权|不存在/)))
      stop()
      failed.mockClear()
    }
  })

  it('renders authenticated download as an action and preserves legacy external links', () => {
    const html = renderToStaticMarkup(createElement(SourceFileAction, { fileUrl: '/documents/1/source', fileName: 'paper.pdf' }))
    expect(html).toContain('<button')
    expect(html).toContain('下载原文件')
    expect(html).not.toContain('href="/documents/1/source"')
    expect(renderToStaticMarkup(createElement(SourceFileAction, { fileUrl: 'https://files.test/old.pdf', fileName: 'old.pdf' })))
      .toContain('href="https://files.test/old.pdf"')
    expect(renderToStaticMarkup(createElement(SourceFileAction, { fileUrl: 'javascript:alert(1)', fileName: 'bad' })))
      .not.toContain('href=')
  })

  it('downloads the authenticated blob and releases the URL without persisting it', async () => {
    vi.useFakeTimers()
    vi.mocked(requestBlob).mockResolvedValue(new Blob(['pdf']))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', { createElement: () => anchor, body: { append: vi.fn() } })
    await downloadDocumentSource('/documents/1/source', 'paper.pdf')
    expect(anchor.href).toBe('blob:download')
    expect(anchor.download).toBe('paper.pdf')
    expect(anchor.click).toHaveBeenCalledOnce()
    expect(anchor.remove).toHaveBeenCalledOnce()
    await vi.runAllTimersAsync()
    expect(revoke).toHaveBeenCalledWith('blob:download')
  })
})
