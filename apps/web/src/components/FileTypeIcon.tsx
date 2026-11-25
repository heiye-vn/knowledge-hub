const ICONS: Record<string, { bg: string; label: string; fontSize: number }> = {
  pdf: { bg: '#E53935', label: 'PDF', fontSize: 7 },
  doc: { bg: '#1E88E5', label: 'W', fontSize: 11 },
  docx: { bg: '#1E88E5', label: 'W', fontSize: 11 },
  xls: { bg: '#43A047', label: 'X', fontSize: 11 },
  xlsx: { bg: '#43A047', label: 'X', fontSize: 11 },
  ppt: { bg: '#FB8C00', label: 'P', fontSize: 11 },
  pptx: { bg: '#FB8C00', label: 'P', fontSize: 11 },
  txt: { bg: '#78909C', label: 'T', fontSize: 11 },
  md: { bg: '#5C6BC0', label: 'MD', fontSize: 7 },
  png: { bg: '#26A69A', label: 'IMG', fontSize: 7 },
  jpg: { bg: '#26A69A', label: 'IMG', fontSize: 7 },
  jpeg: { bg: '#26A69A', label: 'IMG', fontSize: 7 },
  webp: { bg: '#26A69A', label: 'IMG', fontSize: 7 },
  svg: { bg: '#26A69A', label: 'SVG', fontSize: 6 },
}

const FALLBACK = { bg: '#90A4AE', label: 'FILE', fontSize: 6 }

/**
 * 提取文件扩展名标识（PDF / DOCX / XLSX / PPTX / IMG / MD / FILE）。
 *
 * 1. 优先读后端持久化的 fileExtension（最可靠，不受文档标题改名或带版本号影响）；
 * 2. 无 fileExtension 时再回退解析文件名/标题后缀；
 * 3. 纯数字后缀（如标题中的 `v1.1` / `2.0`）视为版本标识而非扩展名，按在线 `md` 文档处理。
 */
export function extFromName(
  name?: string | null,
  fileExtension?: string | null,
) {
  const explicit = fileExtension?.trim().replace(/^\./, '').toLowerCase()
  if (explicit) {
    return explicit in ICONS ? explicit : 'file'
  }
  if (!name) return 'md'
  const base = name.split(/[/\\]/).pop() || name
  const idx = base.lastIndexOf('.')
  if (idx <= 0 || idx === base.length - 1) return 'md'
  const ext = base.slice(idx + 1).toLowerCase()
  if (/^\d+$/.test(ext)) return 'md'
  return ext in ICONS ? ext : 'file'
}

export function fileTypeLabel(
  name?: string | null,
  fileExtension?: string | null,
) {
  const key = extFromName(name, fileExtension)
  if (key === 'doc') return 'DOCX'
  if (key === 'xls') return 'XLSX'
  if (key === 'ppt') return 'PPTX'
  if (key === 'png' || key === 'jpg' || key === 'jpeg' || key === 'webp') {
    return 'IMG'
  }
  return key.toUpperCase()
}

/** 按文件扩展名或文件名画圆角色块图标（PDF / W / X / IMG / MD / FILE） */
export function FileTypeIcon({
  name,
  extension,
  size = 22,
}: {
  name?: string | null
  extension?: string | null
  size?: number
}) {
  const spec = ICONS[extFromName(name, extension)] ?? FALLBACK
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      aria-hidden
      style={{ flexShrink: 0, display: 'block' }}
    >
      <rect width="22" height="22" rx="4" fill={spec.bg} />
      <text
        x="11"
        y="15"
        textAnchor="middle"
        fill="#fff"
        fontSize={spec.fontSize}
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {spec.label}
      </text>
    </svg>
  )
}
