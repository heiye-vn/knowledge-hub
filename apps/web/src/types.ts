export interface AuthUser {
  userId: string
  username: string
  realName?: string | null
  email?: string | null
  avatar?: string | null
  roles: string[]
  permissions: string[]
  teamIds?: string[]
}

export interface LoginResult {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  expiresIn: number
  userInfo: AuthUser
}

export interface PageResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ImportTaskView {
  id: string
  fileName: string
  state: 'queued' | 'processing' | 'completed' | 'failed'
  stage: string
  documentId: string | null
  warnings: string[]
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface DocumentItem {
  id: string
  title: string
  summary?: string | null
  content?: string
  fileUrl?: string | null
  fileName?: string | null
  categoryId?: string | null
  categoryName?: string | null
  teamId?: string | null
  authorId?: string | null
  tags?: string | null
  status: number
  isPublic: boolean
  viewCount?: number
  likeCount?: number
  commentCount?: number
  favouriteCount?: number
  liked?: boolean
  favorited?: boolean
  wordCount?: number
  publishTime?: string | null
  createdAt?: string
  updatedAt?: string
  remark?: string | null
}

export interface SearchHit {
  id: string
  title: string
  summary?: string | null
  categoryId?: string | null
  tags?: string | null
  authorId?: string | null
  status?: number | null
  publishTime?: string | null
  score: number
  highlight: {
    title: string[]
    summary: string[]
    content: string[]
  }
  teamId?: string | null
  isPublic?: boolean | null
}

export type SearchMode = 'hybrid' | 'vector' | 'keyword'

export interface ChunkHit {
  chunkId: string
  documentId: string
  documentTitle: string
  content: string
  heading: string | null
  score: number
  scores?: {
    vector: number | null
    keyword: number | null
  }
  bm25Score?: number
  vectorScore?: number
}

export interface ChatSource {
  index: number
  documentId: string
  documentTitle: string
  heading: string | null
  excerpt: string
  score: number
}

export interface ChatResult {
  /** 本轮问答落库的会话 ID（服务端自动新建或续用），供续聊与历史回看 */
  sessionId: string | null
  answer: string
  sources: ChatSource[]
}

/** AI 对话会话（kh_ai_session） */
export interface ChatSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

/** AI 会话消息（kh_ai_message，assistant 消息带引用溯源） */
export interface ChatMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  sources?: ChatSource[] | null
  createdAt: string
}

export interface GraphHit {
  id: string
  name: string
  label?: string | null
  type?: string | null
  title?: string | null
  description?: string | null
  heading?: string | null
  documentId?: string | null
  summary?: string | null
  snippet?: string | null
}

export interface GraphViewNode {
  id: string
  name: string
  kind: 'document' | 'entity' | 'tag'
  type?: string | null
  documentId?: string | null
  updatedAt?: string | null
  description?: string | null
}

export interface GraphViewEdge {
  source: string
  target: string
  relation: string
  kind: 'mentions' | 'related' | 'tagged'
}

export interface GraphOverview {
  nodes: GraphViewNode[]
  edges: GraphViewEdge[]
  stats: {
    nodeCount: number
    edgeCount: number
    documentCount: number
    entityCount: number
    tagCount: number
    mentionCount: number
    relatedCount: number
    entityTypes: Array<{ type: string; count: number }>
  }
  topEntities: Array<{ name: string; type: string | null; degree: number }>
  recentNodes: Array<{ id: string; name: string; kind: string; updatedAt: string | null }>
  entityTypes: string[]
}

export interface GraphNode {
  id: string
  name: string
  type?: string | null
  description?: string | null
}

export interface GraphEdge {
  source: string
  target: string
  relation: string
  weight: number
  sourceChunkIds?: string[]
}

export interface UserVO {
  id: string
  username: string
  email?: string | null
  realName?: string | null
  avatar?: string | null
  status: number
  lastLoginAt?: string | null
  createdAt: string
  updatedAt: string
  roleCodes: string[]
}

export interface RoleItem {
  id: string
  roleName: string
  roleCode: string
  description?: string | null
  status?: number
}

export interface TeamItem {
  id: string
  teamName: string
  teamCode?: string | null
  description?: string | null
  leaderId?: string | null
  parentId?: string
  sort?: number
  status?: number
  memberCount?: number
}

export interface TeamTreeNode extends TeamItem {
  children?: TeamTreeNode[]
}

export interface ReviewTask {
  id: string
  documentId: string
  reviewerId?: string | null
  reviewerName?: string | null
  reviewResult?: number | null
  reviewComment?: string | null
  beforeStatus: number
  reviewedAt?: string | null
  createdAt: string
}

export interface UserStats {
  documentCount: number
  viewCount: number
  likeCount: number
  commentCount: number
}

export interface CategoryNode {
  id: string
  name: string
  parentId: string
  sort: number
  description?: string | null
  children?: CategoryNode[]
}

export interface CommentItem {
  id: string
  documentId: string
  userId: string
  userName: string
  content: string
  parentId?: string | null
  createdAt: string
}

export interface ShareLink {
  id: string
  documentId: string
  code: string
  needPassword: boolean
  expireAt?: string | null
  createdAt: string
  expired: boolean
}

export interface SharePreview {
  code: string
  title: string | null
  needPassword: boolean
  expireAt?: string | null
}

export interface ShareDocument {
  title: string
  summary?: string | null
  content: string
  expireAt?: string | null
}

export interface DocumentVersionSummary {
  id: string
  documentId: string
  version: number
  title: string
  summary?: string | null
  createBy?: string | null
  createdAt: string
}

export interface DocumentVersionDetail extends DocumentVersionSummary {
  content: string
}

export interface NotificationItem {
  id: string
  userId: string
  type: 'like' | 'comment' | 'system' | string
  title: string
  content?: string | null
  documentId?: string | null
  senderId?: string | null
  senderName?: string | null
  isRead: boolean
  createdAt: string
}

export interface PermissionNode {
  id: string
  parentId: string
  permissionName: string
  permissionCode: string
  permissionType: number
  children?: PermissionNode[]
}
