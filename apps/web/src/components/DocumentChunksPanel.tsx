import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Spin, Tag } from 'antd'
import { AimOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { DocumentMarkdown } from './DocumentMarkdown'
import { KhEmpty } from './KhEmpty'
import type { DocumentChunkItem, DocumentChunksResponse } from '../types'
import { formatTime } from '../utils'

const PREVIEW_CHAR_LIMIT = 800

function ChunkCard({
  chunk,
  totalChunks,
  active,
  onJumpToContent,
}: {
  chunk: DocumentChunkItem
  totalChunks: number
  active: boolean
  onJumpToContent?: (chunk: DocumentChunkItem) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const isLong = chunk.content.length > PREVIEW_CHAR_LIMIT
  const displayText =
    isLong && !expanded
      ? `${chunk.content.slice(0, PREVIEW_CHAR_LIMIT)}...`
      : chunk.content

  useEffect(() => {
    if (!active || !cardRef.current) return
    if (typeof cardRef.current.scrollIntoView === 'function') {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [active])

  return (
    <div
      ref={cardRef}
      className={`kh-chunk-card${active ? ' is-active' : ''}`}
      data-chunk-index={chunk.chunkIndex}
    >
      <div className="kh-chunk-card-head">
        <div className="kh-chunk-card-meta">
          <Tag color={active ? 'blue' : 'default'}>
            #{chunk.chunkIndex + 1} / {totalChunks || chunk.totalChunks || '?'}
          </Tag>
          {chunk.heading ? (
            <span className="kh-chunk-heading" title={chunk.heading}>
              {chunk.heading}
            </span>
          ) : null}
          <span className="kh-chunk-chars">{chunk.charLength} 字</span>
        </div>
        {onJumpToContent ? (
          <Button
            size="small"
            type="link"
            icon={<AimOutlined />}
            onClick={() => onJumpToContent(chunk)}
          >
            定位到正文
          </Button>
        ) : null}
      </div>
      <div className="kh-chunk-card-body">
        <DocumentMarkdown content={displayText} />
      </div>
      {isLong ? (
        <div className="kh-chunk-card-foot">
          <Button
            size="small"
            type="link"
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? '收起切块' : `展开全部（共 ${chunk.charLength} 字）`}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function DocumentChunksPanel({
  chunksData,
  loading,
  error,
  onRetry,
  activeChunkIndex = null,
  activeChunkId = null,
  onJumpToContent,
  documentStatus,
}: {
  chunksData: DocumentChunksResponse | null
  loading: boolean
  error?: string
  onRetry?: () => void
  activeChunkIndex?: number | null
  activeChunkId?: string | null
  onJumpToContent?: (chunk: DocumentChunkItem) => void
  documentStatus?: number
}) {
  const [keyword, setKeyword] = useState('')

  const items = chunksData?.items ?? []
  const totalChunks = chunksData?.totalChunks ?? items.length
  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (item) =>
        item.content.toLowerCase().includes(q) ||
        (item.heading ?? '').toLowerCase().includes(q),
    )
  }, [items, keyword])

  if (loading) {
    return (
      <div className="kh-chunks-state">
        <Spin description="正在读取文档切块..." />
      </div>
    )
  }

  if (error) {
    return (
      <div className="kh-chunks-state">
        <KhEmpty icon="empty" description={error}>
          {onRetry ? (
            <Button icon={<ReloadOutlined />} onClick={onRetry}>
              重新加载
            </Button>
          ) : null}
        </KhEmpty>
      </div>
    )
  }

  const effectiveStatus = chunksData?.documentStatus ?? documentStatus
  if (!items.length) {
    const emptyDesc =
      effectiveStatus !== undefined && effectiveStatus !== 1
        ? '文档当前未处于已发布状态，尚未写入检索切块索引；发布后可在此查看切块。'
        : '当前文档暂无已索引切块（可能尚未建立索引或正文为空）。'
    return (
      <div className="kh-chunks-state">
        <KhEmpty icon="empty" description={emptyDesc}>
          {onRetry ? (
            <Button icon={<ReloadOutlined />} onClick={onRetry}>
              刷新切块
            </Button>
          ) : null}
        </KhEmpty>
      </div>
    )
  }

  return (
    <div className="kh-chunks-panel">
      <div className="kh-chunks-toolbar">
        <div className="kh-chunks-summary">
          <Tag color={chunksData?.indexed ? 'green' : 'default'}>
            {chunksData?.indexed ? '已建立向量/全文索引' : '未索引'}
          </Tag>
          <span>共 {totalChunks} 个切块</span>
          {chunksData?.indexedAt ? (
            <span className="kh-chunks-time">
              索引于 {formatTime(chunksData.indexedAt)}
            </span>
          ) : null}
        </div>
        <Input
          allowClear
          size="small"
          prefix={<SearchOutlined />}
          placeholder="筛选切块内容或章节..."
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          style={{ width: 240, maxWidth: '100%' }}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="kh-chunks-state">
          <KhEmpty icon="search" description="没有匹配该关键词的切块" />
        </div>
      ) : (
        <div className="kh-chunk-list">
          {filtered.map((chunk) => {
            const isActive =
              (activeChunkId != null && chunk.chunkId === activeChunkId) ||
              (activeChunkIndex != null && chunk.chunkIndex === activeChunkIndex)
            return (
              <ChunkCard
                key={chunk.chunkId}
                chunk={chunk}
                totalChunks={totalChunks}
                active={isActive}
                onJumpToContent={onJumpToContent}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

