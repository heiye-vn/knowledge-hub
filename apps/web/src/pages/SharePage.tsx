import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Card, Form, Input, Spin, Typography, message } from 'antd'
import { shareApi } from '../api'
import { ApiError } from '../api/client'
import { DocumentMarkdown } from '../components/DocumentMarkdown'
import { BrandLogo } from '../components/BrandLogo'

/** 公开分享页：免登录访问，密码由链接本身控制 */
export default function SharePage() {
  const { code = '' } = useParams()
  const [title, setTitle] = useState<string | null>(null)
  const [needPassword, setNeedPassword] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    shareApi
      .preview(code)
      .then(async (preview) => {
        setTitle(preview.title)
        setNeedPassword(preview.needPassword)
        if (!preview.needPassword) {
          const doc = await shareApi.access(code)
          setTitle(doc.title)
          setContent(doc.content)
          setSummary(doc.summary ?? null)
        }
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : '分享链接不可用')
      })
      .finally(() => setLoading(false))
  }, [code])

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f5f7fb',
        padding: '48px 16px',
      }}
    >
      <Card
        style={{ width: 900, maxWidth: '100%', margin: '0 auto' }}
        variant="borderless"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 20,
          }}
        >
          <BrandLogo size={36} />
          <h1 style={{ margin: 0, fontSize: 22 }}>{title || '文档分享'}</h1>
        </div>
        {loading ? <Spin /> : null}
        {error ? (
          <Typography.Text type="danger">{error}</Typography.Text>
        ) : null}
        {!loading && needPassword && content == null && !error ? (
          <Form
            layout="vertical"
            style={{ maxWidth: 360 }}
            onFinish={async (values: { password: string }) => {
              try {
                const doc = await shareApi.access(code, values.password)
                setTitle(doc.title)
                setSummary(doc.summary ?? null)
                setContent(doc.content)
              } catch (err) {
                message.error(err instanceof ApiError ? err.message : '无法打开')
              }
            }}
          >
            <Form.Item
              name="password"
              label="访问密码"
              rules={[{ required: true, message: '请输入访问密码' }]}
            >
              <Input.Password autoFocus />
            </Form.Item>
            <Button type="primary" htmlType="submit">
              打开
            </Button>
          </Form>
        ) : null}
        {content != null ? (
          <>
            {summary ? (
              <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                {summary}
              </Typography.Paragraph>
            ) : null}
            <DocumentMarkdown content={content} assetMode="share" />
          </>
        ) : null}
      </Card>
    </div>
  )
}
