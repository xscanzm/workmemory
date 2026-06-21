/**
 * WeeklyPatternDetector：周级模式发现（Task H2）。
 *
 * 在日级蒸馏（DailyDistillManager）基础上发现周级工作模式：
 *  - 深度工作时段（deep_work_time）：最常见的深度工作时段（连续小时块）
 *  - 碎片化时段（fragmented_time）：最常见的碎片化时段
 *  - 常用应用组合（app_combination）：经常一起出现的主题/应用
 *  - 效率趋势（efficiency_trend）：深度工作时长趋势（上升/下降/稳定）
 *  - 注意力热点（attention_hotspot）：注意力最集中的时段（加权峰值小时）
 *
 * 触发：每周一首次启动（由 main/index.ts 调用）
 *
 * 借鉴 EverOS Weekly Pattern 概念，将日级理解聚合为周级模式，
 * 支持跨日工作节奏识别与效率趋势分析。
 */
import type { DayDistillResult } from './DailyDistillManager'
import { DailyDistillRepository } from '../db/repositories/DailyDistillRepository'
import { WeeklyPatternRepository } from '../db/repositories/WeeklyPatternRepository'

/** 周级模式类型 */
export type WeeklyPatternType =
  | 'deep_work_time'
  | 'fragmented_time'
  | 'app_combination'
  | 'efficiency_trend'
  | 'attention_hotspot'

/** 单条周级模式 */
export interface WeeklyPattern {
  /** 模式类型 */
  type: WeeklyPatternType
  /** 模式描述（人类可读） */
  description: string
  /** 证据（来自哪些日期，YYYY-MM-DD） */
  evidence: string[]
  /** 置信度 0-1 */
  confidence: number
  /** 额外数据（如时段、应用列表） */
  metadata?: Record<string, unknown>
}

/** 周级趋势数据 */
export interface WeeklyPatternTrend {
  /** 每天深度工作时长（7 个元素，缺失天补 0） */
  deepWorkHoursTrend: number[]
  /** 每天切换次数（7 个元素，缺失天补 0） */
  switchCountTrend: number[]
  /** 每天主要活动（7 个元素，缺失天补空串） */
  dominantActivityTrend: string[]
}

/** 周级模式检测结果（含趋势） */
export interface WeeklyPatternResult {
  /** 周一日期（YYYY-MM-DD） */
  weekStart: string
  /** 检测到的周级模式 */
  patterns: WeeklyPattern[]
  /** 趋势数据 */
  trend: WeeklyPatternTrend
  /** ISO 创建时间戳 */
  createdAt: string
}

/** 一周天数 */
const WEEK_DAYS = 7
/** 深度工作时段最小连续小时数 */
const DEEP_WORK_MIN_HOURS = 2
/** 应用组合最小共现天数 */
const APP_COMBO_MIN_DAYS = 2
/** 效率趋势判定阈值（小时） */
const EFFICIENCY_TREND_THRESHOLD = 0.5

function nowIso(): string {
  return new Date().toISOString()
}

/** 在日期字符串（YYYY-MM-DD）上加减天数，返回新的日期字符串 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100))
}

/** 将小时数格式化为 "HH:00" */
function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/**
 * 检测深度工作时段：统计 7 天中各小时出现在 themes.hours 的天数，
 * 找出最常见的连续深度工作时段。
 *  - 阈值：>= 峰值小时天数的一半
 *  - 连续段长度 >= DEEP_WORK_MIN_HOURS 时返回时段；否则返回峰值单小时
 *  - confidence = 峰值小时天数 / 7
 */
