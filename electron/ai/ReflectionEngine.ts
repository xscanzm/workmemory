/**
 * ReflectionEngine：周级反思引擎（Task R1）。
 *
 * 在周级模式（WeeklyPatternDetector）+ 用户画像（UserProfileRepository）+ 因果链
 * （CausalChainRepository）基础上生成反思报告：
 *  - patterns：识别到的模式（碎片化时段/深度工作时段/频繁上下文切换/稳定工作模式）
 *  - suggestions：改进建议（针对 warning 模式给出可执行行动）
 *  - trends：趋势分析（deepWorkHours/switchCount/dominantActivity 较上周变化）
 *
 * 触发：每周一 WeeklyPatternDetector 完成后，或用户主动触发（由 main/index.ts 调用）
 *
 * 借鉴 EverOS Reflection 概念，将周级模式转化为可执行的改进建议与趋势洞察，
 * 支持用户对自身工作模式的反思与持续优化。
 */
import type { CausalChain } from './CausalChainBuilder'
import type { UserProfileEntry } from '../db/repositories/UserProfileRepository'
import type {
  WeeklyPattern,
  WeeklyPatternResult,
  WeeklyPatternTrend
} from './WeeklyPatternDetector'
import { WeeklyPatternRepository } from '../db/repositories/WeeklyPatternRepository'
import { UserProfileRepository } from '../db/repositories/UserProfileRepository'
import { CausalChainRepository } from '../db/repositories/CausalChainRepository'
import { ReflectionReportRepository } from '../db/repositories/ReflectionReportRepository'
import { SettingsStore } from '../db/SettingsStore'
import { OpenAIClient } from './OpenAIClient'

/** 反思报告中的模式严重程度 */
export type ReflectionSeverity = 'positive' | 'neutral' | 'warning'

/** 反思报告中的趋势方向 */
export type ReflectionTrendDirection = 'up' | 'down' | 'stable'

/** 反思报告：识别到的模式 */
export interface ReflectionPattern {
  /** 模式描述，如"下午 14:00-15:00 频繁碎片化" */
  description: string
  /** 严重程度：positive（积极）/ neutral（中性）/ warning（需改进） */
  severity: ReflectionSeverity
  /** 证据列表（来自 weekly_patterns.evidence 或趋势数据） */
  evidence: string[]
}

/** 反思报告：改进建议 */
export interface ReflectionSuggestion {
  /** 建议标题，如"在 14:00 设置专注模式" */
  title: string
  /** 建议理由（基于哪些模式/数据） */
  rationale: string
  /** 具体行动（可执行步骤） */
  action: string
}

/** 反思报告：趋势分析 */
export interface ReflectionTrend {
  /** 指标名，如"deepWorkHours" */
  metric: string
  /** 方向：up（上升）/ down（下降）/ stable（稳定） */
  direction: ReflectionTrendDirection
  /** 对比描述，如"较上周提升 15%" */
  comparison: string
}

/** 反思报告 */
export interface ReflectionReport {
  /** 周一日期（YYYY-MM-DD） */
  weekStart: string
  /** 识别到的模式 */
  patterns: ReflectionPattern[]
  /** 改进建议 */
  suggestions: ReflectionSuggestion[]
  /** 趋势分析 */
  trends: ReflectionTrend[]
  /** ISO 创建时间戳 */
  createdAt: string
}

/** 一周天数 */
const WEEK_DAYS = 7
/** 趋势判定阈值：deepWorkHours 变化幅度（小时） */
const DEEP_WORK_TREND_THRESHOLD = 0.5
/** 趋势判定阈值：switchCount 变化幅度（次） */
const SWITCH_COUNT_TREND_THRESHOLD = 2
/** 碎片化时段出现天数阈值（>=此值视为 warning） */
const FRAGMENTED_WARNING_DAYS = 3
/** 频繁上下文切换阈值（日均切换次数） */
const HIGH_SWITCH_THRESHOLD = 15
/** 稳定工作模式判定：deep_work_time 出现天数阈值 */
const STABLE_DEEP_WORK_DAYS = 4

function nowIso(): string {
  return new Date().toISOString()
}

/** 在日期字符串（YYYY-MM-DD）上加减天数，返回新的日期字符串 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * 从 SettingsStore 读取 API 配置（API Key 走加密存储 getApiKey()，不读明文）
 */
