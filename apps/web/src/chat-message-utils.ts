import type { UIMessage } from 'ai'
import type { ChatSource } from './types'

export type RetrieveHit = {
  index: number
  documentId: string
  documentTitle: string
  heading: string | null
}

/** 流式消息：标准 part 之外叠加服务端自定义的 data-* 事件 */
export type KhUIMessage = UIMessage<
  unknown,
  {
    status: { stage: string; text: string }
    think: { text: string }
    sources: ChatSource[]
    retrieve: { query: string; items: RetrieveHit[] }
    session: { sessionId: string }
  }
>

export function sourcesFromParts(parts: KhUIMessage['parts']): ChatSource[] {
  for (const part of parts) {
    if (part.type === 'data-sources' && Array.isArray(part.data)) {
      return part.data
    }
  }
  return []
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

export function textFromParts(parts: KhUIMessage['parts']): string {
  return parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
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
