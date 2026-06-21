/**
 * HourContextPackBuilder：把上一小时 segments 压缩成发送给 AI 的文本证据包。
 */
import type {
  HourChangePoint,
  HourContextPack,
  HourRepresentativeFrame,
  HourWindowTimelineItem,
  SourceQuality,
  WorkSegment
} from '@/types'
import { SegmentRepository } from '../db/repositories/SegmentRepository'

const SIMILARITY_THRESHOLD = 0.82
const TEXT_PREVIEW_MAX = 1200

function timeToSeconds(time: string): number {
  const parts = time.split(':').map((p) => parseInt(p, 10))
  if (parts.length < 2 || parts.some((p) => Number.isNaN(p))) return 0
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] ?? 0)
}

function hourRange(hourBucket: string): { startSeconds: number; endSeconds: number; startTime: string; endTime: string } {
  const hour = parseInt(hourBucket.slice(0, 2), 10)
  const safeHour = Number.isFinite(hour) ? Math.max(0, Math.min(23, hour)) : 0
  return {
    startSeconds: safeHour * 3600,
    endSeconds: (safeHour + 1) * 3600,
    startTime: `${String(safeHour).padStart(2, '0')}:00:00`,
    endTime: `${String(safeHour).padStart(2, '0')}:59:59`
  }
}

function segmentText(segment: WorkSegment): string {
  return `${segment.windowTitle}\n${segment.ocrText || segment.ocrSummary}`.trim()
}

function textTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.toLowerCase()
  const words = normalized.match(/[a-zA-Z0-9]{2,}/g) ?? []
  for (const word of words) tokens.add(word)
  const chinese = normalized.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const chunk of chinese) {
    for (let i = 0; i < chunk.length - 1; i++) tokens.add(chunk.slice(i, i + 2))
    if (chunk.length === 1) tokens.add(chunk)
  }
  return tokens
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function deriveQuality(segment: WorkSegment): SourceQuality {
  if (segment.isPrivate || segment.sourceStatus === 'private') return 'private'
  if (segment.sourceStatus === 'ocr_failed') return 'failed'
  if (segment.sourceQuality) return segment.sourceQuality
  if (segment.sourceStatus === 'ocr_done') return 'medium'
  return 'low'
}

function buildWindowTimeline(segments: WorkSegment[]): HourWindowTimelineItem[] {
  const result: HourWindowTimelineItem[] = []
  for (const segment of segments) {
    const last = result[result.length - 1]
    if (last && last.appName === segment.appName && last.windowTitle === segment.windowTitle) {
      last.endTime = segment.endTime
      last.segmentIds.push(segment.id)
    } else {
      result.push({
        startTime: segment.startTime,
        endTime: segment.endTime,
        appName: segment.appName,
        windowTitle: segment.windowTitle,
        segmentIds: [segment.id]
      })
    }
  }
  return result
}

function toFrame(segment: WorkSegment): HourRepresentativeFrame {
  return {
    segmentId: segment.id,
    startTime: segment.startTime,
    endTime: segment.endTime,
    appName: segment.appName,
    windowTitle: segment.windowTitle,
    text: segmentText(segment).slice(0, TEXT_PREVIEW_MAX),
    sourceQuality: deriveQuality(segment)
  }
}

export class HourContextPackBuilder {
  build(date: string, hourBucket: string): HourContextPack {
    const range = hourRange(hourBucket)
    const allSegments = SegmentRepository.getActiveByDate(date)
    const hourSegments = allSegments.filter((segment) => {
      const start = timeToSeconds(segment.startTime)
      return start >= range.startSeconds && start < range.endSeconds
    })
    const privateCount = hourSegments.filter((s) => s.isPrivate || s.sourceStatus === 'private').length
    const segments = hourSegments.filter((s) => !s.isPrivate && s.sourceStatus !== 'private')

    const representativeFrames: HourRepresentativeFrame[] = []
    const changePoints: HourChangePoint[] = []
    let lastTokens: Set<string> | null = null
    let lastFrame: HourRepresentativeFrame | null = null

    for (const segment of segments) {
      const text = segmentText(segment)
      const tokens = textTokens(text)
      const sameAppAndTitle =
        lastFrame?.appName === segment.appName && lastFrame.windowTitle === segment.windowTitle
      const similarity = lastTokens ? jaccard(lastTokens, tokens) : 0
      const shouldCompress = lastTokens !== null && sameAppAndTitle && similarity >= SIMILARITY_THRESHOLD

      if (shouldCompress && lastFrame) {
        lastFrame.endTime = segment.endTime
        continue
      }

      const frame = toFrame(segment)
      representativeFrames.push(frame)
      if (lastFrame) {
        changePoints.push({
          at: segment.startTime,
          segmentId: segment.id,
          reason: sameAppAndTitle ? '文本内容明显变化' : '应用或窗口切换',
          appName: segment.appName,
          windowTitle: segment.windowTitle,
          textPreview: text.slice(0, 200)
        })
      }
      lastFrame = frame
      lastTokens = tokens
    }

    const appCount = new Set(segments.map((s) => s.appName).filter(Boolean)).size
    const lowQualityCount = segments.filter((s) => {
      const quality = deriveQuality(s)
      return quality === 'low' || quality === 'failed'
    }).length

    return {
      date,
      hourBucket,
      startTime: range.startTime,
      endTime: range.endTime,
      segmentIds: segments.map((s) => s.id),
      representativeFrames,
      changePoints,
      windowTimeline: buildWindowTimeline(segments),
      localStats: {
        segmentCount: segments.length,
        representativeFrameCount: representativeFrames.length,
        appCount,
        ocrDoneCount: segments.filter((s) => s.sourceStatus === 'ocr_done').length,
        lowQualityCount
      },
      privacySummary: {
        privateCount,
        excludedCount: privateCount
      }
    }
  }
}
