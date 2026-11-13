import { del, get, patch, post, put, request } from './client'
import type {
  AuthUser,
  AuditLogItem,
  CategoryNode,
  CategoryStatItem,
  ChatMessage,
  ChatResult,
  ChatSession,
  ChunkHit,
  CommentItem,
  DocumentItem,
  DocumentOverviewStats,
  DocumentVersionDetail,
  DocumentVersionSummary,
  GraphEdge,
  GraphHit,
  GraphNode,
  GraphOverview,
  ImportTaskView,
  LoginResult,
  MemoryItem,
  NotificationItem,
  PageResult,
  PermissionNode,
  ReviewTask,
  RoleItem,
  SearchHit,
  SearchMode,
  ShareDocument,
  ShareLink,
  SharePreview,
  TeamItem,
  TeamTreeNode,
  UserStats,
  UserVO,
  ViewTrendPoint,
} from '../types'

export const authApi = {
  login: (username: string, password: string) =>
    post<LoginResult>('/auth/login', { username, password }),
  me: () => get<AuthUser>('/auth/me'),
  logout: () => post<{ message: string }>('/auth/logout'),
}

export const documentApi = {
  list: (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    const qs = params.toString()
    return get<PageResult<DocumentItem>>(`/documents${qs ? `?${qs}` : ''}`)
  },
  get: (id: string) => get<DocumentItem>(`/documents/${id}`),
  create: (body: Record<string, unknown>) => post<DocumentItem>('/documents', body),
  update: (id: string, body: Record<string, unknown>) =>
    patch<DocumentItem>(`/documents/${id}`, body),
  remove: (id: string) => del<{ affected?: number }>(`/documents/${id}`),
  publish: (id: string) => put<DocumentItem>(`/documents/${id}/publish`),
  archive: (id: string) => put<DocumentItem>(`/documents/${id}/archive`),
  /** 分类占比统计（只统计当前用户可见文档，未分类归入 null） */
  statsByCategory: () => get<CategoryStatItem[]>('/documents/stats/categories'),
  /** 可见范围内全库概览（首页统计卡；与分类占比同口径） */
  statsOverview: () =>
    get<DocumentOverviewStats>('/documents/stats/overview'),
  /** 访问趋势（近 N 天按日聚合，后端补零，1–30 天） */
  viewTrend: (days = 7) =>
    get<ViewTrendPoint[]>(`/documents/stats/views?days=${days}`),
  saveDraft: (id: string) => put<DocumentItem>(`/documents/${id}/save-draft`),
  uploadParse: (form: FormData, signal?: AbortSignal) =>
    request<ImportTaskView>('/documents/upload/parse', {
      method: 'POST', body: form, signal,
    }),
  imports: (signal?: AbortSignal) =>
    request<{ items: ImportTaskView[] }>('/documents/imports', { signal, cache: 'no-store' }),
  importTask: (id: string, signal?: AbortSignal) =>
    request<ImportTaskView>(`/documents/imports/${encodeURIComponent(id)}`, { signal, cache: 'no-store' }),
  retryImport: (id: string, signal?: AbortSignal) =>
    request<ImportTaskView>(`/documents/imports/${encodeURIComponent(id)}/retry`, { method: 'POST', signal }),
  dismissImport: (id: string) =>
    del<{ dismissed: number }>(`/documents/imports/${encodeURIComponent(id)}`),
  dismissImports: () => del<{ dismissed: number }>('/documents/imports'),
  reviewTasks: (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    const qs = params.toString()
    return get<PageResult<ReviewTask>>(
      `/documents/reviews/tasks${qs ? `?${qs}` : ''}`,
    )
  },
  pendingCount: () => get<number>('/documents/reviews/tasks/pending-count'),
  approve: (taskId: string, reviewComment?: string) =>
    post<DocumentItem>(`/documents/reviews/tasks/${taskId}/approve`, {
      reviewComment,
    }),
  reject: (taskId: string, reviewComment: string) =>
    post<DocumentItem>(`/documents/reviews/tasks/${taskId}/reject`, {
      reviewComment,
    }),
  toggleLike: (id: string) =>
    post<{ liked: boolean; likeCount: number }>(`/documents/${id}/likes`),
  toggleFavorite: (id: string) =>
    post<{ favorited: boolean; favouriteCount: number }>(
      `/documents/${id}/favorites`,
    ),
  comments: (id: string) => get<CommentItem[]>(`/documents/${id}/comments`),
  addComment: (id: string, content: string, parentId?: string) =>
    post<{ comment: CommentItem; commentCount: number }>(
      `/documents/${id}/comments`,
      { content, parentId },
    ),
  removeComment: (id: string, commentId: string) =>
    del<{ commentCount: number }>(`/documents/${id}/comments/${commentId}`),
  shares: (id: string) => get<ShareLink[]>(`/documents/${id}/shares`),
  createShare: (id: string, body: { password?: string; expireDays?: number }) =>
    post<ShareLink>(`/documents/${id}/shares`, body),
  revokeShare: (id: string, shareId: string) =>
    del<{ id: string }>(`/documents/${id}/shares/${shareId}`),
  versions: (id: string) =>
    get<DocumentVersionSummary[]>(`/documents/${id}/versions`),
  version: (id: string, versionId: string) =>
    get<DocumentVersionDetail>(`/documents/${id}/versions/${versionId}`),
  restoreVersion: (id: string, versionId: string) =>
    post<DocumentItem>(`/documents/${id}/versions/${versionId}/restore`),
}

