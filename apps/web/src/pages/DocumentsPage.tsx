import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { EditOutlined } from '@ant-design/icons'
import {
  Button,
  Checkbox,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import { categoryApi, documentApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem } from '../types'
import { useAuth } from '../auth'
import {
  DOC_STATUS,
  can,
  canWriteDocument,
  flattenCategories,
  formatTime,
  getVisibilityMeta,
} from '../utils'
import { FileTypeIcon, fileTypeLabel } from '../components/FileTypeIcon'
import { KhIcon } from '../components/icons'
import { DocumentImports } from '../components/DocumentImports'

export default function DocumentsPage() {
  const user = useAuth()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<number | undefined>()
  const [categoryId, setCategoryId] = useState<string>()
  const [categories, setCategories] = useState<{ value: string; label: string }[]>([])
  const [mineOnly, setMineOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<DocumentItem[]>([])
  const [loading, setLoading] = useState(false)
  const pageSize = 10

  async function load(nextPage = page) {
    setLoading(true)
    try {
      const res = await documentApi.list({
        page: nextPage,
        pageSize,
        title: title.trim() || undefined,
        status,
        categoryId,
        authorId: mineOnly ? user?.userId : undefined,
      })
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
    categoryApi
      .tree()
      .then((tree) =>
        setCategories(
          flattenCategories(tree).map((item) => ({
            value: item.id,
            label: item.label,
          })),
        ),
      )
      .catch(() => setCategories([]))
    void load(1)
  }, [])

  return (
    <div className="kh-page">
      <p className="kh-access-hint">
        列表只展示你能看的文档：公开、所在团队，以及自己写的。编辑 / 发布仅作者或管理员可用。
      </p>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input
          allowClear
          placeholder="标题搜索"
          style={{ width: 240 }}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={() => void load(1)}
        />
        <Select
          allowClear
          placeholder="分类"
          style={{ width: 180 }}
          value={categoryId}
          onChange={setCategoryId}
          options={categories}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 140 }}
          value={status}
          onChange={setStatus}
          options={Object.entries(DOC_STATUS).map(([k, v]) => ({
            value: Number(k),
            label: v.label,
          }))}
        />
        <Checkbox checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)}>
          仅我的
        </Checkbox>
        <Button onClick={() => void load(1)}>查询</Button>
        {can(user, 'document:create') ? (
          <Button type="primary" onClick={() => navigate('/documents/new')}>
            新建文档
          </Button>
        ) : null}
      </Space>
      {user ? <DocumentImports key={user.userId} canUpload={can(user, 'document:create')} /> : null}
      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: (p) => void load(p),
        }}
        columns={[
          {
            title: '标题',
            dataIndex: 'title',
            render: (value: string, row: DocumentItem) => (
              <a
                onClick={() => navigate(`/documents/${row.id}`)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <FileTypeIcon name={row.title} />
                {value}
              </a>
            ),
          },
          {
            title: '文件类型',
            dataIndex: 'title',
            width: 100,
            render: (docTitle: string) => fileTypeLabel(docTitle),
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
            render: (s: number) => (
              <Tag color={DOC_STATUS[s]?.color}>{DOC_STATUS[s]?.label}</Tag>
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
            width: 160,
            render: (_: unknown, row: DocumentItem) => {
              const writable =
                can(user, 'document:edit') && canWriteDocument(row, user)
              return (
                <Space size={12}>
                  {writable ? (
                    <Tooltip title="编辑文档">
                      <a
                        onClick={() => navigate(`/documents/${row.id}/edit`)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <EditOutlined /> 编辑
                      </a>
                    </Tooltip>
                  ) : null}
                  {writable && row.status === 0 ? (
                    <Tooltip title="提交发布（触发 RAG 索引重建）">
                      <a
                        onClick={async () => {
                          try {
                            await documentApi.publish(row.id)
                            message.success('已提交发布')
                            void load()
                          } catch (error) {
                            message.error(
                              error instanceof ApiError
                                ? error.message
                                : '发布失败',
                            )
                          }
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <KhIcon name="publish" size={14} /> 发布
                      </a>
                    </Tooltip>
                  ) : null}
                </Space>
              )
            },
          },
        ]}
      />
    </div>
  )
}