function detectDeepWorkTime(distills: DayDistillResult[]): WeeklyPattern[] {
  // 统计每个小时出现在多少天的 themes 中
  const hourDayCount = new Map<number, Set<string>>()
  for (const d of distills) {
    const hours = new Set<number>()
    for (const theme of d.themes) {
      for (const h of theme.hours) {
        hours.add(h)
      }
    }
    for (const h of hours) {
      if (!hourDayCount.has(h)) hourDayCount.set(h, new Set())
      hourDayCount.get(h)!.add(d.date)
    }
  }
  if (hourDayCount.size === 0) return []

  // 找到出现天数最多的小时
  let maxCount = 0
  for (const set of hourDayCount.values()) {
    if (set.size > maxCount) maxCount = set.size
  }
  if (maxCount === 0) return []

  // 从高频小时向两侧扩展，找出连续高频时段
  const threshold = Math.max(1, Math.ceil(maxCount / 2))
  let bestStart = -1
  let bestEnd = -1
  let bestLength = 0
  for (let start = 0; start < 24; start++) {
    const startSet = hourDayCount.get(start)
    if (!startSet || startSet.size < threshold) continue
    let end = start
    while (end + 1 < 24) {
      const nextSet = hourDayCount.get(end + 1)
      if (!nextSet || nextSet.size < threshold) break
      end++
    }
    const length = end - start + 1
    if (length > bestLength) {
      bestLength = length
      bestStart = start
      bestEnd = end
    }
  }

  // 无足够长的连续时段时，取最高频单小时
  if (bestStart < 0 || bestLength < DEEP_WORK_MIN_HOURS) {
    let bestHour = -1
    let bestHourCount = 0
    for (const [h, set] of hourDayCount) {
      if (set.size > bestHourCount) {
        bestHourCount = set.size
        bestHour = h
      }
    }
    if (bestHour < 0) return []
    const evidence = Array.from(hourDayCount.get(bestHour)!).sort()
    return [
      {
        type: 'deep_work_time',
        description: `深度工作时段：${formatHour(bestHour)}（出现 ${bestHourCount}/${WEEK_DAYS} 天）`,
        evidence,
        confidence: clampConfidence(bestHourCount / WEEK_DAYS),
        metadata: { startHour: bestHour, endHour: bestHour, days: bestHourCount }
      }
    ]
  }

  // 证据：时段内所有小时出现日期的并集
  const evidenceSet = new Set<string>()
  for (let h = bestStart; h <= bestEnd; h++) {
    const days = hourDayCount.get(h)
    if (days) for (const date of days) evidenceSet.add(date)
  }
  return [
    {
      type: 'deep_work_time',
      description: `深度工作时段：${formatHour(bestStart)}-${formatHour(bestEnd + 1)}（出现 ${maxCount}/${WEEK_DAYS} 天）`,
      evidence: Array.from(evidenceSet).sort(),
      confidence: clampConfidence(maxCount / WEEK_DAYS),
      metadata: { startHour: bestStart, endHour: bestEnd, days: maxCount }
    }
  ]
}

/**
 * 检测碎片化时段：统计 daily_distills.patterns.fragmentedPeriods，
 * 找出最常见的碎片化时段（按 start 时间分组）。
 *  - confidence = 出现天数 / 7
 */
function detectFragmentedTime(distills: DayDistillResult[]): WeeklyPattern[] {
  // 按 start 分组，统计出现天数
  const periodDays = new Map<string, Set<string>>()
  const periodEnd = new Map<string, string>()
  for (const d of distills) {
    for (const p of d.patterns.fragmentedPeriods) {
      if (!periodDays.has(p.start)) {
        periodDays.set(p.start, new Set())
        periodEnd.set(p.start, p.end)
      }
      periodDays.get(p.start)!.add(d.date)
    }
  }
  if (periodDays.size === 0) return []

  // 找出出现天数最多的碎片化时段
  let bestStart = ''
  let bestEnd = ''
  let bestCount = 0
  for (const [start, days] of periodDays) {
    if (days.size > bestCount) {
      bestCount = days.size
      bestStart = start
      bestEnd = periodEnd.get(start) ?? ''
    }
  }
  if (bestCount === 0) return []

  const evidence = Array.from(periodDays.get(bestStart)!).sort()
  return [
    {
      type: 'fragmented_time',
      description: `每日 ${bestStart}-${bestEnd} 碎片化时段（出现 ${bestCount}/${WEEK_DAYS} 天）`,
      evidence,
      confidence: clampConfidence(bestCount / WEEK_DAYS),
      metadata: { start: bestStart, end: bestEnd, days: bestCount }
    }
  ]
}

/**
 * 检测常用应用组合：从 daily_distills.themes 中提取经常一起出现的主题。
 *  - 找出共现天数最多的主题对（>= APP_COMBO_MIN_DAYS 时返回组合）
 *  - 降级：返回出现天数最多的单个主题
 */
