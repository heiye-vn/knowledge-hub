import { useCallback, useEffect, useState } from 'react'
import {
  Button,
  Modal,
  Select,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import { aiApi, memoryApi } from '../api'
import { ApiError } from '../api/client'
import type { ChatSession, MemoryItem } from '../types'
import { formatTime } from '../utils'

type Layer = 'user' | 'session'

type ConfirmState = {
  open: boolean
  kind: 'one' | 'all'
  item?: MemoryItem
}

/**
 * 我的长期记忆（feat-v22）。
 *
 * 两层分开看：user 层是跨会话画像（身份/岗位/偏好/约束），session 层是
 * 某个会话的临时上下文。session 层必须选会话 —— 后端拿不到 sessionId 时
 * 返回空页，不会退化成「该用户全部记忆」，所以这里的下拉是必需前置。
 *
 * 删除即生效：下一轮问答不再注入。会话删除会顺带清掉该会话的 session 层，
 * user 层画像保留（要清它得走「清空全部」）。
 */
export default function MemoryPage() {
  const [layer, setLayer] = useState<Layer>('user')
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [sessionId, setSessionId] = useState<string>()
  const [items, setItems] = useState<MemoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmState>({
    open: false,
    kind: 'all',
  })
  const pageSize = 10

  const load = useCallback(
    async (nextPage: number) => {
      if (layer === 'session' && !sessionId) {
        setItems([])
        setTotal(0)
        setPage(1)
        return
      }
      setLoading(true)
      try {
        const res = await memoryApi.list(
          layer,
          nextPage,
          pageSize,
          layer === 'session' ? sessionId : undefined,
        )
        setItems(res.items)
        setTotal(res.total)
        setPage(nextPage)
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [layer, sessionId],
  )

  useEffect(() => {
    void load(1)
  }, [load])

  // 会话下拉只在 session 层需要；默认选中最近活跃的会话
  useEffect(() => {
    aiApi
      .sessions(1, 50)
      .then((res) => {
        setSessions(res.items)
        setSessionId((current) => current ?? res.items[0]?.id)
      })
      .catch(() => setSessions([]))
  }, [])

  async function submitConfirm() {
    setSubmitting(true)
    try {
      if (confirm.kind === 'one' && confirm.item) {
        await memoryApi.remove(confirm.item.id)
        message.success('已删除')
        // 删掉当前页最后一条且不在第一页时回退一页，避免停在空页
        await load(items.length === 1 && page > 1 ? page - 1 : page)
      } else {
        await memoryApi.clearAll()
        message.success('已清空全部长期记忆')
        await load(1)
      }
      setConfirm({ open: false, kind: 'all' })
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="kh-page">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
        }}
      >
        <h2 style={{ margin: 0 }}>我的长期记忆</h2>
        <Button
          danger
          onClick={() => setConfirm({ open: true, kind: 'all' })}
          disabled={!total && layer === 'user'}
        >
          清空全部
        </Button>
      </div>
      <p className="kh-access-hint">
        记忆只从你的提问中抽取身份、岗位、回答偏好与长期约束，不包含知识库文档内容；
        删除后立即生效，下一轮问答不再使用。
      </p>

      <Tabs
        activeKey={layer}
        onChange={(key) => setLayer(key as Layer)}
        items={[
          { key: 'user', label: '跨会话画像' },
          { key: 'session', label: '会话上下文' },
        ]}
      />

      {layer === 'session' && (
        <div style={{ marginBottom: 12, display: 'flex', gap: 8 }}>
          <Select
            style={{ width: 320 }}
            placeholder="选择要查看的会话"
            value={sessionId}
            onChange={(value) => setSessionId(value)}
            options={sessions.map((session) => ({
              value: session.id,
              label: session.title,
            }))}
            notFoundContent="暂无会话记录"
            showSearch
            optionFilterProp="label"
          />
        </div>
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: (next) => void load(next),
        }}
        columns={[
          {
            title: '记忆内容',
            dataIndex: 'memory',
            render: (value: string) => (
              <Typography.Paragraph
                style={{ marginBottom: 0 }}
                ellipsis={{ rows: 2, tooltip: value }}
              >
                {value || '（空）'}
              </Typography.Paragraph>
            ),
          },
          {
            title: '层级',
            dataIndex: 'layer',
            width: 110,
            render: (value: Layer) => (
              <Tag color={value === 'user' ? 'blue' : 'green'}>
                {value === 'user' ? '跨会话' : '会话'}
              </Tag>
            ),
          },
          {
            title: '更新时间',
            dataIndex: 'updatedAt',
            width: 170,
            render: (value: string | null) => formatTime(value),
          },
          {
            title: '操作',
            width: 90,
            render: (_: unknown, row: MemoryItem) => (
              <Button
                type="link"
                danger
                size="small"
                onClick={() => setConfirm({ open: true, kind: 'one', item: row })}
              >
                删除
              </Button>
            ),
          },
        ]}
        locale={{ emptyText: '暂无记忆条目' }}
      />

      <Modal
        open={confirm.open}
        title={
          confirm.kind === 'one' ? '删除这条记忆？' : '清空全部长期记忆？'
        }
        okText={confirm.kind === 'one' ? '删除' : '确认清空'}
        okButtonProps={{ danger: true, loading: submitting }}
        cancelText="取消"
        onCancel={() => {
          if (!submitting) setConfirm({ open: false, kind: 'all' })
        }}
        onOk={() => void submitConfirm()}
      >
        {confirm.kind === 'one' ? (
          <div>
            <p style={{ marginBottom: 8 }}>删除后助手将不再记得这条内容：</p>
            <Typography.Paragraph
              type="secondary"
              style={{ marginBottom: 0 }}
              ellipsis={{ rows: 3 }}
            >
              {confirm.item?.memory}
            </Typography.Paragraph>
          </div>
        ) : (
          <p style={{ marginBottom: 0 }}>
            会同时删除跨会话画像与所有会话的上下文。聊天记录本身不受影响，
            但助手会忘记你的身份、偏好与约束。此操作不可恢复。
          </p>
        )}
      </Modal>
    </div>
  )
}
