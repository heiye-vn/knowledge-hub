/**
 * 图标构建脚本：单一数据源 → 6 类产物
 *
 *   node build.mjs
 *
 * 产物：
 *   svg/kh-*.svg        独立图标文件（拖进 Figma / 直接 <img>）
 *   icons.svg           SVG Sprite（<use href="icons.svg#kh-home">）
 *   KhIcon.tsx          React 组件（内联路径，无运行时请求）
 *   index.ts            组件与元数据出口
 *   manifest.json       机器可读清单（供 CI 校验命名 / 数量）
 *   preview.html        规范与预览页
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICONS, GROUPS, META } from './icons.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const svgDir = join(root, 'svg')
mkdirSync(svgDir, { recursive: true })

const SW = META.strokeWidth
const STROKE_ATTRS =
  `fill="none" stroke="currentColor" stroke-width="${SW}" ` +
  `stroke-linecap="round" stroke-linejoin="round"`

/* ── 形状 → SVG 片段 ─────────────────────────────────────── */
function renderShape(s, indent = '') {
  switch (s.t) {
    case 'p':
      return `${indent}<path d="${s.d}" ${STROKE_ATTRS} />`
    case 'c':
      return `${indent}<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${STROKE_ATTRS} />`
    case 'r': {
      const dash = s.dash ? ` stroke-dasharray="${s.dash}"` : ''
      return `${indent}<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.rx}"${dash} ${STROKE_ATTRS} />`
    }
    case 'f':
      return `${indent}<path d="${s.d}" fill="currentColor" stroke="none" />`
    case 'fc':
      return `${indent}<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="currentColor" stroke="none" />`
    default:
      throw new Error(`未知形状类型：${s.t}`)
  }
}

