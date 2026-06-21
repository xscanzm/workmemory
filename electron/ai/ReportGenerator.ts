/**
 * ReportGenerator：日报生成器
 *
 * 流程：
 *  1. 读取 episodeIds 对应 Episodes + 其 segmentIds 的 Segments
 *  2. 构建 timeline：每个 Episode 的时间、标题、一句话总结、OCR 摘要
 *  3. 构建 aiInputSnapshot：实际发送给 AI 的文本（JSON 序列化，用于存档审计）
 *  4. 提取 projectTags：从 Episodes 的 entities(type=project) + topics 聚合
 *  5. 选模板（enhanced/concise/okr/structured）→ buildPrompt
 *  6. 调 OpenAIClient.chatCompletion（从 SettingsStore 读 baseUrl/apiKey/model）
 *  7. 交叉校验：生成结果与原片段交叉校验，发现未在原片段出现的项目名/任务单号追加警告
 *  8. 返回 markdown + aiInputSnapshot + usage
 *
 * 严格基于用户勾选的真实片段，禁止虚构。
 *
 * Task RP1：新增 'structured' 模板路径，按 sections 分区输出结构化日报。
 *  - 输入增加 MemCell + MemScene + causal_chains 上下文
 *  - 分类要点：基于 segment.contentType 分组（chat/webpage/video/forum/product）
 *  - 证据片段：从 MemCell.facts + segment.ocrText 提取，每条 ≤80 字
 *  - 优化建议：从 ReflectionEngine 当周报告提取，否则 AI 生成
 */
import type { Episode, ReportInputSnapshot, ReportSnapshotItem, ReportTemplate, WorkSegment } from '@/types'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { MemCellRepository } from '../db/repositories/MemCellRepository'
import { MemSceneRepository } from '../db/repositories/MemSceneRepository'
import { CausalChainRepository } from '../db/repositories/CausalChainRepository'
import { ReflectionReportRepository } from '../db/repositories/ReflectionReportRepository'
import { SettingsStore } from '../db/SettingsStore'
import { getDatabase } from '../db/database'
import { getTemplate, REPORT_TEMPLATES } from './templates'
import type {
  TemplateParams,
  ReportSection,
  StructuredReport,
  TimelineEntry,
  CategoryNote
} from './templates'
import {
  DEFAULT_STRUCTURED_SECTIONS,
  REPORT_SECTION_TITLES
} from './templates'
import { OpenAIClient, OpenAiApiError } from './OpenAIClient'
import type { ChatCompletionParams, TokenUsage } from './OpenAIClient'
import { maskSensitive } from './SensitiveMasker'
import { filterHighConfidenceEntities } from '@/utils/entity'
import type { MemCell } from '../memory/MemCell'
import type { MemScene } from '../memory/MemSceneClusterer'
import type { CausalChain } from './CausalChainBuilder'
import type { ContentType } from '@/types'

/** 日报生成请求载荷 */
export interface GenerateReportPayload {
  /** YYYY-MM-DD */
  date: string
  templateId: ReportTemplate
  /** 勾选参与生成的 Episode id 列表 */
  episodeIds: string[]
  /** 用户备注 */
  notes: string
  /** 勾选确认弹窗打开时生成的稳定快照，新 UI 默认使用 */
  reportInputSnapshot?: ReportInputSnapshot
}

/** 日报生成结果 */
export interface GenerateReportResult {
  markdown: string
  /** 发送给 AI 的输入快照（仅文本摘要，不含截图） */
  aiInputSnapshot: string
  /** 参与生成的 segment id 列表 */
  segmentIds: string[]
  /** token 用量 */
  usage: TokenUsage
  /** 交叉校验警告（若为空字符串则无警告） */
  warning: string
  /** 已脱敏的敏感信息数量（手机号/邮箱/身份证/银行卡） */
  maskedCount: number
}

/** 单条片段的文本摘要（用于 AI 输入，不含截图） */
interface EpisodeDigest {
  episode: Episode
  segments: WorkSegment[]
}

/** 加载勾选 Episode 及其关联 Segment */
function loadDigests(episodeIds: string[]): EpisodeDigest[] {
  const digests: EpisodeDigest[] = []
  for (const id of episodeIds) {
    const episode = EpisodeRepository.getById(id)
    if (!episode) continue
    const segments = episode.segmentIds
      .map((sid) => SegmentRepository.getById(sid))
      .filter((s): s is WorkSegment => s !== null && !s.isDeleted)
    digests.push({ episode, segments })
  }
  return digests
}

