import { useEffect, useState } from 'react'
import { Button, Spin, Tag, Tooltip } from 'antd'
import { CloseOutlined, ExportOutlined } from '@ant-design/icons'
import { documentApi } from '../api'
import { ApiError } from '../api/client'
import {
  DocumentInspectorTabs,
  type InspectorTabKey,
} from './DocumentInspectorTabs'
import { FileTypeIcon } from './FileTypeIcon'
import { KhEmpty } from './KhEmpty'
import { buildDocumentLocateUrl, type CiteItem } from './SourceCiteList'
import type { LocateTarget } from './markdown-locate'
import type {
  DocumentChunkItem,
  DocumentChunksResponse,
  DocumentItem,
} from '../types'
import { DOC_STATUS } from '../utils'

export function SourceInspectDrawer({
  source,
  onClose,
}: {
  source: CiteItem
  onClose: () => void
}) {
  const [doc, setDoc] = useState<DocumentItem | null>(null)
  const [docLoading, setDocLoading] = useState(true)
  const [docError, setDocError] = useState<string>()

  const [chunksData, setChunksData] = useState<DocumentChunksResponse | null>(
    null,
  )
  const [chunksLoading, setChunksLoading] = useState(true)
  const [chunksError, setChunksError] = useState<string>()

  const [activeTab, setActiveTab] = useState<InspectorTabKey>('content')
  const [locateTarget, setLocateTarget] = useState<LocateTarget | null>(null)
  const [activeChunkIndex, setActiveChunkIndex] = useState<number | null>(
    source.chunkIndex ?? null,
  )
  const [activeChunkId, setActiveChunkId] = useState<string | null>(
    source.chunkId ?? null,
  )

  const loadChunks = async (docId: string, signal?: { cancelled: boolean }) => {
    setChunksLoading(true)
    setChunksError(undefined)
    try {
      const data = await documentApi.chunks(docId)
      if (!signal?.cancelled) setChunksData(data)
    } catch (err) {
      if (!signal?.cancelled) {
        setChunksError(
          err instanceof ApiError ? err.message : '文档切块加载失败',
        )
      }
    } finally {
      if (!signal?.cancelled) setChunksLoading(false)
    }
  }

  useEffect(() => {
    const state = { cancelled: false }
    setActiveTab('content')
    setActiveChunkIndex(source.chunkIndex ?? null)
    setActiveChunkId(source.chunkId ?? null)
    setLocateTarget({
      heading: source.heading,
      excerpt: source.excerpt,
      chunkIndex: source.chunkIndex ?? null,
      nonce: `${source.documentId}-${source.index ?? ''}-${source.chunkIndex ?? ''}-${Date.now()}`,
    })

    setDoc(null)
    setDocLoading(true)
    setDocError(undefined)
    setChunksData(null)

    documentApi
      .get(source.documentId)
      .then((item) => {
        if (!state.cancelled) setDoc(item)
      })
      .catch((err) => {
        if (!state.cancelled) {
          setDocError(err instanceof ApiError ? err.message : '文档加载失败')
        }
      })
      .finally(() => {
        if (!state.cancelled) setDocLoading(false)
      })

    void loadChunks(source.documentId, state)

    return () => {
      state.cancelled = true
    }
  }, [
    source.documentId,
    source.index,
    source.chunkId,
    source.chunkIndex,
    source.heading,
    source.excerpt,
  ])

  // 当切块加载完成且命中对应切块时，用完整 chunk.content 增强正文精定位
  useEffect(() => {
    if (!chunksData?.items.length) return
    const matched = chunksData.items.find(
      (item) =>
        (source.chunkId && item.chunkId === source.chunkId) ||
        (source.chunkIndex != null && item.chunkIndex === source.chunkIndex),
    )
    if (!matched) return
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
  }, [chunksData, source.chunkId, source.chunkIndex])

  const handleJumpToContent = (chunk: DocumentChunkItem) => {
    setActiveChunkIndex(chunk.chunkIndex)
    setActiveChunkId(chunk.chunkId)
    setLocateTarget({
      heading: chunk.heading,
      chunkContent: chunk.content,
      chunkIndex: chunk.chunkIndex,
      nonce: Date.now(),
    })
    setActiveTab('content')
  }

  const openUrl = buildDocumentLocateUrl(source)
  const statusMeta = doc ? DOC_STATUS[doc.status] : undefined

  return (
    <aside className="kh-source-drawer" aria-label="原文溯源面板">
      <div className="kh-source-drawer-top">
        <div className="kh-source-drawer-kicker">
          <span>原文溯源</span>
          {source.index != null ? (
            <Tag color="blue">引用 [{source.index}]</Tag>
          ) : null}
        </div>
        <div className="kh-source-drawer-top-actions">
          <Tooltip title="在新标签页中打开完整文档">
            <Button
              size="small"
              type="text"
              icon={<ExportOutlined />}
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在新标签页中打开"
            />
          </Tooltip>
          <Tooltip title="关闭溯源面板">
            <Button
              size="small"
              type="text"
              icon={<CloseOutlined />}
              onClick={onClose}
              aria-label="关闭溯源面板"
            />
          </Tooltip>
        </div>
      </div>

      <div className="kh-source-drawer-doc">
        <FileTypeIcon
          name={doc?.fileName || source.documentTitle}
          extension={doc?.fileExtension}
          size={30}
        />
        <div className="kh-source-drawer-doc-info">
          <div className="kh-source-drawer-doc-title" title={doc?.title || source.documentTitle}>
            {doc?.title || source.documentTitle}
          </div>
          <div className="kh-source-drawer-doc-meta">
            <span>{doc?.fileExtension?.toUpperCase() || 'MD'}</span>
            {statusMeta ? (
              <Tag color={statusMeta.color} variant={statusMeta.variant}>
                {statusMeta.label}
              </Tag>
            ) : null}
            {source.chunkIndex != null ? (
              <span>定位切块 #{source.chunkIndex + 1}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="kh-source-drawer-body">
        {docLoading ? (
          <div className="kh-chunks-state">
            <Spin description="正在加载溯源文档..." />
          </div>
        ) : docError || !doc ? (
          <div className="kh-chunks-state">
            <KhEmpty
              icon="empty"
              description={docError || '文档不存在或无权查看'}
            />
          </div>
        ) : (
          <DocumentInspectorTabs
            compact
            doc={doc}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            chunksData={chunksData}
            chunksLoading={chunksLoading}
            chunksError={chunksError}
            onReloadChunks={() => void loadChunks(source.documentId)}
            locateTarget={locateTarget}
            onClearLocate={() => setLocateTarget(null)}
            onJumpToContent={handleJumpToContent}
            activeChunkIndex={activeChunkIndex}
            activeChunkId={activeChunkId}
          />
        )}
      </div>
    </aside>
  )
}

