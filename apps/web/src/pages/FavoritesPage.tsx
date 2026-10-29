import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Table, Tag, message } from 'antd'
import { documentApi, favoriteApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem } from '../types'
import { DOC_STATUS, formatTime, getVisibilityMeta } from '../utils'

/** 我的收藏：只展示当前用户仍有权查看的文档 */
export default function FavoritesPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<DocumentItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const pageSize = 10

  async function load(nextPage = page) {
    setLoading(true)
    try {
      const res = await favoriteApi.list(nextPage, pageSize)
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

  return (
    <div className="kh-page">
      <h2 style={{ marginTop: 0 }}>我的收藏</h2>
      <p className="kh-access-hint">
        收藏列表按收藏时间倒序；文档被删除或失去权限后会自动从列表中消失。
      </p>
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
            title: '标题',
            dataIndex: 'title',
            render: (value: string, row: DocumentItem) => (
              <a onClick={() => navigate(`/documents/${row.id}`)}>{value}</a>
            ),
          },
          {
            title: '分类',
            dataIndex: 'categoryName',
            width: 140,
            render: (value?: string | null) => value || '-',
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (status: number) => (
              <Tag color={DOC_STATUS[status]?.color}>
                {DOC_STATUS[status]?.label}
              </Tag>
            ),
          },
          {
            title: '可见性',
            width: 110,
            render: (_: unknown, row: DocumentItem) => {
              const vis = getVisibilityMeta(row)
              return <Tag color={vis.color}>{vis.label}</Tag>
            },
          },
          {
            title: '更新时间',
            dataIndex: 'updatedAt',
            width: 180,
            render: formatTime,
          },
          {
            title: '操作',
            width: 140,
            render: (_: unknown, row: DocumentItem) => (
              <Button
                type="link"
                onClick={async () => {
                  try {
                    await documentApi.toggleFavorite(row.id)
                    message.success('已取消收藏')
                    const nextPage = items.length === 1 && page > 1 ? page - 1 : page
                    void load(nextPage)
                  } catch (error) {
                    message.error(
                      error instanceof ApiError ? error.message : '操作失败',
                    )
                  }
                }}
              >
                取消收藏
              </Button>
            ),
          },
        ]}
      />
    </div>
  )
}