function detectAppCombination(distills: DayDistillResult[]): WeeklyPattern[] {
  // 收集每天的主题标题集合
  const dayTitles: { date: string; titles: Set<string> }[] = []
  const titleDays = new Map<string, Set<string>>()
  for (const d of distills) {
    const titles = new Set<string>()
    for (const theme of d.themes) {
      const title = theme.title.trim()
      if (title) {
        titles.add(title)
        if (!titleDays.has(title)) titleDays.set(title, new Set())
        titleDays.get(title)!.add(d.date)
      }
    }
    dayTitles.push({ date: d.date, titles })
  }

  // 找出共现天数最多的标题对
  let bestPair: [string, string] | null = null
  let bestPairCount = 0
  let bestPairDays: Set<string> = new Set()

  const allTitles = Array.from(titleDays.keys())
  for (let i = 0; i < allTitles.length; i++) {
    for (let j = i + 1; j < allTitles.length; j++) {
      const a = allTitles[i]
      const b = allTitles[j]
      const coOccurDays = new Set<string>()
      for (const { date, titles } of dayTitles) {
        if (titles.has(a) && titles.has(b)) {
          coOccurDays.add(date)
        }
      }
      if (coOccurDays.size > bestPairCount) {
        bestPairCount = coOccurDays.size
        bestPair = [a, b]
        bestPairDays = coOccurDays
      }
    }
  }

  // 有共现 >= APP_COMBO_MIN_DAYS 的组合时返回组合
  if (bestPair && bestPairCount >= APP_COMBO_MIN_DAYS) {
    return [
      {
        type: 'app_combination',
        description: `常用应用组合：${bestPair[0]} + ${bestPair[1]}（共现 ${bestPairCount}/${WEEK_DAYS} 天）`,
        evidence: Array.from(bestPairDays).sort(),
        confidence: clampConfidence(bestPairCount / WEEK_DAYS),
        metadata: { apps: bestPair, days: bestPairCount }
      }
    ]
  }

  // 降级：返回出现天数最多的单个主题
  let bestTitle = ''
  let bestTitleCount = 0
  let bestTitleDays: Set<string> = new Set()
  for (const [title, days] of titleDays) {
    if (days.size > bestTitleCount) {
      bestTitleCount = days.size
      bestTitle = title
      bestTitleDays = days
    }
  }
  if (bestTitleCount === 0) return []

  return [
    {
      type: 'app_combination',
      description: `常用应用：${bestTitle}（出现 ${bestTitleCount}/${WEEK_DAYS} 天）`,
      evidence: Array.from(bestTitleDays).sort(),
      confidence: clampConfidence(bestTitleCount / WEEK_DAYS),
      metadata: { apps: [bestTitle], days: bestTitleCount }
    }
  ]
}

/**
 * 检测效率趋势：基于 deepWorkHoursTrend 判断上升/下降/稳定。
 *  - 比较前半周与后半周的平均深度工作时长
 *  - delta > 阈值：上升；delta < -阈值：下降；否则稳定
 *  - confidence 基于差异幅度：0.5 + consistency * 0.5
 */
function detectEfficiencyTrend(
  distills: DayDistillResult[],
  deepWorkHoursTrend: number[]
): WeeklyPattern[] {
  // 只使用有 distill 的天
  const validHours: { date: string; hours: number }[] = []
  for (const d of distills) {
    validHours.push({ date: d.date, hours: d.patterns.deepWorkHours })
  }
  if (validHours.length < 2) return []

  // 比较前半段与后半段的平均深度工作时长
  const mid = Math.floor(validHours.length / 2)
  const firstHalf = validHours.slice(0, mid)
  const secondHalf = validHours.slice(mid)
  if (firstHalf.length === 0 || secondHalf.length === 0) return []

  const firstAvg = firstHalf.reduce((s, x) => s + x.hours, 0) / firstHalf.length
  const secondAvg = secondHalf.reduce((s, x) => s + x.hours, 0) / secondHalf.length

  let trend: 'rising' | 'declining' | 'stable'
  let trendText: string
  const delta = secondAvg - firstAvg

  if (delta > EFFICIENCY_TREND_THRESHOLD) {
    trend = 'rising'
    trendText = '上升'
  } else if (delta < -EFFICIENCY_TREND_THRESHOLD) {
    trend = 'declining'
    trendText = '下降'
  } else {
    trend = 'stable'
    trendText = '稳定'
  }

  // confidence 基于趋势差异幅度
  const maxAvg = Math.max(firstAvg, secondAvg, 0.1)
  const consistency = Math.min(1, Math.abs(delta) / maxAvg)
  const confidence = clampConfidence(0.5 + consistency * 0.5)

  const evidence = validHours.map((x) => x.date).sort()
  return [
    {
      type: 'efficiency_trend',
      description: `效率趋势：深度工作时长${trendText}（前半周 ${firstAvg.toFixed(1)}h → 后半周 ${secondAvg.toFixed(1)}h）`,
      evidence,
      confidence,
      metadata: {
        trend,
        firstHalfAvg: Math.round(firstAvg * 10) / 10,
        secondHalfAvg: Math.round(secondAvg * 10) / 10,
        delta: Math.round(delta * 10) / 10,
        deepWorkHoursTrend
      }
    }
  ]
}

