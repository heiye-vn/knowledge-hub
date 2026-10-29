import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Empty,
  List,
  Popconfirm,
  Space,
  Spin,
  Typography,
  message,
} from 'antd'
import { DocumentMarkdown } from '../components/DocumentMarkdown'
import { documentApi } from '../api'
import { ApiError } from '../api/client'
import type {
  DocumentItem,
  DocumentVersionDetail,
  DocumentVersionSummary,
} from '../types'
import { formatTime } from '../utils'

/** 历史版本：左侧版本列表，右侧正文预览；回滚生成新版本而不是覆盖历史 */
export default function DocumentVersionsPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [doc, setDoc] = useState<DocumentItem | null>(null)
  const [items, setItems] = useState<DocumentVersionSummary[]>([])
  const [current, setCurrent] = useState<DocumentVersionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState(false)

  async function load(selectId?: string) {
    setLoading(true)
    try {
      const [base, versions] = await Promise.all([
        documentApi.get(id),
        documentApi.versions(id),
      ])
      setDoc(base)
      setItems(versions)
      const target =
        versions.find((item) => item.id === selectId) ?? versions[0]
      setCurrent(target ? await documentApi.version(id, target.id) : null)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '版本加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [id])

  async function selectVersion(item: DocumentVersionSummary) {
    try {
      setCurrent(await documentApi.version(id, item.id))
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '版本加载失败')
    }
  }

  async function restore() {
    if (!current || restoring) return
    setRestoring(true)
    try {
      await documentApi.restoreVersion(id, current.id)
      message.success('已回滚为新版本')
      await load()
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '回滚失败')
    } finally {
      setRestoring(false)
    }
  }

  if (loading) {
    return (
      <div className="kh-page">
        <Spin />
      </div>
    )
  }

  const pendingReview = doc?.status === 3

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }} wrap>
        <Button onClick={() => navigate(`/documents/${id}`)}>返回文档</Button>
        <Typography.Text type="secondary">
          {doc?.title} · 共 {items.length} 个版本
        </Typography.Text>
      </Space>
      <h2 style={{ marginTop: 0 }}>历史版本</h2>
      <p className="kh-access-hint">
        回滚会把选中版本的正文写成一条新版本，原来的记录仍保留。
      </p>
      {pendingReview ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="文档正在审核中，暂不能回滚；请等待审核结果或撤回审核。"
        />
      ) : null}
      {!items.length ? (
        <Empty description="还没有版本记录。编辑并保存正文后会出现在这里。" />
      ) : null}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        <List
          style={{ width: 280, flex: 'none' }}
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              style={{
                cursor: 'pointer',
                background: current?.id === item.id ? '#f0f5ff' : undefined,
                borderRadius: 6,
                paddingInline: 8,
              }}
              onClick={() => void selectVersion(item)}
            >
              <div>
                <div>
                  v{item.version} {item.title}
                </div>
                <Typography.Text type="secondary">
                  {formatTime(item.createdAt)}
                </Typography.Text>
              </div>
            </List.Item>
          )}
        />
        {current ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space style={{ marginBottom: 12 }} wrap>
              <Typography.Text strong>
                v{current.version} {current.title}
              </Typography.Text>
              <Popconfirm
                title="确认回滚到该版本？"
                description="当前正文会作为历史保留，回滚结果会生成一条新版本。"
                onConfirm={() => void restore()}
                disabled={pendingReview}
              >
                <Button type="primary" loading={restoring} disabled={pendingReview}>
                  回滚到此版本
                </Button>
              </Popconfirm>
            </Space>
            <DocumentMarkdown content={current.content || '（空正文）'} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
