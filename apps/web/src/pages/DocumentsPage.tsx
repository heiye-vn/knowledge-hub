import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DeleteOutlined, EditOutlined, RollbackOutlined } from '@ant-design/icons'
import {
  Button,
  Checkbox,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd'
import { categoryApi, documentApi, teamApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem } from '../types'
import { useAuth } from '../auth'
import {
  DOC_STATUS,
  DOC_STATUS_LIST,
  can,
  canWriteDocument,
  flattenCategories,
  flattenTeams,
  formatTime,
  getVisibilityMeta,
  isAdmin,
} from '../utils'
import { FileTypeIcon, fileTypeLabel } from '../components/FileTypeIcon'
import { KhIcon } from '../components/icons'
import {
  DocumentImportBar,
  DocumentImportsSidebar,
  useImportJobs,
} from '../components/DocumentImports'
import { CreateDocumentModal } from '../components/CreateDocumentModal'
import { DocumentStatusGuide } from '../components/DocumentStatusGuide'

type FilterOverrides = {
  title?: string
  status?: number
  categoryId?: string
  teamId?: string
  mineOnly?: boolean
}

function DocumentsWorkspace() {
  const user = useAuth()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<number | undefined>()
  const [categoryId, setCategoryId] = useState<string>()
  const [teamId, setTeamId] = useState<string>()
  const [categories, setCategories] = useState<{ value: string; label: string }[]>([])
  const [teams, setTeams] = useState<{ value: string; label: string }[]>([])
  const [mineOnly, setMineOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<DocumentItem[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const pageSize = 10
  const canCreate = can(user, 'document:create')

  const load = useCallback(
    async (nextPage: number, overrides: FilterOverrides = {}) => {
      const nextTitle = 'title' in overrides ? (overrides.title ?? '') : title
      const nextStatus = 'status' in overrides ? overrides.status : status
      const nextCategoryId =
        'categoryId' in overrides ? overrides.categoryId : categoryId
      const nextTeamId = 'teamId' in overrides ? overrides.teamId : teamId
      const nextMineOnly =
        'mineOnly' in overrides ? Boolean(overrides.mineOnly) : mineOnly

      setLoading(true)
      try {
        const res = await documentApi.list({
          page: nextPage,
          pageSize,
          title: nextTitle.trim() || undefined,
          status: nextStatus,
          categoryId: nextCategoryId,
          teamId: nextTeamId,
          authorId: nextMineOnly ? user?.userId : undefined,
        })
        setItems(res.items)
        setTotal(res.total)
        setPage(nextPage)
      } catch (error) {
        message.error(error instanceof ApiError ? error.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [title, status, categoryId, teamId, mineOnly, user?.userId],
  )

  // 有后台导入任务完成时自动刷新第 1 页文档列表
  const handleImportCompleted = useCallback(() => {
    void load(1)
  }, [load])

  const importJobs = useImportJobs(canCreate, handleImportCompleted)

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
    const teamReq = isAdmin(user)
      ? teamApi
          .tree()
          .then((tree) =>
            flattenTeams(tree).map((t) => ({ value: t.id, label: t.name })),
          )
      : teamApi
          .mine()
          .then((rows) =>
            rows.map((t) => ({ value: t.id, label: t.teamName })),
          )
    teamReq.then(setTeams).catch(() => setTeams([]))
    void load(1)
    // 仅在首次挂载时拉取分类、团队与默认列表；后续查询由筛选变更或用户点击触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleDeleteRow = async (docId: string) => {
    try {
      await documentApi.remove(docId)
      message.success('已删除')
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page
      void load(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '删除失败')
    }
  }

  return (
    <div className={`kh-docs-layout${canCreate ? ' has-aside' : ''}`}>
      <section className="kh-docs-main" aria-label="文档管理">
        <div className="kh-access-hint kh-access-hint--between">
          <span>
            列表只展示你能看的文档：公开、所在团队，以及自己写的。编辑 / 发布仅作者或管理员可用。
          </span>
          <DocumentStatusGuide showLabel placement="bottomRight" />
        </div>
        {canCreate ? (
          <DocumentImportBar
            controller={importJobs}
            categories={categories}
            teams={teams}
            onCreateClick={() => setCreateOpen(true)}
          />
        ) : null}
        <Space style={{ marginBottom: 16 }} wrap>
          <Input
            allowClear
            placeholder="标题搜索"
            style={{ width: 200 }}
            value={title}
            onChange={(e) => {
              const next = e.target.value
              setTitle(next)
              if (next === '' && title !== '') {
                void load(1, { title: '' })
              }
            }}
            onPressEnter={() => void load(1)}
          />
          <Select
            allowClear
            placeholder="分类"
            style={{ width: 150 }}
            value={categoryId}
            onChange={(val) => {
              setCategoryId(val)
              void load(1, { categoryId: val })
            }}
            options={categories}
          />
          <Select
            allowClear
            placeholder="所属团队"
            style={{ width: 150 }}
            value={teamId}
            onChange={(val) => {
              setTeamId(val)
              void load(1, { teamId: val })
            }}
            options={teams}
          />
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 120 }}
            value={status}
            onChange={(val) => {
              setStatus(val)
              void load(1, { status: val })
            }}
            options={DOC_STATUS_LIST.map((item) => ({
              value: item.code,
              label: item.label,
            }))}
          />
          <Checkbox
            checked={mineOnly}
            onChange={(e) => {
              const checked = e.target.checked
              setMineOnly(checked)
              void load(1, { mineOnly: checked })
            }}
          >
            仅我的
          </Checkbox>
          <Button onClick={() => void load(1)}>查询</Button>
        </Space>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={items}
          scroll={{ x: 'max-content' }}
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
              ellipsis: true,
              render: (value: string, row: DocumentItem) => (
                <a
                  onClick={() => navigate(`/documents/${row.id}`)}
                  className="kh-doc-title-link"
                >
                  <FileTypeIcon
                    name={row.fileName || row.title}
                    extension={row.fileExtension}
                  />
                  <span>{value}</span>
                </a>
              ),
            },
            {
              title: '文件类型',
              dataIndex: 'title',
              width: 100,
              render: (_: string, row: DocumentItem) =>
                fileTypeLabel(row.fileName || row.title, row.fileExtension),
            },
            {
              title: '分类',
              dataIndex: 'categoryName',
              width: 120,
              ellipsis: true,
              render: (value?: string | null) => value || '-',
            },
            {
              title: '作者',
              dataIndex: 'authorName',
              width: 108,
              ellipsis: true,
              render: (value?: string | null) => value || '-',
            },
            {
              title: (
                <span className="kh-status-col-head">
                  状态
                  <DocumentStatusGuide placement="bottom" />
                </span>
              ),
              dataIndex: 'status',
              width: 108,
              render: (s: number) => {
                const meta = DOC_STATUS[s]
                return (
                  <Tooltip title={meta?.description}>
                    <Tag
                      color={meta?.color}
                      variant={meta?.variant}
                      style={{ marginInlineEnd: 0 }}
                    >
                      {meta?.label}
                    </Tag>
                  </Tooltip>
                )
              },
            },
            {
              title: '可见性',
              width: 118,
              render: (_: unknown, row: DocumentItem) => {
                const vis = getVisibilityMeta(row)
                const text =
                  vis.scope === 'team' && row.teamName ? row.teamName : vis.label
                const tip =
                  vis.scope === 'public'
                    ? '所有登录用户可见'
                    : vis.scope === 'team'
                      ? `仅「${row.teamName || '所属团队'}」成员可见`
                      : '仅作者本人与管理员可见'
                return (
                  <Tooltip title={tip}>
                    <Tag
                      color={vis.color}
                      style={{
                        marginInlineEnd: 0,
                        maxWidth: 102,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        verticalAlign: 'bottom',
                      }}
                    >
                      {text}
                    </Tag>
                  </Tooltip>
                )
              },
            },
            {
              title: '更新时间',
              dataIndex: 'updatedAt',
              width: 156,
              render: formatTime,
            },
            {
              title: '操作',
              width: 196,
              render: (_: unknown, row: DocumentItem) => {
                const writable =
                  can(user, 'document:edit') && canWriteDocument(row, user)
                const canDelete =
                  can(user, 'document:delete') && canWriteDocument(row, user)

                if (row.status === 0) {
                  if (!writable && !canDelete) {
                    return <span style={{ color: '#bfbfbf' }}>-</span>
                  }
                  return (
                    <Space size={10}>
                      {writable ? (
                        <>
                          <Tooltip title="编辑草稿">
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
                          <Tooltip title="提交发布（触发 RAG 索引重建）">
                            <a
                              onClick={async () => {
                                try {
                                  await documentApi.publish(row.id)
                                  message.success('已提交发布')
                                  void load(page)
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
                        </>
                      ) : null}
                      {canDelete ? (
                        <Popconfirm
                          title="确认删除该草稿文档？"
                          description="删除后将从文档列表中移除。"
                          okText="删除"
                          okType="danger"
                          cancelText="取消"
                          onConfirm={() => handleDeleteRow(row.id)}
                        >
                          <a
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              color: '#dc2626',
                            }}
                          >
                            <DeleteOutlined /> 删除
                          </a>
                        </Popconfirm>
                      ) : null}
                    </Space>
                  )
                }

                if (row.status === 1) {
                  if (!writable) {
                    return <span style={{ color: '#bfbfbf' }}>-</span>
                  }
                  return (
                    <Space size={10}>
                      <Popconfirm
                        title="确认下架为草稿？"
                        description="下架后将暂时从搜索与 AI 问答中移除，修改完成后可重新发布。"
                        okText="下架"
                        cancelText="取消"
                        onConfirm={async () => {
                          try {
                            await documentApi.saveDraft(row.id)
                            message.success('已下架为草稿，现在可以编辑')
                            void load(page)
                          } catch (error) {
                            message.error(
                              error instanceof ApiError
                                ? error.message
                                : '操作失败',
                            )
                          }
                        }}
                      >
                        <Tooltip title="已发布文档需先下架为草稿才能修改内容">
                          <a
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <RollbackOutlined /> 下架编辑
                          </a>
                        </Tooltip>
                      </Popconfirm>
                      <Popconfirm
                        title="确认归档该文档？"
                        description="归档为只读终态，将从搜索与 AI 问答索引移除且不可重新发布。"
                        okText="归档"
                        okType="danger"
                        cancelText="取消"
                        onConfirm={async () => {
                          try {
                            await documentApi.archive(row.id)
                            message.success('已归档')
                            void load(page)
                          } catch (error) {
                            message.error(
                              error instanceof ApiError
                                ? error.message
                                : '归档失败',
                            )
                          }
                        }}
                      >
                        <a
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          <KhIcon name="archive" size={14} /> 归档
                        </a>
                      </Popconfirm>
                    </Space>
                  )
                }

                if (row.status === 3) {
                  if (!writable) {
                    return <span style={{ color: '#bfbfbf' }}>-</span>
                  }
                  return (
                    <Popconfirm
                      title="确认撤回提审？"
                      description="撤回后将关闭当前待审任务并退回草稿，可继续编辑或删除。"
                      okText="撤回"
                      cancelText="取消"
                      onConfirm={async () => {
                        try {
                          await documentApi.withdrawReview(row.id)
                          message.success('已撤回至草稿')
                          void load(page)
                        } catch (error) {
                          message.error(
                            error instanceof ApiError
                              ? error.message
                              : '撤回失败',
                          )
                        }
                      }}
                    >
                      <a
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <RollbackOutlined /> 撤回提审
                      </a>
                    </Popconfirm>
                  )
                }

                if (row.status === 2) {
                  if (!canDelete) {
                    return <span style={{ color: '#bfbfbf' }}>-</span>
                  }
                  return (
                    <Popconfirm
                      title="确认删除该归档文档？"
                      description="删除后将从文档列表中移除。"
                      okText="删除"
                      okType="danger"
                      cancelText="取消"
                      onConfirm={() => handleDeleteRow(row.id)}
                    >
                      <a
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: '#dc2626',
                        }}
                      >
                        <DeleteOutlined /> 删除
                      </a>
                    </Popconfirm>
                  )
                }

                return <span style={{ color: '#bfbfbf' }}>-</span>
              },
            },
          ]}
        />
        {canCreate ? (
          <CreateDocumentModal
            open={createOpen}
            categories={categories}
            onCancel={() => setCreateOpen(false)}
            onCreated={() => {
              setCreateOpen(false)
              void load(1)
            }}
          />
        ) : null}
      </section>

      {canCreate ? <DocumentImportsSidebar controller={importJobs} /> : null}
    </div>
  )
}

/** 按账号 ID 挂载，确保切换账号后导入任务队列与筛选状态彻底隔离 */
export default function DocumentsPage() {
  const user = useAuth()
  return <DocumentsWorkspace key={user?.userId ?? 'guest'} />
}