function getApiConfig(): { baseUrl: string; apiKey: string; model: string } {
  const settings = SettingsStore.get()
  return {
    baseUrl: settings.apiBaseUrl || 'https://api.openai.com/v1',
    apiKey: SettingsStore.getApiKey(),
    model: settings.modelName || 'gpt-4o-mini'
  }
}

/**
 * 从 WeeklyPattern.metadata 中提取碎片化时段出现天数。
 */
function fragmentedDays(pattern: WeeklyPattern): number {
  const meta = pattern.metadata as { days?: number } | undefined
  return typeof meta?.days === 'number' ? meta.days : 0
}

/**
 * 从 WeeklyPattern.metadata 中提取深度工作时段出现天数。
 */
function deepWorkDays(pattern: WeeklyPattern): number {
  const meta = pattern.metadata as { days?: number } | undefined
  return typeof meta?.days === 'number' ? meta.days : 0
}

/**
 * 从 WeeklyPattern.metadata 中提取深度工作时段范围（HH:00-HH:00）。
 */
function deepWorkRange(pattern: WeeklyPattern): string {
  const meta = pattern.metadata as { startHour?: number; endHour?: number } | undefined
  if (typeof meta?.startHour !== 'number' || typeof meta?.endHour !== 'number') {
    return ''
  }
  const fmt = (h: number): string => `${String(h).padStart(2, '0')}:00`
  return `${fmt(meta.startHour)}-${fmt(meta.endHour + 1)}`
}

/**
 * 从 WeeklyPattern.metadata 中提取碎片化时段范围（HH:00-HH:00）。
 */
function fragmentedRange(pattern: WeeklyPattern): string {
  const meta = pattern.metadata as { start?: string; end?: string } | undefined
  if (!meta?.start || !meta?.end) return ''
  return `${meta.start}-${meta.end}`
}

/**
 * 计算周内日均切换次数（switchCountTrend 求和 / 7）。
 */
function avgSwitchCount(trend: WeeklyPatternTrend): number {
  if (trend.switchCountTrend.length === 0) return 0
  const sum = trend.switchCountTrend.reduce((s, x) => s + x, 0)
  return sum / WEEK_DAYS
}

/**
 * 计算周内总深度工作时长（deepWorkHoursTrend 求和）。
 */
function totalDeepWorkHours(trend: WeeklyPatternTrend): number {
  return trend.deepWorkHoursTrend.reduce((s, x) => s + x, 0)
}

/**
 * 识别反思模式：基于 weekly_patterns 中的 5 类模式映射为 ReflectionPattern。
 *
 * 映射规则：
 *  - fragmented_time（出现天数 >= 阈值）→ warning
 *  - deep_work_time（出现天数 >= 阈值）→ positive
 *  - efficiency_trend（declining）→ warning；（rising）→ positive；（stable）→ neutral
 *  - attention_hotspot → positive
 *  - app_combination → neutral
 *
 * 额外识别：
 *  - 频繁上下文切换（日均切换 >= 阈值）→ warning
 *  - 稳定工作模式（deep_work_time 出现天数 >= 阈值且日均切换低）→ positive
 */
