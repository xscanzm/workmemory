/**
 * ReminderScheduler：复盘建议调度器
 *
 * 功能：
 *  - 下班时段检测：当前时间在 18:00-20:00（可配置）且当日有 Episode → 触发"下班复盘"提醒
 *  - 周五复盘：每周五 17:00 触发"本周复盘"提醒
 *  - 主动洞察推送：通过 MascotNotifier 推送气泡（受频率限制）
 *  - start()/stop()：启动定时检查（每 30 分钟检查一次下班/周五条件）
 *  - emit 事件：'reminder-due'(reminder)
 *
 * 依赖注入 IMascotNotifier，阶段 10 注入真实 MascotManager。
 */
import { EventEmitter } from 'node:events'
import type { IMascotNotifier, MascotBubblePayload } from '../mascot/MascotNotifier'
import { getMascotNotifier } from '../mascot/MascotNotifier'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'

/** 提醒类型 */
export type ReminderType = 'offwork_review' | 'weekly_review' | 'insight'

/** 提醒 */
export interface Reminder {
  type: ReminderType
  title: string
  message: string
  /** 跳转目标页面 */
  navigatePage?: string
  /** 触发时间 ISO */
  triggeredAt: string
}

/** 调度器配置 */
export interface ReminderSchedulerConfig {
  /** 下班复盘开始小时（默认 18） */
  offworkStartHour: number
  /** 下班复盘结束小时（默认 20） */
  offworkEndHour: number
  /** 周五复盘小时（默认 17） */
  weeklyReviewHour: number
  /** 检查间隔（毫秒，默认 30 分钟） */
  checkIntervalMs: number
}

/** 默认配置 */
const DEFAULT_CONFIG: ReminderSchedulerConfig = {
  offworkStartHour: 18,
  offworkEndHour: 20,
  weeklyReviewHour: 17,
  checkIntervalMs: 30 * 60 * 1000
}

/**
 * ReminderScheduler：复盘建议调度器。
 *
 * 事件：
 *  - 'reminder-due'(reminder)：提醒到期
 */
export class ReminderScheduler extends EventEmitter {
  private config: ReminderSchedulerConfig
  private notifier: IMascotNotifier
  private timer: NodeJS.Timeout | null = null
  private initialized = false

  /** 当天已触发的提醒类型（避免重复触发） */
  private triggeredToday: Set<ReminderType> = new Set()
  /** 当天日期标记（用于跨日重置） */
  private currentDate = ''

  constructor(config?: Partial<ReminderSchedulerConfig>, notifier?: IMascotNotifier) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.notifier = notifier ?? getMascotNotifier()
    this.currentDate = this.todayString()
  }

  /**
   * 启动定时检查。
   * 每 30 分钟检查一次下班/周五条件。
   */
  start(): void {
    if (this.initialized) return
    this.initialized = true

    this.timer = setInterval(() => {
      this.checkConditions()
    }, this.config.checkIntervalMs)

    console.log('[ReminderScheduler] 已启动，检查间隔', this.config.checkIntervalMs, 'ms')
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.initialized = false
    this.triggeredToday.clear()
  }

  /**
   * 立即检查条件（供外部主动调用）。
   * 检查下班时段、周五复盘条件，满足则触发提醒。
   */
  checkConditions(): void {
    this.checkDailyReset()

    const now = new Date()
    const hour = now.getHours()
    const dayOfWeek = now.getDay() // 0=周日, 5=周五

    // 周五复盘：周五且到达指定小时
    if (
      dayOfWeek === 5 &&
      hour >= this.config.weeklyReviewHour &&
      !this.triggeredToday.has('weekly_review')
    ) {
      if (this.hasEpisodesThisWeek()) {
        this.triggerWeeklyReview()
      }
    }

    // 下班复盘：下班时段且当日有 Episode
    if (
      hour >= this.config.offworkStartHour &&
      hour < this.config.offworkEndHour &&
      !this.triggeredToday.has('offwork_review')
    ) {
      if (this.hasEpisodesToday()) {
        this.triggerOffworkReview()
      }
    }
  }

  /**
   * 主动推送洞察气泡（受 Mascot 频率限制）。
   * @returns true 表示推送成功，false 表示被频率限制拦截
   */
  pushInsight(title: string, message: string, navigatePage = 'insights'): boolean {
    const payload: MascotBubblePayload = {
      type: 'insight',
      title,
      message,
      action: { type: 'navigate', page: navigatePage }
    }
    const shown = this.notifier.tryShowBubble(payload)
    if (shown) {
      const reminder: Reminder = {
        type: 'insight',
        title,
        message,
        navigatePage,
        triggeredAt: new Date().toISOString()
      }
      this.emit('reminder-due', reminder)
    }
    return shown
  }

  /** 通知气泡被用户关闭（用于频率限制器记录） */
  notifyBubbleDismissed(): void {
    this.notifier.onBubbleDismissed()
  }

  /** 更新配置 */
  updateConfig(patch: Partial<ReminderSchedulerConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  /** 注入新的 MascotNotifier（阶段 10 替换真实实现） */
  setNotifier(notifier: IMascotNotifier): void {
    this.notifier = notifier
  }

  // ===================== 内部方法 =====================

  /** 触发下班复盘提醒 */
  private triggerOffworkReview(): void {
    const reminder: Reminder = {
      type: 'offwork_review',
      title: '下班复盘时间',
      message: '今天的工作已告一段落，花 5 分钟回顾今日成果，整理待办事项',
      navigatePage: 'today',
      triggeredAt: new Date().toISOString()
    }
    this.triggeredToday.add('offwork_review')
    this.emit('reminder-due', reminder)

    const payload: MascotBubblePayload = {
      type: 'reminder',
      title: reminder.title,
      message: reminder.message,
      action: { type: 'navigate', page: reminder.navigatePage ?? 'today' }
    }
    this.notifier.tryShowBubble(payload)

    console.log('[ReminderScheduler] 触发下班复盘提醒')
  }

  /** 触发周五复盘提醒 */
  private triggerWeeklyReview(): void {
    const reminder: Reminder = {
      type: 'weekly_review',
      title: '本周复盘',
      message: '一周工作即将结束，回顾本周进展，规划下周重点',
      navigatePage: 'reports',
      triggeredAt: new Date().toISOString()
    }
    this.triggeredToday.add('weekly_review')
    this.emit('reminder-due', reminder)

    const payload: MascotBubblePayload = {
      type: 'reminder',
      title: reminder.title,
      message: reminder.message,
      action: { type: 'navigate', page: reminder.navigatePage ?? 'reports' }
    }
    this.notifier.tryShowBubble(payload)

    console.log('[ReminderScheduler] 触发周五复盘提醒')
  }

  /** 检查今日是否有 Episode */
  private hasEpisodesToday(): boolean {
    const today = this.todayString()
    const episodes = EpisodeRepository.getByDate(today)
    return episodes.length > 0
  }

  /** 检查本周是否有 Episode */
  private hasEpisodesThisWeek(): boolean {
    const episodes = EpisodeRepository.getRecent(7)
    return episodes.length > 0
  }

  /** 跨日重置 */
  private checkDailyReset(): void {
    const today = this.todayString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.triggeredToday.clear()
      this.notifier.resetDailyLimit()
    }
  }

  /** 今日日期字符串 */
  private todayString(): string {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
}
