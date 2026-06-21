/**
 * ProactiveAdvisor：主动建议引擎（Task R4）。
 *
 * 在反思与进化 Sprint 中，基于用户画像、技能卡和历史模式，主动给用户提建议：
 *  - skill_reference：当前活动匹配已有技能卡 → "要参考之前的经验吗"
 *  - rest_reminder：当前连续活动 >2h 且历史模式显示该时段效率低 → "建议休息"
 *  - focus_suggestion：检测到与昨日相同的碎片化模式 → "今天又在频繁切换，要试试专注模式吗"
 *
 * 触发：由 main/index.ts 定时调用（如每 15 分钟），或用户主动触发。
 *
 * 节流：同一 type 的建议 4 小时内不重复（内存 Map）。
 * 推送：通过 MascotNotifier.notifyAdvice 推送到桌面伙伴。
 *
 * 借鉴 EverOS Proactive 概念，将记忆资产转化为主动的认知辅助，
 * 支持用户在合适时机参考过往经验、调整工作节奏。
 */
import { randomUUID } from 'node:crypto'
import type { Skill } from './SkillEvolver'
import type { WeeklyPatternResult } from './WeeklyPatternDetector'
import { SkillRepository } from '../db/repositories/SkillRepository'
import { DailyDistillRepository } from '../db/repositories/DailyDistillRepository'
import { WeeklyPatternRepository } from '../db/repositories/WeeklyPatternRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { notifyAdvice as mascotNotifyAdvice } from '../mascot/MascotNotifier'

/** 建议类型 */
export type AdviceType = 'skill_reference' | 'rest_reminder' | 'focus_suggestion'

/** 主动建议 */
export interface Advice {
  /** 建议 ID（UUID） */
  id: string
  /** 建议类型 */
  type: AdviceType
  /** 建议标题 */
  title: string
  /** 建议内容 */
  message: string
  /** 可选的行动建议 */
  action?: string
  /** 关联的技能卡 ID（skill_reference 类型适用） */
  skillId?: string
  /** 置信度 0-1 */
  confidence: number
  /** ISO 创建时间戳 */
  createdAt: string
}

/** 当前活动信息（用于建议触发判定） */
export interface CurrentActivity {
  /** 活动类型，如 'coding'、'writing' */
  activityType?: string
  /** OCR 文本（用于关键词匹配） */
  ocrText?: string
  /** 应用名 */
  appName?: string
  /** 窗口标题 */
  windowTitle?: string
  /** 活动开始时间（ISO 时间戳或 HH:MM:SS 格式） */
  startTime?: string
  /** 活动日期（YYYY-MM-DD，用于解析 HH:MM:SS 格式的 startTime） */
  date?: string
}

/** 节流窗口：4 小时 */
const THROTTLE_MS = 4 * 60 * 60 * 1000
/** 技能卡匹配阈值 */
const SKILL_MATCH_THRESHOLD = 0.5
/** 连续活动休息提醒阈值：2 小时 */
const REST_THRESHOLD_MS = 2 * 60 * 60 * 1000
/** 高切换次数阈值（日均） */
const HIGH_SWITCH_THRESHOLD = 15
/** 碎片化时段判定：fragmentedPeriods 非空即视为碎片化 */
const FRAGMENTED_PERIODS_MIN = 1

/** 节流 Map：adviceType → 上次展示时间戳（毫秒） */
const adviceThrottle = new Map<AdviceType, number>()

function nowIso(): string {
  return new Date().toISOString()
}

function todayString(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 在日期字符串（YYYY-MM-DD）上加减天数，返回新的日期字符串 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 获取指定日期所在周的周一日期（YYYY-MM-DD，本地时区） */
function getWeekStart(date: Date = new Date()): string {
  const d = new Date(date)
  const day = d.getDay() // 0 = Sunday, 1 = Monday
  const diff = day === 0 ? -6 : 1 - day // 回到本周周一
  d.setDate(d.getDate() + diff)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** 将置信度限制在 [0, 1] 范围内，保留两位小数 */
function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100))
}

/** 判断指定类型的建议是否被节流（4 小时内已展示） */
function isThrottled(type: AdviceType): boolean {
  const lastShown = adviceThrottle.get(type)
  if (!lastShown) return false
  return Date.now() - lastShown < THROTTLE_MS
}