export const categoryApi = {
  tree: () => get<CategoryNode[]>('/categories/tree'),
  create: (body: {
    name: string
    parentId?: string
    sort?: number
    description?: string
  }) => post<CategoryNode>('/categories', body),
  update: (
    id: string,
    body: {
      name?: string
      parentId?: string
      sort?: number
      description?: string
    },
  ) => put<CategoryNode>(`/categories/${id}`, body),
  remove: (id: string) => del<{ id: string }>(`/categories/${id}`),
}

export const favoriteApi = {
  list: (page = 1, pageSize = 20) =>
    get<PageResult<DocumentItem>>(`/favorites?page=${page}&pageSize=${pageSize}`),
}

export const shareApi = {
  preview: (code: string) => get<SharePreview>(`/shares/${code}`),
  access: (code: string, password?: string) =>
    post<ShareDocument>(`/shares/${code}/access`, { password }),
}

export const notificationApi = {
  list: (page = 1, pageSize = 20) =>
    get<PageResult<NotificationItem>>(
      `/notifications?page=${page}&pageSize=${pageSize}`,
    ),
  unreadCount: () => get<{ count: number }>('/notifications/unread-count'),
  markRead: (id: string) => post<NotificationItem>(`/notifications/${id}/read`),
  markAllRead: () => post<{ ok: boolean }>('/notifications/read-all'),
  broadcast: (body: { title: string; content: string; userIds?: string[] }) =>
    post<{ count: number }>('/notifications/broadcast', body),
}

export const searchApi = {
  /** 文档全文搜索（对齐主项目 POST /search/documents） */
  search: (body: {
    keyword?: string
    page?: number
    pageSize?: number
    categoryId?: string
    authorId?: string
    status?: number
  }) => post<PageResult<SearchHit>>('/search/documents', body),
}

export const aiApi = {
  chat: (content: string, topK = 5, sessionId?: string) =>
    post<ChatResult>('/ai/chat', { content, topK, sessionId }),
  /** 纯语义/混合检索（对齐主项目 POST /search，支持三种模式；不落会话） */
  ragSearch: (query: string, topK = 8, mode: SearchMode = 'hybrid') =>
    post<ChunkHit[]>('/search', { query, topK, mode }),
  /** 本人会话分页，最近活跃在前 */
  sessions: (page = 1, pageSize = 50) =>
    get<PageResult<ChatSession>>(`/ai/sessions?page=${page}&pageSize=${pageSize}`),
  /** 新建空会话 */
  createSession: () => post<ChatSession>('/ai/sessions', {}),
  /** 会话历史消息，时间正序 */
  messages: (id: string) => get<ChatMessage[]>(`/ai/sessions/${id}/messages`),
  renameSession: (id: string, title: string) =>
    patch<ChatSession>(`/ai/sessions/${id}`, { title }),
  removeSession: (id: string) => del<{ message: string }>(`/ai/sessions/${id}`),
}

/**
 * 长期记忆治理（feat-v22）
 *
 * session 层必须带 sessionId：后端拿不到 run_id 过滤条件时会返回空页，
 * 而不是退化成「该用户全部记忆」——漏传只会少看，不会看到别人的或跨层的。
 */
export const memoryApi = {
  list: (layer: 'user' | 'session', page = 1, pageSize = 20, sessionId?: string) => {
    const params = new URLSearchParams({
      layer,
      page: String(page),
      pageSize: String(pageSize),
    })
    if (sessionId) params.set('sessionId', sessionId)
    return get<PageResult<MemoryItem>>(`/ai/memory?${params.toString()}`)
  },
  /** Mem0 的记忆 id 是外部字符串，必须转义后再拼进路径 */
  remove: (id: string) =>
    del<{ message: string }>(`/ai/memory/${encodeURIComponent(id)}`),
  /** 清空全部（含各会话上下文），不可恢复 */
  clearAll: () => del<{ message: string }>('/ai/memory'),
}

