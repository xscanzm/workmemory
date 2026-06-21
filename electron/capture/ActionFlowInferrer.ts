/**
 * ActionFlowInferrer：操作流推断器
 *
 * 通过相邻 segment 的对比推断用户操作流（复制粘贴/上下文切换/深度滚动/
 * 连续编辑/线性浏览），用于感知增强。
 *
 * 推断规则（按优先级从高到低）：
 *  - copy-paste: prev 的某段文本（≥10 字）在 curr 中出现，且时间间隔 <2min
 *  - switch-context: appName 变化，或非浏览器应用的 windowTitle 变化
 *  - browse-linear: 同浏览器应用，windowTitle 或 browserUrl 变化，时间间隔 <2min
 *  - scroll-deep: 同窗口，OCR 文本行级重叠率 >50% 且有新增内容，时间间隔 <1min
 *  - edit-continuous: 同应用同窗口，OCR 文本渐进变化（行级差异 20-50%）
 *  - unknown: 以上都不匹配
 *
 * 时间解析：支持 ISO 时间戳（如 "2026-06-21T10:30:00.000Z"）和 HH:MM:SS 格式。
 */
import type { ActionFlow } from '@/types'

/** 轻量 Segment 输入接口（不直接依赖完整 WorkSegment，降低耦合） */
export interface SegmentLike {
  id: string
  appName: string
  windowTitle: string
  ocrText: string
  /** ISO 时间戳或 HH:MM:SS */
  startTime: string
  endTime: string
  browserUrl?: string
}

/** 推断结果 */
export interface ActionFlowInference {
  actionFlow: ActionFlow
  evidence: string
}

/** 浏览器应用关键词（用于 browse-linear 判定） */
const BROWSER_APP_KEYWORDS = [
  'chrome', 'edge', 'firefox', 'safari', 'brave', 'opera', 'vivaldi', 'arc', 'chromium'
]

/** copy-paste 时间间隔阈值（秒） */
const COPY_PASTE_MAX_INTERVAL = 2 * 60

/** browse-linear 时间间隔阈值（秒） */
const BROWSE_LINEAR_MAX_INTERVAL = 2 * 60

/** scroll-deep 时间间隔阈值（秒） */
const SCROLL_DEEP_MAX_INTERVAL = 1 * 60

/** copy-paste 最小文本长度（字符） */
const COPY_PASTE_MIN_LENGTH = 10

/** scroll-deep 重叠率阈值 */
const SCROLL_DEEP_MIN_OVERLAP = 0.5

/** edit-continuous 行级差异范围 */
const EDIT_CONTINUOUS_MIN_DIFF = 0.2
const EDIT_CONTINUOUS_MAX_DIFF = 0.5

/** 一天的秒数（用于 HH:MM:SS 跨天修正） */
const SECONDS_PER_DAY = 86400

/** 证据中展示的文本块最大长度（超出截断加省略号） */
const EVIDENCE_PREVIEW_MAX = 40

/**
 * 解析时间字符串为秒数。
 * 支持 ISO 时间戳（如 "2026-06-21T10:30:00.000Z"）和 HH:MM:SS 格式。
 * 解析失败返回 NaN。
 */