/** 标记指定类型的建议已展示（更新节流时间戳） */
function markShown(type: AdviceType): void {
  adviceThrottle.set(type, Date.now())
}

/** 重置节流 Map（仅供测试使用） */
export function resetThrottle(): void {
  adviceThrottle.clear()
}

/**
 * 从文本中提取关键词集合。
 *
 * 中文 token：提取 2 字符 bigram（如"数据库迁移" → {数据库, 据库迁, 库迁移, 迁移}），
 *            token 长度 ≤3 时也整体作为一个关键词。
 * 英文 token：长度 ≥3 时整体作为一个关键词（小写）。
 */
function extractKeywords(text: string): Set<string> {
  const keywords = new Set<string>()
  if (!text) return keywords
  const lower = text.toLowerCase()
  const tokens = lower
    .split(/[\s,，。.;；:：!！?？()（）[\]【】"'`'/\\_-]+/)
    .filter((t) => t.length > 0)
  for (const token of tokens) {
    if (/[\u4e00-\u9fa5]/.test(token)) {
      // 中文 token：提取 2 字符 bigram
      for (let i = 0; i < token.length - 1; i++) {
        keywords.add(token.substring(i, i + 2))
      }
      // 短 token（≤3 字符）整体也作为关键词
      if (token.length <= 3) {
        keywords.add(token)
      }
    } else {
      // 英文/其他：长度 ≥3 时作为关键词
      if (token.length >= 3) {
        keywords.add(token)
      }
    }
  }
  return keywords
}

/**
 * 计算两个关键词集合的重叠系数（overlap coefficient）。
 * overlap = |intersection| / min(|a|, |b|)
 *
 * 相比 Jaccard，重叠系数在集合大小差异较大时更合理：
 * 当活动文本关键词是技能卡关键词的子集时，重叠系数为 1.0。
 */
function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  let intersection = 0
  for (const x of smaller) {
    if (larger.has(x)) intersection++
  }
  return intersection / smaller.size
}

/**
 * 从技能卡提取关键词集合（title + steps）。
 */
function extractSkillKeywords(skill: Skill): Set<string> {
  const keywords = new Set<string>()
  for (const kw of extractKeywords(skill.title)) {
    keywords.add(kw)
  }
  for (const step of skill.steps) {
    // 去除步骤序号前缀（如 "1. "）后再提取
    const cleaned = step.replace(/^\d+\.\s*/, '')
    for (const kw of extractKeywords(cleaned)) {
      keywords.add(kw)
    }
  }
  return keywords
}

/**
 * 从当前活动提取用于匹配的文本（拼接 activityType + ocrText + appName + windowTitle）。
 */
function buildActivityText(activity: CurrentActivity): string {
  return [activity.activityType, activity.ocrText, activity.appName, activity.windowTitle]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' ')
}

/**
 * 解析活动开始时间为毫秒时间戳。
 * 支持两种格式：
 *  - ISO 时间戳（含 'T'）：直接解析
 *  - HH:MM:SS 格式：与 date 拼接为本地时间解析
 */
function parseActivityStartTime(startTime: string, date?: string): number {
  if (startTime.includes('T')) {
    return new Date(startTime).getTime()
  }
  // HH:MM:SS 格式，与 date 拼接
  const dateStr = date || todayString()
  return new Date(`${dateStr}T${startTime}`).getTime()
}

/**
 * 从数据库获取当前活动（今日最新 segment）。
 * 无 segment 时返回 null。
 */
function getCurrentActivityFromDb(): CurrentActivity | null {
  try {
    const today = todayString()
    const segments = SegmentRepository.getActiveByDate(today)
    if (segments.length === 0) return null
    const latest = segments[segments.length - 1]
    return {
      activityType: latest.activityType,
      ocrText: latest.ocrText,
      appName: latest.appName,
      windowTitle: latest.windowTitle,
      startTime: latest.startTime,
      date: latest.date
    }
  } catch (e) {
    console.warn(
      '[ProactiveAdvisor] 获取当前活动失败:',
      e instanceof Error ? e.message : String(e)
    )
    return null
  }
}

/**
 * 规则 1：技能卡参考建议。
 *
 * 将当前活动文本与所有技能卡的 title+steps 关键词匹配，
 * 若重叠系数 > 阈值，返回 skill_reference 建议（附 skillId）。
 */
