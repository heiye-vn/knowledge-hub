import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Form,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from '@ant-design/icons'
import {
  DocumentInspectorTabs,
  type InspectorTabKey,
} from '../components/DocumentInspectorTabs'
import DocumentEngagement from '../components/DocumentEngagement'
import { SourceFileAction } from '../components/SourceFileAction'
import type { LocateTarget } from '../components/markdown-locate'
import { KhIcon } from '../components/icons'
import { KhEmpty } from '../components/KhEmpty'
import { documentApi, indexingApi, teamApi } from '../api'
import { ApiError } from '../api/client'
import type {
  DocumentChunkItem,
  DocumentChunksResponse,
  DocumentItem,
  ReviewTask,
} from '../types'
import { useAuth } from '../auth'
import {
  DOC_STATUS,
  can,
  canWriteDocument,
  flattenTeams,
  formatFileSize,
  formatTime,
  getVisibilityMeta,
  isAdmin,
} from '../utils'
import { FileTypeIcon } from '../components/FileTypeIcon'

function parseTabParam(raw: string | null): InspectorTabKey {
  if (raw === 'source' || raw === 'chunks') return raw
  return 'content'
}

function renderReviewResultTag(result?: number | null) {
  if (result == null) return <Tag color="processing">待审</Tag>
  if (result === 1) return <Tag color="success">通过</Tag>
  if (result === 3) return <Tag>已撤回</Tag>
  return <Tag color="error">驳回</Tag>
}

