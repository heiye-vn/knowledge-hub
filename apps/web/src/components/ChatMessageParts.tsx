import { useState, type ReactNode } from 'react'
import { getToolName, isToolUIPart } from 'ai'
import { AnswerMarkdown, SourceCiteList } from './SourceCiteList'
import {
  citedSources,
  sourcesFromParts,
  stripInternalToolJson,
  textFromParts,
  type EvalPart,
  type IntentPart,
  type KhUIMessage,
  type RetrieveHit,
} from '../chat-message-utils'

type WebSearchHit = {
  title: string
  url: string
  snippet: string
  siteName?: string
}

type WebSearchResult = {
  query: string
  items: WebSearchHit[]
  provider?: string
  error?: string
}

type ToolPartLike = {
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

/**
 * 按消息的 part 类型渲染过程时间线与正文：
 * 意图 → 知识库检索 → 评估 → 改写 → 再检索 → 联网 → 思考 → 正文 → 引用。
 */
export function ChatMessageParts({
  messageId,
  parts,
  role,
  showSources = true,
}: {
  messageId: string
  parts: KhUIMessage['parts']
  role: KhUIMessage['role']
  showSources?: boolean
}) {
  const sources = citedSources(sourcesFromParts(parts), textFromParts(parts))
  const [activeCite, setActiveCite] = useState<number | null>(null)
  const texts = parts.filter((part) => {
    if (part.type !== 'text' || !part.text) return false
    return Boolean(stripInternalToolJson(part.text))
  })

  if (role === 'user') {
    return (
      <>
        {texts.map((part, i) =>
          part.type === 'text' ? (
            <div key={i} className="kh-bubble-text">
              {part.text}
            </div>
          ) : null,
        )}
      </>
    )
  }

  const hasRetrieve = parts.some(
    (part) =>
      part.type === 'data-retrieve' ||
      (isToolUIPart(part) && getToolName(part) === 'retrieve_knowledge'),
  )
  const hasIntent = parts.some((part) => part.type === 'data-intent')
  const hasRewrite = parts.some(
    (part) => isToolUIPart(part) && getToolName(part) === 'rewrite_query',
  )

  return (
    <>
      {renderProcessParts(parts, hasRetrieve, hasIntent, hasRewrite)}
      {texts.map((part, i) =>
        part.type === 'text' ? (
          <div key={`text-${i}`} className="kh-bubble-md">
            <AnswerMarkdown
              text={stripInternalToolJson(part.text)}
              sources={sources}
              scope={messageId}
              onCite={setActiveCite}
            />
          </div>
        ) : null,
      )}
      {showSources && sources.length ? (
        <SourceCiteList
          items={sources}
          scope={messageId}
          activeIndex={activeCite}
          onSelect={setActiveCite}
        />
      ) : null}
    </>
  )
}

/** 回答正文前的过程条：意图 → 检索 → 评估 → 改写 → 再检索 → 联网 → 思考。 */
function renderProcessParts(
  parts: KhUIMessage['parts'],
  hasRetrieve: boolean,
  hasIntent: boolean,
  hasRewrite: boolean,
) {
  const nodes: ReactNode[] = []
  let reasoningBuf: string[] = []
  let reasoningStreaming = false
  let thinkKey = 0

  const flushReasoning = () => {
    if (!reasoningBuf.length) return
    nodes.push(
      <ThinkBlock
        key={`think-${thinkKey}`}
        text={reasoningBuf.join('\n\n')}
        streaming={reasoningStreaming}
      />,
    )
    thinkKey += 1
    reasoningBuf = []
    reasoningStreaming = false
  }

  parts.forEach((part, i) => {
    if (part.type === 'reasoning' || part.type === 'data-think') {
      const text =
        'text' in part && typeof part.text === 'string' ? part.text : ''
      if (text) reasoningBuf.push(text)
      if ('state' in part && part.state === 'streaming') reasoningStreaming = true
      return
    }

    flushReasoning()

    if (
      part.type === 'step-start' ||
      part.type === 'data-session' ||
      part.type === 'data-sources' ||
      part.type === 'source-document' ||
      part.type === 'text'
    ) {
      return
    }

    if (part.type === 'data-status') {
      if (part.data.stage === 'generate') return
      if (part.data.stage === 'retrieve' && hasRetrieve) return
      if (part.data.stage === 'intent' && hasIntent) return
      if (part.data.stage === 'rewrite' && hasRewrite) return
      nodes.push(
        <TraceItem key={i} kind="status" tone="pending">
          <div className="kh-trace-status">{part.data.text}</div>
        </TraceItem>,
      )
      return
    }

    if (part.type === 'data-intent') {
      nodes.push(<IntentCard key={i} data={part.data} />)
      return
    }

    if (part.type === 'data-eval') {
      nodes.push(<EvalCard key={i} data={part.data} />)
      return
    }

    if (part.type === 'data-retrieve') {
      nodes.push(
        <RetrieveCard key={i} query={part.data.query} items={part.data.items} />,
      )
      return
    }

    if (isToolUIPart(part) && getToolName(part) === 'retrieve_knowledge') {
      nodes.push(
        <RetrieveToolCard key={i} part={part as unknown as ToolPartLike} />,
      )
      return
    }

    if (isToolUIPart(part) && getToolName(part) === 'rewrite_query') {
      nodes.push(
        <RewriteToolCard key={i} part={part as unknown as ToolPartLike} />,
      )
      return
    }

    if (part.type === 'source-url') {
      nodes.push(
        <a
          key={i}
          className="kh-web-link"
          href={part.url}
          target="_blank"
          rel="noreferrer"
        >
          {part.title || part.url}
        </a>,
      )
      return
    }

    if (isToolUIPart(part) && getToolName(part) === 'web_search') {
      nodes.push(
        <WebSearchCard key={i} part={part as unknown as ToolPartLike} />,
      )
    }
  })

  flushReasoning()
  if (!nodes.length) return null
  return <div className="kh-trace">{nodes}</div>
}

function TraceItem({
  kind,
  tone,
  children,
}: {
  kind: string
  tone?: string
  children: ReactNode
}) {
  return (
    <div className={`kh-trace-item kh-trace-${kind}${tone ? ` ${tone}` : ''}`}>
      <span className="kh-trace-node" aria-hidden />
      <div className="kh-trace-card">{children}</div>
    </div>
  )
}

function IntentCard({ data }: { data: IntentPart }) {
  return (
    <TraceItem kind="intent">
      <div className="kh-panel">
        <div className="kh-panel-head">
          <span className="kh-panel-type">意图识别</span>
          <span className="kh-panel-title">{data.label}</span>
        </div>
        <dl className="kh-meta">
          {data.query ? (
            <div>
              <dt>建议检索词</dt>
              <dd>{data.query}</dd>
            </div>
          ) : null}
          <div>
            <dt>范围</dt>
            <dd>
              <span className={data.allowRetrieve ? 'on' : 'off'}>知识库</span>
              <span className={data.allowWeb ? 'on' : 'off'}>联网</span>
            </dd>
          </div>
        </dl>
      </div>
    </TraceItem>
  )
}

function EvalCard({ data }: { data: EvalPart }) {
  const tone = !data.ok ? 'failed' : data.retried ? 'warn' : 'ok'
  const stamp = !data.ok ? '不足' : data.retried ? '再次检索' : '切题'
  return (
    <TraceItem kind="eval" tone={tone}>
      <div className="kh-panel">
        <div className="kh-panel-head">
          <span className="kh-panel-type">检索评估</span>
          <span className={`kh-badge ${tone}`}>{stamp}</span>
          <span className="kh-panel-title">{data.text}</span>
        </div>
        {data.query || data.retryQuery ? (
          <dl className="kh-meta">
            {data.query ? (
              <div>
                <dt>检索词</dt>
                <dd>{data.query}</dd>
              </div>
            ) : null}
            {data.retryQuery ? (
              <div>
                <dt>再次检索词</dt>
                <dd>{data.retryQuery}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </TraceItem>
  )
}

function RetrieveHits({ items }: { items: RetrieveHit[] }) {
  return (
    <ol className="kh-sheet-docs">
      {items.map((hit) => (
        <li key={`${hit.documentId}-${hit.index}`}>
          <em>{String(hit.index).padStart(2, '0')}</em>
          <span>
            {hit.documentTitle}
            {hit.heading ? <small>{hit.heading}</small> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

function RetrieveCard({
  query,
  items,
}: {
  query: string
  items: RetrieveHit[]
}) {
  const count = items.length
  return (
    <KbPanel
      pending={false}
      failed={!count}
      label={count ? '已检索可见文档' : '未检索到相关资料'}
      query={query}
      count={count}
    >
      {count ? <RetrieveHits items={items} /> : null}
    </KbPanel>
  )
}

function ThinkBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <TraceItem kind="think" tone={streaming ? 'pending' : undefined}>
      <details className="kh-note" open>
        <summary className="kh-panel-head">
          <span className="kh-panel-type">思考过程</span>
          <span className="kh-panel-title">{streaming ? '思考中…' : '已完成'}</span>
        </summary>
        <p className="kh-note-body">{text}</p>
      </details>
    </TraceItem>
  )
}

function KbPanel({
  pending,
  failed,
  label,
  query,
  count,
  error,
  children,
}: {
  pending: boolean
  failed: boolean
  label: string
  query?: string
  count?: number
  error?: string
  children?: ReactNode
}) {
  const tone = pending ? 'pending' : failed ? 'failed' : 'ok'
  return (
    <TraceItem kind="kb" tone={tone}>
      <details className="kh-sheet" open>
        <summary className="kh-panel-head">
          <span className="kh-panel-type">知识库</span>
          <span className="kh-panel-title">{label}</span>
          {query ? <span className="kh-panel-sub">{query}</span> : null}
          {count ? <b className="kh-panel-n">{count}</b> : null}
        </summary>
        {error ? <div className="kh-step-err">{error}</div> : children}
      </details>
    </TraceItem>
  )
}

function RetrieveToolCard({ part }: { part: ToolPartLike }) {
  const input = asRecord(part.input)
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available'
  const rec = parseToolPayload(part.output)
  const query =
    (typeof rec?.query === 'string' && rec.query) ||
    (typeof input.query === 'string' ? input.query : '')
  const items = Array.isArray(rec?.items) ? (rec.items as RetrieveHit[]) : []
  const failed = part.state === 'output-error' || typeof rec?.error === 'string'
  const label = pending
    ? '正在检索知识库'
    : failed
      ? '检索失败'
      : items.length
        ? '已检索可见文档'
        : '未检索到相关资料'

  return (
    <KbPanel
      pending={pending}
      failed={failed || !items.length}
      label={label}
      query={query}
      count={!pending && items.length ? items.length : undefined}
      error={failed ? String(rec?.error || part.errorText || '检索失败') : undefined}
    >
      {!failed && items.length ? <RetrieveHits items={items} /> : null}
    </KbPanel>
  )
}

function RewriteToolCard({ part }: { part: ToolPartLike }) {
  const rec = parseToolPayload(part.output)
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available'
  const failed = part.state === 'output-error' || typeof rec?.error === 'string'
  const query = typeof rec?.query === 'string' ? rec.query : ''
  const previous =
    typeof rec?.previousQuery === 'string' ? rec.previousQuery : ''
  const tone = pending ? 'pending' : failed ? 'failed' : 'ok'
  const title = pending ? '正在改写检索词' : failed ? '改写失败' : '已改写检索词'

  return (
    <TraceItem kind="rewrite" tone={tone}>
      <div className="kh-panel">
        <div className="kh-panel-head">
          <span className="kh-panel-type">改写</span>
          <span className="kh-panel-title">{title}</span>
        </div>
        {failed ? (
          <div className="kh-step-err">
            {String(rec?.error || part.errorText || '改写失败')}
          </div>
        ) : previous || query ? (
          <dl className="kh-meta">
            {previous ? (
              <div>
                <dt>上次</dt>
                <dd>{previous}</dd>
              </div>
            ) : null}
            {query ? (
              <div>
                <dt>新检索词</dt>
                <dd>{query}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </TraceItem>
  )
}

function WebSearchCard({ part }: { part: ToolPartLike }) {
  const input = asRecord(part.input)
  const query = typeof input.query === 'string' ? input.query : ''
  const pending =
    part.state === 'input-streaming' || part.state === 'input-available'
  const output = asWebSearchResult(part.output)
  const failed = part.state === 'output-error' || Boolean(output?.error)
  const count = output?.items?.length ?? 0
  const providerLabel = output?.provider
    ? output.provider.charAt(0).toUpperCase() + output.provider.slice(1)
    : ''
  const label = pending
    ? '正在搜索公开信息'
    : failed
      ? '搜索失败'
      : `已搜索公开信息${providerLabel ? ` · ${providerLabel}` : ''}`
  const tone = pending ? 'pending' : failed ? 'failed' : count ? 'ok' : undefined

  return (
    <TraceItem kind="web" tone={tone}>
      <details className="kh-links" open={pending || failed || !count}>
        <summary className="kh-panel-head">
          <span className="kh-panel-type">联网</span>
          <span className="kh-panel-title">{label}</span>
          {query ? <span className="kh-panel-sub">{query}</span> : null}
          {!pending && count ? <b className="kh-panel-n">{count}</b> : null}
        </summary>
        {failed ? (
          <div className="kh-step-err">{output?.error || part.errorText}</div>
        ) : count ? (
          <div className="kh-link-grid">
            {output?.items.map((hit) => {
              const host = hostOf(hit.url)
              return (
                <a
                  key={hit.url}
                  className="kh-link-tile"
                  href={hit.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="kh-link-fav">
                    {host.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="kh-link-title">{hit.title}</span>
                  <span className="kh-link-host">{host}</span>
                </a>
              )
            })}
          </div>
        ) : null}
      </details>
    </TraceItem>
  )
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  return {}
}

function asWebSearchResult(value: unknown): WebSearchResult | null {
  const rec = parseToolPayload(value)
  if (!rec) return null
  return {
    query: typeof rec.query === 'string' ? rec.query : '',
    items: Array.isArray(rec.items) ? (rec.items as WebSearchHit[]) : [],
    provider: typeof rec.provider === 'string' ? rec.provider : undefined,
    error: typeof rec.error === 'string' ? rec.error : undefined,
  }
}

/** LangChain 工具结果可能是 JSON 字符串或带 content 的消息对象，递归解包 */
function parseToolPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return parseToolPayload(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const rec = value as Record<string, unknown>
  if (typeof rec.content === 'string') {
    const nested = parseToolPayload(rec.content)
    if (nested) return nested
  }
  return rec
}