function checkSkillReference(activity: CurrentActivity): Advice | null {
  let skills: Skill[]
  try {
    skills = SkillRepository.getAll()
  } catch (e) {
    console.warn(
      '[ProactiveAdvisor] 获取技能卡失败:',
      e instanceof Error ? e.message : String(e)
    )
    return null
  }
  if (skills.length === 0) return null

  const activityText = buildActivityText(activity)
  if (!activityText) return null
  const activityKeywords = extractKeywords(activityText)
  if (activityKeywords.size === 0) return null

  let bestSkill: Skill | null = null
  let bestScore = 0
  for (const skill of skills) {
    const skillKeywords = extractSkillKeywords(skill)
    if (skillKeywords.size === 0) continue
    const score = overlapCoefficient(activityKeywords, skillKeywords)
    if (score > bestScore) {
      bestScore = score
      bestSkill = skill
    }
  }

  if (!bestSkill || bestScore <= SKILL_MATCH_THRESHOLD) return null

  return {
    id: randomUUID(),
    type: 'skill_reference',
    title: '要参考之前的经验吗',
    message: `检测到你正在进行的任务与技能卡「${bestSkill.title}」相关（匹配度 ${(bestScore * 100).toFixed(0)}%），要参考之前的经验吗？`,
    action: '查看技能卡',
    skillId: bestSkill.id,
    confidence: clampConfidence(bestScore),
    createdAt: nowIso()
  }
}

/**
 * 规则 2：休息提醒建议。
 *
 * 当前连续活动时长（从最近 segment 的 startTime 到现在）>2h，
 * 且历史模式（weekly_patterns）显示该时段效率低
 * （存在 fragmented_time 模式覆盖当前小时，或 deepWorkHours 偏低），
 * 返回 rest_reminder 建议。
 */
function checkRestReminder(activity: CurrentActivity): Advice | null {
  if (!activity.startTime) return null

  const startMs = parseActivityStartTime(activity.startTime, activity.date)
  if (Number.isNaN(startMs)) return null
  const elapsedMs = Date.now() - startMs
  if (elapsedMs <= REST_THRESHOLD_MS) return null

  // 获取本周周级模式，判断当前时段是否效率低
  let weekly: WeeklyPatternResult | null = null
  try {
    const weekStart = getWeekStart()
    weekly = WeeklyPatternRepository.getByWeekStart(weekStart)
  } catch (e) {
    console.warn(
      '[ProactiveAdvisor] 获取周级模式失败:',
      e instanceof Error ? e.message : String(e)
    )
    return null
  }
  if (!weekly) return null

  const currentHour = new Date().getHours()
  let lowEfficiency = false

  // 检查是否存在覆盖当前小时的 fragmented_time 模式
  for (const pattern of weekly.patterns) {
    if (pattern.type !== 'fragmented_time') continue
    const meta = pattern.metadata as
      | { start?: string; end?: string; startHour?: number; endHour?: number }
      | undefined
    if (typeof meta?.startHour === 'number' && typeof meta?.endHour === 'number') {
      if (currentHour >= meta.startHour && currentHour <= meta.endHour) {
        lowEfficiency = true
        break
      }
    } else if (typeof meta?.start === 'string' && typeof meta?.end === 'string') {
      const startHour = parseInt(meta.start.split(':')[0], 10)
      const endHour = parseInt(meta.end.split(':')[0], 10)
      if (!Number.isNaN(startHour) && !Number.isNaN(endHour) && currentHour >= startHour && currentHour <= endHour) {
        lowEfficiency = true
        break
      }
    }
  }

  // 若无碎片化时段覆盖，检查深度工作时长是否偏低（日均 <1h）
  if (!lowEfficiency && weekly.trend.deepWorkHoursTrend.length > 0) {
    const avgDeepWork =
      weekly.trend.deepWorkHoursTrend.reduce((s, x) => s + x, 0) /
      weekly.trend.deepWorkHoursTrend.length
    if (avgDeepWork < 1) {
      lowEfficiency = true
    }
  }

  if (!lowEfficiency) return null

  const hours = Math.floor(elapsedMs / (60 * 60 * 1000))
  return {
    id: randomUUID(),
    type: 'rest_reminder',
    title: '建议休息',
    message: `你已连续工作 ${hours} 小时，该时段历史效率较低，建议休息一下，活动身体或闭目养神。`,
    action: '休息 5 分钟',
    confidence: 0.7,
    createdAt: nowIso()
  }
}

