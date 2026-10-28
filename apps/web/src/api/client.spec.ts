import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '../types'

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>()

  get length() {
    return this.store.size
  }

  clear() {
    this.store.clear()
  }

  getItem(key: string) {
    return this.store.get(key) ?? null
  }

  key(index: number) {
    return [...this.store.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.store.delete(key)
  }

  setItem(key: string, value: string) {
    this.store.set(key, value)
  }
}

const user: AuthUser = {
  userId: 'u1',
  username: 'user',
  roles: ['ROLE_USER'],
  permissions: ['search'],
  teamIds: [],
}

describe('fetchWithAuthRefresh', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', new MemoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('401 时刷新令牌并用新 token 重试一次', async () => {
    const auth = await import('../auth')
    auth.setAuth({
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
      user,
    })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              accessToken: 'new-access',
              refreshToken: 'new-refresh',
              userInfo: user,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response('stream-ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { fetchWithAuthRefresh } = await import('./client')
    const response = await fetchWithAuthRefresh('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const retryInit = fetchMock.mock.calls[2][1] as RequestInit
    expect(new Headers(retryInit.headers).get('Authorization')).toBe(
      'Bearer new-access',
    )
    expect(auth.getAccessToken()).toBe('new-access')
  })

  it('刷新失败时清理本地登录态并返回原 401', async () => {
    const auth = await import('../auth')
    auth.setAuth({
      accessToken: 'old-access',
      refreshToken: 'refresh-token',
      user,
    })

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const { fetchWithAuthRefresh } = await import('./client')
    const response = await fetchWithAuthRefresh('/api/ai/chat/stream')

    expect(response.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.getAccessToken()).toBeNull()
  })

  it('downloads binary content with the existing refresh flow and API prefix', async () => {
    const auth = await import('../auth')
    auth.setAuth({ accessToken: 'old', refreshToken: 'refresh', user })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: {
        accessToken: 'new', refreshToken: 'next', userInfo: user,
      } })))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 255, 128, 10]), {
        headers: { 'Content-Type': 'image/png' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const client = await import('./client')
    const blob = await client.requestBlob('/api/documents/123/assets/456')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 255, 128, 10])
    expect(blob.type).toBe('image/png')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/documents/123/assets/456')
    expect(new Headers(fetchMock.mock.calls[2][1].headers).get('Authorization')).toBe('Bearer new')
  })

  it('never sends credentials for external or non-exact resource paths', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = await import('./client')
    for (const path of [
      'https://evil.test/documents/1/assets/2', '//evil.test/documents/1/assets/2',
      '/documents/1/assets/2?redirect=https://evil.test', '/documents/1/assets/../source',
      '/documents/1/assets/2#hash', '/documents/1/assets/2/extra', '/documents/abc/source',
    ]) {
      await expect(client.requestBlob(path)).rejects.toThrow()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['/gateway/', '/', 'https://api.test/v1/'])('supports configured VITE_API_BASE %s without double prefixes', async (base) => {
    vi.stubEnv('VITE_API_BASE', base)
    const fetchMock = vi.fn().mockImplementation(async () => new Response('file'))
    vi.stubGlobal('fetch', fetchMock)
    const client = await import('./client')
    const prefix = base === '/' ? '' : base.replace(/\/+$/, '')
    await client.requestBlob(`${prefix}/documents/123/source`)
    expect(fetchMock.mock.calls[0][0]).toBe(`${prefix}/documents/123/source`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', cache: 'no-store' })
  })

  it('preserves JSON response unwrapping for created import tasks', async () => {
    const task = { id: '123', fileName: 'x.pdf', state: 'queued', stage: 'queued', documentId: null, warnings: [], error: null, createdAt: 'now', updatedAt: 'now' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 201, message: 'success', data: task }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = await import('./client')
    const form = new FormData()
    form.append('requestId', '9d78208e-0988-45b2-bd32-3c7a40676f81')
    expect(await client.request('/documents/upload/parse', { method: 'POST', body: form })).toEqual(task)
    expect(new Headers(fetchMock.mock.calls[0][1].headers).has('Content-Type')).toBe(false)
  })

  it('shares a single refresh between concurrent JSON and binary requests', async () => {
    const auth = await import('../auth')
    auth.setAuth({ accessToken: 'old', refreshToken: 'refresh', user })
    const fetchMock = vi.fn().mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/auth/refresh')) return new Response(JSON.stringify({ data: { accessToken: 'new', refreshToken: 'next', userInfo: user } }))
      if (new Headers(init?.headers).get('Authorization') !== 'Bearer new') return new Response('', { status: 401 })
      return path.endsWith('/source') ? new Response('binary') : new Response(JSON.stringify({ code: 200, data: { items: [] } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = await import('./client')
    const [json, blob] = await Promise.all([client.request('/documents/imports'), client.requestBlob('/documents/1/source')])
    expect(json).toEqual({ items: [] })
    expect(await blob.text()).toBe('binary')
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith('/auth/refresh'))).toHaveLength(1)
  })

  it('does not restore a previous account after a refresh completes during account change', async () => {
    const auth = await import('../auth')
    auth.setAuth({ accessToken: 'old', refreshToken: 'refresh', user })
    let finish!: (response: Response) => void
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const client = await import('./client')
    const refresh = client.refreshAccessToken()
    auth.setAuth({ accessToken: 'other-access', refreshToken: 'other-refresh', user: { ...user, userId: 'other' } })
    finish(new Response(JSON.stringify({ data: { accessToken: 'stale', refreshToken: 'stale-refresh', userInfo: user } })))
    expect(await refresh).toBe(false)
    expect(auth.getAccessToken()).toBe('other-access')
    expect(auth.getUser()?.userId).toBe('other')
  })

  it('does not refresh or retry an aborted binary request', async () => {
    const auth = await import('../auth')
    auth.setAuth({ accessToken: 'old', refreshToken: 'refresh', user })
    const controller = new AbortController()
    const fetchMock = vi.fn().mockImplementation(async () => {
      controller.abort()
      return new Response('', { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = await import('./client')
    await expect(client.requestBlob('/documents/1/source', { signal: controller.signal })).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.getAccessToken()).toBe('old')
  })

  it('shows binary resource errors instead of decoding them as successful blobs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: '无权访问资源' }), { status: 403 },
    )))
    const client = await import('./client')
    await expect(client.requestBlob('/documents/123/source')).rejects.toMatchObject({
      status: 403, message: '无权访问资源',
    })
  })
})
