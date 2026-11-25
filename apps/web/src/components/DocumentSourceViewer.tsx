import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Segmented, Spin, Tag } from 'antd'
import {
  DownloadOutlined,
  ExportOutlined,
  ReloadOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons'
import { ApiError, documentResourcePath, requestBlob } from '../api/client'
import { DocumentMarkdown } from './DocumentMarkdown'
import { FileTypeIcon } from './FileTypeIcon'
import { KhEmpty } from './KhEmpty'
import { downloadDocumentSource } from './SourceFileAction'
import { formatFileSize } from '../utils'

type LoadedSource =
  | { kind: 'pdf'; blob: Blob; url: string }
  | { kind: 'image'; blob: Blob; url: string }
  | { kind: 'text'; blob: Blob; url: string; text: string; ext: 'txt' | 'md' }
  | { kind: 'docx'; blob: Blob; buffer: ArrayBuffer }
  | { kind: 'pptx'; blob: Blob; buffer: ArrayBuffer }
  | {
      kind: 'xlsx'
      blob: Blob
      sheets: Array<{ name: string; rows: string[][] }>
    }
  | { kind: 'unsupported'; blob: Blob; ext: string }

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp'])
const TEXT_EXTS = new Set(['txt', 'md'])
const INLINE_OPEN_EXTS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'txt',
  'md',
])

function resolveExtension(
  fileExtension?: string | null,
  fileName?: string,
): string {
  const clean = fileExtension?.trim().toLowerCase().replace(/^\./, '')
  if (clean) return clean
  if (!fileName || !fileName.includes('.')) return ''
  return fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
}

function excelColumnLabel(index: number): string {
  let n = index
  let label = ''
  while (n >= 0) {
    label = String.fromCharCode((n % 26) + 65) + label
    n = Math.floor(n / 26) - 1
  }
  return label
}

function formatCellValue(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime())
      ? ''
      : cell.toISOString().slice(0, 19).replace('T', ' ')
  }
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  return String(cell)
}

