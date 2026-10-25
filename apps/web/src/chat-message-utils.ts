import type { UIMessage } from 'ai'
import type { ChatSource, GraphViewEdge, GraphViewNode } from './types'

export type RetrieveHit = {
  index: number
  documentId: string
  documentTitle: string
  heading: string | null
}

/** 与后端 ChatIntent 一致；kb = 知识库 */
export type ChatIntent =
  | 'chitchat' // 闲聊，不检索
  | 'profile' // 个人偏好，不检索
  | 'kb' // 知识库
  | 'web' // 联网
  | 'kb_then_web' // 先知识库，不足再联网

/** data-intent：本轮路由，决定是否展示知识库/图谱/联网范围 */
export type IntentPart = {
  intent: ChatIntent
  label: string
  query: string
  graphQueries?: string[]
  allowRetrieve: boolean
  allowGraph?: boolean
  allowWeb: boolean
}

/**
 * data-graph / retrieve_graph 的对话图谱命中。
 * 注意与 types.ts 的 GraphHit 区分：后者是 /kg/search 的节点行。
 */
export type ChatGraphHit = {
  query?: string
  entities?: Array<{
    name: string
    type?: string | null
    description?: string | null
  }>
  relations?: Array<{
    source: string
    relation: string
    target: string
    sourceChunkIds?: string[]
  }>
  documents?: Array<{ documentId: string; title: string }>
  error?: string
}

/** data-eval：ok 表示资料切题，不是「有召回条数」 */
export type EvalPart = {
  ok: boolean
  reason:
    | 'ok' // 首轮检索切题
    | 'retried_ok' // 改写后再查切题
    | 'empty' // 首轮无命中
    | 'retried_empty' // 改写后再查仍无命中
    | 'irrelevant' // 首轮有命中但不切题
    | 'retried_irrelevant' // 改写后再查仍不切题
    | 'error' // 检索接口失败
  text: string
  retried: boolean
  query: string
  retryQuery?: string
}

/** 流式消息：标准 part 之外叠加服务端自定义的 data-* 事件 */
export type KhUIMessage = UIMessage<
  unknown,
  {
    status: { stage: string; text: string }
    think: { text: string }
    sources: ChatSource[]
    retrieve: { query: string; items: RetrieveHit[] }
    intent: IntentPart
    eval: EvalPart
    graph: ChatGraphHit
    session: { sessionId: string }
  }
>

/** 多轮检索会写多段 data-sources，取最后一个非空段 */
export function sourcesFromParts(parts: KhUIMessage['parts']): ChatSource[] {
  let latest: ChatSource[] = []
  for (const part of parts) {
    if (part.type !== 'data-sources' || !Array.isArray(part.data)) continue
    if (part.data.length) latest = part.data
  }
  return latest
}

/** 只保留回答里实际标了 [n] 的资料，避免无关召回也占引用区 */
export function citedSources(
  sources: ChatSource[],
  answer: string,
): ChatSource[] {
  const used = new Set(
    [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
  )
  if (!used.size) return []
  return sources.filter((s) => used.has(s.index))
}

/** 对话图谱命中 → 力导向图节点/边；文档到实体按密度补合成提及边。 */
export function graphHitToView(data: ChatGraphHit): {
  nodes: GraphViewNode[]
  edges: GraphViewEdge[]
} {
  const nodes: GraphViewNode[] = []
  const seen = new Set<string>()
  for (const entity of data.entities ?? []) {
    const id = `entity:${entity.name}`
    if (seen.has(id)) continue
    seen.add(id)
    nodes.push({
      id,
      name: entity.name,
      kind: 'entity',
      type: entity.type,
      description: entity.description,
    })
  }
  for (const doc of data.documents ?? []) {
    const id = `doc:${doc.documentId}`
    if (seen.has(id)) continue
    seen.add(id)
    nodes.push({
      id,
      name: doc.title || doc.documentId,
      kind: 'document',
      documentId: doc.documentId,
    })
  }

  const edges: GraphViewEdge[] = []
  const edgeKeys = new Set<string>()
  const pushEdge = (edge: GraphViewEdge) => {
    if (!seen.has(edge.source) || !seen.has(edge.target)) return
    const key = `${edge.kind}\t${edge.source}\t${edge.relation}\t${edge.target}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
  }

  for (const rel of data.relations ?? []) {
    pushEdge({
      source: `entity:${rel.source}`,
      target: `entity:${rel.target}`,
      relation: rel.relation,
      kind: 'related',
    })
  }

  const entityIds = nodes.filter((n) => n.kind === 'entity').map((n) => n.id)
  const docIds = nodes.filter((n) => n.kind === 'document').map((n) => n.id)
  const mentionAll = docIds.length * entityIds.length <= 16
  for (const docId of docIds) {
    const targets = mentionAll ? entityIds : entityIds.slice(0, 1)
    for (const entityId of targets) {
      pushEdge({
        source: docId,
        target: entityId,
        relation: '提及',
        kind: 'mentions',
      })
    }
  }
  return { nodes, edges }
}

export function textFromParts(parts: KhUIMessage['parts']): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => stripInternalToolJson(part.text))
    .filter(Boolean)
    .join('')
}

/** 评估/改写/路由模型的 JSON 不应出现在回答里 */
export function stripInternalToolJson(text: string): string {
  return text
    .split('\n')
    .filter((line) => !isInternalToolJson(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isInternalToolJson(text: string): boolean {
  if (!text.startsWith('{')) return false
  try {
    const obj = JSON.parse(text) as Record<string, unknown>
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return false
    const keys = Object.keys(obj)
    if (keys.includes('relevant') && keys.includes('reason')) return true
    if (keys.length === 1 && keys[0] === 'query') return true
    if (keys.includes('intent') && keys.includes('standalone_query')) return true
    return false
  } catch {
    return false
  }
}

/** 历史消息（行记录）还原成 UIMessage，与实时流共用同一套渲染 */
export function historyToUIMessages(
  rows: Array<{
    id: string
    role: 'user' | 'assistant'
    content: string
    sources?: ChatSource[] | null
  }>,
): KhUIMessage[] {
  return rows.map((row) => {
    if (row.role === 'user') {
      return {
        id: row.id,
        role: 'user',
        parts: [{ type: 'text', text: row.content }],
      }
    }
    const parts: KhUIMessage['parts'] = []
    if (row.sources?.length) {
      parts.push({ type: 'data-sources', data: row.sources })
    }
    parts.push({ type: 'text', text: row.content })
    return { id: row.id, role: 'assistant', parts }
  })
}