function identifyPatterns(
  weekly: WeeklyPatternResult,
  profile: UserProfileEntry[]
): ReflectionPattern[] {
  const patterns: ReflectionPattern[] = []

  for (const wp of weekly.patterns) {
    if (wp.type === 'fragmented_time') {
      const days = fragmentedDays(wp)
      const range = fragmentedRange(wp)
      patterns.push({
        description: range
          ? `下午 ${range} 频繁碎片化（${days}/${WEEK_DAYS} 天）`
          : wp.description,
        severity: days >= FRAGMENTED_WARNING_DAYS ? 'warning' : 'neutral',
        evidence: wp.evidence.slice()
      })
    } else if (wp.type === 'deep_work_time') {
      const days = deepWorkDays(wp)
      const range = deepWorkRange(wp)
      patterns.push({
        description: range
          ? `深度工作时段 ${range}（${days}/${WEEK_DAYS} 天稳定）`
          : wp.description,
        severity: 'positive',
        evidence: wp.evidence.slice()
      })
    } else if (wp.type === 'efficiency_trend') {
      const meta = wp.metadata as { trend?: 'rising' | 'declining' | 'stable' } | undefined
      const trend = meta?.trend ?? 'stable'
      patterns.push({
        description: wp.description,
        severity: trend === 'declining' ? 'warning' : trend === 'rising' ? 'positive' : 'neutral',
        evidence: wp.evidence.slice()
      })
    } else if (wp.type === 'attention_hotspot') {
      patterns.push({
        description: wp.description,
        severity: 'positive',
        evidence: wp.evidence.slice()
      })
    } else if (wp.type === 'app_combination') {
      patterns.push({
        description: wp.description,
        severity: 'neutral',
        evidence: wp.evidence.slice()
      })
    }
  }

  // 额外识别：频繁上下文切换
  const avgSwitch = avgSwitchCount(weekly.trend)
  if (avgSwitch >= HIGH_SWITCH_THRESHOLD) {
    patterns.push({
      description: `频繁上下文切换（日均 ${avgSwitch.toFixed(1)} 次）`,
      severity: 'warning',
      evidence: weekly.trend.switchCountTrend
        .map((c, i) => `${addDays(weekly.weekStart, i)}: ${c} 次`)
        .filter((line) => !line.endsWith(': 0 次'))
    })
  }

  // 额外识别：稳定工作模式（深度工作时段稳定 + 切换次数低 + 画像含 work_pattern）
  const deepWorkPattern = weekly.patterns.find((p) => p.type === 'deep_work_time')
  const hasWorkPatternProfile = profile.some(
    (p) => p.key === 'work_pattern' && p.confidence >= 0.5
  )
  if (
    deepWorkPattern &&
    deepWorkDays(deepWorkPattern) >= STABLE_DEEP_WORK_DAYS &&
    avgSwitch < HIGH_SWITCH_THRESHOLD &&
    hasWorkPatternProfile
  ) {
    patterns.push({
      description: '稳定的工作模式（深度工作时段规律 + 上下文切换可控）',
      severity: 'positive',
      evidence: [
        `深度工作时段 ${deepWorkRange(deepWorkPattern)} 出现 ${deepWorkDays(deepWorkPattern)}/${WEEK_DAYS} 天`,
        `日均切换 ${avgSwitch.toFixed(1)} 次`,
        `用户画像 work_pattern 已建立`
      ]
    })
  }

  return patterns
}

/**
 * 基于反思模式生成改进建议。
 *
 * 规则：
 *  - 碎片化时段（warning）→ "在 XX 时段设置专注模式，关闭通知"
 *  - 深度工作时段（positive）→ "保持 XX 时段的深度工作习惯"
 *  - 频繁上下文切换（warning）→ "尝试批量处理同类任务"
 *  - 效率趋势下降（warning）→ "复盘下降原因，调整工作节奏"
 *  - 稳定工作模式（positive）→ "继续保持当前工作节奏"
 */