export function DocumentSourceViewer({
  fileUrl,
  fileName,
  fileExtension,
  fileSize,
  compact = false,
}: {
  fileUrl?: string | null
  fileName: string
  fileExtension?: string | null
  fileSize?: string | number | null
  compact?: boolean
}) {
  const ext = resolveExtension(fileExtension, fileName)
  const sourcePath = fileUrl ? documentResourcePath(fileUrl, 'source') : null
  const legacyUrl =
    !sourcePath && fileUrl && /^(https?:\/\/|\/(?!\/))[^\s\\]+$/i.test(fileUrl)
      ? fileUrl
      : null

  const [reloadTick, setReloadTick] = useState(0)
  const [loading, setLoading] = useState(Boolean(sourcePath))
  const [error, setError] = useState<string>()
  const [loaded, setLoaded] = useState<LoadedSource | null>(null)
  const [zoom, setZoom] = useState(100)
  const [mdMode, setMdMode] = useState<'source' | 'rendered'>('source')
  const [sheetIdx, setSheetIdx] = useState(0)
  const [officeError, setOfficeError] = useState<string>()
  const [downloading, setDownloading] = useState(false)

  const docxHostRef = useRef<HTMLDivElement>(null)
  const pptxHostRef = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(() => {
    setReloadTick((n) => n + 1)
  }, [])

  useEffect(() => {
    setZoom(100)
    setMdMode('source')
    setSheetIdx(0)
    setOfficeError(undefined)
  }, [fileUrl, ext])

  useEffect(() => {
    if (!sourcePath) {
      setLoading(false)
      setLoaded(null)
      setError(undefined)
      return
    }

    const controller = new AbortController()
    let objectUrlToRevoke: string | null = null
    setLoading(true)
    setError(undefined)
    setOfficeError(undefined)
    setLoaded(null)

    ;(async () => {
      const rawBlob = await requestBlob(sourcePath, {
        signal: controller.signal,
      })
      if (controller.signal.aborted) return

      if (ext === 'pdf') {
        const pdfBlob = new Blob([rawBlob], { type: 'application/pdf' })
        objectUrlToRevoke = URL.createObjectURL(pdfBlob)
        setLoaded({ kind: 'pdf', blob: pdfBlob, url: objectUrlToRevoke })
      } else if (IMAGE_EXTS.has(ext)) {
        objectUrlToRevoke = URL.createObjectURL(rawBlob)
        setLoaded({ kind: 'image', blob: rawBlob, url: objectUrlToRevoke })
      } else if (TEXT_EXTS.has(ext)) {
        const text = await rawBlob.text()
        if (controller.signal.aborted) return
        const textBlob = new Blob([text], { type: 'text/plain; charset=utf-8' })
        objectUrlToRevoke = URL.createObjectURL(textBlob)
        setLoaded({
          kind: 'text',
          blob: rawBlob,
          url: objectUrlToRevoke,
          text,
          ext: ext === 'md' ? 'md' : 'txt',
        })
      } else if (ext === 'docx') {
        const buffer = await rawBlob.arrayBuffer()
        if (controller.signal.aborted) return
        setLoaded({ kind: 'docx', blob: rawBlob, buffer })
      } else if (ext === 'pptx') {
        const buffer = await rawBlob.arrayBuffer()
        if (controller.signal.aborted) return
        setLoaded({ kind: 'pptx', blob: rawBlob, buffer })
      } else if (ext === 'xlsx') {
        const readXlsxFile = (await import('read-excel-file/browser')).default
        const rawSheets = await readXlsxFile(rawBlob)
        if (controller.signal.aborted) return
        const sheets = rawSheets.map((s) => ({
          name: s.sheet || 'Sheet',
          rows: s.data.map((row) => row.map(formatCellValue)),
        }))
        setLoaded({ kind: 'xlsx', blob: rawBlob, sheets })
      } else {
        setLoaded({ kind: 'unsupported', blob: rawBlob, ext })
      }
    })()
      .catch((cause) => {
        if (controller.signal.aborted) return
        setError(
          cause instanceof ApiError
            ? cause.message
            : '原文件加载或解析失败，请下载后查看',
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => {
      controller.abort()
      if (objectUrlToRevoke) URL.revokeObjectURL(objectUrlToRevoke)
    }
  }, [sourcePath, ext, reloadTick])

  // DOCX 渲染
  useEffect(() => {
    if (loaded?.kind !== 'docx' || !docxHostRef.current) return
    const host = docxHostRef.current
    host.innerHTML = ''
    let cancelled = false
    setOfficeError(undefined)

    import('docx-preview')
      .then(({ renderAsync }) =>
        renderAsync(loaded.buffer.slice(0), host, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          breakPages: true,
        }),
      )
      .catch(() => {
        if (!cancelled) setOfficeError('Word 原件渲染失败，请尝试下载原文件查看')
      })

    return () => {
      cancelled = true
      host.innerHTML = ''
    }
  }, [loaded])

  // PPTX 渲染
  useEffect(() => {
    if (loaded?.kind !== 'pptx' || !pptxHostRef.current) return
    const host = pptxHostRef.current
    host.innerHTML = ''
    let cancelled = false
    let previewer: { destroy: () => void } | null = null
    setOfficeError(undefined)

    const availableWidth =
      canvasWrapRef.current?.clientWidth || (compact ? 440 : 760)
    const width = Math.max(360, Math.min(840, availableWidth - 32))
    const height = Math.round((width * 9) / 16)

    import('pptx-preview')
      .then(({ init }) => {
        if (cancelled) return
        const instance = init(host, { width, height, mode: 'list' })
        previewer = instance
        return instance.preview(loaded.buffer.slice(0))
      })
      .catch(() => {
        if (!cancelled) setOfficeError('PPTX 幻灯片渲染失败，请尝试下载原文件查看')
      })

    return () => {
      cancelled = true
      try {
        previewer?.destroy()
      } catch {
        /* 清理忽略 */
      }
      host.innerHTML = ''
    }
  }, [loaded, compact])

  const handleDownload = async () => {
    if (!sourcePath || downloading) return
    setDownloading(true)
    try {
      await downloadDocumentSource(sourcePath, fileName)
    } finally {
      setDownloading(false)
    }
  }

  const handleOpenInNewTab = () => {
    if (legacyUrl) {
      window.open(legacyUrl, '_blank', 'noopener,noreferrer')
      return
    }
    if (loaded && 'url' in loaded && INLINE_OPEN_EXTS.has(ext)) {
      window.open(loaded.url, '_blank', 'noopener,noreferrer')
      return
    }
    void handleDownload()
  }

  if (!fileUrl) {
    return (
      <div className="kh-source-empty">
        <KhEmpty
          icon="empty"
          description="该文档为在线编辑创建，暂无原始上传文件可预览。"
        />
      </div>
    )
  }

  if (legacyUrl) {
    return (
      <div className="kh-source-empty">
        <KhEmpty icon="empty" description="历史外链原文件，请在外部窗口查看或下载。">
          <Button
            type="primary"
            icon={<ExportOutlined />}
            href={legacyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开原文件
          </Button>
        </KhEmpty>
      </div>
    )
  }

  if (!sourcePath) {
    return (
      <div className="kh-source-empty">
        <KhEmpty icon="empty" description="原文件地址不受支持，无法在线预览。" />
      </div>
    )
  }

  const canZoom =
    loaded?.kind === 'image' ||
    loaded?.kind === 'docx' ||
    loaded?.kind === 'pptx'
  const activeSheet =
    loaded?.kind === 'xlsx' ? loaded.sheets[sheetIdx] ?? loaded.sheets[0] : null
  const maxExcelCols = activeSheet
    ? Math.max(
        1,
        activeSheet.rows.reduce((max, row) => Math.max(max, row.length), 0),
      )
    : 0

  return (
    <div className={`kh-source-viewer${compact ? ' is-compact' : ''}`}>
      <div className="kh-source-toolbar">
        <div className="kh-source-file-meta">
          <FileTypeIcon name={fileName} extension={ext} size={20} />
          <span className="kh-source-file-name" title={fileName}>
            {fileName}
          </span>
          {ext ? <Tag>{ext.toUpperCase()}</Tag> : null}
          {formatFileSize(fileSize) ? (
            <span className="kh-source-file-size">
              {formatFileSize(fileSize)}
            </span>
          ) : null}
        </div>
        <div className="kh-source-toolbar-actions">
          {loaded?.kind === 'text' && loaded.ext === 'md' ? (
            <Segmented
              size="small"
              value={mdMode}
              onChange={(val) => setMdMode(val as 'source' | 'rendered')}
              options={[
                { label: '原文件源码', value: 'source' },
                { label: 'Markdown', value: 'rendered' },
              ]}
            />
          ) : null}
          {canZoom ? (
            <div className="kh-source-zoom">
              <Button
                size="small"
                icon={<ZoomOutOutlined />}
                disabled={zoom <= 50}
                onClick={() => setZoom((z) => Math.max(50, z - 15))}
                aria-label="缩小"
              />
              <button
                type="button"
                className="kh-source-zoom-val"
                title="点击重置缩放"
                onClick={() => setZoom(100)}
              >
                {zoom}%
              </button>
              <Button
                size="small"
                icon={<ZoomInOutlined />}
                disabled={zoom >= 200}
                onClick={() => setZoom((z) => Math.min(200, z + 15))}
                aria-label="放大"
              />
            </div>
          ) : null}
          <Button
            size="small"
            icon={<ExportOutlined />}
            onClick={handleOpenInNewTab}
            disabled={loading || Boolean(error)}
          >
            新标签打开
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            loading={downloading}
            onClick={() => void handleDownload()}
          >
            下载
          </Button>
        </div>
      </div>

      <div ref={canvasWrapRef} className="kh-source-canvas">
        {loading ? (
          <div className="kh-chunks-state">
            <Spin description="正在加载原件内容..." />
          </div>
        ) : error ? (
          <div className="kh-chunks-state">
            <KhEmpty icon="empty" description={error}>
              <Button icon={<ReloadOutlined />} onClick={reload}>
                重试加载
              </Button>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => void handleDownload()}
              >
                下载原文件
              </Button>
            </KhEmpty>
          </div>
        ) : loaded?.kind === 'pdf' ? (
          <iframe
            className="kh-source-pdf-frame"
            src={loaded.url}
            title={fileName}
          />
        ) : loaded?.kind === 'image' ? (
          <div className="kh-source-image-wrap">
            <img
              src={loaded.url}
              alt={fileName}
              style={{
                width: zoom === 100 ? 'auto' : `${zoom}%`,
                maxWidth: zoom <= 100 ? '100%' : 'none',
              }}
            />
          </div>
        ) : loaded?.kind === 'text' ? (
          loaded.ext === 'md' && mdMode === 'rendered' ? (
            <div className="kh-source-md-preview">
              <DocumentMarkdown content={loaded.text} />
            </div>
          ) : (
            <div className="kh-source-code-wrap">
              {loaded.text.split(/\r?\n/).map((line, i) => (
                <div key={i} className="kh-source-code-line">
                  <span className="kh-source-code-ln">{i + 1}</span>
                  <span className="kh-source-code-text">{line || ' '}</span>
                </div>
              ))}
            </div>
          )
        ) : loaded?.kind === 'docx' ? (
          officeError ? (
            <div className="kh-chunks-state">
              <KhEmpty icon="empty" description={officeError}>
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  onClick={() => void handleDownload()}
                >
                  下载原文件
                </Button>
              </KhEmpty>
            </div>
          ) : (
            <div
              className="kh-source-office-stage"
              style={{
                zoom: `${zoom}%`,
              }}
            >
              <div ref={docxHostRef} className="kh-source-docx-host" />
            </div>
          )
        ) : loaded?.kind === 'pptx' ? (
          officeError ? (
            <div className="kh-chunks-state">
              <KhEmpty icon="empty" description={officeError}>
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  onClick={() => void handleDownload()}
                >
                  下载原文件
                </Button>
              </KhEmpty>
            </div>
          ) : (
            <div
              className="kh-source-office-stage"
              style={{
                zoom: `${zoom}%`,
              }}
            >
              <div ref={pptxHostRef} className="kh-source-pptx-host" />
            </div>
          )
        ) : loaded?.kind === 'xlsx' ? (
          <div className="kh-source-xlsx-wrap">
            {loaded.sheets.length > 1 ? (
              <div className="kh-source-xlsx-sheets">
                {loaded.sheets.map((s, idx) => (
                  <button
                    key={`${s.name}-${idx}`}
                    type="button"
                    className={`kh-source-sheet-btn${idx === sheetIdx ? ' is-active' : ''}`}
                    onClick={() => setSheetIdx(idx)}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            ) : null}
            {activeSheet && activeSheet.rows.length > 0 ? (
              <div className="kh-source-xlsx-scroll">
                <table className="kh-source-xlsx-table">
                  <thead>
                    <tr>
                      <th className="kh-source-xlsx-rn">#</th>
                      {Array.from({ length: maxExcelCols }, (_, c) => (
                        <th key={c}>{excelColumnLabel(c)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeSheet.rows.map((row, rIdx) => (
                      <tr key={rIdx} className={rIdx === 0 ? 'is-first-row' : ''}>
                        <td className="kh-source-xlsx-rn">{rIdx + 1}</td>
                        {Array.from({ length: maxExcelCols }, (_, c) => (
                          <td key={c}>{row[c] ?? ''}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="kh-chunks-state">
                <KhEmpty icon="empty" description="当前工作表为空" />
              </div>
            )}
          </div>
        ) : (
          <div className="kh-chunks-state">
            <KhEmpty
              icon="empty"
              description={`暂不支持 .${ext || '未知'} 格式的在线预览，请下载原文件查看。`}
            >
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                onClick={() => void handleDownload()}
              >
                下载原文件
              </Button>
            </KhEmpty>
          </div>
        )}
      </div>
    </div>
  )
}
