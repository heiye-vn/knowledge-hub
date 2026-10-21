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
})