function generateSuggestions(
  reflectionPatterns: ReflectionPattern[],
  weekly: WeeklyPatternResult
): ReflectionSuggestion[] {
  const suggestions: ReflectionSuggestion[] = []

  // 碎片化时段建议
  const fragmented = weekly.patterns.find((p) => p.type === 'fragmented_time')
  if (fragmented) {
    const range = fragmentedRange(fragmented)
    const days = fragmentedDays(fragmented)
    if (days >= FRAGMENTED_WARNING_DAYS) {
      suggestions.push({
        title: range
          ? `在 ${range} 设置专注模式`
          : '在碎片化时段设置专注模式',
        rationale: `本周 ${days}/${WEEK_DAYS} 天在 ${range || '同时段'} 出现碎片化，` +
          '上下文频繁切换会显著降低深度工作时长。',
        action: range
          ? `在 ${range} 关闭即时通讯通知，使用番茄钟（25min 工作 + 5min 休息），` +
            '将碎片化任务集中到该时段末尾统一处理。'
          : '识别碎片化时段后关闭通知，使用番茄钟将碎片化任务集中处理。'
      })
    }
  }

  // 频繁上下文切换建议
  const avgSwitch = avgSwitchCount(weekly.trend)
  if (avgSwitch >= HIGH_SWITCH_THRESHOLD) {
    suggestions.push({
      title: '尝试批量处理同类任务',
      rationale: `本周日均上下文切换 ${avgSwitch.toFixed(1)} 次，频繁切换会带来注意力残余成本。`,
      action: '将同类任务（如邮件回复、代码审查、文档阅读）集中到固定时段批量处理，' +
        '减少在不同活动类型间的来回切换。'
    })
  }

  // 效率趋势下降建议
  const efficiencyTrend = weekly.patterns.find((p) => p.type === 'efficiency_trend')
  if (efficiencyTrend) {
    const meta = efficiencyTrend.metadata as { trend?: string } | undefined
    if (meta?.trend === 'declining') {
      suggestions.push({
        title: '复盘深度工作时长下降原因',
        rationale: efficiencyTrend.description,
        action: '回顾下半周的工作安排，识别打断深度工作的因素（会议、临时需求、疲劳等），' +
          '在下周计划中预留保护性的深度工作时段。'
      })
    }
  }

  // 深度工作时段保持建议（positive）
  const deepWork = weekly.patterns.find((p) => p.type === 'deep_work_time')
  if (deepWork) {
    const days = deepWorkDays(deepWork)
    const range = deepWorkRange(deepWork)
    if (days >= STABLE_DEEP_WORK_DAYS) {
      suggestions.push({
        title: range ? `保持 ${range} 的深度工作习惯` : '保持深度工作时段习惯',
        rationale: `本周 ${days}/${WEEK_DAYS} 天在 ${range || '同时段'} 进入深度工作，` +
          '稳定的深度工作节奏是高效产出的基础。',
        action: range
          ? `继续在 ${range} 保护深度工作时间，避免安排会议或处理即时消息。` +
            '可在该时段开始前准备好所需资料，减少切换成本。'
          : '继续保护深度工作时段，提前准备所需资料。'
      })
    }
  }

  // 稳定工作模式保持建议
  const stablePattern = reflectionPatterns.find(
    (p) => p.severity === 'positive' && p.description.startsWith('稳定的工作模式')
  )
  if (stablePattern) {
    suggestions.push({
      title: '继续保持当前工作节奏',
      rationale: stablePattern.evidence.join('；'),
      action: '当前工作模式稳定高效，可在下周尝试在此基础上小幅扩展深度工作时段，' +
        '或引入新的主题学习以保持成长。'
    })
  }

  return suggestions
}

/**
 * 分析趋势：基于本周 trend 与上周 trend 对比生成 ReflectionTrend。
 *
 * 指标：
 *  - deepWorkHours：本周总深度工作时长 vs 上周，方向 up/down/stable
 *  - switchCount：本周日均切换次数 vs 上周，方向 up/down/stable
 *  - dominantActivity：本周主导活动是否变化
 *
 * 无上周数据时，仅基于本周数据给出绝对值描述（direction 为 stable）。
 */
function analyzeTrends(
  thisWeek: WeeklyPatternResult,
  lastWeek: WeeklyPatternResult | null
): ReflectionTrend[] {
  const trends: ReflectionTrend[] = []

  // deepWorkHours 趋势
  const thisDeep = totalDeepWorkHours(thisWeek.trend)
  if (lastWeek) {
    const lastDeep = totalDeepWorkHours(lastWeek.trend)
    const delta = thisDeep - lastDeep
    let direction: ReflectionTrendDirection = 'stable'
    let comparison = ''
    if (delta > DEEP_WORK_TREND_THRESHOLD) {
      direction = 'up'
      const pct = lastDeep > 0 ? Math.round((delta / lastDeep) * 100) : 100
      comparison = `较上周提升 ${pct}%（+${delta.toFixed(1)}h）`
    } else if (delta < -DEEP_WORK_TREND_THRESHOLD) {
      direction = 'down'
      const pct = lastDeep > 0 ? Math.round(((-delta) / lastDeep) * 100) : 0
      comparison = `较上周下降 ${pct}%（${delta.toFixed(1)}h）`
    } else {
      comparison = `与上周基本持平（${thisDeep.toFixed(1)}h vs ${lastDeep.toFixed(1)}h）`
    }
    trends.push({
      metric: 'deepWorkHours',
      direction,
      comparison
    })
  } else {
    trends.push({
      metric: 'deepWorkHours',
      direction: 'stable',
      comparison: `本周累计 ${thisDeep.toFixed(1)}h 深度工作（无上周数据对比）`
    })
  }

  // switchCount 趋势
  const thisSwitch = avgSwitchCount(thisWeek.trend)
  if (lastWeek) {
    const lastSwitch = avgSwitchCount(lastWeek.trend)
    const delta = thisSwitch - lastSwitch
    let direction: ReflectionTrendDirection = 'stable'
    let comparison = ''
    if (delta > SWITCH_COUNT_TREND_THRESHOLD) {
      direction = 'up'
      comparison = `较上周增加 ${delta.toFixed(1)} 次/天（${lastSwitch.toFixed(1)}→${thisSwitch.toFixed(1)}）`
    } else if (delta < -SWITCH_COUNT_TREND_THRESHOLD) {
      direction = 'down'
      comparison = `较上周减少 ${(-delta).toFixed(1)} 次/天（${lastSwitch.toFixed(1)}→${thisSwitch.toFixed(1)}）`
    } else {
      comparison = `与上周基本持平（${thisSwitch.toFixed(1)} 次/天）`
    }
    trends.push({
      metric: 'switchCount',
      direction,
      comparison
    })
  } else {
    trends.push({
      metric: 'switchCount',
      direction: 'stable',
      comparison: `本周日均 ${thisSwitch.toFixed(1)} 次切换（无上周数据对比）`
    })
  }

  // dominantActivity 变化
  const thisDominant = thisWeek.trend.dominantActivityTrend.filter((a) => a.length > 0)
  const thisTopActivity = topActivity(thisDominant)
  if (lastWeek) {
    const lastDominant = lastWeek.trend.dominantActivityTrend.filter((a) => a.length > 0)
    const lastTopActivity = topActivity(lastDominant)
    if (thisTopActivity && lastTopActivity && thisTopActivity !== lastTopActivity) {
      trends.push({
        metric: 'dominantActivity',
                        direction: 'up',
        comparison: `主导活动从 ${lastTopActivity} 转向 ${thisTopActivity}`
      })
    } else if (thisTopActivity) {
      trends.push({
        metric: 'dominantActivity',
        direction: 'stable',
        comparison: `主导活动保持为 ${thisTopActivity}`
      })
    }
  } else if (thisTopActivity) {
    trends.push({
      metric: 'dominantActivity',
      direction: 'stable',
      comparison: `本周主导活动为 ${thisTopActivity}（无上周数据对比）`
    })
  }

  return trends
}