/**
 * 检测注意力热点：找出注意力最集中的时段。
 *  - 统计每个小时在 themes 中出现的天数，按当天 deepWorkHours 加权
 *  - 加权权重最高的小时为注意力热点
 *  - confidence = 出现天数 / 7
 */
function detectAttentionHotspot(distills: DayDistillResult[]): WeeklyPattern[] {
  const hourWeight = new Map<number, number>()
  const hourDays = new Map<number, Set<string>>()
  for (const d of distills) {
    const hours = new Set<number>()
    for (const theme of d.themes) {
      for (const h of theme.hours) {
        hours.add(h)
      }
    }
    for (const h of hours) {
      hourWeight.set(h, (hourWeight.get(h) ?? 0) + d.patterns.deepWorkHours)
      if (!hourDays.has(h)) hourDays.set(h, new Set())
      hourDays.get(h)!.add(d.date)
    }
  }
  if (hourWeight.size === 0) return []

  // 找出加权权重最高的小时
  let bestHour = -1
  let bestWeight = -1
  for (const [h, w] of hourWeight) {
    if (w > bestWeight) {
      bestWeight = w
      bestHour = h
    }
  }
  if (bestHour < 0) return []

  const days = hourDays.get(bestHour)!.size
  const evidence = Array.from(hourDays.get(bestHour)!).sort()
  return [
    {
      type: 'attention_hotspot',
      description: `注意力热点：${formatHour(bestHour)}（${days}/${WEEK_DAYS} 天活跃，累计深度工作 ${bestWeight.toFixed(1)}h）`,
      evidence,
      confidence: clampConfidence(days / WEEK_DAYS),
      metadata: {
        hour: bestHour,
        days,
        totalDeepWorkHours: Math.round(bestWeight * 10) / 10
      }
    }
  ]
}

/**
 * 周级模式发现：聚合近 7 天 daily_distills，发现周级工作模式。
 *
 * 处理流程：
 *  1. 通过 DailyDistillRepository.getByDateRange 获取 weekStart 起 7 天的 daily_distills
 *  2. 计算 trend（每天 deepWorkHours/switchCount/dominantActivity，缺失天补 0/''）
 *  3. 检测 5 类模式（deep_work_time/fragmented_time/app_combination/efficiency_trend/attention_hotspot）
 *  4. 通过 WeeklyPatternRepository.upsert 持久化
 *
 * 某天没有 daily_distill 时跳过该天（不影响其他天的模式检测）；
 * 7 天都没有 daily_distill 时返回空 patterns。
 *
 * @param weekStart 周一日期字符串（YYYY-MM-DD）
 * @returns 周级模式数组
 */
export async function detectPatterns(weekStart: string): Promise<WeeklyPattern[]> {
  const endDate = addDays(weekStart, WEEK_DAYS - 1)
  const distills = DailyDistillRepository.getByDateRange(weekStart, endDate)

  // 构建 trend 数组（7 个元素，缺失天补 0/''）
  const distillByDate = new Map<string, DayDistillResult>()
  for (const d of distills) {
    distillByDate.set(d.date, d)
  }
  const trend: WeeklyPatternTrend = {
    deepWorkHoursTrend: [],
    switchCountTrend: [],
    dominantActivityTrend: []
  }
  for (let i = 0; i < WEEK_DAYS; i++) {
    const date = addDays(weekStart, i)
    const d = distillByDate.get(date)
    trend.deepWorkHoursTrend.push(d?.patterns.deepWorkHours ?? 0)
    trend.switchCountTrend.push(d?.patterns.switchCount ?? 0)
    trend.dominantActivityTrend.push(d?.patterns.dominantActivity ?? '')
  }

  const patterns: WeeklyPattern[] = []
  if (distills.length > 0) {
    patterns.push(...detectDeepWorkTime(distills))
    patterns.push(...detectFragmentedTime(distills))
    patterns.push(...detectAppCombination(distills))
    patterns.push(...detectEfficiencyTrend(distills, trend.deepWorkHoursTrend))
    patterns.push(...detectAttentionHotspot(distills))
  }

  const result: WeeklyPatternResult = {
    weekStart,
    patterns,
    trend,
    createdAt: nowIso()
  }

  try {
    WeeklyPatternRepository.upsert(result)
  } catch (e) {
    console.error(
      '[WeeklyPatternDetector] 周级模式持久化失败:',
      e instanceof Error ? e.message : String(e)
    )
  }

  return patterns
}