function parseTimeToSeconds(time: string): number {
  const trimmed = (time ?? '').trim()
  if (trimmed.length === 0) return NaN

  // 尝试 ISO 时间戳（Date.parse 支持标准 ISO 8601）
  const isoMs = Date.parse(trimmed)
  if (!isNaN(isoMs)) {
    return isoMs / 1000
  }

  // HH:MM:SS 格式（可选小数秒）
  const match = trimmed.match(/^(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?$/)
  if (match) {
    const h = parseInt(match[1], 10)
    const m = parseInt(match[2], 10)
    const s = parseInt(match[3], 10)
    return h * 3600 + m * 60 + s
  }

  return NaN
}

/**
 * 计算时间间隔（curr.startTime - prev.endTime），单位秒。
 * 支持 HH:MM:SS 跨天（若结果为负且在 24h 内，加 24h 修正）。
 * 解析失败返回 Infinity（时间相关规则不匹配）。
 */
function getTimeDiffSeconds(prevEnd: string, currStart: string): number {
  const prev = parseTimeToSeconds(prevEnd)
  const curr = parseTimeToSeconds(currStart)
  if (isNaN(prev) || isNaN(curr)) return Infinity
  let diff = curr - prev
  if (diff < 0 && diff > -SECONDS_PER_DAY) {
    diff += SECONDS_PER_DAY
  }
  return diff
}

/** 判断是否为浏览器应用 */
function isBrowserApp(appName: string): boolean {
  const lower = (appName ?? '').toLowerCase()
  return BROWSER_APP_KEYWORDS.some(k => lower.includes(k))
}

/** 按行分割 OCR 文本，去除空行并 trim */
function splitLines(text: string): string[] {
  return (text ?? '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
}

/**
 * 从 OCR 文本中提取候选文本块（按行/句分割）。
 * 用于 copy-paste 检测：在 prev 中提取 ≥10 字的块，检查是否在 curr 中出现。
 */
function extractChunks(text: string): string[] {
  const chunks: string[] = []
  const lines = splitLines(text)
  for (const line of lines) {
    chunks.push(line)
    // 长行额外按句末标点分割，增加匹配机会
    if (line.length > 30) {
      const sentences = line
        .split(/[。！？.!?]/)
        .map(s => s.trim())
        .filter(s => s.length >= COPY_PASTE_MIN_LENGTH)
      chunks.push(...sentences)
    }
  }
  return chunks
}

/**
 * 计算行级 Jaccard 相似度及 curr 中的新增行。
 * - similarity: 交集/并集（0-1）
 * - newLines: curr 有但 prev 没有的行
 */
function lineJaccard(prevText: string, currText: string): {
  similarity: number
  newLines: string[]
} {
  const prevLines = new Set(splitLines(prevText))
  const currLines = splitLines(currText)
  const currSet = new Set(currLines)

  let intersection = 0
  for (const line of prevLines) {
    if (currSet.has(line)) intersection++
  }
  const union = prevLines.size + currSet.size - intersection
  const similarity = union > 0 ? intersection / union : 0

  const newLines = currLines.filter(l => !prevLines.has(l))

  return { similarity, newLines }
}

/**
 * 检测 copy-paste：在 prev.ocrText 中查找 ≥10 字的块，检查是否在 curr.ocrText 中出现。
 * 优先返回较长的匹配块（更具体的证据）。返回匹配块或 null。
 */
function detectCopyPaste(prev: SegmentLike, curr: SegmentLike): string | null {
  const chunks = extractChunks(prev.ocrText)
  const candidates = chunks
    .filter(c => c.length >= COPY_PASTE_MIN_LENGTH)
    .sort((a, b) => b.length - a.length)
  for (const chunk of candidates) {
    if (curr.ocrText.includes(chunk)) {
      return chunk
    }
  }
  return null
}

/** 截断文本块用于证据展示（超长加省略号） */
function previewChunk(chunk: string): string {
  return chunk.length > EVIDENCE_PREVIEW_MAX
    ? chunk.slice(0, EVIDENCE_PREVIEW_MAX) + '...'
    : chunk
}

/**
 * 推断相邻两个 segment 之间的操作流。
 *
 * @param prev 前一个 segment
 * @param curr 当前 segment
 * @returns { actionFlow, evidence }；无法识别时 actionFlow='unknown'
 */
export function inferActionFlow(
  prev: SegmentLike,
  curr: SegmentLike
): ActionFlowInference {
  const timeDiff = getTimeDiffSeconds(prev.endTime, curr.startTime)
  const sameApp = (prev.appName ?? '').toLowerCase() === (curr.appName ?? '').toLowerCase()
  const sameTitle = (prev.windowTitle ?? '') === (curr.windowTitle ?? '')
  const prevIsBrowser = isBrowserApp(prev.appName)
  const currIsBrowser = isBrowserApp(curr.appName)

  // 1. copy-paste（最高优先级）
  if (timeDiff < COPY_PASTE_MAX_INTERVAL) {
    const pastedChunk = detectCopyPaste(prev, curr)
    if (pastedChunk) {
      return {
        actionFlow: 'copy-paste',
        evidence: `prev 中的 '${previewChunk(pastedChunk)}' 出现在 curr 中`
      }
    }
  }

  // 2. switch-context：appName 变化，或非浏览器应用的 windowTitle 变化
  //    （浏览器应用的标题变化归入 browse-linear，视为"细微变化"）
  if (!sameApp) {
    return {
      actionFlow: 'switch-context',
      evidence: `应用从 '${prev.appName || '(空)'}' 切换到 '${curr.appName || '(空)'}'`
    }
  }
  if (!sameTitle && !(prevIsBrowser && currIsBrowser)) {
    return {
      actionFlow: 'switch-context',
      evidence: `窗口从 '${prev.windowTitle || '(空)'}' 切换到 '${curr.windowTitle || '(空)'}'`
    }
  }

  // 3. browse-linear：同浏览器应用，windowTitle 或 browserUrl 变化，时间间隔 <2min
  if (prevIsBrowser && currIsBrowser && timeDiff < BROWSE_LINEAR_MAX_INTERVAL) {
    const urlChanged = !!prev.browserUrl && !!curr.browserUrl && prev.browserUrl !== curr.browserUrl
    const titleChanged = !sameTitle
    if (titleChanged || urlChanged) {
      const change = titleChanged
        ? `标题从 '${prev.windowTitle || '(空)'}' 变为 '${curr.windowTitle || '(空)'}'`
        : `URL 从 '${prev.browserUrl}' 变为 '${curr.browserUrl}'`
      return {
        actionFlow: 'browse-linear',
        evidence: `浏览器线性浏览，${change}`
      }
    }
  }

  // 4. scroll-deep：同窗口，OCR 文本重叠率 >50% 且有新增内容，时间间隔 <1min
  if (sameApp && sameTitle && timeDiff < SCROLL_DEEP_MAX_INTERVAL) {
    const { similarity, newLines } = lineJaccard(prev.ocrText, curr.ocrText)
    if (similarity > SCROLL_DEEP_MIN_OVERLAP && newLines.length > 0) {
      return {
        actionFlow: 'scroll-deep',
        evidence: `同窗口深度滚动，OCR 文本重叠率 ${Math.round(similarity * 100)}%，新增 ${newLines.length} 行`
      }
    }
  }

  // 5. edit-continuous：同应用同窗口，OCR 文本渐进变化（行级差异 20-50%）
  if (sameApp && sameTitle) {
    const { similarity } = lineJaccard(prev.ocrText, curr.ocrText)
    const diff = 1 - similarity
    if (diff >= EDIT_CONTINUOUS_MIN_DIFF && diff <= EDIT_CONTINUOUS_MAX_DIFF) {
      return {
        actionFlow: 'edit-continuous',
        evidence: `同应用同窗口，OCR 文本渐进变化（差异 ${Math.round(diff * 100)}%）`
      }
    }
  }

  // 6. unknown
  return {
    actionFlow: 'unknown',
    evidence: '无法识别操作流'
  }
}
