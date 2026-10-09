import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import {
  Button,
  Empty,
  Input,
  Select,
  Space,
  Typography,
  message,
} from 'antd'
import { aiApi } from '../api'
import { ApiError } from '../api/client'
import { getAccessToken } from '../auth'
import {
  ChatMessageParts,
  historyToUIMessages,
  type KhUIMessage,
} from '../components/ChatMessageParts'
import type { ChatMessage, ChatSession, SearchMode } from '../types'
import { formatTime } from '../utils'

const CHAT_ID = 'kh-chat'

/**
 * 知识问答（feat-v14 起流式渲染）
 *
 * - useChat + DefaultChatTransport 对接 /ai/chat/stream（SSE），
 *   按 part 类型渲染思考 / 检索 / 联网搜索 / 正文组件
 * - URL 即会话态：/chat?session=<id>，切换会话拉取历史消息；
 *   新会话由服务端自动创建并经 data-session 事件回写 URL
 * - 「仅检索」走 /rag/search 纯检索，不落会话（本地拼装展示消息）
 * - 历史加载用 cancelled 守卫保证 effect 幂等（StrictMode 双调用安全）
 * - 流式期间锁定会话切换 / 新建 / 删除，避免中途串流
 */
export default function ChatPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const sessionId = params.get('session') || undefined

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [input, setInput] = useState('')
  const [topK, setTopK] = useState(5)
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const logRef = useRef<HTMLDivElement>(null)
  const sessionIdRef = useRef(sessionId)
  const loadedSessionRef = useRef<string | undefined>(undefined)
  const pinBottomRef = useRef(true)
  sessionIdRef.current = sessionId

  const transport = useMemo(
    () =>
      new DefaultChatTransport<KhUIMessage>({
        api: '/api/ai/chat/stream',
        headers: () => {
          const token = getAccessToken()
          const headers: Record<string, string> = {}
          if (token) headers.Authorization = `Bearer ${token}`
          return headers
        },
      }),
    [],
  )

  const { messages, sendMessage, setMessages, status, stop, error } =
    useChat<KhUIMessage>({
      id: CHAT_ID,
      transport,
      onData: (part) => {
        if (part.type !== 'data-session') return
        const nextId = part.data.sessionId
        if (!nextId || nextId === sessionIdRef.current) return
        loadedSessionRef.current = nextId
        navigate(`/chat?session=${nextId}`, { replace: true })
      },
      onFinish: () => {
        void loadSessions()
      },
      onError: (err) => {
        message.error(err.message || '问答请求失败')
      },
    })

  const streaming = status === 'submitted' || status === 'streaming'
  const busy = streaming

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
        setMessages([])
      }
      return
    }
    if (loadedSessionRef.current === sessionId) return
    let cancelled = false
    loadedSessionRef.current = sessionId
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
  }, [sessionId, streaming, navigate, setMessages])

  function onLogScroll() {
    const el = logRef.current
    if (!el) return
    // 用户主动上翻时暂停自动吸底，靠近底部时恢复
    pinBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    if (!pinBottomRef.current) return
    requestAnimationFrame(() => {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
    })
  }, [messages, status])

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    pinBottomRef.current = true
    await sendMessage({ text }, { body: { sessionId, topK } })
  }

  async function sendRagOnly() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    pinBottomRef.current = true
    setMessages((prev) => [
      ...prev,
      {
        id: `local-u-${Date.now()}`,
        role: 'user',
        parts: [{ type: 'text', text }],
      },
    ])
    try {
      const hits = await aiApi.ragSearch(text, topK, mode)
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
    }
  }

  function switchSession(id?: string) {
    if (busy) {
      message.warning('请等待当前回答结束再切换会话')
      return
    }
    navigate(id ? `/chat?session=${id}` : '/chat')
  }

  async function onNew() {
    if (busy) {
      message.warning('请等待当前回答结束再开新对话')
      return
    }
    try {
      const created = await aiApi.createSession()
      loadedSessionRef.current = created.id
      setMessages([])
      navigate(`/chat?session=${created.id}`)
      void loadSessions()
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '创建会话失败')
    }
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
        setMessages([])
        navigate('/chat')
      }
      void loadSessions()
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除会话失败')
    }
  }

  return (
    <div className="kh-page kh-chat-layout">
      <aside className="kh-chat-sessions">
        <Button
          type="primary"
          icon={<PlusOutlined />}
          block
          disabled={busy}
          onClick={() => void onNew()}
        >
          新对话
        </Button>
        <div className="kh-chat-session-list">
          {sessions.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有会话"
            />
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
                  <DeleteOutlined onClick={(e) => void onRemove(s.id, e)} />
                </div>
              </div>
            ))
          )}
        </div>
      </aside>
      <div className="kh-chat">
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          知识问答
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          流式回答会展示知识库检索、思考与联网搜索过程，并写入左侧会话；「仅检索」不落库。
        </Typography.Paragraph>
        <div className="kh-chat-log" ref={logRef} onScroll={onLogScroll}>
          {messages.length === 0 ? (
            <div
              style={{
                padding: '40px 0',
                textAlign: 'center',
                color: '#8c8c8c',
              }}
            >
              输入您的问题，系统将基于企业知识库进行准确解答与引用溯源。
            </div>
          ) : (
            messages.map((m, i) => {
              const liveAssistant =
                streaming && m.role === 'assistant' && i === messages.length - 1
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
            })
          )}
          {error ? <div className="kh-chat-error">{error.message}</div> : null}
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Select
            size="large"
            value={mode}
            onChange={setMode}
            disabled={busy}
            style={{ width: 110 }}
            options={[
              { label: '混合检索', value: 'hybrid' },
              { label: '向量检索', value: 'vector' },
              { label: '全文关键字', value: 'keyword' },
            ]}
          />
          <Input
            size="large"
            placeholder="例如：系统架构的核心模块有哪些？"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => void send()}
          />
          <Input
            size="large"
            style={{ width: 70 }}
            value={topK}
            disabled={busy}
            onChange={(e) =>
              setTopK(Math.min(10, Math.max(1, Number(e.target.value) || 5)))
            }
            title="TopK 召回条数 (1-10)"
          />
          <Button size="large" disabled={busy} onClick={() => void sendRagOnly()}>
            仅检索
          </Button>
          {streaming ? (
            <Button size="large" onClick={() => void stop()}>
              停止
            </Button>
          ) : (
            <Button
              type="primary"
              size="large"
              onClick={() => void send()}
            >
              发送
            </Button>
          )}
        </Space.Compact>
      </div>
    </div>
  )
}
