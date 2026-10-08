import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
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
import type { ChatMessage, ChatSession, ChatSource, SearchMode } from '../types'
import { formatTime } from '../utils'
import { AnswerWithCitations, SourceCiteList } from '../components/SourceCiteList'

interface Bubble {
  role: 'user' | 'assistant'
  content: string
  sources?: ChatSource[] | null
}

/**
 * 知识问答（feat-v13 起支持会话历史）
 *
 * - URL 即会话态：/chat?session=<id>，切换会话拉取历史消息
 * - 不带 session 参数时是新会话；首问由服务端自动建会话并回传 sessionId
 * - 「仅检索」走 /search 纯检索，不落会话
 * - 历史加载用 cancelled 守卫保证 effect 幂等（StrictMode 双调用安全）
 */
export default function ChatPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const sessionId = params.get('session') || undefined

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [input, setInput] = useState('')
  const [topK, setTopK] = useState(5)
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Bubble[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const scrollLog = useCallback(() => {
    requestAnimationFrame(() => {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
    })
  }, [])

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
    if (!sessionId) {
      setMessages([])
      return
    }
    let cancelled = false
    aiApi
      .messages(sessionId)
      .then((rows: ChatMessage[]) => {
        if (cancelled) return
        setMessages(
          rows.map((m) => ({
            role: m.role,
            content: m.content,
            sources: m.sources,
          })),
        )
        scrollLog()
      })
      .catch((error) => {
        if (cancelled) return
        message.error(error instanceof ApiError ? error.message : '加载会话失败')
        navigate('/chat', { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, navigate, scrollLog])

  async function send(asRagOnly = false) {
    const text = input.trim()
    if (!text) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)
    scrollLog()
    try {
      if (asRagOnly) {
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
            role: 'assistant',
            content: `仅检索模式（${mode}，Top ${topK}）结果：\n\n${content}`,
          },
        ])
      } else {
        const res = await aiApi.chat(text, topK, sessionId)
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: res.answer, sources: res.sources },
        ])
        if (res.sessionId && res.sessionId !== sessionId) {
          navigate(`/chat?session=${res.sessionId}`, { replace: true })
        }
        void loadSessions()
      }
      scrollLog()
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '问答请求失败')
    } finally {
      setLoading(false)
    }
  }

  async function onNew() {
    try {
      const created = await aiApi.createSession()
      navigate(`/chat?session=${created.id}`)
      void loadSessions()
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '创建会话失败')
    }
  }

  async function onRemove(id: string, e: MouseEvent) {
    e.stopPropagation()
    try {
      await aiApi.removeSession(id)
      if (sessionId === id) navigate('/chat')
      void loadSessions()
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '删除会话失败')
    }
  }

  return (
    <div className="kh-page kh-chat-layout">
      <aside className="kh-chat-sessions">
        <Button type="primary" icon={<PlusOutlined />} block onClick={() => void onNew()}>
          新对话
        </Button>
        <div className="kh-chat-session-list">
          {sessions.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话" />
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                className={`kh-chat-session-item${sessionId === s.id ? ' active' : ''}`}
                onClick={() => navigate(`/chat?session=${s.id}`)}
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
          混合召回 + 上下文增强生成，回答带引用溯源。问答自动写入左侧会话，「仅检索」不落库。
        </Typography.Paragraph>
        <div className="kh-chat-log" ref={logRef}>
          {!messages.length ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#8c8c8c' }}>
              输入您的问题，系统将基于企业知识库进行准确解答与引用溯源。
            </div>
          ) : null}
          {messages.map((m, i) => {
            const sources = m.sources ?? undefined
            return (
              <div key={i} className={`kh-bubble ${m.role}`}>
                {m.role === 'assistant' ? (
                  <AnswerWithCitations text={m.content} sources={sources} />
                ) : (
                  m.content
                )}
                {sources?.length ? (
                  <div style={{ marginTop: 12, borderTop: '1px dashed #e8e8e8', paddingTop: 8 }}>
                    <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 6 }}>
                      引用来源（共 {sources.length} 条）：
                    </div>
                    <SourceCiteList
                      items={sources.map((s) => ({
                        index: s.index,
                        documentId: s.documentId,
                        documentTitle: s.documentTitle,
                        heading: s.heading,
                        excerpt: s.excerpt,
                      }))}
                    />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Select
            size="large"
            value={mode}
            onChange={setMode}
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
            disabled={loading}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => void send(false)}
          />
          <Input
            size="large"
            style={{ width: 70 }}
            value={topK}
            onChange={(e) => setTopK(Math.min(10, Math.max(1, Number(e.target.value) || 5)))}
            title="TopK 召回条数 (1-10)"
          />
          <Button size="large" loading={loading} onClick={() => void send(true)}>
            仅检索
          </Button>
          <Button
            type="primary"
            size="large"
            loading={loading}
            onClick={() => void send(false)}
          >
            发送
          </Button>
        </Space.Compact>
      </div>
    </div>
  )
}