/* ── 1. 独立 SVG ─────────────────────────────────────────── */
for (const file of readdirSync(svgDir)) {
  if (file.endsWith('.svg')) unlinkSync(join(svgDir, file))
}
for (const icon of ICONS) {
  const body = icon.shapes.map((s) => renderShape(s, '  ')).join('\n')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" role="img" aria-label="${icon.zh}">
${body}
</svg>
`
  writeFileSync(join(svgDir, `kh-${icon.name}.svg`), svg, 'utf8')
}

/* ── 2. Sprite ───────────────────────────────────────────── */
const symbols = ICONS.map((icon) => {
  const body = icon.shapes.map((s) => renderShape(s, '    ')).join('\n')
  return `  <symbol id="kh-${icon.name}" viewBox="0 0 24 24">\n${body}\n  </symbol>`
}).join('\n')

const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">
  <defs>
${symbols}
  </defs>
</svg>
`
writeFileSync(join(root, 'icons.svg'), sprite, 'utf8')

/* ── 3. React 组件 ───────────────────────────────────────── */
const tsShapes = ICONS.map((icon) => {
  const items = icon.shapes.map((s) => {
    if (s.t === 'p') return `    { t: 'p', d: '${s.d}' }`
    if (s.t === 'c') return `    { t: 'c', cx: ${s.cx}, cy: ${s.cy}, r: ${s.r} }`
    if (s.t === 'r') {
      const dash = s.dash ? `, dash: '${s.dash}'` : ''
      return `    { t: 'r', x: ${s.x}, y: ${s.y}, w: ${s.w}, h: ${s.h}, rx: ${s.rx}${dash} }`
    }
    if (s.t === 'f') return `    { t: 'f', d: '${s.d}' }`
    return `    { t: 'fc', cx: ${s.cx}, cy: ${s.cy}, r: ${s.r} }`
  }).join(',\n')
  return `  '${icon.name}': [\n${items},\n  ]`
}).join(',\n')

const names = ICONS.map((i) => `  | '${i.name}'`).join('\n')

const tsx = `/* 由 design/kh-icons/build.mjs 自动生成，请勿手改。 */

import type { CSSProperties, SVGProps } from 'react'

export type KhIconName =
${names}

type Shape =
  | { t: 'p'; d: string }
  | { t: 'c'; cx: number; cy: number; r: number }
  | { t: 'r'; x: number; y: number; w: number; h: number; rx: number; dash?: string }
  | { t: 'f'; d: string }
  | { t: 'fc'; cx: number; cy: number; r: number }

const ICONS: Record<KhIconName, Shape[]> = {
${tsShapes}
}

export interface KhIconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'color'> {
  name: KhIconName
  /** 像素尺寸，默认 24 */
  size?: number
  /** 颜色，默认继承 currentColor */
  color?: string
  /** 描边宽度，默认 ${SW}，非特殊场景不要改 */
  strokeWidth?: number
  style?: CSSProperties
}

export function KhIcon({
  name,
  size = 24,
  color = 'currentColor',
  strokeWidth = ${SW},
  style,
  ...rest
}: KhIconProps) {
  const shapes = ICONS[name]
  if (!shapes) return null
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0, ...style }}
      {...rest}
    >
      {shapes.map((s, i) => {
        if (s.t === 'p') return <path key={i} d={s.d} />
        if (s.t === 'c') return <circle key={i} cx={s.cx} cy={s.cy} r={s.r} />
        if (s.t === 'r') {
          return (
            <rect
              key={i}
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={s.rx}
              strokeDasharray={s.dash}
            />
          )
        }
        if (s.t === 'f') return <path key={i} d={s.d} fill={color} stroke="none" />
        return <circle key={i} cx={s.cx} cy={s.cy} r={s.r} fill={color} stroke="none" />
      })}
    </svg>
  )
}

export default KhIcon
`
writeFileSync(join(root, 'KhIcon.tsx'), tsx, 'utf8')

/* ── 4. 元数据出口 ───────────────────────────────────────── */
const metaEntries = ICONS.map(
  (i) =>
    `  { name: '${i.name}', zh: '${i.zh}', group: '${i.group}', use: '${i.use}' }`,
).join(',\n')

const indexTs = `/* 由 design/kh-icons/build.mjs 自动生成，请勿手改。 */

export { KhIcon, type KhIconName, type KhIconProps } from './KhIcon'
export { default } from './KhIcon'

export const KH_ICON_META = [
${metaEntries},
] as const

export const KH_ICON_NAMES = KH_ICON_META.map((i) => i.name)
`
writeFileSync(join(root, 'index.ts'), indexTs, 'utf8')

/* ── 5. Manifest ─────────────────────────────────────────── */
writeFileSync(
  join(root, 'manifest.json'),
  JSON.stringify(
    {
      ...META,
      generatedAt: new Date().toISOString(),
      count: ICONS.length,
      groups: GROUPS,
      icons: ICONS.map((i) => ({
        file: `svg/kh-${i.name}.svg`,
        spriteId: `kh-${i.name}`,
        name: i.name,
        zh: i.zh,
        group: i.group,
        use: i.use,
        keywords: i.keywords,
        shapeCount: i.shapes.length,
      })),
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

/* ── 6. 预览页 ───────────────────────────────────────────── */
const tpl = readFileSync(join(root, 'preview.tpl.html'), 'utf8')
const payload = JSON.stringify({ meta: META, groups: GROUPS, icons: ICONS }).replace(
  /</g,
  '\\u003c',
)
writeFileSync(join(root, 'preview.html'), tpl.replace('__ICON_DATA__', payload), 'utf8')

console.log(
  `✓ 构建完成：${ICONS.length} 枚图标 · ${Object.keys(GROUPS).length} 个分组\n` +
    `  svg/            ${ICONS.length} 个独立文件\n` +
    `  icons.svg       sprite\n` +
    `  KhIcon.tsx      React 组件\n` +
    `  index.ts        元数据出口\n` +
    `  manifest.json   机器可读清单\n` +
    `  preview.html    预览页`,
)
