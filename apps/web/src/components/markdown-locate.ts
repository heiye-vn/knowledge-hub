export interface LocateTarget {
  heading?: string | null
  excerpt?: string | null
  chunkContent?: string | null
  chunkIndex?: number | null
  nonce?: number | string
}

const BLOCK_SELECTOR = 'p, li, tr, blockquote, pre, h1, h2, h3, h4, h5, h6'
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

function normalizeMatchText(raw: string): string {
  return raw
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function stripMarkdownSyntax(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\d+\]/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\w-]*|```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\*\*|__|~~|\*/g, '')
    .replace(/\.\.\.|…/g, ' ')
}

/** 从切块正文、摘录与章节标题中提取高辨识度检索短语（6-32 字，最多 6 条） */
export function extractLocatePhrases(input: {
  heading?: string | null
  excerpt?: string | null
  chunkContent?: string | null
}): string[] {
  const source = input.chunkContent?.trim() || input.excerpt?.trim() || ''
  if (!source) return []

  const normalizedHeading = normalizeMatchText(input.heading ?? '')
  const cleaned = stripMarkdownSyntax(source)
  const rawLines = cleaned
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  const candidates: string[] = []
  for (const line of rawLines) {
    // 跳过 GFM 分隔线与纯符号行
    if (/^[-:|\s]+$/.test(line)) continue
    if (normalizedHeading && normalizeMatchText(line) === normalizedHeading) {
      continue
    }
    const segments = line
      .split(/[。！？；;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    for (const seg of segments) {
      if (seg.length >= 6) {
        candidates.push(seg.slice(0, 32))
      }
      if (seg.length > 32) {
        const mid = Math.floor((seg.length - 24) / 2)
        const slice = seg.slice(mid, mid + 24).trim()
        if (slice.length >= 6) candidates.push(slice)
      }
    }
  }

  if (!candidates.length) {
    const fallback = rawLines.join(' ').replace(/\s+/g, ' ').trim()
    if (fallback.length >= 4) {
      candidates.push(fallback.slice(0, 32))
    }
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of candidates) {
    const key = normalizeMatchText(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= 6) break
  }
  return result
}

function headingLevel(el: Element): number {
  const match = /^H([1-6])$/i.exec(el.tagName)
  return match ? Number(match[1]) : 7
}

function findHeadingElement(
  container: HTMLElement,
  heading: string,
): HTMLElement | null {
  const target = normalizeMatchText(heading)
  if (!target) return null
  const headings = Array.from(
    container.querySelectorAll<HTMLElement>(HEADING_SELECTOR),
  )
  let fuzzy: HTMLElement | null = null
  for (const el of headings) {
    const text = normalizeMatchText(el.textContent ?? '')
    if (!text) continue
    if (text === target) return el
    if (!fuzzy && (text.includes(target) || target.includes(text))) {
      fuzzy = el
    }
  }
  return fuzzy
}

function collectSectionBlocks(
  container: HTMLElement,
  headingEl: HTMLElement,
): HTMLElement[] {
  const allBlocks = Array.from(
    container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  )
  const startIdx = allBlocks.indexOf(headingEl)
  if (startIdx < 0) return allBlocks
  const level = headingLevel(headingEl)
  const scoped: HTMLElement[] = []
  for (let i = startIdx + 1; i < allBlocks.length; i += 1) {
    const el = allBlocks[i]
    if (headingLevel(el) <= level) break
    scoped.push(el)
  }
  return scoped
}

function scoreElement(el: HTMLElement, normalizedPhrases: string[]): number {
  const text = normalizeMatchText(el.textContent ?? '')
  if (!text) return 0
  let score = 0
  for (const phrase of normalizedPhrases) {
    if (text.includes(phrase)) {
      score += 100 + phrase.length
    }
  }
  return score
}

/** 清除既有高亮，在渲染后的 Markdown 容器中定位并高亮对应章节/段落/表格行 */
export function locateAndHighlightInMarkdown(
  container: HTMLElement,
  target: LocateTarget,
): { matched: boolean; label: string | null } {
  for (const prev of Array.from(
    container.querySelectorAll('.kh-locate-highlight'),
  )) {
    prev.classList.remove('kh-locate-highlight')
  }

  const phrases = extractLocatePhrases({
    heading: target.heading,
    excerpt: target.excerpt,
    chunkContent: target.chunkContent,
  })
  const normalizedPhrases = phrases.map(normalizeMatchText).filter(Boolean)

  const headingEl = target.heading
    ? findHeadingElement(container, target.heading)
    : null
  const scopedBlocks = headingEl
    ? collectSectionBlocks(container, headingEl)
    : Array.from(container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
  const allBlocks = Array.from(
    container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
  )

  const searchIn = (pool: HTMLElement[]): HTMLElement[] => {
    if (!normalizedPhrases.length) return []
    const scored = pool
      .map((el, idx) => ({ el, idx, score: scoreElement(el, normalizedPhrases) }))
      .filter((item) => item.score > 0)
    if (!scored.length) return []

    // 表格单元格若被 tr 与内部 p 同时命中，只保留最小语义单元或 tr（优先具体子块或 tr）
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
    const best = scored[0]
    const hits = [best.el]
    // 紧邻的连续块若也命中该切块短语，一并高亮（最多 3 个）
    for (let offset = 1; offset <= 2; offset += 1) {
      const next = pool[best.idx + offset]
      if (!next || next.contains(best.el) || best.el.contains(next)) continue
      if (scoreElement(next, normalizedPhrases) > 0) {
        hits.push(next)
      } else {
        break
      }
    }
    return hits
  }

  let matchedEls = searchIn(scopedBlocks)
  if (!matchedEls.length && headingEl) {
    matchedEls = searchIn(allBlocks)
  }
  if (!matchedEls.length && headingEl) {
    matchedEls = [headingEl]
  }

  if (!matchedEls.length) {
    return { matched: false, label: null }
  }

  for (const el of matchedEls) {
    el.classList.add('kh-locate-highlight')
  }
  const first = matchedEls[0]
  if (typeof first.scrollIntoView === 'function') {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const label =
    target.heading?.trim() ||
    (first.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 32) ||
    null
  return { matched: true, label }
}

