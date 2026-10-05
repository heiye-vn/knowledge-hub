import { useRef, useState } from 'react'
import {
  Button,
  Input,
  Select,
  Space,
  Typography,
  message,
} from 'antd'
import { aiApi } from '../api'
import { ApiError } from '../api/client'
import type { ChatSource, SearchMode } from '../types'
import { AnswerWithCitations, SourceCiteList } from '../components/SourceCiteList'

interface Bubble {
  role: 'user' | 'assistant'
  content: string
  sources?: ChatSource[]
}

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [topK, setTopK] = useState(5)
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Bubble[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  async function send(asRagOnly = false) {
    const text = input.trim()
    if (!text) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)
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
        const res = await aiApi.chat(text, topK)
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: res.answer, sources: res.sources },
        ])
      }
      requestAnimationFrame(() => {
        logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
      })
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '问答请求失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="kh-page kh-chat">
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        知识问答
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        基于企业知识库多路混合召回与大模型上下文增强生成。无召回时主动拒答以避免幻觉。
      </Typography.Paragraph>
      <div className="kh-chat-log" ref={logRef}>
        {!messages.length ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: '#8c8c8c' }}>
            输入您的问题，系统将基于企业知识库进行准确解答与引用溯源。
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={`kh-bubble ${m.role}`}>
            {m.role === 'assistant' ? (
              <AnswerWithCitations text={m.content} sources={m.sources} />
            ) : (
              m.content
            )}
            {m.sources?.length ? (
              <div style={{ marginTop: 12, borderTop: '1px dashed #e8e8e8', paddingTop: 8 }}>
                <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 6 }}>
                  引用来源（共 {m.sources.length} 条）：
                </div>
                <SourceCiteList
                  items={m.sources.map((s) => ({
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
        ))}
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
  )
}
