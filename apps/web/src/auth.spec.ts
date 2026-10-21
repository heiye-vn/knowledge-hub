import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from './types'

/**
 * 认证存储：localStorage 是唯一持久层，模块加载时读取用户快照。
 * 每个用例重置模块并换一份内存 Storage，避免模块级 currentUser 串味。
 */
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
  permissions: ['document:list'],
  teamIds: [],
}

describe('auth 存储', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', new MemoryStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setAuth 同时写入双令牌与用户快照', async () => {
    const auth = await import('./auth')

    auth.setAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user,
    })

    expect(auth.getAccessToken()).toBe('access-token')
    expect(auth.getRefreshToken()).toBe('refresh-token')
    expect(auth.getUser()).toEqual(user)
  })

  it('updateUser 只更新用户快照，不影响令牌', async () => {
    const auth = await import('./auth')
    auth.setAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user,
    })

    auth.updateUser({ ...user, realName: '新名字' })

    expect(auth.getUser()?.realName).toBe('新名字')
    expect(auth.getAccessToken()).toBe('access-token')
    expect(auth.getRefreshToken()).toBe('refresh-token')
  })

  it('clearAuth 清空全部本地登录态', async () => {
    const auth = await import('./auth')
    auth.setAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user,
    })

    auth.clearAuth()

    expect(auth.getAccessToken()).toBeNull()
    expect(auth.getRefreshToken()).toBeNull()
    expect(auth.getUser()).toBeNull()
  })

  it('订阅者在登录态变化时收到通知，取消订阅后不再触发', async () => {
    const auth = await import('./auth')
    const listener = vi.fn()
    const unsubscribe = auth.subscribeAuth(listener)

    auth.setAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      user,
    })
    auth.clearAuth()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    auth.setAuth({
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
      user,
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
