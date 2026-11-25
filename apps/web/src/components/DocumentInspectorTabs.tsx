import { Button, Tag } from 'antd'
import { AimOutlined, CloseOutlined } from '@ant-design/icons'
import { DocumentMarkdown } from './DocumentMarkdown'
import { DocumentSourceViewer } from './DocumentSourceViewer'
import { DocumentChunksPanel } from './DocumentChunksPanel'
import type { LocateTarget } from './markdown-locate'
import type {
  DocumentChunkItem,
  DocumentChunksResponse,
  DocumentItem,
} from '../types'

export type InspectorTabKey = 'content' | 'source' | 'chunks'

export function DocumentInspectorTabs({
  doc,
  activeTab,
  onTabChange,
  chunksData,
  chunksLoading,
  chunksError,
  onReloadChunks,
  locateTarget,
  onClearLocate,
  onJumpToContent,
  activeChunkIndex,
  activeChunkId,
  compact = false,
}: {
  doc: DocumentItem
  activeTab: InspectorTabKey
  onTabChange: (tab: InspectorTabKey) => void
  chunksData: DocumentChunksResponse | null
  chunksLoading: boolean
  chunksError?: string
  onReloadChunks?: () => void
  locateTarget?: LocateTarget | null
  onClearLocate?: () => void
  onJumpToContent?: (chunk: DocumentChunkItem) => void
  activeChunkIndex?: number | null
  activeChunkId?: string | null
  compact?: boolean
}) {
  const chunkCount =
    chunksData?.totalChunks ?? chunksData?.items.length ?? null

  const hasLocate = Boolean(
    locateTarget &&
      (locateTarget.heading ||
        locateTarget.excerpt ||
        locateTarget.chunkContent ||
        locateTarget.chunkIndex != null),
  )

  return (
    <div className={`kh-inspector${compact ? ' is-compact' : ''}`}>
      <div className="kh-doc-tabs" role="tablist" aria-label="文档内容视图">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'content'}
          className={`kh-doc-tab${activeTab === 'content' ? ' is-active' : ''}`}
          onClick={() => onTabChange('content')}
        >
          文档正文
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'source'}
          className={`kh-doc-tab${activeTab === 'source' ? ' is-active' : ''}`}
          onClick={() => onTabChange('source')}
        >
          文档原件
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'chunks'}
          className={`kh-doc-tab${activeTab === 'chunks' ? ' is-active' : ''}`}
          onClick={() => onTabChange('chunks')}
        >
          文档切块
          {chunkCount !== null ? (
            <span className="kh-doc-tab-count">{chunkCount}</span>
          ) : null}
        </button>
      </div>

      {activeTab === 'content' ? (
        <div className="kh-inspector-pane">
          {hasLocate ? (
            <div className="kh-locate-banner">
              <div className="kh-locate-banner-info">
                <AimOutlined />
                <span>已定位至引用片段</span>
                {locateTarget?.chunkIndex != null ? (
                  <Tag color="blue">切块 #{locateTarget.chunkIndex + 1}</Tag>
                ) : null}
                {locateTarget?.heading ? (
                  <span
                    className="kh-locate-banner-heading"
                    title={locateTarget.heading}
                  >
                    章节：{locateTarget.heading}
                  </span>
                ) : null}
              </div>
              <div className="kh-locate-banner-actions">
                {locateTarget?.chunkIndex != null ? (
                  <Button
                    size="small"
                    type="link"
                    onClick={() => onTabChange('chunks')}
                  >
                    查看对应切块
                  </Button>
                ) : null}
                {onClearLocate ? (
                  <Button
                    size="small"
                    type="text"
                    icon={<CloseOutlined />}
                    onClick={onClearLocate}
                  >
                    清除定位
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          <DocumentMarkdown
            content={doc.content || '（暂无正文）'}
            locateTarget={locateTarget}
          />
        </div>
      ) : null}

      {activeTab === 'source' ? (
        <div className="kh-inspector-pane">
          <DocumentSourceViewer
            fileUrl={doc.fileUrl}
            fileName={doc.fileName ?? doc.title}
            fileExtension={doc.fileExtension}
            fileSize={doc.fileSize}
            compact={compact}
          />
        </div>
      ) : null}

      {activeTab === 'chunks' ? (
        <div className="kh-inspector-pane">
          <DocumentChunksPanel
            chunksData={chunksData}
            loading={chunksLoading}
            error={chunksError}
            onRetry={onReloadChunks}
            activeChunkIndex={activeChunkIndex}
            activeChunkId={activeChunkId}
            onJumpToContent={onJumpToContent}
            documentStatus={doc.status}
          />
        </div>
      ) : null}
    </div>
  )
}

