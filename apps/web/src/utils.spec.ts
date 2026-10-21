import { describe, expect, it } from 'vitest'
import {
  can,
  canWriteDocument,
  getVisibilityMeta,
  isAdmin,
  isReviewer,
} from './utils'
import type { AuthUser } from './types'

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: 'u1',
    username: 'user',
    roles: ['ROLE_USER'],
    permissions: [],
    teamIds: [],
    ...overrides,
  }
}

describe('权限工具', () => {
  it('未登录用户没有任何权限', () => {
    expect(can(null, 'document:list')).toBe(false)
    expect(isAdmin(null)).toBe(false)
    expect(isReviewer(null)).toBe(false)
    expect(canWriteDocument({ authorId: 'u1' }, null)).toBe(false)
  })

  it('管理员与通配权限短路放行', () => {
    expect(can(makeUser({ roles: ['ROLE_ADMIN'] }), 'anything')).toBe(true)
    expect(can(makeUser({ permissions: ['*'] }), 'anything')).toBe(true)
    expect(isAdmin(makeUser({ roles: ['ROLE_ADMIN'] }))).toBe(true)
  })

  it('普通用户只命中显式权限码', () => {
    const user = makeUser({ permissions: ['document:list'] })
    expect(can(user, 'document:list')).toBe(true)
    expect(can(user, 'document:delete')).toBe(false)
  })

  it('审核员身份包含管理员', () => {
    expect(isReviewer(makeUser({ roles: ['ROLE_REVIEWER'] }))).toBe(true)
    expect(isReviewer(makeUser({ roles: ['ROLE_ADMIN'] }))).toBe(true)
    expect(isReviewer(makeUser())).toBe(false)
  })

  it('写权限：作者本人或管理员', () => {
    const author = makeUser({ userId: 'u1' })
    const other = makeUser({ userId: 'u2' })
    const admin = makeUser({ userId: 'u2', roles: ['ROLE_ADMIN'] })

    expect(canWriteDocument({ authorId: 'u1' }, author)).toBe(true)
    expect(canWriteDocument({ authorId: 'u1' }, other)).toBe(false)
    expect(canWriteDocument({ authorId: 'u1' }, admin)).toBe(true)
    expect(canWriteDocument({ authorId: null }, author)).toBe(false)
  })

  it('可见性标签按公开 / 团队 / 个人降级', () => {
    expect(getVisibilityMeta({ isPublic: true, teamId: 't1' }).scope).toBe(
      'public',
    )
    expect(getVisibilityMeta({ isPublic: false, teamId: 't1' }).scope).toBe(
      'team',
    )
    expect(getVisibilityMeta({}).scope).toBe('private')
  })
})
