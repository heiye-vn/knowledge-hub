import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Popconfirm, Space, Spin, Tag, Typography, message } from 'antd'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { documentApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem } from '../types'
import { useAuth } from '../auth'
import { DOC_STATUS, can, formatTime } from '../utils'
import { FileTypeIcon } from '../components/FileTypeIcon'

export default function DocumentDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const user = useAuth()
  const [doc, setDoc] = useState<DocumentItem | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      setDoc(await documentApi.get(id))
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [id])

  if (loading || !doc) {
    return (
      <div className="kh-page">
        <Spin />
      </div>
    )
  }

  const status = DOC_STATUS[doc.status]

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 12 }} wrap>
        <Button onClick={() => navigate('/documents')}>返回列表</Button>
        {can(user, 'document:edit') ? (
          <Button onClick={() => navigate(`/documents/${id}/edit`)}>编辑</Button>
        ) : null}
        {can(user, 'document:edit') && (doc.status === 0 || doc.status === 2) ? (
          <Button
            type="primary"
            onClick={async () => {
              try {
                setDoc(await documentApi.publish(id))
                message.success('已发布（若开启审核则进入待审状态）')
              } catch (error) {
                message.error(
                  error instanceof ApiError ? error.message : '发布失败',
                )
              }
            }}
          >
            发布
          </Button>
        ) : null}
        {can(user, 'document:edit') && doc.status === 1 ? (
          <>
            <Button
              onClick={async () => {
                try {
                  setDoc(await documentApi.saveDraft(id))
                  message.success('已下架为草稿')
                } catch (error) {
                  message.error(
                    error instanceof ApiError ? error.message : '操作失败',
                  )
                }
              }}
            >
              下架编辑
            </Button>
            <Button
              onClick={async () => {
                try {
                  setDoc(await documentApi.archive(id))
                  message.success('已归档')
                } catch (error) {
                  message.error(
                    error instanceof ApiError ? error.message : '归档失败',
                  )
                }
              }}
            >
              归档
            </Button>
          </>
        ) : null}
        {can(user, 'document:delete') ? (
          <Popconfirm
            title="确认删除该文档？"
            onConfirm={async () => {
              try {
                await documentApi.remove(id)
                message.success('已删除')
                navigate('/documents')
              } catch (error) {
                message.error(
                  error instanceof ApiError ? error.message : '删除失败',
                )
              }
            }}
          >
            <Button danger>删除</Button>
          </Popconfirm>
        ) : null}
      </Space>

      <div className="kh-doc-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FileTypeIcon name={doc.title} size={32} />
          <h1 style={{ margin: 0, fontSize: 22 }}>{doc.title}</h1>
        </div>
        <div className="kh-doc-meta">
          <Tag color={status?.color}>{status?.label}</Tag>
          {doc.isPublic ? <Tag color="blue">公开</Tag> : <Tag>私有</Tag>}
          <span>更新于 {formatTime(doc.updatedAt)}</span>
          {doc.wordCount ? <span>约 {doc.wordCount} 字</span> : null}
        </div>
        {doc.summary ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
            {doc.summary}
          </Typography.Paragraph>
        ) : null}
        {doc.tags ? (
          <div style={{ marginTop: 8 }}>
            {doc.tags
              .split(/[,，]/)
              .map((t) => t.trim())
              .filter(Boolean)
              .map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
          </div>
        ) : null}
      </div>

      <div className="kh-doc-body">
        <Markdown remarkPlugins={[remarkGfm]}>{doc.content || '（暂无正文）'}</Markdown>
      </div>
    </div>
  )
}
