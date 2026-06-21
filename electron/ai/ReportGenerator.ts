/**
 * ReportGenerator：日报生成器
 *
 * 流程：
 *  1. 读取 episodeIds 对应 Episodes + 其 segmentIds 的 Segments
 *  2. 构建 timeline：每个 Episode 的时间、标题、一句话总结、OCR 摘要
 *  3. 构建 aiInputSnapshot：实际发送给 AI 的文本（JSON 序列化，用于存档审计）
 *  4. 提取 projectTags：从 Episodes 的 entities(type=project) + topics 聚合
 *  5. 选模板（enhanced/concise/okr）→ buildPrompt
 *  6. 调 OpenAIClient.chatCompletion（从 SettingsStore 读 baseUrl/apiKey/model）
 *  7. 交叉校验：生成结果与原片段交叉校验，发现未在原片段出现的项目名/任务单号追加警告
 *  8. 返回 markdown + aiInputSnapshot + usage
 *
 * 严格基于用户勾选的真实片段，禁止虚构。
 */
import type { Episode, ReportInputSnapshot, ReportSnapshotItem, ReportTemplate, WorkSegment } from '@/types'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { SettingsStore } from '../db/SettingsStore'
import { getDatabase } from '../db/database'
import { getTemplate, REPORT_TEMPLATES } from './templates'
import type { TemplateParams } from './templates'
import { OpenAIClient } from './OpenAIClient'
import type { ChatCompletionParams, TokenUsage } from './OpenAIClient'
import { maskSensitive } from './SensitiveMasker'
import { filterHighConfidenceEntities } from '@/utils/entity'

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

/** 结构化输出期望的 JSON 形状 */
interface StructuredReport {
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

/** 计算字符串字符数（供前端确认面板显示） */
export function countChars(text: string): number {
  return text.length
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
    const result = await OpenAIClient.chatCompletion(chatParams)

    // B5：结构化输出路径——尝试解析 JSON 并渲染为 Markdown；解析失败则回退到原始输出
    let content = result.content
    if (template.structuredOutput === true) {
      try {
        const structured = JSON.parse(result.content) as StructuredReport
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
    let warningText = ''
    if (builtFromEpisodes) {
      const failureReason = getDistillFailureReason(payload.date)
      const reason =
        failureReason && failureReason.length > 0 ? failureReason : '小时级理解尚未运行'
      warningText = `小时级理解未就绪：${reason}，当前使用工作记忆事件降级生成`
      markdownWarning = `\n\n---\n\n⚠️ 注意：${warningText}`
    } else if (snapshot.sourceType === 'raw_fallback') {
      markdownWarning =
        '\n\n---\n\n⚠️ 注意：本日报使用原始/启发式片段降级生成，建议在小时级理解完成后重新生成。'
      warningText = '使用原始/启发式片段降级生成'
    }

    return {
      markdown: `${content}${markdownWarning}`,
      aiInputSnapshot,
      segmentIds,
      usage: result.usage,
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
