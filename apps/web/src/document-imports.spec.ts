import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImportJobs, validateUploadFile } from './document-imports'
import type { ImportTaskView } from './types'

const task = (state: ImportTaskView['state'] = 'queued'): ImportTaskView => ({
  id: '123', fileName: 'notes.md', state, stage: state,
  documentId: state === 'completed' ? '9007199254740993' : null,
  warnings: [], error: state === 'failed' ? '解析失败' : null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
})
const api = () => ({
  imports: vi.fn().mockResolvedValue({ items: [] }),
  importTask: vi.fn().mockResolvedValue(task('completed')),
  retryImport: vi.fn().mockResolvedValue(task()),
  uploadParse: vi.fn().mockResolvedValue(task()),
  dismissImport: vi.fn().mockResolvedValue({ dismissed: 1 }),
  dismissImports: vi.fn().mockResolvedValue({ dismissed: 2 }),
})
const stores: ImportJobs[] = []
const create = (backend = api()) => {
  const store = new ImportJobs(backend)
  stores.push(store)
  return { store, backend }
}
afterEach(() => { stores.forEach((store) => store.stop()); stores.length = 0; vi.useRealTimers() })

describe('owned import jobs', () => {
  it('validates the exact supported extensions and 50MB limit before upload', () => {
    for (const name of ['x.PDF', 'x.docx', 'x.pptx', 'x.xlsx', 'x.txt', 'x.md', 'x.png', 'x.jpg', 'x.jpeg', 'x.webp']) {
      expect(validateUploadFile({ name, size: 50 * 1024 * 1024 })).toBeNull()
    }
    for (const name of ['x.exe', 'x.doc', 'x.svg', 'x.html', 'noextension']) {
      expect(validateUploadFile({ name, size: 1 })).toBeTruthy()
    }
    expect(validateUploadFile({ name: 'x.pdf', size: 50 * 1024 * 1024 + 1 })).toBeTruthy()
  })

  it('loads server history, polls active jobs with one list request, and stops on completion', async () => {
    vi.useFakeTimers()
    const { store, backend } = create()
    backend.imports
      .mockResolvedValueOnce({ items: [task(), { ...task('failed'), id: 'other' }] })
      .mockResolvedValueOnce({ items: [task('completed'), { ...task('failed'), id: 'other' }] })
    await store.start()
    expect(store.getSnapshot().items).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.getSnapshot().items[0].documentId).toBe('9007199254740993')
    expect(backend.imports).toHaveBeenCalledTimes(2)
    expect(backend.importTask).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(9000)
    expect(backend.imports).toHaveBeenCalledTimes(2)
  })

  it('ends loading and pauses polling on errors with explicit refresh recovery', async () => {
    vi.useFakeTimers()
    const { store, backend } = create()
    backend.imports.mockRejectedValueOnce(new Error('offline'))
    await store.start()
    expect(store.getSnapshot().loading).toBe(false)
    expect(store.getSnapshot().error).toContain('offline')
    backend.imports.mockResolvedValue({ items: [task()] })
    await store.refresh()
    backend.imports.mockRejectedValueOnce(new Error('poll failed'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.getSnapshot().error).toContain('poll failed')
    const callsAfterError = backend.imports.mock.calls.length
    await vi.advanceTimersByTimeAsync(9000)
    expect(backend.imports).toHaveBeenCalledTimes(callsAfterError)
    await store.refresh()
    backend.imports.mockResolvedValue({ items: [task('completed')] })
    await vi.advanceTimersByTimeAsync(3000)
    expect(store.getSnapshot().items[0].state).toBe('completed')
  })

  it('prevents duplicate sends and retains UUID + metadata for network retry', async () => {
    const { store, backend } = create()
    await store.start()
    let reject!: (error: Error) => void
    backend.uploadParse.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const file = new File(['# notes'], 'notes.md')
    const send = store.upload(file, { title: 'Notes', teamId: '999' })
    expect(store.getSnapshot().submitting).toBe(true)
    await store.upload(file)
    expect(backend.uploadParse).toHaveBeenCalledTimes(1)
    const firstForm = backend.uploadParse.mock.calls[0][0] as FormData
    expect(firstForm.get('requestId')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(firstForm.get('teamId')).toBe('999')
    reject(new Error('network disconnected'))
    await send
    expect(store.getSnapshot().submitting).toBe(false)
    expect(store.getSnapshot().uploadError).toContain('network disconnected')
    await store.retryUpload()
    expect(backend.uploadParse.mock.calls[1][0]).toBe(firstForm)
    expect(store.getSnapshot().items[0].state).toBe('queued')
    expect(store.getSnapshot().submitting).toBe(false)
    await store.upload(new File(['next'], 'next.md'))
    expect((backend.uploadParse.mock.calls[2][0] as FormData).get('requestId')).not.toBe(firstForm.get('requestId'))
  })

  it('retries a failed task without reuploading the source', async () => {
    const { store, backend } = create()
    backend.imports.mockResolvedValue({ items: [task('failed')] })
    await store.start()
    await store.retry('123')
    expect(store.getSnapshot().items[0].state).toBe('queued')
    expect(backend.retryImport.mock.calls[0][0]).toBe('123')
    expect(backend.uploadParse).not.toHaveBeenCalled()
  })

  it('does not submit files rejected by client validation', async () => {
    const { store, backend } = create()
    await store.start()
    await store.upload(new File(['script'], 'bad.svg'))
    expect(backend.uploadParse).not.toHaveBeenCalled()
    expect(store.getSnapshot().uploadError).toContain('不支持')
    expect(store.getSnapshot().canRetryUpload).toBe(false)
  })

  it('does not lose an uploaded task when an older history response arrives', async () => {
    const { store, backend } = create()
    let finish!: (value: { items: ImportTaskView[] }) => void
    backend.imports.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const initial = store.start()
    await store.upload(new File(['content'], 'notes.md'))
    finish({ items: [] })
    await initial
    expect(store.getSnapshot().items[0].id).toBe('123')
  })

  it('dismisses one record locally only after the server confirms', async () => {
    const { store, backend } = create()
    backend.imports.mockResolvedValue({ items: [task('completed'), { ...task('failed'), id: 'other' }] })
    await store.start()
    await store.dismiss('123')
    expect(backend.dismissImport).toHaveBeenCalledWith('123')
    expect(store.getSnapshot().items.map((item) => item.id)).toEqual(['other'])
    backend.dismissImport.mockRejectedValueOnce(new Error('forbidden'))
    await store.dismiss('other')
    expect(store.getSnapshot().items).toHaveLength(1)
    expect(store.getSnapshot().error).toContain('forbidden')
  })

  it('clears finished records while keeping active tasks in the list', async () => {
    const { store, backend } = create()
    backend.imports.mockResolvedValue({
      items: [task(), { ...task('completed'), id: 'done' }, { ...task('failed'), id: 'bad' }],
    })
    await store.start()
    await store.dismissAll()
    expect(backend.dismissImports).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().items.map((item) => item.id)).toEqual(['123'])
  })

  it('restarts cleanly after StrictMode cleanup during the initial history request', async () => {
    const { store, backend } = create()
    let finish!: (value: { items: ImportTaskView[] }) => void
    backend.imports.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const initial = store.start()
    store.stop()
    backend.imports.mockResolvedValue({ items: [task('completed')] })
    await store.start()
    finish({ items: [task()] })
    await initial
    expect(store.getSnapshot().loading).toBe(false)
    expect(store.getSnapshot().items[0].state).toBe('completed')
  })

  it('cleans timers, aborts requests and ignores late responses after unmount', async () => {
    vi.useFakeTimers()
    const { store, backend } = create()
    backend.imports.mockResolvedValue({ items: [task()] })
    await store.start()
    let finish!: (value: { items: ImportTaskView[] }) => void
    backend.imports.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(backend.imports).toHaveBeenCalledTimes(2)
    const signal = backend.imports.mock.calls[1][0] as AbortSignal
    store.stop()
    expect(signal.aborted).toBe(true)
    finish({ items: [task('completed')] })
    await vi.advanceTimersByTimeAsync(9000)
    expect(store.getSnapshot().items[0].state).toBe('queued')
    expect(backend.imports).toHaveBeenCalledTimes(2)
    const nextUser = create().store
    await nextUser.start()
    expect(nextUser.getSnapshot().items).toEqual([])
  })
})
