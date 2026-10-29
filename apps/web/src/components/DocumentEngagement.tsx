import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import {
  LikeFilled,
  LikeOutlined,
  ShareAltOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons'
import { documentApi } from '../api'
import { ApiError } from '../api/client'
import type { CommentItem, DocumentItem, ShareLink } from '../types'
import { useAuth } from '../auth'
import { canWriteDocument, formatTime, isAdmin } from '../utils'

/** 文档详情页互动区：点赞、收藏、评论（一层回复）、分享链接管理 */
export default function DocumentEngagement({
  doc,
  onChange,
}: {
  doc: DocumentItem
  onChange: (next: DocumentItem) => void
}) {
  const user = useAuth()
  const [comments, setComments] = useState<CommentItem[]>([])
  const [content, setContent] = useState('')
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [shares, setShares] = useState<ShareLink[]>([])
  const [shareForm] = Form.useForm()
  const writable = canWriteDocument(doc, user)
  const canShare = writable && doc.status === 1

  async function loadComments() {
    try {
      setComments(await documentApi.comments(doc.id))
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '评论加载失败')
    }
  }

  useEffect(() => {
    void loadComments()
  }, [doc.id])

  const threaded = useMemo(() => {
    const replies = new Map<string, CommentItem[]>()
    const roots: CommentItem[] = []
    for (const item of comments) {
      if (item.parentId) {
        const list = replies.get(item.parentId) ?? []
        list.push(item)
        replies.set(item.parentId, list)
      } else {
        roots.push(item)
      }
    }
    return roots.map((item) => ({
      ...item,
      replies: replies.get(item.id) ?? [],
    }))
  }, [comments])

  async function submitComment() {
    const text = content.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      const res = await documentApi.addComment(doc.id, text, replyTo?.id)
      setComments((prev) => [...prev, res.comment])
      onChange({ ...doc, commentCount: res.commentCount })
      setContent('')
      setReplyTo(null)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '评论失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function removeComment(item: CommentItem) {
    try {
      const res = await documentApi.removeComment(doc.id, item.id)
      setComments((prev) =>
        prev.filter((row) => row.id !== item.id && row.parentId !== item.id),
      )
      onChange({ ...doc, commentCount: res.commentCount })
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '删除失败')
    }
  }

  function canDelete(item: CommentItem) {
    return item.userId === user?.userId || isAdmin(user)
  }

  async function openShare() {
    setShareOpen(true)
    try {
      setShares(await documentApi.shares(doc.id))
    } catch (error) {
      setShares([])
      message.error(error instanceof ApiError ? error.message : '分享列表加载失败')
    }
  }

  const shareUrl = (code: string) => `${window.location.origin}/share/${code}`

  return (
    <div style={{ marginTop: 28 }}>
      <Space wrap>
        <Button
          icon={doc.liked ? <LikeFilled /> : <LikeOutlined />}
          type={doc.liked ? 'primary' : 'default'}
          onClick={async () => {
            try {
              const res = await documentApi.toggleLike(doc.id)
              onChange({ ...doc, liked: res.liked, likeCount: res.likeCount })
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : '操作失败')
            }
          }}
        >
          {doc.liked ? '已赞' : '点赞'} {doc.likeCount ?? 0}
        </Button>
        <Button
          icon={doc.favorited ? <StarFilled /> : <StarOutlined />}
          type={doc.favorited ? 'primary' : 'default'}
          onClick={async () => {
            try {
              const res = await documentApi.toggleFavorite(doc.id)
              onChange({
                ...doc,
                favorited: res.favorited,
                favouriteCount: res.favouriteCount,
              })
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : '操作失败')
            }
          }}
        >
          {doc.favorited ? '已收藏' : '收藏'} {doc.favouriteCount ?? 0}
        </Button>
        {canShare ? (
          <Button icon={<ShareAltOutlined />} onClick={() => void openShare()}>
            分享
          </Button>
        ) : null}
      </Space>

      <Typography.Title level={5} style={{ marginTop: 26 }}>
        评论 {doc.commentCount ?? comments.length}
      </Typography.Title>
      <Input.TextArea
        rows={3}
        maxLength={2000}
        value={content}
        placeholder={replyTo ? `回复 ${replyTo.userName}` : '写下评论'}
        onChange={(event) => setContent(event.target.value)}
      />
      <Space style={{ marginTop: 8 }}>
        <Button
          type="primary"
          loading={submitting}
          onClick={() => void submitComment()}
        >
          发表
        </Button>
        {replyTo ? (
          <Button onClick={() => setReplyTo(null)}>取消回复</Button>
        ) : null}
      </Space>

      <List
        style={{ marginTop: 16 }}
        dataSource={threaded}
        locale={{ emptyText: '还没有评论' }}
        renderItem={(item) => (
          <List.Item
            actions={[
              <a key="reply" onClick={() => setReplyTo(item)}>
                回复
              </a>,
              canDelete(item) ? (
                <a key="delete" onClick={() => void removeComment(item)}>
                  删除
                </a>
              ) : null,
            ].filter(Boolean)}
          >
            <List.Item.Meta
              title={
                <Space>
                  <span>{item.userName}</span>
                  <Typography.Text type="secondary">
                    {formatTime(item.createdAt)}
                  </Typography.Text>
                </Space>
              }
              description={
                <div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{item.content}</div>
                  {item.replies.map((reply) => (
                    <div
                      key={reply.id}
                      style={{
                        marginTop: 8,
                        padding: '8px 12px',
                        background: '#fafafa',
                        borderRadius: 6,
                      }}
                    >
                      <Space>
                        <Typography.Text strong>{reply.userName}</Typography.Text>
                        <Typography.Text type="secondary">
                          {formatTime(reply.createdAt)}
                        </Typography.Text>
                        {canDelete(reply) ? (
                          <a onClick={() => void removeComment(reply)}>删除</a>
                        ) : null}
                      </Space>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{reply.content}</div>
                    </div>
                  ))}
                </div>
              }
            />
          </List.Item>
        )}
      />

      <Modal
        title="分享文档"
        open={shareOpen}
        onCancel={() => setShareOpen(false)}
        footer={null}
      >
        <Form
          form={shareForm}
          layout="vertical"
          onFinish={async (values: { password?: string; expireDays?: number }) => {
            try {
              const created = await documentApi.createShare(doc.id, {
                password: values.password?.trim() || undefined,
                expireDays: values.expireDays,
              })
              setShares((prev) => [created, ...prev])
              const url = shareUrl(created.code)
              await navigator.clipboard.writeText(url).catch(() => undefined)
              message.success('已创建，链接已复制')
              shareForm.resetFields()
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : '创建失败')
            }
          }}
        >
          <Form.Item
            name="password"
            label="访问密码"
            rules={[{ min: 4, message: '密码至少 4 位' }]}
          >
            <Input.Password placeholder="不填则无需密码" maxLength={32} />
          </Form.Item>
          <Form.Item name="expireDays" label="有效天数">
            <Select
              allowClear
              placeholder="不选则长期有效"
              options={[
                { value: 1, label: '1 天' },
                { value: 7, label: '7 天' },
                { value: 30, label: '30 天' },
                { value: 90, label: '90 天' },
              ]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            生成链接
          </Button>
        </Form>
        <List
          style={{ marginTop: 16 }}
          dataSource={shares}
          locale={{ emptyText: '还没有分享链接' }}
          renderItem={(item) => {
            const url = shareUrl(item.code)
            return (
              <List.Item
                actions={[
                  <a
                    key="copy"
                    onClick={() => {
                      void navigator.clipboard.writeText(url)
                      message.success('已复制')
                    }}
                  >
                    复制
                  </a>,
                  <a
                    key="off"
                    onClick={async () => {
                      try {
                        await documentApi.revokeShare(doc.id, item.id)
                        setShares((prev) =>
                          prev.filter((row) => row.id !== item.id),
                        )
                        message.success('已关闭')
                      } catch (error) {
                        message.error(
                          error instanceof ApiError ? error.message : '关闭失败',
                        )
                      }
                    }}
                  >
                    关闭
                  </a>,
                ]}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ wordBreak: 'break-all' }}>{url}</div>
                  <Space size={4} wrap>
                    <Tag>{item.needPassword ? '需要密码' : '无密码'}</Tag>
                    <Tag>{item.expireAt ? `${formatTime(item.expireAt)} 到期` : '长期有效'}</Tag>
                    {item.expired ? <Tag color="red">已过期</Tag> : null}
                  </Space>
                </div>
              </List.Item>
            )
          }}
        />
      </Modal>
    </div>
  )
}
