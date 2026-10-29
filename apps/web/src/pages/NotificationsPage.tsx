import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, List, Space, Tag, Typography, message } from 'antd'
import { notificationApi } from '../api'
import { ApiError } from '../api/client'
import type { NotificationItem } from '../types'
import { formatTime } from '../utils'

const TYPE_LABEL: Record<string, string> = {
  like: '点赞',
  comment: '评论',
  system: '站内',
}

/** 站内通知：互动通知 + 管理员广播 */
export default function NotificationsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<NotificationItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const pageSize = 20

  async function load(nextPage = page) {
    setLoading(true)
    try {
      const res = await notificationApi.list(nextPage, pageSize)
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(1)
  }, [])

  function notifyBadgeChanged() {
    window.dispatchEvent(new Event('kh:notifications-changed'))
  }

  async function open(item: NotificationItem) {
    if (!item.isRead) {
      try {
        await notificationApi.markRead(item.id)
        setItems((prev) =>
          prev.map((row) => (row.id === item.id ? { ...row, isRead: true } : row)),
        )
        notifyBadgeChanged()
      } catch {
        // 已读失败不阻断跳转
      }
    }
    if (item.documentId) navigate(`/documents/${item.documentId}`)
  }

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }} wrap>
        <h2 style={{ margin: 0 }}>通知</h2>
        <Button
          onClick={async () => {
            try {
              await notificationApi.markAllRead()
              setItems((prev) => prev.map((row) => ({ ...row, isRead: true })))
              notifyBadgeChanged()
              message.success('已全部标为已读')
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : '操作失败')
            }
          }}
        >
          全部已读
        </Button>
      </Space>
      <List
        loading={loading}
        dataSource={items}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: (next) => void load(next),
        }}
        locale={{ emptyText: '暂无通知' }}
        renderItem={(item) => (
          <List.Item
            style={{
              cursor: item.documentId ? 'pointer' : 'default',
              background: item.isRead ? undefined : '#f6ffed',
            }}
            onClick={() => void open(item)}
          >
            <List.Item.Meta
              title={
                <Space wrap>
                  {!item.isRead ? <Tag color="green">未读</Tag> : null}
                  <Tag>{TYPE_LABEL[item.type] || item.type}</Tag>
                  <span>{item.title}</span>
                </Space>
              }
              description={
                <div>
                  {item.content ? <div>{item.content}</div> : null}
                  <Typography.Text type="secondary">
                    {item.senderName ? `${item.senderName} · ` : ''}
                    {formatTime(item.createdAt)}
                  </Typography.Text>
                </div>
              }
            />
          </List.Item>
        )}
      />
    </div>
  )
}
