/**
 * AnomalyDetector：异常检测器
 *
 * 功能：
 *  - detect(dateRange)：返回 Insight[]
 *    - 窗口切换次数异常：当日 segment 数 >50
 *    - 碎片化工作：<5min Episode 占比 >40%
 *    - 深度工作不足：单 Episode >30min 总时长 <2h
 *    - 长时间单一应用：单应用连续 >2h
 *    - 隐私窗口过多：隐私占位 >10 次
 *  - severity 分级：info / warning / danger
 */
import type { Episode, WorkSegment } from '@/types'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import type { DateRange } from './TimeAuditEngine'

/** 洞察严重级别 */
export type InsightSeverity = 'info' | 'warning' | 'danger'

/** 洞察类型 */
export type InsightType =
  | 'window_switch_storm'
  | 'fragmentation'
  | 'low_deep_work'
  | 'marathon_session'
  | 'privacy_heavy'

/** 洞察结果 */
export interface Insight {
  type: InsightType
  severity: InsightSeverity
  title: string
  message: string
  /** 改进建议 */
  suggestion: string
  /** 相关日期 YYYY-MM-DD */
  date: string
  /** 数值指标（如切换次数、碎片占比等） */
  metric?: number
}

/** 阈值常量 */
const WINDOW_SWITCH_THRESHOLD = 50
const WINDOW_SWITCH_DANGER_THRESHOLD = 100
const FRAGMENTATION_THRESHOLD = 0.4
const FRAGMENTATION_DANGER_THRESHOLD = 0.6
const DEEP_WORK_THRESHOLD_SEC = 2 * 60 * 60
const DEEP_WORK_EPISODE_MIN_SEC = 30 * 60
const MARATHON_THRESHOLD_SEC = 2 * 60 * 60
const PRIVACY_HEAVY_THRESHOLD = 10

/** Episode 时长 <5 分钟视为碎片 */
const FRAGMENT_EPISODE_SEC = 5 * 60

/**
 * AnomalyDetector：异常检测器。
 */
export class AnomalyDetector {
  /**
   * 检测指定日期范围内的异常。
   * 按日期逐日检测，返回所有 Insight 列表。
   */
  detect(dateRange: DateRange): Insight[] {
    const insights: Insight[] = []

    // 获取日期范围内的所有日期
    const dates = this.enumerateDates(dateRange.start, dateRange.end)

    for (const date of dates) {
      const episodes = EpisodeRepository.getByDate(date)
      const segments = SegmentRepository.getActiveByDate(date)
      const privateSegments = SegmentRepository.getPrivateByDate(date)

      // 1. 窗口切换次数异常
      const switchInsight = this.detectWindowSwitchStorm(date, segments)
      if (switchInsight) insights.push(switchInsight)

      // 2. 碎片化工作
      const fragInsight = this.detectFragmentation(date, episodes)
      if (fragInsight) insights.push(fragInsight)

      // 3. 深度工作不足
      const deepWorkInsight = this.detectLowDeepWork(date, episodes)
      if (deepWorkInsight) insights.push(deepWorkInsight)

      // 4. 长时间单一应用
      const marathonInsights = this.detectMarathonSessions(date, segments)
      insights.push(...marathonInsights)

      // 5. 隐私窗口过多
      const privacyInsight = this.detectPrivacyHeavy(date, privateSegments)
      if (privacyInsight) insights.push(privacyInsight)
    }

    return insights
  }

  // ===================== 各类异常检测 =====================

  /** 窗口切换次数异常：当日 segment 数 >50 */
  private detectWindowSwitchStorm(date: string, segments: WorkSegment[]): Insight | null {
    if (segments.length <= WINDOW_SWITCH_THRESHOLD) return null

    const severity: InsightSeverity =
      segments.length >= WINDOW_SWITCH_DANGER_THRESHOLD ? 'danger' : 'warning'

    return {
      type: 'window_switch_storm',
      severity,
      title: '窗口切换频繁',
      message: `今日窗口切换 ${segments.length} 次，建议合并碎片`,
      suggestion: '尝试使用虚拟桌面分组相关工作，减少频繁切换带来的注意力损耗',
      date,
      metric: segments.length
    }
  }

