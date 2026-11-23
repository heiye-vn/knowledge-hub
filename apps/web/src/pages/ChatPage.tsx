import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ComponentRef,
  KeyboardEvent,
  MouseEvent,
  TouchEvent,
  WheelEvent,
} from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import {
  DeleteOutlined,
  DownOutlined,
  PlusOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {
  Button,
  Input,
  InputNumber,
  Select,
  Tooltip,
  message,
} from 'antd'
import { aiApi } from '../api'
import { API_BASE, ApiError, fetchWithAuthRefresh } from '../api/client'
import { getAccessToken } from '../auth'
import { formatChatError } from '../chat-error-utils'
import { BrandLogo } from '../components/BrandLogo'
import { ChatErrorCard } from '../components/ChatErrorCard'
import { ChatMessageParts } from '../components/ChatMessageParts'
import { KhEmpty } from '../components/KhEmpty'
import { KhIcon } from '../components/icons'
import {
  historyToUIMessages,
  textFromParts,
  type KhUIMessage,
} from '../chat-message-utils'
import type { ChatMessage, ChatSession, SearchMode } from '../types'
import { formatTime } from '../utils'

const CHAT_ID = 'kh-chat'

const QUICK_PROMPTS = [
  {
    title: '系统架构梳理',
    prompt: '系统架构的核心模块有哪些，彼此之间是如何协作的？',
  },
  {
    title: '流程与制度查询',
    prompt: '请总结当前知识库中与审批、发布或权限管理相关的核心规范。',
  },
  {
    title: '检索定位原文',
    prompt: '列出知识库中最近更新的重要技术文档要点，并标注出处。',
  },
]

/**
 * 知识问答（流式 Agentic RAG）
 *
 * - 全高沉浸式两栏布局：左侧历史会话栏 + 右侧居中阅读列（max-width: 860px）
 * - useChat + DefaultChatTransport 对接 /ai/chat/stream，按 part 渲染意图/检索/评估/改写/联网/思考与正文
 * - URL 即会话态：/chat?session=<id>；新会话由服务端创建并经 data-session 回写
 * - 保留 topK / 检索模式 / 「仅检索」入口；仅检索不落库
 */
export default function ChatPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const sessionId = params.get('session') || undefined

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [input, setInput] = useState('')
  const [topK, setTopK] = useState(5)
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [ragOnlyLoading, setRagOnlyLoading] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<ComponentRef<typeof Input.TextArea>>(null)
  const sessionIdRef = useRef(sessionId)
  const loadedSessionRef = useRef<string | undefined>(undefined)
  /** true 时流式输出自动滚到底；用户上滑后解开，避免抢滚动 */
  const pinBottomRef = useRef(true)
  /** 程序滚动时忽略 onScroll，避免误判为用户离开底部 */
  const autoScrollingRef = useRef(false)
  const scrollRafRef = useRef<number | null>(null)
  const touchYRef = useRef<number | null>(null)
  const [showJump, setShowJump] = useState(false)
  sessionIdRef.current = sessionId

  const transport = useMemo(
    () =>
      new DefaultChatTransport<KhUIMessage>({
        api: `${API_BASE}/ai/chat/stream`,
        headers: () => {
          const token = getAccessToken()
          const headers: Record<string, string> = {}
          if (token) headers.Authorization = `Bearer ${token}`
          return headers
        },
        // useChat 自管 fetch，不会走 request() 的 401 刷新；复用统一的刷新重试
        fetch: fetchWithAuthRefresh,
      }),
    [],
  )

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error,
    regenerate,
    clearError,
  } = useChat<KhUIMessage>({
    id: CHAT_ID,
    transport,
    onData: (part) => {
      if (part.type !== 'data-session') return
      const nextId = part.data.sessionId
      if (!nextId) return
      // 服务端 touchTitle 已在流前更新标题，这里立即刷新侧栏，
      // 避免首答期间仍显示「新对话」
      void loadSessions()
      if (nextId === sessionIdRef.current) return
      loadedSessionRef.current = nextId
      navigate(`/chat?session=${nextId}`, { replace: true })
    },
    onFinish: () => {
      void loadSessions()
    },
    onError: (err) => {
      // 对话流中会渲染完整的诊断错误卡，这里只弹简短中文标题避免英文堆栈刷屏
      message.error(formatChatError(err).title)
    },
  })

  const streaming = status === 'submitted' || status === 'streaming'
  const busy = streaming || ragOnlyLoading
  const isEmptyConversation = messages.length === 0 && !error

  const lastUserQuestion = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        const text = textFromParts(messages[i].parts).trim()
        if (text) return text
      }
    }
    return ''
  }, [messages])

  const loadSessions = useCallback(async () => {
    try {
      const res = await aiApi.sessions()
      setSessions(res.items)
    } catch {
      /* 会话列表加载失败不挡问答 */
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (streaming) return
    if (!sessionId) {
      if (loadedSessionRef.current) {
        loadedSessionRef.current = undefined
        clearError()
        setMessages([])
      }
      return
    }
    if (loadedSessionRef.current === sessionId) return
    let cancelled = false
    loadedSessionRef.current = sessionId
    clearError()
    aiApi
      .messages(sessionId)
      .then((rows: ChatMessage[]) => {
        if (cancelled) return
        setMessages(historyToUIMessages(rows))
      })
      .catch((err) => {
        if (!cancelled) {
          loadedSessionRef.current = undefined
          message.error(err instanceof ApiError ? err.message : '加载会话失败')
          navigate('/chat', { replace: true })
        }
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, streaming, navigate, setMessages, clearError])

  function gapToBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  function syncJumpButton() {
    const el = logRef.current
    const overflow = !!el && el.scrollHeight - el.clientHeight > 8
    const next = !pinBottomRef.current && overflow
    setShowJump((prev) => (prev === next ? prev : next))
  }

  function setPinned(next: boolean) {
    pinBottomRef.current = next
    if (!next && scrollRafRef.current != null) {
      cancelAnimationFrame(scrollRafRef.current)
      scrollRafRef.current = null
    }
    syncJumpButton()
  }

  function scrollToBottom() {
    const el = logRef.current
    if (!el || !pinBottomRef.current) return
    autoScrollingRef.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      autoScrollingRef.current = false
    })
  }

  function onLogScroll() {
    if (autoScrollingRef.current) return
    const el = logRef.current
    if (!el) return
    setPinned(gapToBottom(el) < 48)
  }

  /** 滚轮向上立刻取消钉底；向下接近底部再钉回 */
  function onLogWheel(e: WheelEvent<HTMLDivElement>) {
    if (e.deltaY < 0) {
      setPinned(false)
      return
    }
    const el = logRef.current
    if (el && gapToBottom(el) - e.deltaY < 48) setPinned(true)
  }

  function onLogTouchStart(e: TouchEvent<HTMLDivElement>) {
    touchYRef.current = e.touches[0]?.clientY ?? null
  }

  function onLogTouchMove(e: TouchEvent<HTMLDivElement>) {
    const y = e.touches[0]?.clientY
    if (touchYRef.current != null && y != null && y > touchYRef.current + 6) {
      setPinned(false)
    }
    touchYRef.current = y ?? null
  }

  function jumpToBottom() {
    setPinned(true)
    scrollToBottom()
  }

  useEffect(() => {
    if (!pinBottomRef.current) return
    if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      scrollToBottom()
    })
    return () => {
      if (scrollRafRef.current != null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [messages, status, error])

  async function sendText(rawText: string) {
    const text = rawText.trim()
    if (!text || busy) return
    setInput('')
    clearError()
    setPinned(true)
    await sendMessage({ text }, { body: { sessionId, topK, mode } })
  }

  async function send() {
    await sendText(input)
  }

  async function runRagOnly(text: string, appendUserMessage: boolean) {
    const clean = text.trim()
    if (!clean || busy) return
    clearError()
    setPinned(true)
    setRagOnlyLoading(true)
    if (appendUserMessage) {
      setMessages((prev) => [
        ...prev,
        {
          id: `local-u-${Date.now()}`,
          role: 'user',
          parts: [{ type: 'text', text: clean }],
        },
      ])
    }
    try {
      const hits = await aiApi.ragSearch(clean, topK, mode)
      const content = hits.length
        ? hits
            .map(
              (h, i) =>
                `[${i + 1}] ${h.documentTitle}${h.heading ? ` / ${h.heading}` : ''}\n${h.content.slice(0, 180)}`,
            )
            .join('\n\n')
        : '没有召回到相关知识切片。'
      setMessages((prev) => [
        ...prev,
        {
          id: `local-a-${Date.now()}`,
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: `仅检索模式（${mode}，Top ${topK}）结果：\n\n${content}`,
            },
          ],
        },
      ])
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '检索请求失败')
    } finally {
      setRagOnlyLoading(false)
    }
  }

  async function sendRagOnly() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    await runRagOnly(text, true)
  }

  async function retryLastAnswer() {
    if (busy || !lastUserQuestion) return
    clearError()
    setPinned(true)
    await regenerate({ body: { sessionId, topK, mode } })
  }

  async function fallbackToRagOnly() {
    if (busy || !lastUserQuestion) return
    await runRagOnly(lastUserQuestion, false)
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey) return
    // 中文输入法组合期间回车仅确认选词，不触发发送
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    e.preventDefault()
    void send()
  }

  function switchSession(id?: string) {
    if (busy) {
      message.warning('请等待当前回答结束再切换会话')
      return
    }
    clearError()
    navigate(id ? `/chat?session=${id}` : '/chat')
  }

  const isFreshDraft = !sessionId && isEmptyConversation

  /**
   * 切回空白草稿态，不提前向服务端落库空会话；
   * 真正发出首条消息时由 /ai/chat/stream 自动创建会话并经 data-session 回写 URL 与侧栏，
   * 避免重复点击按钮堆积大量无意义的「新对话」空记录。
   */
  function onNew() {
    if (busy) {
      message.warning('请等待当前回答结束再开新对话')
      return
    }
    if (!isFreshDraft) {
      loadedSessionRef.current = undefined
      clearError()
      setMessages([])
      if (sessionId) {
        navigate('/chat')
      }
    }
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
    })
  }

  async function onRemove(id: string, e: MouseEvent) {
    e.stopPropagation()
    if (busy) {
      message.warning('请等待当前回答结束再删除')
      return
    }
    try {
      await aiApi.removeSession(id)
      if (sessionId === id) {
        loadedSessionRef.current = undefined
        clearError()
        setMessages([])
        navigate('/chat')
      }
      void loadSessions()
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除会话失败')
    }
  }

  const composer = (
    <div className="kh-chat-composer">
      <Input.TextArea
        ref={textareaRef}
        className="kh-chat-textarea"
        variant="borderless"
        autoSize={{ minRows: 2, maxRows: 6 }}
        placeholder="输入您的问题，Enter 发送，Shift + Enter 换行…"
        aria-label="提问输入框"
        value={input}
        disabled={busy}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onComposerKeyDown}
      />
      <div className="kh-chat-composer-bar">
        <div className="kh-chat-composer-controls">
          <Select
            size="small"
            value={mode}
            onChange={setMode}
            disabled={busy}
            aria-label="检索模式"
            style={{ width: 108 }}
            options={[
              { label: '混合检索', value: 'hybrid' },
              { label: '向量检索', value: 'vector' },
              { label: '全文关键字', value: 'keyword' },
            ]}
          />
          <Tooltip title="TopK 召回条数 (1-10)">
            <div className="kh-chat-topk">
              <span>Top</span>
              <InputNumber
                size="small"
                min={1}
                max={10}
                controls={false}
                aria-label="TopK 召回条数"
                value={topK}
                disabled={busy}
                onChange={(val) =>
                  setTopK(Math.min(10, Math.max(1, Number(val) || 5)))
                }
                style={{ width: 42 }}
              />
            </div>
          </Tooltip>
          <span className="kh-chat-composer-note">「仅检索」不落库</span>
        </div>
        <div className="kh-chat-composer-actions">
          <Button
            size="middle"
            icon={<SearchOutlined />}
            loading={ragOnlyLoading}
            disabled={busy || !input.trim()}
            onClick={() => void sendRagOnly()}
          >
            仅检索
          </Button>
          {streaming ? (
            <Button
              size="middle"
              danger
              icon={<StopOutlined />}
              onClick={() => void stop()}
            >
              停止
            </Button>
          ) : (
            <Button
              type="primary"
              size="middle"
              icon={<SendOutlined />}
              disabled={busy || !input.trim()}
              onClick={() => void send()}
            >
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div className="kh-chat-layout">
      <aside className="kh-chat-sessions" aria-label="对话会话列表">
        <div className="kh-chat-sessions-head">
          <Tooltip title={isFreshDraft ? '当前已是新对话，直接提问即可' : ''}>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              block
              disabled={busy || isFreshDraft}
              onClick={onNew}
            >
              新建对话
            </Button>
          </Tooltip>
        </div>
        <div className="kh-chat-sessions-caption">
          <span>历史会话</span>
          <span>{sessions.length}</span>
        </div>
        <div className="kh-chat-session-list">
          {sessions.length === 0 ? (
            <div className="kh-chat-sessions-empty">
              <KhEmpty icon="chat" size={32} description="还没有历史会话" />
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`kh-chat-session-item${sessionId === s.id ? ' active' : ''}${busy ? ' disabled' : ''}`}
                onClick={() => switchSession(s.id)}
              >
                <div className="kh-chat-session-title" title={s.title}>
                  {s.title}
                </div>
                <div className="kh-chat-session-meta">
                  <span>{formatTime(s.updatedAt)}</span>
                  <DeleteOutlined
                    aria-label="删除会话"
                    onClick={(e) => void onRemove(s.id, e)}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="kh-chat" aria-label="知识问答对话区">
        <div className="kh-chat-scope-bar">
          <span className="kh-chat-scope-pill">
            <KhIcon name="locked" size={13} />
            仅检索你有权限的文档（公开、所在团队、本人文档）
          </span>
          <span className="kh-chat-scope-desc">
            自动识别意图并按需调度知识库、图谱与联网检索
          </span>
        </div>

        {isEmptyConversation ? (
          <div className="kh-chat-welcome-stage">
            <div className="kh-chat-welcome-inner">
              <div className="kh-chat-welcome-head">
                <BrandLogo size={40} />
                <h2>有什么可以帮您查找或梳理？</h2>
                <p>
                  基于企业知识库与知识图谱进行溯源解答，资料不足时自动改写检索词或按需联网核验。
                </p>
              </div>
              <div className="kh-chat-quick-grid">
                {QUICK_PROMPTS.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    className="kh-chat-quick-card"
                    disabled={busy}
                    onClick={() => void sendText(item.prompt)}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="kh-chat-log-wrap">
            <div
              className="kh-chat-log"
              ref={logRef}
              onScroll={onLogScroll}
              onWheel={onLogWheel}
              onTouchStart={onLogTouchStart}
              onTouchMove={onLogTouchMove}
            >
              <div className="kh-chat-thread">
                {messages.map((m, i) => {
                  const liveAssistant =
                    streaming &&
                    m.role === 'assistant' &&
                    i === messages.length - 1
                  return (
                    <div key={m.id} className={`kh-bubble ${m.role}`}>
                      <ChatMessageParts
                        messageId={m.id}
                        parts={m.parts}
                        role={m.role}
                        showSources={!liveAssistant}
                      />
                    </div>
                  )
                })}
                {error ? (
                  <ChatErrorCard
                    error={error}
                    busy={busy}
                    canRetryAction={Boolean(lastUserQuestion)}
                    canFallbackRagAction={Boolean(lastUserQuestion)}
                    onRetry={() => void retryLastAnswer()}
                    onFallbackRag={() => void fallbackToRagOnly()}
                    onDismiss={clearError}
                  />
                ) : null}
              </div>
            </div>
            {showJump ? (
              <Button
                className="kh-chat-jump"
                size="small"
                icon={<DownOutlined />}
                onClick={jumpToBottom}
              >
                回到底部
              </Button>
            ) : null}
          </div>
        )}

        <div className="kh-chat-dock">
          <div className="kh-chat-dock-inner">{composer}</div>
        </div>
      </section>
    </div>
  )
}
