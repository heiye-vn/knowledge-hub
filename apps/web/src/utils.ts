import type { AuthUser, CategoryNode, TeamTreeNode } from './types'

export interface DocStatusMeta {
  code: number
  label: string
  color: string
  variant: 'filled' | 'solid'
  /** 是否写入搜索 / RAG / 图谱索引（可供搜索与 AI 问答命中） */
  searchable: boolean
  /** 面向业务人员的简明状态说明 */
  description: string
}

export const DOC_STATUS: Record<number, DocStatusMeta> = {
  0: {
    code: 0,
    label: '草稿',
    color: 'default',
    variant: 'filled',
    searchable: false,
    description: '编写或修改中的未上线内容；可直接编辑、版本回滚或提交发布。',
  },
  1: {
    code: 1,
    label: '已发布',
    color: '#16a34a',
    variant: 'solid',
    searchable: true,
    description:
      '正式生效的活跃知识；如需修改请先点「下架编辑」转为草稿，过时作废可点「归档」。',
  },
  2: {
    code: 2,
    label: '已归档',
    color: '#b45309',
    variant: 'solid',
    searchable: false,
    description:
      '已下线并只读封存的历史档案，保留正文与版本备查，不可编辑或重新发布。',
  },
  3: {
    code: 3,
    label: '待审核',
    color: '#2352a0',
    variant: 'solid',
    searchable: false,
    description:
      '已提交审批，内容暂时锁定不可编辑或删除；如需修改可先撤回提审，审核通过后自动发布，驳回后退回草稿。',
  },
}

/** 按业务生命周期顺序排列的状态列表（草稿 → 待审核 → 已发布 → 已归档） */
export const DOC_STATUS_LIST: DocStatusMeta[] = [
  DOC_STATUS[0],
  DOC_STATUS[3],
  DOC_STATUS[1],
  DOC_STATUS[2],
]

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

export interface FlatCategoryOption {
  id: string
  name: string
  label: string
}

/** 分类树打平为下拉选项，子分类用全角空格缩进 */
export function flattenCategories(
  nodes: CategoryNode[],
  depth = 0,
): FlatCategoryOption[] {
  const result: FlatCategoryOption[] = []
  for (const node of nodes) {
    result.push({
      id: node.id,
      name: node.name,
      label: `${'　'.repeat(depth)}${node.name}`,
    })
    if (node.children?.length) {
      result.push(...flattenCategories(node.children, depth + 1))
    }
  }
  return result
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

/** 格式化文件字节数为可读体积（B / KB / MB / GB） */
export function formatFileSize(bytes?: string | number | null): string {
  if (bytes === null || bytes === undefined || bytes === '') return ''
  const size = Number(bytes)
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
