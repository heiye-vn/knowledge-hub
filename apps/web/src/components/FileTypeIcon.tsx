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
 * 从文件名 / 标题截取后缀。
 * 无后缀（在线新建的文档）按 md；后缀无法识别时回退中性 file 徽标，
 * 避免上传的图片等文件被误标成 MD（上传区支持 PNG / JPG / JPEG / WEBP）。
 */
export function extFromName(name?: string | null) {
  if (!name) return 'md'
  const base = name.split(/[/\\]/).pop() || name
  const idx = base.lastIndexOf('.')
  if (idx <= 0 || idx === base.length - 1) return 'md'
  const ext = base.slice(idx + 1).toLowerCase()
  return ext in ICONS ? ext : 'file'
}

export function fileTypeLabel(name?: string | null) {
  const key = extFromName(name)
  if (key === 'doc') return 'DOCX'
  if (key === 'xls') return 'XLSX'
  if (key === 'ppt') return 'PPTX'
  if (key === 'png' || key === 'jpg' || key === 'jpeg' || key === 'webp') {
    return 'IMG'
  }
  return key.toUpperCase()
}

/** 按文件名后缀画圆角色块图标（PDF / W / X / IMG / FILE） */
export function FileTypeIcon({
  name,
  size = 22,
}: {
  name?: string | null
  size?: number
}) {
  const spec = ICONS[extFromName(name)] ?? FALLBACK
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