/** 计算活动列表的众数（出现最多的活动） */
function topActivity(activities: string[]): string | null {
  if (activities.length === 0) return null
  const counts = new Map<string, number>()
  for (const a of activities) {
    counts.set(a, (counts.get(a) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [a, c] of counts) {
    if (c > bestCount) {
      best = a
      bestCount = c
    }
  }
  return best
}

/**
 * 构建 AI 用户提示词：包含 weekly_patterns、用户画像、causal_chains 概览。
 */
function buildAiUserPrompt(
  weekStart: string,
  weekly: WeeklyPatternResult | null,
  profile: UserProfileEntry[],
  causalChains: CausalChain[]
): string {
  const patternLines = weekly
    ? weekly.patterns
        .map((p) => `- [${p.type}] ${p.description}（置信度 ${p.confidence.toFixed(2)}，证据 ${p.evidence.length} 天）`)
        .join('\n')
    : '（无周级模式数据）'
  const trendLine = weekly
    ? `deepWorkHoursTrend: [${weekly.trend.deepWorkHoursTrend.join(', ')}]\n` +
      `switchCountTrend: [${weekly.trend.switchCountTrend.join(', ')}]\n` +
      `dominantActivityTrend: [${weekly.trend.dominantActivityTrend.map((a) => a || '—').join(', ')}]`
    : '（无趋势数据）'
  const profileLines = profile
    .map((p) => `- ${p.key}: ${p.value} (type=${p.type}, 置信度 ${p.confidence.toFixed(2)})`)
    .join('\n')
  const chainLines = causalChains
    .slice(0, 20)
    .map((c) => `- [${c.relation}] ${c.evidence}（置信度 ${c.confidence.toFixed(2)}）`)
    .join('\n')
  return [
    `周起始日期：${weekStart}`,
    '',
    '## 周级模式（weekly_patterns）',
    patternLines,
    '',
    '## 趋势数据（trend）',
    trendLine,
    '',
    '## 用户画像（user_profile）',
    profileLines || '（无画像数据）',
    '',
    `## 因果链（causal_chains，共 ${causalChains.length} 条，仅展示前 20 条）`,
    chainLines || '（无因果链数据）',
    '',
    '请基于以上信息，生成 JSON 对象，包含三个字段：',
    '- patterns: 识别到的模式数组，每项含 description（描述）、severity（positive/neutral/warning）、evidence（证据字符串数组）',
    '- suggestions: 改进建议数组，每项含 title（标题）、rationale（理由）、action（具体行动）',
    '- trends: 趋势分析数组，每项含 metric（指标名）、direction（up/down/stable）、comparison（对比描述）',
    '',
    '输出格式：{"patterns": [...], "suggestions": [...], "trends": [...]}',
    '只返回 JSON 对象，第一个字符必须是 {，不要 Markdown、不要额外解释。'
  ].join('\n')
}

/** AI 返回的反思报告（解析用，不含 weekStart/createdAt） */
interface AiReflectionBody {
  patterns?: unknown
  suggestions?: unknown
  trends?: unknown
}

/**
 * 校验并规范化 AI 返回的模式项。
 */
function normalizeAiPattern(raw: unknown): ReflectionPattern | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  if (!description) return null
  const severityRaw = obj.severity
  const severity: ReflectionSeverity =
    severityRaw === 'positive' || severityRaw === 'neutral' || severityRaw === 'warning'
      ? severityRaw
      : 'neutral'
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence.filter((e): e is string => typeof e === 'string')
    : []
  return { description, severity, evidence }
}

/**
 * 校验并规范化 AI 返回的建议项。
 */
function normalizeAiSuggestion(raw: unknown): ReflectionSuggestion | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : ''
  const action = typeof obj.action === 'string' ? obj.action.trim() : ''
  if (!title || !rationale || !action) return null
  return { title, rationale, action }
}