  /** 碎片化工作：<5min Episode 占比 >40% */
  private detectFragmentation(date: string, episodes: Episode[]): Insight | null {
    if (episodes.length === 0) return null

    let fragmentCount = 0
    for (const episode of episodes) {
      const duration = this.computeEpisodeDuration(episode)
      if (duration > 0 && duration < FRAGMENT_EPISODE_SEC) {
        fragmentCount++
      }
    }

    const ratio = fragmentCount / episodes.length
    if (ratio <= FRAGMENTATION_THRESHOLD) return null

    const severity: InsightSeverity =
      ratio >= FRAGMENTATION_DANGER_THRESHOLD ? 'danger' : 'warning'
    const percentage = Math.round(ratio * 100)

    return {
      type: 'fragmentation',
      severity,
      title: '工作碎片化',
      message: `今日 ${percentage}% 的工作片段不足 5 分钟，注意力过于分散`,
      suggestion: '尝试将同类任务集中处理，使用番茄工作法保持 25 分钟以上专注',
      date,
      metric: Math.round(ratio * 100)
    }
  }

  /** 深度工作不足：单 Episode >30min 总时长 <2h */
  private detectLowDeepWork(date: string, episodes: Episode[]): Insight | null {
    if (episodes.length === 0) return null

    let deepWorkSeconds = 0
    for (const episode of episodes) {
      const duration = this.computeEpisodeDuration(episode)
      if (duration >= DEEP_WORK_EPISODE_MIN_SEC) {
        deepWorkSeconds += duration
      }
    }

    if (deepWorkSeconds >= DEEP_WORK_THRESHOLD_SEC) return null

    const deepWorkMinutes = Math.round(deepWorkSeconds / 60)
    return {
      type: 'low_deep_work',
      severity: 'warning',
      title: '深度工作不足',
      message: `今日深度工作（>30 分钟连续片段）仅 ${deepWorkMinutes} 分钟，不足 2 小时`,
      suggestion: '关闭即时通讯通知，预留至少 90 分钟的连续时间块用于核心任务',
      date,
      metric: deepWorkSeconds
    }
  }

  /** 长时间单一应用：单应用连续 >2h */
  private detectMarathonSessions(date: string, segments: WorkSegment[]): Insight[] {
    const insights: Insight[] = []
    if (segments.length === 0) return insights

    // 按应用名聚合时长
    const appDurations = new Map<string, number>()
    for (const segment of segments) {
      const appName = segment.appName.trim() || segment.processName.trim() || '未知应用'
      appDurations.set(appName, (appDurations.get(appName) ?? 0) + segment.durationSeconds)
    }

    for (const [appName, seconds] of appDurations) {
      if (seconds <= MARATHON_THRESHOLD_SEC) continue
      const hours = Math.round((seconds / 3600) * 10) / 10
      insights.push({
        type: 'marathon_session',
        severity: 'info',
        title: '长时间连续工作',
        message: `在 ${appName} 连续工作 ${hours} 小时，建议休息`,
        suggestion: '每 45-60 分钟起身活动 5 分钟，避免久坐和用眼疲劳',
        date,
        metric: seconds
      })
    }

    return insights
  }

  /** 隐私窗口过多：隐私占位 >10 次 */
  private detectPrivacyHeavy(date: string, privateSegments: WorkSegment[]): Insight | null {
    if (privateSegments.length <= PRIVACY_HEAVY_THRESHOLD) return null

    return {
      type: 'privacy_heavy',
      severity: 'info',
      title: '隐私保护频繁触发',
      message: `今日隐私保护触发 ${privateSegments.length} 次，部分工作时段未被记录`,
      suggestion: '如需记录这些时段，可在设置中调整隐私规则或临时关闭隐私模式',
      date,
      metric: privateSegments.length
    }
  }

  // ===================== 内部工具 =====================

  /** 枚举日期范围内的所有日期（含两端） */
  private enumerateDates(startDate: string, endDate: string): string[] {
    const dates: string[] = []
    const start = new Date(startDate + 'T00:00:00')
    const end = new Date(endDate + 'T00:00:00')
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return []
    const current = new Date(start)
    while (current <= end) {
      dates.push(this.formatDate(current))
      current.setDate(current.getDate() + 1)
    }
    return dates
  }

  /** 计算 Episode 时长（秒） */
  private computeEpisodeDuration(episode: Episode): number {
    const start = this.timeToSeconds(episode.startTime)
    const end = this.timeToSeconds(episode.endTime)
    const diff = end - start
    return diff > 0 ? diff : 0
  }

  /** "HH:MM:SS" → 秒 */
  private timeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':')
    if (parts.length === 3) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)
    }
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60
    }
    return 0
  }

  /** Date → YYYY-MM-DD */
  private formatDate(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
}
