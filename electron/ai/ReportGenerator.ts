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
import type { Episode, ReportInputSnapshot, ReportTemplate, WorkSegment } from '@/types'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { SettingsStore } from '../db/SettingsStore'
import { getTemplate, REPORT_TEMPLATES } from './templates'
import type { TemplateParams } from './templates'
import { OpenAIClient } from './OpenAIClient'
import type { TokenUsage } from './OpenAIClient'
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

interface SnapshotDigest {
  snapshot: ReportInputSnapshot
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
      for (const evidence of item.evidenceRefs.slice(0, 3)) {
        lines.push(`- 证据：${evidence.quote}`)
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
function collectSegmentIds(digests: EpisodeDigest[]): string[] {
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
 * 交叉校验：提取生成内容中的项目名/任务单号，检查是否在原片段范围内。
 * 若发现未在原片段出现的具体项目名/任务单号，返回警告文本。
 */
function crossValidate(generatedMarkdown: string, digests: EpisodeDigest[]): string {
  // 收集原片段中出现的所有项目名（entities type=project + topics）
  const knownProjects = new Set<string>()
  for (const { episode } of digests) {
    for (const entity of episode.entities) {
      if (entity.type === 'project' && entity.name) {
        knownProjects.add(entity.name.toLowerCase())
      }
    }
    for (const t of episode.topics) {
      if (t && !t.startsWith('__')) knownProjects.add(t.toLowerCase())
    }
  }

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

  // 从生成内容中提取项目名和任务单号
  // 项目名：Markdown 标题或加粗文本中出现的专有名词（启发式：## 项目名 或 **项目名**）
  const projectInGenerated = new Set<string>()
  const headingPattern = /^#{1,3}\s+(.+)$/gm
  const boldPattern = /\*\*([^*]+)\*\*/g
  let match: RegExpExecArray | null
  while ((match = headingPattern.exec(generatedMarkdown)) !== null) {
    const heading = match[1].trim()
    // 过滤掉通用标题（如"核心产出"、"明日计划"等）
    if (heading.length > 1 && heading.length < 30 && !isGenericHeading(heading)) {
      projectInGenerated.add(heading)
    }
  }
  while ((match = boldPattern.exec(generatedMarkdown)) !== null) {
    const bold = match[1].trim()
    if (bold.length > 1 && bold.length < 30 && !isGenericHeading(bold)) {
      projectInGenerated.add(bold)
    }
  }

  // 从生成内容中提取任务单号
  const taskNumbersInGenerated = new Set<string>()
  taskNumberPattern.lastIndex = 0
  while ((match = taskNumberPattern.exec(generatedMarkdown)) !== null) {
    taskNumbersInGenerated.add(match[1].toUpperCase())
  }

  // 找出未在原片段出现的项目名
  const suspiciousProjects: string[] = []
  for (const proj of projectInGenerated) {
    const projLower = proj.toLowerCase()
    // 检查是否是已知项目的子串或超串（模糊匹配）
    let found = false
    for (const known of knownProjects) {
      if (known.includes(projLower) || projLower.includes(known)) {
        found = true
        break
      }
    }
    if (!found) {
      suspiciousProjects.push(proj)
    }
  }

  // 找出未在原片段出现的任务单号
  const suspiciousTaskNumbers: string[] = []
  for (const taskNum of taskNumbersInGenerated) {
    if (!knownTaskNumbers.has(taskNum)) {
      suspiciousTaskNumbers.push(taskNum)
    }
  }

  // 构建警告
  const warnings: string[] = []
  if (suspiciousProjects.length > 0) {
    warnings.push(`项目名：${suspiciousProjects.slice(0, 5).join('、')}`)
  }
  if (suspiciousTaskNumbers.length > 0) {
    warnings.push(`任务单号：${suspiciousTaskNumbers.slice(0, 5).join('、')}`)
  }

  if (warnings.length === 0) {
    return ''
  }
  return `⚠️ 注意：以下内容可能需要核实（未在原始工作片段中出现）：${warnings.join('；')}`
}

/** 判断是否为通用标题（非项目名） */
function isGenericHeading(text: string): boolean {
  const generic = [
    '核心产出',
    '推进事项',
    '协作沟通',
    '其他',
    '明日计划',
    '风险与阻碍',
    '待对齐目标',
    '工作日报',
    '今日工作日报',
    'okr 对齐日报',
    '汇总',
    '总结',
    '产出'
  ]
  const lower = text.toLowerCase().trim()
  return generic.some((g) => lower === g.toLowerCase() || lower.includes(g.toLowerCase()))
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
   * 1. 加载勾选 Episode + Segment
   * 2. 构建 timeline / projectTags 文本
   * 3. 渲染模板提示词（buildPrompt）
   * 4. 调用 OpenAIClient.chatCompletion
   * 5. 交叉校验生成结果
   * 6. 返回 markdown + 输入快照 + segmentIds + usage + warning
   */
  async generate(payload: GenerateReportPayload): Promise<GenerateReportResult> {
    if (payload.reportInputSnapshot) {
      const snapshotDigest: SnapshotDigest = { snapshot: payload.reportInputSnapshot }
      void snapshotDigest
      if (payload.reportInputSnapshot.items.length === 0) {
        throw new Error('未找到可用的工作记忆事件，请至少勾选一条内容。')
      }

      const rawTimeline = buildSnapshotTimeline(payload.reportInputSnapshot)
      const { text: timeline, maskedCount } = maskSensitive(rawTimeline)
      const projectTags = buildSnapshotProjectTags(payload.reportInputSnapshot)
      const segmentIds = payload.reportInputSnapshot.segmentIds

      const template = getTemplate(payload.templateId)
      const templateParams: TemplateParams = {
        timeline,
        userNotes: payload.notes || payload.reportInputSnapshot.userNotes,
        projectTags,
        date: payload.date
      }
      const { systemPrompt, userPrompt } = template.buildPrompt(templateParams)
      const aiInputSnapshot = buildSnapshotAiInputSnapshot(payload.reportInputSnapshot, timeline, projectTags)

      const apiConfig = getApiConfig()
      if (!apiConfig.apiKey) {
        throw new Error('未配置 AI API Key，请在设置中配置')
      }

      const result = await OpenAIClient.chatCompletion({
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.4,
        maxTokens: 2048
      })

      const fallbackWarning =
        payload.reportInputSnapshot.sourceType === 'raw_fallback'
          ? '\n\n---\n\n⚠️ 注意：本日报使用原始/启发式片段降级生成，建议在小时级理解完成后重新生成。'
          : ''

      return {
        markdown: `${result.content}${fallbackWarning}`,
        aiInputSnapshot,
        segmentIds,
        usage: result.usage,
        warning: fallbackWarning ? '使用原始/启发式片段降级生成' : '',
        maskedCount: maskedCount + payload.reportInputSnapshot.maskedCount
      }
    }

    const digests = loadDigests(payload.episodeIds)
    if (digests.length === 0) {
      throw new Error('未找到可用的 Episode 片段，请至少勾选一条今日工作事件。')
    }

    const rawTimeline = buildTimeline(digests)
    // C3.3：对 OCR 摘要文本中的手机号/邮箱/身份证/银行卡脱敏后再发送给 AI
    const { text: timeline, maskedCount } = maskSensitive(rawTimeline)
    const projectTags = buildProjectTags(digests)
    const segmentIds = collectSegmentIds(digests)

    // 使用模板的 buildPrompt 构建提示词
    const template = getTemplate(payload.templateId)
    const templateParams: TemplateParams = {
      timeline,
      userNotes: payload.notes,
      projectTags,
      date: payload.date
    }
    const { systemPrompt, userPrompt } = template.buildPrompt(templateParams)

    // 输入快照：JSON 序列化，用于存档审计（使用脱敏后的 timeline）
    const aiInputSnapshot = buildAiInputSnapshot(payload, digests, timeline, projectTags)

    // 从 SettingsStore 读 API 配置
    const apiConfig = getApiConfig()
    if (!apiConfig.apiKey) {
      throw new Error('未配置 AI API Key，请在设置中配置')
    }

    // 调用 OpenAI-compatible API
    const result = await OpenAIClient.chatCompletion({
      baseUrl: apiConfig.baseUrl,
      apiKey: apiConfig.apiKey,
      model: apiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4,
      maxTokens: 2048
    })

    // 交叉校验：检查生成内容是否含未在原片段出现的项目名/任务单号
    const warning = crossValidate(result.content, digests)

    // 若有警告，追加到 markdown 末尾（不删除原内容，仅标记）
    const finalMarkdown = warning ? `${result.content}\n\n---\n\n${warning}` : result.content

    return {
      markdown: finalMarkdown,
      aiInputSnapshot,
      segmentIds,
      usage: result.usage,
      warning,
      maskedCount
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