/**
 * 规则 3：专注模式建议。
 *
 * 获取今日与昨日的 daily_distill，若两者均呈现高切换次数（≥阈值）
 * 或碎片化时段（fragmentedPeriods 非空），返回 focus_suggestion 建议。
 */
function checkFocusSuggestion(): Advice | null {
  const today = todayString()
  const yesterday = addDays(today, -1)

  let todayDistill: ReturnType<typeof DailyDistillRepository.getByDate> = null
  let yesterdayDistill: ReturnType<typeof DailyDistillRepository.getByDate> = null
  try {
    todayDistill = DailyDistillRepository.getByDate(today)
    yesterdayDistill = DailyDistillRepository.getByDate(yesterday)
  } catch (e) {
    console.warn(
      '[ProactiveAdvisor] 获取日级理解失败:',
      e instanceof Error ? e.message : String(e)
    )
    return null
  }

  if (!todayDistill || !yesterdayDistill) return null

  const todayHighSwitch = todayDistill.patterns.switchCount >= HIGH_SWITCH_THRESHOLD
  const todayFragmented = todayDistill.patterns.fragmentedPeriods.length >= FRAGMENTED_PERIODS_MIN
  const yesterdayHighSwitch = yesterdayDistill.patterns.switchCount >= HIGH_SWITCH_THRESHOLD
  const yesterdayFragmented =
    yesterdayDistill.patterns.fragmentedPeriods.length >= FRAGMENTED_PERIODS_MIN

  // 今日与昨日均呈现高切换或碎片化 → 相似碎片化模式
  const todayChaotic = todayHighSwitch || todayFragmented
  const yesterdayChaotic = yesterdayHighSwitch || yesterdayFragmented
  if (!todayChaotic || !yesterdayChaotic) return null

  return {
    id: randomUUID(),
    type: 'focus_suggestion',
    title: '今天又在频繁切换，要试试专注模式吗',
    message: `今天已切换 ${todayDistill.patterns.switchCount} 次${
      todayFragmented ? `，存在 ${todayDistill.patterns.fragmentedPeriods.length} 个碎片化时段` : ''
    }，与昨日模式相似。要试试专注模式吗？`,
    action: '开启专注模式',
    confidence: 0.6,
    createdAt: nowIso()
  }
}

/**
 * 主动建议检查：基于当前活动、技能卡、历史模式生成建议。
 *
 * 处理流程：
 *  1. 获取当前活动（优先使用 currentActivity 参数，否则从今日最新 segment 推断）
 *  2. 依次尝试 3 条触发规则（skill_reference → rest_reminder → focus_suggestion）
 *  3. 对首个未被节流的建议：标记节流、通过 MascotNotifier 推送、返回
 *  4. 无建议或全部被节流时返回 null
 *
 * @param currentActivity 可选的当前活动信息（测试或外部注入时使用）
 * @returns 建议对象；无建议返回 null
 */
export async function checkAndAdvise(
  currentActivity?: CurrentActivity
): Promise<Advice | null> {
  const activity = currentActivity ?? getCurrentActivityFromDb()

  // 规则 1 & 2 依赖当前活动；规则 3 仅依赖 daily_distill
  const candidates: Advice[] = []

  if (activity) {
    const skillAdvice = checkSkillReference(activity)
    if (skillAdvice) candidates.push(skillAdvice)

    const restAdvice = checkRestReminder(activity)
    if (restAdvice) candidates.push(restAdvice)
  }

  const focusAdvice = checkFocusSuggestion()
  if (focusAdvice) candidates.push(focusAdvice)

  // 按优先级返回首个未被节流的建议
  for (const advice of candidates) {
    if (isThrottled(advice.type)) {
      continue
    }
    markShown(advice.type)
    // 通过桌面伙伴推送建议
    try {
      mascotNotifyAdvice(advice)
    } catch (e) {
      console.warn(
        '[ProactiveAdvisor] 推送建议失败:',
        e instanceof Error ? e.message : String(e)
      )
    }
    return advice
  }

  return null
}