export default function DocumentDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuth()
  const [doc, setDoc] = useState<DocumentItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)

  const [reviewHistory, setReviewHistory] = useState<ReviewTask[]>([])
  const [reviewModalOpen, setReviewModalOpen] = useState(false)

  const [visModalOpen, setVisModalOpen] = useState(false)
  const [visSaving, setVisSaving] = useState(false)
  const [baseTeamOptions, setBaseTeamOptions] = useState<
    { value: string; label: string }[]
  >([])
  const [teamsLoaded, setTeamsLoaded] = useState(false)
  const [visForm] = Form.useForm<{ isPublic: boolean; teamId?: string }>()

  const [reindexing, setReindexing] = useState(false)

  const [chunksData, setChunksData] = useState<DocumentChunksResponse | null>(
    null,
  )
  const [chunksLoading, setChunksLoading] = useState(true)
  const [chunksError, setChunksError] = useState<string>()

  const tabParam = parseTabParam(searchParams.get('tab'))
  const chunkParam = searchParams.get('chunk')
  const headingParam = searchParams.get('heading')
  const excerptParam = searchParams.get('excerpt')
  const parsedChunkIdx =
    chunkParam !== null && /^\d+$/.test(chunkParam) ? Number(chunkParam) : null

  const [activeTab, setActiveTab] = useState<InspectorTabKey>(tabParam)
  const [activeChunkIndex, setActiveChunkIndex] = useState<number | null>(
    parsedChunkIdx,
  )
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null)
  const [locateTarget, setLocateTarget] = useState<LocateTarget | null>(() =>
    parsedChunkIdx != null || headingParam || excerptParam
      ? {
          chunkIndex: parsedChunkIdx,
          heading: headingParam,
          excerpt: excerptParam,
          nonce: 'init',
        }
      : null,
  )

  useEffect(() => {
    setActiveTab(tabParam)
  }, [tabParam])

  useEffect(() => {
    if (parsedChunkIdx == null && !headingParam && !excerptParam) return
    setActiveChunkIndex(parsedChunkIdx)
    setLocateTarget({
      chunkIndex: parsedChunkIdx,
      heading: headingParam,
      excerpt: excerptParam,
      nonce: `${id}-${chunkParam ?? ''}-${headingParam ?? ''}`,
    })
  }, [id, chunkParam, parsedChunkIdx, headingParam, excerptParam])

  const loadChunks = useCallback(async (docId: string) => {
    setChunksLoading(true)
    setChunksError(undefined)
    try {
      setChunksData(await documentApi.chunks(docId))
    } catch (error) {
      setChunksError(
        error instanceof ApiError ? error.message : '文档切块加载失败',
      )
    } finally {
      setChunksLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setForbidden(false)
    try {
      const [detail, history] = await Promise.all([
        documentApi.get(id),
        documentApi.reviewHistory(id).catch(() => [] as ReviewTask[]),
      ])
      setDoc(detail)
      setReviewHistory(history)
    } catch (error) {
      setDoc(null)
      // 后端对无权文档返回 403，前端据此给出友好空状态
      if (error instanceof ApiError && error.status === 403) {
        setForbidden(true)
        message.error('无权查看该文档')
      } else {
        message.error(error instanceof ApiError ? error.message : '加载失败')
      }
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
    void loadChunks(id)
  }, [id, load, loadChunks])

  // 当切块到达且 URL 带 chunk 参数时，自动用完整 chunk.content 增强正文精定位
  useEffect(() => {
    if (!chunksData?.items.length || parsedChunkIdx == null) return
    const matched = chunksData.items.find(
      (item) => item.chunkIndex === parsedChunkIdx,
    )
    if (!matched) return
    setActiveChunkId(matched.chunkId)
    setLocateTarget((prev) =>
      prev
        ? {
            ...prev,
            heading: prev.heading ?? matched.heading,
            chunkContent: matched.content,
            chunkIndex: matched.chunkIndex,
          }
        : prev,
    )
  }, [chunksData, parsedChunkIdx])

  const teamOptions = useMemo(() => {
    const options = [...baseTeamOptions]
    if (doc?.teamId && !options.some((item) => item.value === doc.teamId)) {
      options.push({
        value: doc.teamId,
        label: doc.teamName || '当前团队',
      })
    }
    return options
  }, [baseTeamOptions, doc?.teamId, doc?.teamName])

  const openVisibilityModal = () => {
    if (!doc) return
    visForm.setFieldsValue({
      isPublic: Boolean(doc.isPublic),
      teamId: doc.teamId || undefined,
    })
    setVisModalOpen(true)
    if (!teamsLoaded) {
      const req = isAdmin(user)
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
      req
        .then((opts) => {
          setBaseTeamOptions(opts)
          setTeamsLoaded(true)
        })
        .catch(() => setBaseTeamOptions([]))
    }
  }

  const handleSaveVisibility = async () => {
    const values = await visForm.validateFields()
    setVisSaving(true)
    try {
      // 仅传可见性字段，命中后端 isVisibilityOnlyUpdate 分支直接同步三套索引
      await documentApi.update(id, {
        isPublic: Boolean(values.isPublic),
        teamId: values.teamId || null,
      })
      message.success('可见性已更新并同步索引')
      setVisModalOpen(false)
      await load()
    } catch (error) {
      message.error(
        error instanceof ApiError ? error.message : '更新可见性失败',
      )
    } finally {
      setVisSaving(false)
    }
  }

  const handleTabChange = (nextTab: InspectorTabKey) => {
    setActiveTab(nextTab)
    const nextParams = new URLSearchParams(searchParams)
    if (nextTab === 'content') {
      nextParams.delete('tab')
    } else {
      nextParams.set('tab', nextTab)
    }
    setSearchParams(nextParams, { replace: true })
  }

  const handleClearLocate = () => {
    setLocateTarget(null)
    setActiveChunkIndex(null)
    setActiveChunkId(null)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('chunk')
    nextParams.delete('heading')
    nextParams.delete('excerpt')
    setSearchParams(nextParams, { replace: true })
  }

  const handleJumpToContent = (chunk: DocumentChunkItem) => {
    setActiveChunkIndex(chunk.chunkIndex)
    setActiveChunkId(chunk.chunkId)
    setLocateTarget({
      heading: chunk.heading,
      chunkContent: chunk.content,
      chunkIndex: chunk.chunkIndex,
      nonce: Date.now(),
    })
    handleTabChange('content')
  }

  if (loading) {
    return (
      <div className="kh-page">
        <Spin />
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="kh-page">
        <KhEmpty
          icon={forbidden ? 'locked' : 'empty'}
          description={forbidden ? '无权查看该文档' : '文档不存在或已删除'}
        >
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/documents')}>
            返回列表
          </Button>
        </KhEmpty>
      </div>
    )
  }

  const status = DOC_STATUS[doc.status]
  const vis = getVisibilityMeta(doc)
  const writable = can(user, 'document:edit') && canWriteDocument(doc, user)
  const canDelete = can(user, 'document:delete') && canWriteDocument(doc, user)
  const deleteDescription =
    doc.status === 1
      ? '该文档当前已发布，删除后将立即从搜索、AI 问答与知识图谱中移除。'
      : doc.status === 2
        ? '删除后该归档文档将从列表中移除。'
        : '删除后该草稿将从列表中移除。'
  const latestReview = reviewHistory[0]
  const rejectedNotice =
    doc.status === 0 && latestReview?.reviewResult === 2 ? latestReview : null

  return (
    <div className="kh-page kh-document-page">
      {rejectedNotice ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="最近一次发布审核未通过"
          description={
            <div>
              <div>驳回原因：{rejectedNotice.reviewComment || '未填写'}</div>
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                审核人：{rejectedNotice.reviewerName || '-'} ·{' '}
                {formatTime(
                  rejectedNotice.reviewedAt || rejectedNotice.createdAt,
                )}
              </div>
            </div>
          }
          action={
            writable ? (
              <Button
                size="small"
                type="primary"
                onClick={() => navigate(`/documents/${id}/edit`)}
              >
                前往修改
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <Space className="kh-doc-actions" wrap>
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate('/documents')}
        >
          返回列表
        </Button>
        <SourceFileAction fileUrl={doc.fileUrl} fileName={doc.fileName ?? doc.title} />
        {writable && doc.status === 0 ? (
          <Button
            icon={<EditOutlined />}
            onClick={() => navigate(`/documents/${id}/edit`)}
          >
            编辑
          </Button>
        ) : null}
        {writable ? (
          <Button
            icon={<KhIcon name="version" size={16} />}
            onClick={() => navigate(`/documents/${id}/versions`)}
          >
            版本
          </Button>
        ) : null}
        {reviewHistory.length ? (
          <Button
            icon={<HistoryOutlined />}
            onClick={() => setReviewModalOpen(true)}
          >
            审核记录（{reviewHistory.length}）
          </Button>
        ) : null}
        {writable && doc.status === 0 ? (
          <Button
            type="primary"
            icon={<KhIcon name="publish" size={16} />}
            onClick={async () => {
              try {
                await documentApi.publish(id)
                message.success('已发布（若开启审核则进入待审状态）')
                await Promise.all([load(), loadChunks(id)])
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
        {writable && doc.status === 1 ? (
          <>
            <Button icon={<EyeOutlined />} onClick={openVisibilityModal}>
              调整可见性
            </Button>
            <Popconfirm
              title="确认下架为草稿？"
              description="下架后将变为草稿并暂时移出搜索与 AI 问答索引，修改完成后可重新发布。"
              okText="下架"
              cancelText="取消"
              onConfirm={async () => {
                try {
                  await documentApi.saveDraft(id)
                  message.success('已下架为草稿')
                  await Promise.all([load(), loadChunks(id)])
                } catch (error) {
                  message.error(
                    error instanceof ApiError ? error.message : '操作失败',
                  )
                }
              }}
            >
              <Button icon={<RollbackOutlined />}>下架编辑</Button>
            </Popconfirm>
            <Popconfirm
              title="确认归档该文档？"
              description="归档为只读终态，将从搜索与 AI 问答索引移除且不可重新发布。"
              okText="归档"
              okType="danger"
              cancelText="取消"
              onConfirm={async () => {
                try {
                  await documentApi.archive(id)
                  message.success('已归档')
                  await Promise.all([load(), loadChunks(id)])
                } catch (error) {
                  message.error(
                    error instanceof ApiError ? error.message : '归档失败',
                  )
                }
              }}
            >
              <Button icon={<KhIcon name="archive" size={16} />}>归档</Button>
            </Popconfirm>
          </>
        ) : null}
        {isAdmin(user) && doc.status === 1 ? (
          <Popconfirm
            title="确认重建该文档的 RAG 索引？"
            description="将提交异步队列重新切块并写入向量索引，适用于检索召回异常时纠偏。"
            okText="重建"
            cancelText="取消"
            onConfirm={async () => {
              setReindexing(true)
              try {
                const res = await indexingApi.reindex([id])
                message.success(`已提交重建索引任务（任务 ID：${res.taskId}）`)
              } catch (error) {
                message.error(
                  error instanceof ApiError ? error.message : '提交重建失败',
                )
              } finally {
                setReindexing(false)
              }
            }}
          >
            <Button icon={<ReloadOutlined />} loading={reindexing}>
              重建索引
            </Button>
          </Popconfirm>
        ) : null}
        {writable && doc.status === 3 ? (
          <Popconfirm
            title="确认撤回提审？"
            description="撤回后将关闭当前待审任务并退回草稿，可继续编辑或删除。"
            okText="撤回"
            cancelText="取消"
            onConfirm={async () => {
              try {
                await documentApi.withdrawReview(id)
                message.success('已撤回至草稿')
                await Promise.all([load(), loadChunks(id)])
              } catch (error) {
                message.error(
                  error instanceof ApiError ? error.message : '撤回失败',
                )
              }
            }}
          >
            <Button icon={<RollbackOutlined />}>撤回提审</Button>
          </Popconfirm>
        ) : null}
        {canDelete && doc.status !== 3 ? (
          <Popconfirm
            title="确认删除该文档？"
            description={deleteDescription}
            okText="删除"
            okType="danger"
            cancelText="取消"
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
            <Button danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        ) : null}
      </Space>

      <div className="kh-doc-header">
        <div className="kh-doc-title-row">
          <FileTypeIcon
            name={doc.fileName || doc.title}
            extension={doc.fileExtension}
            size={32}
          />
          <h1 className="kh-doc-title">{doc.title}</h1>
        </div>
        <div className="kh-doc-meta">
          <Tooltip title={status?.description}>
            <Tag color={status?.color} variant={status?.variant}>
              {status?.label}
            </Tag>
          </Tooltip>
          <Tag color={vis.color}>
            {vis.scope === 'team' && doc.teamName
              ? `团队 · ${doc.teamName}`
              : vis.label}
          </Tag>
          {doc.categoryName ? <Tag>{doc.categoryName}</Tag> : null}
          {doc.version ? (
            writable ? (
              <Tooltip title="查看版本历史">
                <Tag
                  color="geekblue"
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/documents/${id}/versions`)}
                >
                  v{doc.version}
                </Tag>
              </Tooltip>
            ) : (
              <Tag color="geekblue">v{doc.version}</Tag>
            )
          ) : null}
          {doc.authorName ? <span>作者：{doc.authorName}</span> : null}
          <span>浏览 {doc.viewCount ?? 0} 次</span>
          {doc.wordCount ? <span>约 {doc.wordCount} 字</span> : null}
          {chunksData ? (
            <Tooltip title="点击查看全部文档切块">
              <Tag
                color={chunksData.indexed ? 'green' : 'default'}
                style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                onClick={() => handleTabChange('chunks')}
              >
                {chunksData.totalChunks} 个切块
              </Tag>
            </Tooltip>
          ) : null}
          <Tooltip
            title={
              <div>
                {doc.createdAt ? (
                  <div>创建于：{formatTime(doc.createdAt)}</div>
                ) : null}
                {doc.publishTime ? (
                  <div>发布于：{formatTime(doc.publishTime)}</div>
                ) : null}
                {doc.updatedAt ? (
                  <div>更新于：{formatTime(doc.updatedAt)}</div>
                ) : null}
              </div>
            }
          >
            <span>更新于 {formatTime(doc.updatedAt)}</span>
          </Tooltip>
          {doc.publishTime ? (
            <span>发布于 {formatTime(doc.publishTime)}</span>
          ) : null}
          {doc.fileName ? (
            <span>
              原文件：{doc.fileName}
              {formatFileSize(doc.fileSize)
                ? `（${formatFileSize(doc.fileSize)}）`
                : ''}
            </span>
          ) : null}
        </div>
        {doc.summary ? (
          <Typography.Paragraph type="secondary" className="kh-doc-summary">
            {doc.summary}
          </Typography.Paragraph>
        ) : null}
        {doc.tags ? (
          <div className="kh-doc-tags">
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

      <DocumentInspectorTabs
        doc={doc}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        chunksData={chunksData}
        chunksLoading={chunksLoading}
        chunksError={chunksError}
        onReloadChunks={() => void loadChunks(id)}
        locateTarget={locateTarget}
        onClearLocate={handleClearLocate}
        onJumpToContent={handleJumpToContent}
        activeChunkIndex={activeChunkIndex}
        activeChunkId={activeChunkId}
      />
      <DocumentEngagement doc={doc} onChange={setDoc} />

      <Modal
        title="审核记录"
        open={reviewModalOpen}
        footer={null}
        onCancel={() => setReviewModalOpen(false)}
      >
        <List
          dataSource={reviewHistory}
          renderItem={(item) => (
            <List.Item>
              <div style={{ width: '100%' }}>
                <Space style={{ marginBottom: 4 }} wrap>
                  {renderReviewResultTag(item.reviewResult)}
                  {item.reviewerName ? (
                    <Typography.Text strong>{item.reviewerName}</Typography.Text>
                  ) : null}
                  <Typography.Text type="secondary">
                    {formatTime(item.reviewedAt || item.createdAt)}
                  </Typography.Text>
                </Space>
                {item.reviewComment ? (
                  <div>{item.reviewComment}</div>
                ) : (
                  <Typography.Text type="secondary">无审核意见</Typography.Text>
                )}
              </div>
            </List.Item>
          )}
        />
      </Modal>

      <Modal
        title="调整可见性"
        open={visModalOpen}
        okText="保存并同步索引"
        cancelText="取消"
        confirmLoading={visSaving}
        onCancel={() => setVisModalOpen(false)}
        onOk={() => void handleSaveVisibility()}
      >
        <p className="kh-access-hint" style={{ marginBottom: 14 }}>
          修改后将直接同步更新搜索、AI 问答与知识图谱的访问范围，无需下架重审。
        </p>
        <Form form={visForm} layout="vertical">
          <Form.Item
            name="isPublic"
            label="公开可见"
            valuePropName="checked"
            extra="打开后对所有登录用户可见"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            name="teamId"
            label="所属团队"
            extra={
              teamOptions.length
                ? '未公开时，仅作者本人及该团队成员可见'
                : '你尚未加入团队，仅可设为公开或仅自己可见'
            }
          >
            <Select
              allowClear
              placeholder="不指定则仅自己可见（未公开时）"
              options={teamOptions}
              disabled={!teamOptions.length}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