/**
 * 校验并规范化 AI 返回的趋势项。
 */
function normalizeAiTrend(raw: unknown): ReflectionTrend | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const metric = typeof obj.metric === 'string' ? obj.metric.trim() : ''
  const directionRaw = obj.direction
  const direction: ReflectionTrendDirection =
    directionRaw === 'up' || directionRaw === 'down' || directionRaw === 'stable'
      ? directionRaw
      : 'stable'
  const comparison = typeof obj.comparison === 'string' ? obj.comparison.trim() : ''
  if (!metric || !comparison) return null
  return { metric, direction, comparison }
}

/**
 * 解析 AI 返回的 JSON 为 AiReflectionBody。
 * 返回值约定：
 *  - null：响应不可解析（非 JSON 或结构不符），调用方应降级为规则反思
 *  - AiReflectionBody：响应是合法的 JSON 对象（字段可能为空）
 */
function parseAiResponse(content: string): AiReflectionBody | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  return parsed as AiReflectionBody
}

/**
 * 调用 AI 增强反思报告。
 * 返回值约定：
 *  - null：AI 不可用（未配置 API Key）、调用失败、或响应不可解析，调用方应使用规则反思
 *  - { patterns, suggestions, trends }：AI 成功返回合法 JSON
 */
async function reflectByAi(
  weekStart: string,
  weekly: WeeklyPatternResult | null,
  profile: UserProfileEntry[],
  causalChains: CausalChain[]
): Promise<{
  patterns: ReflectionPattern[]
  suggestions: ReflectionSuggestion[]
  trends: ReflectionTrend[]
} | null> {
  const apiConfig = getApiConfig()
  if (!apiConfig.apiKey) return null
  const userPrompt = buildAiUserPrompt(weekStart, weekly, profile, causalChains)
  try {
    const result = await OpenAIClient.chatCompletion({
      baseUrl: apiConfig.baseUrl,
      apiKey: apiConfig.apiKey,
      model: apiConfig.model,
      messages: [
        {
          role: 'system',
          content:
            '你是一个工作记忆周级反思引擎。根据给定的周级模式、用户画像与因果链，' +
            '生成结构化的反思报告：识别模式、提出改进建议、分析趋势。' +
            '只返回 JSON 对象，不要 Markdown、不要额外解释。'
        },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      maxTokens: 2048,
      responseFormat: { type: 'json_object' }
    })
    const body = parseAiResponse(result.content)
    if (body === null) {
      console.warn(
        '[ReflectionEngine] AI 返回内容无法解析，降级使用规则反思'
      )
      return null
    }
    const patterns = Array.isArray(body.patterns)
      ? body.patterns.map(normalizeAiPattern).filter((p): p is ReflectionPattern => p !== null)
      : []
    const suggestions = Array.isArray(body.suggestions)
      ? body.suggestions.map(normalizeAiSuggestion).filter((s): s is ReflectionSuggestion => s !== null)
      : []
    const trends = Array.isArray(body.trends)
      ? body.trends.map(normalizeAiTrend).filter((t): t is ReflectionTrend => t !== null)
      : []
    return { patterns, suggestions, trends }
  } catch (e) {
    console.warn(
      '[ReflectionEngine] AI 反思生成失败，降级使用规则反思:',
      e instanceof Error ? e.message : String(e)
    )
    return null
  }
}

/**
 * 周级反思：基于 weekly_patterns + user_profile + causal_chains 生成反思报告。
 *
 * 处理流程：
 *  1. 通过 WeeklyPatternRepository.getByWeekStart 获取本周周级模式
 *  2. 通过 UserProfileRepository.getStable + getTransient 获取用户画像
 *  3. 通过 CausalChainRepository.getByDateRange 获取周内因果链
 *  4. 通过 WeeklyPatternRepository.getByWeekStart(lastWeekStart) 获取上周模式（用于趋势对比）
 *  5. 识别 patterns（规则映射 + 额外识别频繁切换/稳定模式）
 *  6. 生成 suggestions（针对 warning 模式给出可执行行动）
 *  7. 分析 trends（deepWorkHours/switchCount/dominantActivity 较上周变化）
 *  8. AI 增强：如果 AI 可用，让 AI 基于数据生成更深入的反思和建议（覆盖规则结果）
 *  9. 通过 ReflectionReportRepository.upsert 持久化
 *
 * 无 weekly_patterns 时仍生成空报告（含趋势兜底），不抛出错误。
 *
 * @param weekStart 周一日期字符串（YYYY-MM-DD）
 * @returns 反思报告
 */
export async function reflect(weekStart: string): Promise<ReflectionReport> {
  // 1. 获取本周周级模式
  const weekly = WeeklyPatternRepository.getByWeekStart(weekStart)

  // 2. 获取用户画像（stable + transient）
  const profile: UserProfileEntry[] = [
    ...UserProfileRepository.getStable(),
    ...UserProfileRepository.getTransient()
  ]

  // 3. 获取周内因果链
  const weekEnd = addDays(weekStart, WEEK_DAYS - 1)
  let causalChains: CausalChain[] = []
  try {
    causalChains = CausalChainRepository.getByDateRange(weekStart, weekEnd)
  } catch (e) {
    console.warn(
      '[ReflectionEngine] 获取因果链失败，继续生成反思报告:',
      e instanceof Error ? e.message : String(e)
    )
  }

  // 4. 获取上周模式（用于趋势对比）
  const lastWeekStart = addDays(weekStart, -WEEK_DAYS)
  let lastWeek: WeeklyPatternResult | null = null
  try {
    lastWeek = WeeklyPatternRepository.getByWeekStart(lastWeekStart)
  } catch (e) {
    console.warn(
      '[ReflectionEngine] 获取上周模式失败，继续生成反思报告:',
      e instanceof Error ? e.message : String(e)
    )
  }

  // 5-7. 基于规则生成 patterns / suggestions / trends
  const emptyTrend: WeeklyPatternTrend = {
    deepWorkHoursTrend: [],
    switchCountTrend: [],
    dominantActivityTrend: []
  }
  const weeklyForAnalysis: WeeklyPatternResult = weekly ?? {
    weekStart,
    patterns: [],
    trend: emptyTrend,
    createdAt: nowIso()
  }

  let patterns = identifyPatterns(weeklyForAnalysis, profile)
  let suggestions = generateSuggestions(patterns, weeklyForAnalysis)
  let trends = analyzeTrends(weeklyForAnalysis, lastWeek)

  // 8. AI 增强：如果 AI 可用，让 AI 基于数据生成更深入的反思和建议
  //    AI 返回合法结果时覆盖规则结果；AI 不可用或失败时保留规则结果
  const aiResult = await reflectByAi(weekStart, weekly, profile, causalChains)
  if (aiResult) {
    if (aiResult.patterns.length > 0) patterns = aiResult.patterns
    if (aiResult.suggestions.length > 0) suggestions = aiResult.suggestions
    if (aiResult.trends.length > 0) trends = aiResult.trends
  }

  const report: ReflectionReport = {
    weekStart,
    patterns,
    suggestions,
    trends,
    createdAt: nowIso()
  }

  // 9. 持久化
  try {
    ReflectionReportRepository.upsert(report)
  } catch (e) {
    console.error(
      '[ReflectionEngine] 反思报告持久化失败:',
      e instanceof Error ? e.message : String(e)
    )
  }

  return report
}