/** 构建 timeline 文本：每个 Episode 的时间、标题、摘要、OCR 摘要 */
function buildTimeline(digests: EpisodeDigest[]): string {
  if (digests.length === 0) return '（无勾选片段）'
  const lines: string[] = []
  for (const { episode, segments } of digests) {
    lines.push(`### ${episode.startTime} - ${episode.endTime} | ${episode.title}`)
    if (episode.oneLineSummary) {
      lines.push(`- 一句话总结：${episode.oneLineSummary}`)
    }
    // 应用与窗口标题摘要（去重）
    const appSet = new Set<string>()
    for (const seg of segments) {
      const label = seg.appName || seg.processName || '未知应用'
      appSet.add(label)
    }
    if (appSet.size > 0) {
      lines.push(`- 涉及应用：${Array.from(appSet).join('、')}`)
    }
    // OCR 摘要：取 ocr_summary 或 ocr_text 前 200 字
    const ocrSummaries = segments
      .map((s) => {
        if (s.ocrSummary && s.ocrSummary.length > 0) return s.ocrSummary
        if (s.ocrText && s.ocrText.length > 0) return s.ocrText.slice(0, 200)
        return ''
      })
      .filter((s) => s.length > 0)
      .slice(0, 3)
    for (const s of ocrSummaries) {
      lines.push(`- 内容摘要：${s}`)
    }
    // 证据片段：取各 segment ocrText 的前 2 条非空行，每行截断 ≤80 字
    const evidenceLines: string[] = []
    for (const seg of segments) {
      if (evidenceLines.length >= 2) break
      if (!seg.ocrText) continue
      for (const raw of seg.ocrText.split('\n')) {
        const trimmed = raw.trim()
        if (trimmed.length === 0) continue
        evidenceLines.push(trimmed.slice(0, 80))
        if (evidenceLines.length >= 2) break
      }
    }
    if (evidenceLines.length > 0) {
      lines.push(`- 证据片段：${evidenceLines.join(' | ')}`)
    }
    // 实体引用（低置信实体不进入报告默认选择）
    const highConfidenceEntities = filterHighConfidenceEntities(episode.entities)
    if (highConfidenceEntities.length > 0) {
      const entityStr = highConfidenceEntities
        .map(
          (e) =>
            `${e.type === 'person' ? '人' : e.type === 'project' ? '项目' : e.type === 'document' ? '文档' : 'URL'}:${e.name}`
        )
        .join('、')
      lines.push(`- 关联实体：${entityStr}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function buildSnapshotTimeline(snapshot: ReportInputSnapshot): string {
  if (snapshot.items.length === 0) return '（无勾选片段）'
  const lines: string[] = []
  if (snapshot.sourceType === 'raw_fallback') {
    lines.push('> 注意：本次使用原始/启发式片段降级生成，来源质量低于工作记忆事件。')
    lines.push('')
  }
  for (const item of snapshot.items) {
    lines.push(`### ${item.startTime} - ${item.endTime} | ${item.title}`)
    lines.push(`- 工作记忆总结：${item.summary}`)
    if (item.project) lines.push(`- 项目：${item.project}`)
    if (item.topics.length > 0) lines.push(`- 主题：${item.topics.join('、')}`)
    if (item.entities.length > 0) {
      lines.push(`- 关联实体：${item.entities.map((e) => `${e.type}:${e.name}`).join('、')}`)
    }
    if (item.evidenceRefs.length > 0) {
      const quotes = item.evidenceRefs
        .slice(0, 2)
        .map((e) => e.quote)
        .filter((q) => q && q.length > 0)
      if (quotes.length > 0) {
        lines.push(`- 证据片段：${quotes.join(' | ')}`)
      }
    }
    lines.push(`- 来源质量：${item.sourceQuality}；置信度：${item.confidence}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 构建项目标签数组：从 Episodes 的 entities(type=project) + topics 聚合（低置信实体不进入默认选择） */
function buildProjectTags(digests: EpisodeDigest[]): string[] {
  const tagSet = new Set<string>()
  for (const { episode, segments } of digests) {
    // 从 entities 提取项目实体（仅高置信）
    const highConfidenceEntities = filterHighConfidenceEntities(episode.entities)
    for (const entity of highConfidenceEntities) {
      if (entity.type === 'project' && entity.name) {
        tagSet.add(entity.name)
      }
    }
    // 从 topics 提取
    for (const t of episode.topics) {
      if (t && !t.startsWith('__')) tagSet.add(t)
    }
    // 从 segment tags 提取
    for (const seg of segments) {
      for (const t of seg.tags) {
        if (t) tagSet.add(t)
      }
    }
  }
  return Array.from(tagSet)
}

function buildSnapshotProjectTags(snapshot: ReportInputSnapshot): string[] {
  const tags = new Set<string>()
  for (const item of snapshot.items) {
    if (item.project) tags.add(item.project)
    for (const topic of item.topics) tags.add(topic)
    for (const entity of item.entities) {
      if (entity.type === 'project' && entity.name) tags.add(entity.name)
    }
  }
  return [...tags]
}

/** 收集所有参与生成的 segment id */
export function collectSegmentIds(digests: EpisodeDigest[]): string[] {
  const ids: string[] = []
  for (const { segments } of digests) {
    for (const s of segments) ids.push(s.id)
  }
  return ids
}

/** 构建 aiInputSnapshot：JSON 序列化，用于存档审计 */
function buildAiInputSnapshot(
  payload: GenerateReportPayload,
  digests: EpisodeDigest[],
  timeline: string,
  projectTags: string[]
): string {
  const snapshot = {
    date: payload.date,
    templateId: payload.templateId,
    templateName: REPORT_TEMPLATES[payload.templateId]?.name ?? payload.templateId,
    userNotes: payload.notes,
    projectTags,
    episodeCount: digests.length,
    episodes: digests.map(({ episode, segments }) => ({
      id: episode.id,
      startTime: episode.startTime,
      endTime: episode.endTime,
      title: episode.title,
      oneLineSummary: episode.oneLineSummary,
      entities: episode.entities,
      topics: episode.topics,
      segmentCount: segments.length,
      segmentIds: segments.map((s) => s.id),
      ocrSummaries: segments
        .map((s) => s.ocrSummary || s.ocrText.slice(0, 200))
        .filter((s) => s.length > 0)
    })),
    timelineText: timeline
  }
  return JSON.stringify(snapshot, null, 2)
}

function buildSnapshotAiInputSnapshot(snapshot: ReportInputSnapshot, timeline: string, projectTags: string[]): string {
  return JSON.stringify(
    {
      ...snapshot,
      projectTags,
      itemCount: snapshot.items.length,
      timelineText: timeline
    },
    null,
    2
  )
}

/**
 * 交叉校验：提取生成内容中的任务单号，检查是否在原片段范围内。
 * 若发现未在原片段出现的任务单号，返回警告文本。
 */
export function crossValidate(generatedMarkdown: string, digests: EpisodeDigest[]): string {
  // 收集原片段中出现的所有任务单号（从 title、oneLineSummary、ocrText 中提取）
  // 任务单号模式：#123、TASK-123、JIRA-123、BUG-123、需求#123 等
  const taskNumberPattern = /(?:#|任务|需求|BUG|JIRA|TASK|ISSUE)[#-]?([A-Z]+-?\d+)/gi
  const knownTaskNumbers = new Set<string>()
  for (const { episode, segments } of digests) {
    const combinedText = `${episode.title} ${episode.oneLineSummary} ${segments
      .map((s) => `${s.windowTitle} ${s.ocrText} ${s.ocrSummary}`)
      .join(' ')}`
    let match: RegExpExecArray | null
    taskNumberPattern.lastIndex = 0
    while ((match = taskNumberPattern.exec(combinedText)) !== null) {
      knownTaskNumbers.add(match[1].toUpperCase())
    }
  }

  // 从生成内容中提取任务单号
  const taskNumbersInGenerated = new Set<string>()
  let match: RegExpExecArray | null
  taskNumberPattern.lastIndex = 0
  while ((match = taskNumberPattern.exec(generatedMarkdown)) !== null) {
    taskNumbersInGenerated.add(match[1].toUpperCase())
  }

  // 找出未在原片段出现的任务单号
  const suspiciousTaskNumbers: string[] = []
  for (const taskNum of taskNumbersInGenerated) {
    if (!knownTaskNumbers.has(taskNum)) {
      suspiciousTaskNumbers.push(taskNum)
    }
  }

  if (suspiciousTaskNumbers.length === 0) {
    return ''
  }
  return `⚠️ 注意：以下任务单号未在原始工作片段中出现：${suspiciousTaskNumbers.slice(0, 5).join('、')}`
}

/**
 * 当 payload.reportInputSnapshot 缺失但 episodeIds 有数据时，从 EpisodeRepository
 * 加载 Episodes 并构建一个 raw_fallback 快照，使后续流程统一走快照路径。
 */
function buildSnapshotFromEpisodes(episodes: Episode[]): ReportInputSnapshot {
  const items: ReportSnapshotItem[] = episodes.map((episode) => ({
    id: episode.id,
    startTime: episode.startTime,
    endTime: episode.endTime,
    title: episode.title,
    summary: episode.oneLineSummary,
    project: '',
    topics: episode.topics,
    entities: episode.entities,
    evidenceRefs: [],
    segmentIds: episode.segmentIds,
    sourceQuality: 'medium',
    confidence: 0.5
  }))
  const segmentIds: string[] = []
  for (const item of items) {
    for (const sid of item.segmentIds) segmentIds.push(sid)
  }
  return {
    date: episodes[0]?.date ?? '',
    templateId: 'enhanced',
    userNotes: '',
    createdAt: new Date().toISOString(),
    sourceType: 'raw_fallback',
    items,
    segmentIds,
    cleanEpisodeIds: [],
    maskedCount: 0
  }
}

/**
 * 查询指定日期 distill_runs 中最近一次失败记录的 error_message。
 * 若无失败记录或 error_message 为空，返回 null。
 */
function getDistillFailureReason(date: string): string | null {
  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT error_message FROM distill_runs WHERE date = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 1`
    )
    .get(date) as { error_message?: string } | undefined
  if (!row || !row.error_message || row.error_message.length === 0) return null
  return row.error_message
}

/** 结构化输出期望的 JSON 形状（旧版 B5 路径，非 RP1 结构化日报） */
interface LegacyStructuredOutput {
  title?: string
  sections?: Array<{ heading?: string; items?: string[] }>
  summary?: string
}

/**
 * 将结构化 JSON 输出渲染为 Markdown。
 * 缺失字段会被优雅跳过。
 */
function renderStructuredToMarkdown(data: {
  title: string
  sections: Array<{ heading: string; items: string[] }>
  summary: string
}): string {
  const parts: string[] = []
  if (data.title) {
    parts.push(`# ${data.title}`)
  }
  for (const section of data.sections) {
    const sectionLines: string[] = []
    if (section.heading) {
      sectionLines.push(`## ${section.heading}`)
    }
    const items = section.items.filter((i) => i).map((i) => `- ${i}`)
    if (items.length > 0) {
      sectionLines.push(items.join('\n'))
    }
    if (sectionLines.length > 0) {
      parts.push(sectionLines.join('\n\n'))
    }
  }
  if (data.summary) {
    parts.push(`> ${data.summary}`)
  }
  return parts.join('\n\n')
}

function getAiFailureWarning(error: unknown): string {
  if (error instanceof OpenAiApiError) {
    if (error.statusCode === 401) {
      return error.message
    }
    if (
      error.reasonCode === 'reasoning_only' ||
      error.reasonCode === 'length_without_content'
    ) {
      return 'AI 未返回最终答案，已使用勾选片段在本地生成客观日报草稿'
    }
    return `AI 生成失败：${error.message}，已使用勾选片段在本地生成客观日报草稿`
  }
  return `AI 生成失败：${error instanceof Error ? error.message : String(error)}，已使用勾选片段在本地生成客观日报草稿`
}

function renderRuleBasedSnapshotReport(
  payload: GenerateReportPayload,
  snapshot: ReportInputSnapshot,
  projectTags: string[]
): string {
  const lines: string[] = [`# 工作日报 ${payload.date}`]
  const selectedItems = snapshot.items

  if (payload.notes || snapshot.userNotes) {
    lines.push(`## 用户备注\n\n${payload.notes || snapshot.userNotes}`)
  }

  const summaries = selectedItems
    .map((item) => item.summary || item.title)
    .filter((text) => text && text.trim().length > 0)
    .slice(0, 12)

  if (summaries.length > 0) {
    lines.push(`## 今日概览\n\n${summaries.map((item) => `- ${item}`).join('\n')}`)
  }

  if (projectTags.length > 0) {
    lines.push(`## 相关主题\n\n${projectTags.slice(0, 20).map((tag) => `- ${tag}`).join('\n')}`)
  }

  const timeline = selectedItems
    .map((item) => {
      const details: string[] = [`- **${item.startTime} - ${item.endTime}** ${item.title}`]
      if (item.summary) details.push(`  - 摘要：${item.summary}`)
      if (item.project) details.push(`  - 项目：${item.project}`)
      if (item.topics.length > 0) details.push(`  - 主题：${item.topics.slice(0, 5).join('、')}`)
      return details.join('\n')
    })
    .join('\n')

  if (timeline) {
    lines.push(`## 时间线\n\n${timeline}`)
  }

  const evidence = selectedItems
    .flatMap((item) => item.evidenceRefs.map((ref) => ref.quote))
    .filter((quote) => quote && quote.trim().length > 0)
    .slice(0, 20)

  if (evidence.length > 0) {
    lines.push(`## 证据片段\n\n${evidence.map((quote) => `- ${quote}`).join('\n')}`)
  }

  lines.push('## 说明\n\n本日报由本地规则基于勾选片段生成，未使用截图内容。')
  return lines.join('\n\n')
}

/** 计算字符串字符数（供前端确认面板显示） */
export function countChars(text: string): number {
  return text.length
}

// ===================== Task RP1：结构化日报生成 =====================

/** 证据片段最大字符数（RP1.5） */
const EVIDENCE_MAX_CHARS = 80
/** 证据片段最大条数 */
const EVIDENCE_MAX_ITEMS = 20
/** 关键证据行特征：含数字、代码、URL 等 */
const EVIDENCE_LINE_REGEX = /(\d{2,}|https?:\/\/|[A-Z_]{3,}|[#$@][\w-]+|0x[0-9a-f]+|[\u00a5\uFFE5$]\s*\d)/i

/** 构造当日 MemCell 查询的 ISO 时间范围（UTC 当日 00:00 - 23:59:59.999） */
function dayRange(date: string): { start: string; end: string } {
  return {
    start: `${date}T00:00:00.000Z`,
    end: `${date}T23:59:59.999Z`
  }
}

/** 获取指定日期所在周的周一日期（YYYY-MM-DD，本地时区） */
function getWeekStartForDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  const day = d.getUTCDay() // 0 = Sunday, 1 = Monday
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** 截断字符串到指定长度 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max)
}

/**
 * 按 contentType 分组当日 segments，并为每组提取结构化摘要（RP1.4）。
 * - chat→chatNotes, webpage→webNotes, video→videoNotes, forum→forumNotes, product→productNotes
 * - 每组基于 segment.contentData（P2 已实现的结构化提取）和 ocrText 提取要点
 * - 如果某 contentType 没有对应 segment，对应 notes 为空数组
 */
function buildCategoryNotes(
  segments: WorkSegment[],
  contentType: ContentType
): CategoryNote[] {
  const filtered = segments.filter((s) => s.contentType === contentType)
  if (filtered.length === 0) return []

  const notes: CategoryNote[] = []
  for (const seg of filtered) {
    const title = seg.windowTitle || seg.appName || `${contentType} 片段`
    const details: string[] = []
    const data = seg.contentData ?? {}

    // 基于 contentData 提取结构化要点
    if (contentType === 'chat') {
      const participants = Array.isArray(data.participants) ? data.participants : []
      const messageCount = typeof data.messageCount === 'number' ? data.messageCount : 0
      const keyMessages = Array.isArray(data.keyMessages) ? data.keyMessages : []
      const platform = typeof data.platform === 'string' ? data.platform : ''
      if (platform) details.push(`平台：${platform}`)
      if (participants.length > 0) details.push(`参与者：${participants.join('、')}`)
      if (messageCount > 0) details.push(`消息数：${messageCount}`)
      for (const msg of keyMessages.slice(0, 3)) {
        if (typeof msg === 'string' && msg.length > 0) details.push(truncate(msg, EVIDENCE_MAX_CHARS))
      }
    } else if (contentType === 'webpage') {
      const url = typeof data.url === 'string' ? data.url : ''
      const pageTitle = typeof data.pageTitle === 'string' ? data.pageTitle : ''
      const domain = typeof data.domain === 'string' ? data.domain : ''
      const keyParagraphs = Array.isArray(data.keyParagraphs) ? data.keyParagraphs : []
      if (pageTitle) details.push(`标题：${pageTitle}`)
      if (domain) details.push(`域名：${domain}`)
      if (url) details.push(`URL：${truncate(url, EVIDENCE_MAX_CHARS)}`)
      for (const p of keyParagraphs.slice(0, 2)) {
        if (typeof p === 'string' && p.length > 0) details.push(truncate(p, EVIDENCE_MAX_CHARS))
      }
    } else if (contentType === 'video') {
      const platform = typeof data.platform === 'string' ? data.platform : ''
      const videoTitle = typeof data.title === 'string' ? data.title : ''
      const duration = typeof data.duration === 'string' ? data.duration : ''
      const subtitles = Array.isArray(data.subtitles) ? data.subtitles : []
      if (platform) details.push(`平台：${platform}`)
      if (videoTitle) details.push(`标题：${videoTitle}`)
      if (duration) details.push(`时长：${duration}`)
      for (const sub of subtitles.slice(0, 3)) {
        if (typeof sub === 'string' && sub.length > 0) details.push(`字幕：${truncate(sub, EVIDENCE_MAX_CHARS)}`)
      }
    } else if (contentType === 'forum') {
      const threadTitle = typeof data.threadTitle === 'string' ? data.threadTitle : ''
      const posts = typeof data.posts === 'number' ? data.posts : 0
      const authors = Array.isArray(data.authors) ? data.authors : []
      if (threadTitle) details.push(`帖子：${threadTitle}`)
      if (posts > 0) details.push(`回复数：${posts}`)
      if (authors.length > 0) details.push(`作者：${authors.slice(0, 5).join('、')}`)
    } else if (contentType === 'product') {
      const name = typeof data.name === 'string' ? data.name : ''
      const price = typeof data.price === 'string' ? data.price : ''
      const source = typeof data.source === 'string' ? data.source : ''
      if (name) details.push(`商品：${name}`)
      if (price) details.push(`价格：${price}`)
      if (source) details.push(`来源：${source}`)
    }

    // 兜底：如果 contentData 未提取到要点，从 ocrText 取前 2 条非空行
    if (details.length === 0 && seg.ocrText) {
      const lines = seg.ocrText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, 2)
      for (const line of lines) {
        details.push(truncate(line, EVIDENCE_MAX_CHARS))
      }
    }

    if (details.length > 0) {
      notes.push({ title: truncate(title, 60), details })
    }
  }
  return notes
}

/**
 * 从 MemCell.facts + segment.ocrText 提取证据片段（RP1.5）。
 * - 从当日 MemCell.facts 提取，每条 ≤80 字（超长截断）
 * - 从当日 segments 的 ocrText 提取关键行（含数字、代码、URL 等特征行）
 * - 合并去重，最多 20 条
 */
function buildEvidence(memCells: MemCell[], segments: WorkSegment[]): string[] {
  const evidenceSet = new Set<string>()

  // 从 MemCell.facts 提取
  for (const cell of memCells) {
    for (const fact of cell.facts) {
      if (typeof fact === 'string' && fact.length > 0) {
        evidenceSet.add(truncate(fact.trim(), EVIDENCE_MAX_CHARS))
      }
    }
  }

  // 从 segments 的 ocrText 提取关键行（含数字、代码、URL 等特征行）
  for (const seg of segments) {
    if (!seg.ocrText) continue
    for (const raw of seg.ocrText.split('\n')) {
      const trimmed = raw.trim()
      if (trimmed.length === 0 || trimmed.length > 200) continue
      if (EVIDENCE_LINE_REGEX.test(trimmed)) {
        evidenceSet.add(truncate(trimmed, EVIDENCE_MAX_CHARS))
      }
    }
  }

  return Array.from(evidenceSet).slice(0, EVIDENCE_MAX_ITEMS)
}

/**
 * 从 ReflectionEngine 当周报告提取优化建议（RP1.6）。
 * - 获取当周 ReflectionReport（ReflectionReportRepository.getByWeekStart）
 * - 如果有，从 suggestions 提取（拼接 title + action）
 * - 如果没有，返回空数组（调用方可选择 AI 生成）
 */
function buildSuggestionsFromReflection(date: string): string[] {
  const weekStart = getWeekStartForDate(date)
  const report = ReflectionReportRepository.getByWeekStart(weekStart)
  if (!report || report.suggestions.length === 0) return []
  return report.suggestions.map((s) => {
    const parts: string[] = []
    if (s.title) parts.push(s.title)
    if (s.action) parts.push(s.action)
    return parts.join('：')
  })
}

/**
 * 构建时间线条目（RP1.11 TimelineEntry）。
 * 基于当日 segments 按时间排序，每个 segment 生成一条时间线。
 */
function buildTimelineEntries(
  segments: WorkSegment[],
  memCells: MemCell[]
): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  // 按 startTime 排序 segments
  const sortedSegs = [...segments].sort((a, b) =>
    a.startTime.localeCompare(b.startTime)
  )

  for (const seg of sortedSegs) {
    const title = seg.windowTitle || seg.appName || '工作片段'
    const detail = seg.ocrSummary || (seg.ocrText ? truncate(seg.ocrText.trim(), 100) : '')
    // 金句/字幕：从 contentData 提取
    let quote: string | undefined
    if (seg.contentData) {
      const subtitles = Array.isArray(seg.contentData.subtitles) ? seg.contentData.subtitles : []
      const keyMessages = Array.isArray(seg.contentData.keyMessages) ? seg.contentData.keyMessages : []
      if (subtitles.length > 0 && typeof subtitles[0] === 'string') {
        quote = truncate(subtitles[0], EVIDENCE_MAX_CHARS)
      } else if (keyMessages.length > 0 && typeof keyMessages[0] === 'string') {
        quote = truncate(keyMessages[0], EVIDENCE_MAX_CHARS)
      }
    }
    // 证据：从 ocrText 取第一条特征行
    let evidence: string | undefined
    if (seg.ocrText) {
      for (const raw of seg.ocrText.split('\n')) {
        const trimmed = raw.trim()
        if (trimmed.length > 0 && EVIDENCE_LINE_REGEX.test(trimmed)) {
          evidence = truncate(trimmed, EVIDENCE_MAX_CHARS)
          break
        }
      }
    }
    entries.push({
      time: `${seg.startTime} ~ ${seg.endTime}`,
      title: truncate(title, 80),
      detail: detail || undefined,
      quote,
      evidence
    })
  }

  // 如果 segments 为空，从 MemCell 构建时间线
  if (entries.length === 0 && memCells.length > 0) {
    const sortedCells = [...memCells].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    for (const cell of sortedCells) {
      entries.push({
        time: cell.createdAt,
        title: truncate(cell.episode, 80),
        detail: cell.facts.length > 0 ? truncate(cell.facts[0], 100) : undefined
      })
    }
  }

  return entries
}

/**
 * 构建主题归纳（RP1.11 themes）。
 * 基于 MemScene（主题场景）提取当日活跃主题。
 */
function buildThemes(memCells: MemCell[], scenes: MemScene[]): string[] {
  if (memCells.length === 0) return []
  const cellIds = new Set(memCells.map((c) => c.id))
  const themes: string[] = []
  for (const scene of scenes) {
    // 仅保留成员含当日 MemCell 的 MemScene
    const hasMember = scene.memberCellIds.some((id) => cellIds.has(id))
    if (!hasMember) continue
    const title = scene.title || scene.summary || '未命名主题'
    themes.push(title)
  }
  // 兜底：如果 MemScene 没有匹配，从 MemCell.episode 提取主题
  if (themes.length === 0) {
    const episodeSet = new Set<string>()
    for (const cell of memCells) {
      if (cell.episode && !episodeSet.has(cell.episode)) {
        episodeSet.add(cell.episode)
        themes.push(truncate(cell.episode, 60))
      }
    }
  }
  return themes
}

/**
 * 构建今日做了什么 / 今日看了什么（RP1.11 whatIDid / whatISaw）。
 * - whatIDid：从 MemCell.episode 提取（用户做了什么）
 * - whatISaw：从 segments 的 contentType=webpage/video/forum 提取（用户看了什么）
 */
function buildWhatIDidAndSaw(
  memCells: MemCell[],
  segments: WorkSegment[]
): { whatIDid: string[]; whatISaw: string[] } {
  const whatIDid: string[] = []
  const whatISaw: string[] = []

  // 今日做了什么：从 MemCell.episode 提取
  const didSet = new Set<string>()
  for (const cell of memCells) {
    if (cell.episode && !didSet.has(cell.episode)) {
      didSet.add(cell.episode)
      whatIDid.push(truncate(cell.episode, 100))
    }
  }

  // 今日看了什么：从 webpage/video/forum/product segments 提取
  const sawSet = new Set<string>()
  for (const seg of segments) {
    if (!seg.contentType) continue
    if (!['webpage', 'video', 'forum', 'product'].includes(seg.contentType)) continue
    let label = ''
    if (seg.contentData) {
      if (typeof seg.contentData.pageTitle === 'string') label = seg.contentData.pageTitle
      else if (typeof seg.contentData.title === 'string') label = seg.contentData.title
      else if (typeof seg.contentData.threadTitle === 'string') label = seg.contentData.threadTitle
      else if (typeof seg.contentData.name === 'string') label = seg.contentData.name
    }
    if (!label) label = seg.windowTitle || seg.appName || ''
    if (label && !sawSet.has(label)) {
      sawSet.add(label)
      whatISaw.push(truncate(label, 100))
    }
  }

  return { whatIDid, whatISaw }
}

/**
 * 构建管家总结（RP1.11 butlerSummary）。
 * 基于当日 MemCell + segments 数量与主题，生成 1-3 句话概括。
 */
function buildButlerSummary(
  date: string,
  memCells: MemCell[],
  segments: WorkSegment[],
  themes: string[]
): string {
  const parts: string[] = []
  parts.push(`${date} 共记录 ${memCells.length} 条工作记忆、${segments.length} 个工作片段`)
  if (themes.length > 0) {
    parts.push(`主要主题：${themes.slice(0, 3).join('、')}`)
  }
  if (memCells.length > 0) {
    // 取第一条 MemCell 的 episode 作为代表活动
    const firstActivity = memCells[0].episode
    if (firstActivity) {
      parts.push(`代表活动：${truncate(firstActivity, 60)}`)
    }
  }
  return parts.join('；')
}

/**
 * 构建结构化日报的 AI 提示词（RP1.3）。
 * 包含 MemCell + MemScene + causal_chains 上下文。
 */
function buildStructuredPrompt(
  date: string,
  memCells: MemCell[],
  scenes: MemScene[],
  causalChains: CausalChain[],
  segments: WorkSegment[],
  sections: ReportSection[],
  userNotes: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `你是一名专业的工作汇报撰写助手。请严格遵守以下规则：
1. 你只能基于以下用户勾选的真实工作片段进行归纳和表达增强，严禁虚构任何未发生的事项、未提及的项目或未列出的产出。如果信息不足，宁可简短也不要编造。
2. 不得编造时间、数据、人名或项目名。
3. 若片段信息不足以支撑某部分内容，则省略该部分，不要补充臆测。
4. 输出 JSON 对象，字段对应分区。
5. 采用"结构化分区"风格：按指定的 sections 分区输出，每个分区有明确标题与要点。`

  const sectionsList = sections.map((s) => `- ${s}: ${REPORT_SECTION_TITLES[s]}`).join('\n')

  const memCellText = memCells
    .map((c) => `- [${c.createdAt}] ${c.episode}${c.facts.length > 0 ? `（事实：${c.facts.slice(0, 3).join('；')}）` : ''}`)
    .join('\n')

  const sceneText = scenes
    .map((s) => `- ${s.title}${s.summary ? `：${s.summary}` : ''}（成员 ${s.memberCellIds.length} 条）`)
    .join('\n')

  const causalText = causalChains
    .map((c) => `- ${c.relation}（置信度 ${c.confidence.toFixed(2)}）：${c.evidence}`)
    .join('\n')

  const segmentText = segments
    .map((s) => {
      const ct = s.contentType || 'other'
      const parts = [`[${s.startTime}-${s.endTime}]`, s.windowTitle || s.appName]
      if (s.ocrSummary) parts.push(s.ocrSummary)
      return `- ${parts.join(' ')}（类型：${ct}）`
    })
    .join('\n')

  const userPrompt = `请根据以下今日工作上下文，生成一份"结构化分区版"日报。

## 日期
${date}

## 需要输出的分区
${sectionsList}

## 工作记忆单元（MemCell）
${memCellText || '（无）'}

## 主题场景（MemScene）
${sceneText || '（无）'}

## 因果链（CausalChain）
${causalText || '（无）'}

## 工作片段（Segment）
${segmentText || '（无）'}

## 用户备注
${userNotes || '（无）'}

## 输出要求
- 输出 JSON 对象，包含以下字段：
  - butlerSummary: string（管家总结，1-3 句话概括当日整体情况）
  - whatIDid: string[]（今日做了什么，每条一句话）
  - whatISaw: string[]（今日看了什么，每条一句话）
  - themes: string[]（主题归纳，每条一个主题）
  - timeline: Array<{ time: string; title: string; detail?: string; quote?: string; evidence?: string }>
  - chatNotes/webNotes/forumNotes/videoNotes/productNotes: Array<{ title: string; details: string[] }>
  - evidence: string[]（证据片段，每条 ≤80 字）
  - suggestions: string[]（优化建议）
- 严格基于上下文，禁止虚构
- 如果某类内容没有对应片段，对应数组为空`

  return { systemPrompt, userPrompt }
}

/**
 * 解析 AI 返回的结构化日报 JSON（RP1.3）。
 * 解析失败时返回 null，由调用方降级为基于规则的生成。
 */
function parseStructuredReportFromAi(
  content: string,
  date: string,
  fallback: StructuredReport
): StructuredReport | null {
  try {
    const raw = JSON.parse(content) as Record<string, unknown>
    const toArray = (v: unknown): string[] => {
      if (!Array.isArray(v)) return []
      return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    }
    const toCategoryNotes = (v: unknown): CategoryNote[] => {
      if (!Array.isArray(v)) return []
      return v
        .map((item): CategoryNote | null => {
          if (typeof item !== 'object' || item === null) return null
          const obj = item as Record<string, unknown>
          const title = typeof obj.title === 'string' ? obj.title : ''
          const details = Array.isArray(obj.details)
            ? obj.details.filter((d): d is string => typeof d === 'string' && d.length > 0)
            : []
          if (!title && details.length === 0) return null
          return { title, details }
        })
        .filter((n): n is CategoryNote => n !== null)
    }
    const toTimeline = (v: unknown): TimelineEntry[] => {
      if (!Array.isArray(v)) return []
      return v
        .map((item): TimelineEntry | null => {
          if (typeof item !== 'object' || item === null) return null
          const obj = item as Record<string, unknown>
          const time = typeof obj.time === 'string' ? obj.time : ''
          const title = typeof obj.title === 'string' ? obj.title : ''
          if (!time && !title) return null
          return {
            time,
            title,
            detail: typeof obj.detail === 'string' ? obj.detail : undefined,
            quote: typeof obj.quote === 'string' ? obj.quote : undefined,
            evidence: typeof obj.evidence === 'string' ? obj.evidence : undefined
          }
        })
        .filter((n): n is TimelineEntry => n !== null)
    }

    return {
      date,
      butlerSummary: typeof raw.butlerSummary === 'string' ? raw.butlerSummary : fallback.butlerSummary,
      whatIDid: toArray(raw.whatIDid).length > 0 ? toArray(raw.whatIDid) : fallback.whatIDid,
      whatISaw: toArray(raw.whatISaw).length > 0 ? toArray(raw.whatISaw) : fallback.whatISaw,
      themes: toArray(raw.themes).length > 0 ? toArray(raw.themes) : fallback.themes,
      timeline: toTimeline(raw.timeline).length > 0 ? toTimeline(raw.timeline) : fallback.timeline,
      chatNotes: toCategoryNotes(raw.chatNotes).length > 0 ? toCategoryNotes(raw.chatNotes) : fallback.chatNotes,
      webNotes: toCategoryNotes(raw.webNotes).length > 0 ? toCategoryNotes(raw.webNotes) : fallback.webNotes,
      forumNotes: toCategoryNotes(raw.forumNotes).length > 0 ? toCategoryNotes(raw.forumNotes) : fallback.forumNotes,
      videoNotes: toCategoryNotes(raw.videoNotes).length > 0 ? toCategoryNotes(raw.videoNotes) : fallback.videoNotes,
      productNotes: toCategoryNotes(raw.productNotes).length > 0 ? toCategoryNotes(raw.productNotes) : fallback.productNotes,
      evidence: toArray(raw.evidence).length > 0 ? toArray(raw.evidence) : fallback.evidence,
      suggestions: toArray(raw.suggestions).length > 0 ? toArray(raw.suggestions) : fallback.suggestions
    }
  } catch {
    return null
  }
}

/**
 * 将 StructuredReport 渲染为 Markdown（RP1.7）。
 * 按 sections 分区输出，每个分区有标题和内容。
 */
export function renderStructuredReportToMarkdown(
  report: StructuredReport,
  sections: ReportSection[] = DEFAULT_STRUCTURED_SECTIONS
): string {
  const parts: string[] = []
  parts.push(`# 工作日报 ${report.date}`)

  for (const section of sections) {
    const title = REPORT_SECTION_TITLES[section]
    switch (section) {
      case 'butler_summary': {
        if (report.butlerSummary) {
          parts.push(`## ${title}\n\n${report.butlerSummary}`)
        }
        break
      }
      case 'what_i_did': {
        if (report.whatIDid.length > 0) {
          parts.push(`## ${title}\n\n${report.whatIDid.map((i) => `- ${i}`).join('\n')}`)
        }
        break
      }
      case 'what_i_saw': {
        if (report.whatISaw.length > 0) {
          parts.push(`## ${title}\n\n${report.whatISaw.map((i) => `- ${i}`).join('\n')}`)
        }
        break
      }
      case 'themes': {
        if (report.themes.length > 0) {
          parts.push(`## ${title}\n\n${report.themes.map((i) => `- ${i}`).join('\n')}`)
        }
        break
      }
      case 'timeline': {
        if (report.timeline.length > 0) {
          const lines = report.timeline.map((t) => {
            const segs: string[] = [`- **${t.time}** ${t.title}`]
            if (t.detail) segs.push(`  - 细节：${t.detail}`)
            if (t.quote) segs.push(`  - 金句：${t.quote}`)
            if (t.evidence) segs.push(`  - 证据：${t.evidence}`)
            return segs.join('\n')
          })
          parts.push(`## ${title}\n\n${lines.join('\n')}`)
        }
        break
      }
      case 'chat_notes':
      case 'web_notes':
      case 'forum_notes':
      case 'video_notes':
      case 'product_notes': {
        const notes =
          section === 'chat_notes' ? report.chatNotes :
          section === 'web_notes' ? report.webNotes :
          section === 'forum_notes' ? report.forumNotes :
          section === 'video_notes' ? report.videoNotes :
          report.productNotes
        if (notes.length > 0) {
          const lines = notes.map((n) => {
            const segs = [`- **${n.title}**`]
            for (const d of n.details) segs.push(`  - ${d}`)
            return segs.join('\n')
          })
          parts.push(`## ${title}\n\n${lines.join('\n')}`)
        }
        break
      }
      case 'evidence': {
        if (report.evidence.length > 0) {
          parts.push(`## ${title}\n\n${report.evidence.map((i) => `- ${i}`).join('\n')}`)
        }
        break
      }
      case 'suggestions': {
        if (report.suggestions.length > 0) {
          parts.push(`## ${title}\n\n${report.suggestions.map((i) => `- ${i}`).join('\n')}`)
        }
        break
      }
    }
  }

  return parts.join('\n\n')
}

/**
 * 基于规则生成结构化日报（RP1.15 降级路径）。
 * 从 segments + MemCell 直接组装，不调用 AI。
 */
function buildStructuredReportByRules(
  date: string,
  memCells: MemCell[],
  scenes: MemScene[],
  segments: WorkSegment[]
): StructuredReport {
  const themes = buildThemes(memCells, scenes)
  const { whatIDid, whatISaw } = buildWhatIDidAndSaw(memCells, segments)
  const timeline = buildTimelineEntries(segments, memCells)
  const evidence = buildEvidence(memCells, segments)
  const suggestions = buildSuggestionsFromReflection(date)
  const butlerSummary = buildButlerSummary(date, memCells, segments, themes)

  return {
    date,
    butlerSummary,
    whatIDid,
    whatISaw,
    themes,
    timeline,
    chatNotes: buildCategoryNotes(segments, 'chat'),
    webNotes: buildCategoryNotes(segments, 'webpage'),
    forumNotes: buildCategoryNotes(segments, 'forum'),
    videoNotes: buildCategoryNotes(segments, 'video'),
    productNotes: buildCategoryNotes(segments, 'product'),
    evidence,
    suggestions
  }
}

/**
 * 结构化日报生成主流程（RP1.3 - RP1.6）。
 *
 * 流程：
 *  1. 加载当日 MemCell + MemScene + causal_chains + segments 上下文
 *  2. 基于规则生成兜底 StructuredReport
 *  3. 如果 AI 可用，构建提示词调用 AI，解析返回的 JSON
 *     - AI 解析失败或不可用时，降级为基于规则的生成
 *  4. 渲染为 Markdown 并返回 GenerateReportResult
 */
async function generateStructuredReport(
  payload: GenerateReportPayload,
  snapshot: ReportInputSnapshot
): Promise<GenerateReportResult> {
  const date = payload.date
  const sections = REPORT_TEMPLATES.structured.structuredSections ?? DEFAULT_STRUCTURED_SECTIONS

  // 1. 加载上下文
  const { start, end } = dayRange(date)
  const memCells = MemCellRepository.getByDateRange(start, end)
  const scenes = MemSceneRepository.getAll()
  const causalChains = CausalChainRepository.getByDate(date)
  // 当日 segments：优先从 snapshot.segmentIds 加载，否则按 date 查询
  let segments: WorkSegment[] = []
  if (snapshot.segmentIds.length > 0) {
    segments = SegmentRepository.getByIds(snapshot.segmentIds)
  }
  if (segments.length === 0) {
    segments = SegmentRepository.getActiveByDate(date)
  }

  // 2. 基于规则生成兜底 StructuredReport
  const fallbackReport = buildStructuredReportByRules(date, memCells, scenes, segments)

  // 3. 尝试 AI 生成
  let structuredReport: StructuredReport = fallbackReport
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let aiUsed = false

  const apiConfig = getApiConfig()
  if (apiConfig.apiKey) {
    try {
      const { systemPrompt, userPrompt } = buildStructuredPrompt(
        date,
        memCells,
        scenes,
        causalChains,
        segments,
        sections,
        payload.notes
      )
      const chatParams: ChatCompletionParams = {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.4,
        maxTokens: 4096,
        responseFormat: { type: 'json_object' }
      }
      const result = await OpenAIClient.chatCompletion(chatParams)
      usage = result.usage
      const parsed = parseStructuredReportFromAi(result.content, date, fallbackReport)
      if (parsed) {
        structuredReport = parsed
        aiUsed = true
      }
    } catch (e) {
      console.warn(
        '[ReportGenerator] 结构化日报 AI 生成失败，降级为规则生成:',
        e instanceof Error ? e.message : String(e)
      )
    }
  }

  // 如果 AI 未生成优化建议，从 ReflectionReport 补充
  if (structuredReport.suggestions.length === 0) {
    structuredReport.suggestions = buildSuggestionsFromReflection(date)
  }

  // 4. 渲染为 Markdown
  const markdown = renderStructuredReportToMarkdown(structuredReport, sections)

  // 构建 aiInputSnapshot
  const aiInputSnapshot = JSON.stringify(
    {
      date,
      templateId: 'structured',
      templateName: REPORT_TEMPLATES.structured.name,
      userNotes: payload.notes,
      sections,
      memCellCount: memCells.length,
      sceneCount: scenes.length,
      causalChainCount: causalChains.length,
      segmentCount: segments.length,
      aiUsed,
      structuredReport
    },
    null,
    2
  )

  // 脱敏处理
  const { text: maskedMarkdown, maskedCount } = maskSensitive(markdown)

  return {
    markdown: maskedMarkdown,
    aiInputSnapshot,
    segmentIds: snapshot.segmentIds,
    usage,
    warning: aiUsed ? '' : 'AI 不可用，使用规则生成结构化日报',
    maskedCount
  }
}

/** 从 SettingsStore 读取 API 配置（API Key 走加密存储 getApiKey()，不读明文） */
function getApiConfig(): { baseUrl: string; apiKey: string; model: string } {
  const settings = SettingsStore.get()
  return {
    baseUrl: settings.apiBaseUrl || 'https://api.openai.com/v1',
    apiKey: SettingsStore.getApiKey(),
    model: settings.modelName || 'gpt-4o-mini'
  }
}

export const ReportGenerator = {
  /**
   * 生成日报 markdown。
   * 1. 确定输入快照：优先 payload.reportInputSnapshot；否则从 episodeIds 构建 raw_fallback 快照
   * 2. 构建 timeline / projectTags 文本
   * 3. 渲染模板提示词（buildPrompt）
   * 4. 调用 OpenAIClient.chatCompletion（若模板开启 structuredOutput 则走 JSON 模式）
   * 5. 返回 markdown + 输入快照 + segmentIds + usage + warning
   */
  async generate(payload: GenerateReportPayload): Promise<GenerateReportResult> {
    // 确定使用的快照：优先使用 payload.reportInputSnapshot；否则从 episodeIds 构建
    let snapshot = payload.reportInputSnapshot
    let builtFromEpisodes = false
    if (!snapshot && payload.episodeIds.length > 0) {
      const episodes = payload.episodeIds
        .map((id) => EpisodeRepository.getById(id))
        .filter((e): e is Episode => e !== null)
      if (episodes.length > 0) {
        snapshot = buildSnapshotFromEpisodes(episodes)
        snapshot.templateId = payload.templateId
        snapshot.date = payload.date
        snapshot.userNotes = payload.notes
        builtFromEpisodes = true
      }
    }

    // RP1：'structured' 模板走独立的结构化日报生成路径
    // 结构化日报基于 segments（snapshot.segmentIds）+ MemCell + MemScene 上下文，
    // 不依赖 snapshot.items（CleanEpisode 摘要项），因此单独校验并提前路由。
    if (payload.templateId === 'structured') {
      if (!snapshot) {
        throw new Error('未找到可用的工作记忆事件，请至少勾选一条内容。')
      }
      return generateStructuredReport(payload, snapshot)
    }

    if (!snapshot || snapshot.items.length === 0) {
      throw new Error('未找到可用的工作记忆事件，请至少勾选一条内容。')
    }

    const rawTimeline = buildSnapshotTimeline(snapshot)
    const { text: timeline, maskedCount } = maskSensitive(rawTimeline)
    const projectTags = buildSnapshotProjectTags(snapshot)
    const segmentIds = snapshot.segmentIds

    const template = getTemplate(payload.templateId)
    const templateParams: TemplateParams = {
      timeline,
      userNotes: payload.notes || snapshot.userNotes,
      projectTags,
      date: payload.date
    }
    const { systemPrompt, userPrompt } = template.buildPrompt(templateParams)
    const aiInputSnapshot = buildSnapshotAiInputSnapshot(snapshot, timeline, projectTags)

    const apiConfig = getApiConfig()
    if (!apiConfig.apiKey) {
      throw new Error('未配置 AI API Key，请在设置中配置')
    }

    const chatParams: ChatCompletionParams = {
      baseUrl: apiConfig.baseUrl,
      apiKey: apiConfig.apiKey,
      model: apiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4,
      maxTokens: 2048
    }
    if (template.structuredOutput === true) {
      chatParams.responseFormat = { type: 'json_object' }
    }
    let result: Awaited<ReturnType<typeof OpenAIClient.chatCompletion>> | null = null
    let aiWarningText = ''
    try {
      result = await OpenAIClient.chatCompletion(chatParams)
    } catch (e) {
      aiWarningText = getAiFailureWarning(e)
    }

    // B5：结构化输出路径——尝试解析 JSON 并渲染为 Markdown；解析失败则回退到原始输出
    // 注意：'structured' 模板（RP1）在上方已提前 return，不会进入此处
    let content = result
      ? result.content
      : renderRuleBasedSnapshotReport(payload, snapshot, projectTags)
    if (result && template.structuredOutput === true) {
      try {
        const structured = JSON.parse(result.content) as LegacyStructuredOutput
        content = renderStructuredToMarkdown({
          title: structured.title ?? '',
          sections: Array.isArray(structured.sections)
            ? structured.sections.map((s) => ({
                heading: s.heading ?? '',
                items: Array.isArray(s.items) ? s.items : []
              }))
            : [],
          summary: structured.summary ?? ''
        })
      } catch (e) {
        console.warn(
          '[ReportGenerator] 结构化输出 JSON 解析失败，回退到普通 Markdown 输出:',
          e instanceof Error ? e.message : String(e)
        )
        // content 保持为 result.content（AI 原始输出）
      }
    }

    // 确定警告文本：
    // - builtFromEpisodes（raw_fallback 路径）：追加小时级理解未就绪提示，并附带 distill 失败原因
    // - 其他 raw_fallback 快照（UI 传入）：保留原有降级提示
    let markdownWarning = ''
    let warningText = aiWarningText
    if (builtFromEpisodes) {
      const failureReason = getDistillFailureReason(payload.date)
      const reason =
        failureReason && failureReason.length > 0 ? failureReason : '小时级理解尚未运行'
      warningText = [warningText, `小时级理解未就绪：${reason}，当前使用工作记忆事件降级生成`]
        .filter(Boolean)
        .join('；')
      markdownWarning = `\n\n---\n\n⚠️ 注意：${warningText}`
    } else if (snapshot.sourceType === 'raw_fallback') {
      const rawFallbackWarning = '使用原始/启发式片段降级生成'
      warningText = [warningText, rawFallbackWarning].filter(Boolean).join('；')
      markdownWarning = `\n\n---\n\n⚠️ 注意：${warningText || '本日报使用原始/启发式片段降级生成，建议在小时级理解完成后重新生成。'}`
    } else if (warningText) {
      markdownWarning = `\n\n---\n\n⚠️ 注意：${warningText}`
    }

    return {
      markdown: `${content}${markdownWarning}`,
      aiInputSnapshot,
      segmentIds,
      usage: result?.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      warning: warningText,
      maskedCount: maskedCount + snapshot.maskedCount
    }
  },

  /**
   * 估算发送字符数（供前端确认面板显示）。
   * 构建 timeline 并返回字符数，不调用 AI。
   */
  estimateChars(episodeIds: string[], notes: string): number {
    const digests = loadDigests(episodeIds)
    if (digests.length === 0) return 0
    const timeline = buildTimeline(digests)
    const projectTags = buildProjectTags(digests)
    const snapshot = buildAiInputSnapshot(
      { date: '', templateId: 'enhanced', episodeIds, notes },
      digests,
      timeline,
      projectTags
    )
    return countChars(snapshot)
  },

  /** 测试 API 连接（发送一个极简 ping 请求） */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const apiConfig = getApiConfig()
    return OpenAIClient.testConnection(apiConfig)
  }
}
