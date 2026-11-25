import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Button,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EditOutlined,
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
import { documentApi } from '../api'
import { ApiError } from '../api/client'
import type {
  DocumentChunkItem,
  DocumentChunksResponse,
  DocumentItem,
} from '../types'
import { useAuth } from '../auth'
import {
  DOC_STATUS,
  can,
  canWriteDocument,
  formatFileSize,
  formatTime,
  getVisibilityMeta,
} from '../utils'
import { FileTypeIcon } from '../components/FileTypeIcon'

function parseTabParam(raw: string | null): InspectorTabKey {
  if (raw === 'source' || raw === 'chunks') return raw
  return 'content'
}

export default function DocumentDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuth()
  const [doc, setDoc] = useState<DocumentItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)

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

  async function load() {
    setLoading(true)
    setForbidden(false)
    try {
      setDoc(await documentApi.get(id))
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
  }

  useEffect(() => {
    void load()
    void loadChunks(id)
  }, [id, loadChunks])

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

  return (
    <div className="kh-page kh-document-page">
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
        {writable && doc.status === 0 ? (
          <Button
            type="primary"
            icon={<KhIcon name="publish" size={16} />}
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
        {writable && doc.status === 1 ? (
          <>
            <Popconfirm
              title="确认下架为草稿？"
              description="下架后将变为草稿并暂时移出搜索与 AI 问答索引，修改完成后可重新发布。"
              okText="下架"
              cancelText="取消"
              onConfirm={async () => {
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
                  setDoc(await documentApi.archive(id))
                  message.success('已归档')
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
        {can(user, 'document:delete') && writable ? (
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
    </div>
  )
}
