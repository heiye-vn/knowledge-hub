import type { AuthUser, TeamTreeNode } from './types'

export const DOC_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: '草稿', color: 'default' },
  1: { label: '已发布', color: 'success' },
  2: { label: '已归档', color: 'warning' },
  3: { label: '待审核', color: 'processing' },
}

export function formatTime(value?: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function can(user: AuthUser | null, code: string) {
  if (!user) return false
  if (user.roles.includes('ROLE_ADMIN') || user.permissions.includes('*')) return true
  return user.permissions.includes(code)
}

export function isAdmin(user: AuthUser | null) {
  return Boolean(user?.roles.includes('ROLE_ADMIN'))
}

export function isReviewer(user: AuthUser | null) {
  return Boolean(
    user?.roles.includes('ROLE_ADMIN') || user?.roles.includes('ROLE_REVIEWER'),
  )
}

export function displayName(user: AuthUser | null) {
  if (!user) return '未登录'
  return user.realName?.trim() || user.username
}

/** ES 高亮只保留 em 标签，转义其他 HTML 避免 XSS */
export function safeHighlight(html?: string) {
  if (!html) return ''
  return html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;em&gt;/g, '<em>')
    .replace(/&lt;\/em&gt;/g, '</em>')
}

/** 通用 HTML 转义：拼入 tooltip 等 HTML 字符串前必须处理用户/模型可控文本 */
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 写权限守卫：系统管理员或作者本人可编辑/删除/发布 */
export function canWriteDocument(
  doc: { authorId?: string | null },
  user?: AuthUser | null,
): boolean {
  if (!user) return false
  if (user.roles.includes('ROLE_ADMIN') || user.permissions.includes('*')) return true
  return Boolean(doc.authorId && user.userId === doc.authorId)
}

/** 可见性标签与样式元信息 */
export function getVisibilityMeta(doc: {
  isPublic?: boolean | null
  teamId?: string | null
}) {
  if (doc.isPublic) return { label: '公开', color: 'green', scope: 'public' as const }
  if (doc.teamId) return { label: '团队', color: 'blue', scope: 'team' as const }
  return { label: '个人', color: 'purple', scope: 'private' as const }
}

export interface FlatTeamOption {
  id: string
  name: string
  depth: number
}

/** 递归扁平化团队树为下拉选项列表（带全角空格缩进展示层级） */
export function flattenTeams(nodes: TeamTreeNode[], depth = 0): FlatTeamOption[] {
  const result: FlatTeamOption[] = []
  for (const node of nodes) {
    result.push({
      id: node.id,
      name: `${'　'.repeat(depth)}${node.teamName}`,
      depth,
    })
    if (node.children && node.children.length > 0) {
      result.push(...flattenTeams(node.children, depth + 1))
    }
  }
  return result
}