export const graphApi = {
  /** 全景图谱（对齐主项目 GET /kg/overview） */
  overview: (query: {
    keyword?: string
    entityType?: string
    from?: string
    to?: string
    docLimit?: number
  }) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    const qs = params.toString()
    return get<GraphOverview>(`/kg/overview${qs ? `?${qs}` : ''}`)
  },
  search: (keyword: string, limit = 50) => {
    const params = new URLSearchParams({ keyword, limit: String(limit) })
    return get<GraphHit[]>(`/kg/search?${params}`)
  },
  nodes: (type?: string, limit = 80) => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (type) params.set('type', type)
    return get<GraphNode[]>(`/kg/nodes?${params}`)
  },
  edges: (limit = 120) => get<GraphEdge[]>(`/kg/edges?limit=${limit}`),
}

export const userApi = {
  stats: () => get<UserStats>('/users/me/stats'),
  updateMe: (body: { realName?: string; email?: string; avatar?: string }) =>
    put<UserVO>('/users/me', body),
  changePassword: (oldPassword: string, newPassword: string) =>
    put<{ message: string }>('/users/password/change', {
      oldPassword,
      newPassword,
    }),
  page: (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    return get<PageResult<UserVO>>(`/users/page?${params}`)
  },
  create: (body: Record<string, unknown>) => post<UserVO>('/users', body),
  update: (id: string, body: Record<string, unknown>) =>
    put<UserVO>(`/users/${id}`, body),
  remove: (id: string) => del<{ message: string }>(`/users/${id}`),
  resetPassword: (id: string, newPassword: string) =>
    put<{ message: string }>(`/users/${id}/password/reset`, { newPassword }),
  getRoles: (id: string) =>
    get<{ userId: string; roleCodes: string[] }>(`/users/${id}/roles`),
  assignRoles: (id: string, roleCodes: string[]) =>
    put<{ userId: string; roleCodes: string[] }>(`/users/${id}/roles`, {
      roleCodes,
    }),
  getPermissions: (id: string) =>
    get<{ userId: string; permissionCodes: string[] }>(
      `/users/${id}/permissions`,
    ),
  assignPermissions: (id: string, permissionCodes: string[]) =>
    put<{ userId: string; permissionCodes: string[] }>(
      `/users/${id}/permissions`,
      { permissionCodes },
    ),
}

export const roleApi = {
  list: () => get<RoleItem[]>('/roles/list'),
  create: (body: { roleName: string; roleCode: string; description?: string }) =>
    post<RoleItem>('/roles', body),
  update: (id: string, body: Record<string, unknown>) =>
    put<RoleItem>(`/roles/${id}`, body),
  remove: (id: string) => del<{ message: string }>(`/roles/${id}`),
  permissions: (id: string) =>
    get<{ roleId: string; permissionIds: string[] }>(`/roles/${id}/permissions`),
  assignPermissions: (id: string, permissionIds: string[]) =>
    put<{ roleId: string; permissionIds: string[] }>(
      `/roles/${id}/permissions`,
      {
        permissionIds,
      },
    ),
}

export const permissionApi = {
  tree: () => get<PermissionNode[]>('/permissions/tree'),
}

export const teamApi = {
  page: (query: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') params.set(k, String(v))
    }
    return get<PageResult<TeamItem>>(`/teams/page?${params}`)
  },
  tree: () => get<TeamTreeNode[]>('/teams/tree'),
  mine: () => get<TeamItem[]>('/teams/mine'),
  create: (body: Record<string, unknown>) => post<TeamItem>('/teams', body),
  update: (id: string, body: Record<string, unknown>) =>
    put<TeamItem>(`/teams/${id}`, body),
  remove: (id: string) => del<{ message: string }>(`/teams/${id}`),
  members: (id: string) => get<unknown[]>(`/teams/${id}/members`),
  addMembers: (id: string, userIds: string[]) =>
    post<unknown>(`/teams/${id}/members`, userIds),
  removeMembers: (id: string, userIds: string[]) =>
    del<unknown>(`/teams/${id}/members`, userIds),
}

/** 审计日志（首页「近期操作记录」；管理员看全部，普通用户只看自己的） */
export const auditApi = {
  recent: (limit = 10) => get<AuditLogItem[]>(`/audit/logs?limit=${limit}`),
}
