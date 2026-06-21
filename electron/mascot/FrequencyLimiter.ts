/**
 * FrequencyLimiter：桌面伙伴气泡频率限制器
 *
 * 实现 spec 的硬约束：
 *  - 每天最多弹出 2 次主动气泡
 *  - 10 分钟内连续 3 次关闭则当天停止所有主动气泡
 *  - 跨天自动重置
 *
 * 状态存内存，重启后当天计数重置（合理行为：重启视为新的一天开始）。
 */
import { SettingsStore } from '../db/SettingsStore'

/** 每天主动气泡最大次数 */
const DAILY_MAX_BUBBLES = 2

/** 关闭冷却窗口（毫秒）：10 分钟 */
const DISMISS_WINDOW_MS = 10 * 60 * 1000

/** 冷却窗口内最大关闭次数：3 次则当天停止 */
const DISMISS_THRESHOLD = 3

/** 频率限制统计 */
export interface FrequencyStats {
  /** 当天已展示次数 */
  todayShown: number
  /** 当前 10 分钟窗口内关闭次数 */
  todayClosedInWindow: number
  /** 当天是否已被停止 */
  blockedToday: boolean
  /** 当天日期标记 */
  date: string
}

/**
 * FrequencyLimiter：气泡频率限制器。
 *
 * 使用方法：
 *  1. tryShowBubble()：检查是否允许展示，允许则调用 onBubbleShown()
 *  2. onBubbleClosed()：用户关闭气泡时调用
 *  3. getStats()：获取当前统计
 *  4. resetDailyLimit()：手动重置（跨日自动检测）
 */
export class FrequencyLimiter {
  /** 当天已展示次数 */
  private dailyCount = 0
  /** 当天日期标记（YYYY-MM-DD），用于跨日重置 */
  private dailyDate = ''
  /** 最近的关闭时间戳列表（用于 10 分钟窗口判断） */
  private recentDismissals: number[] = []
  /** 当天是否已被关闭冷却停止 */
  private dailyStopped = false

  constructor() {
    this.dailyDate = this.todayString()
  }

  /**
   * 检查是否允许展示气泡。
   * 不递增计数——调用方在确认展示后应调用 onBubbleShown()。
   *
   * @returns true 表示允许展示；false 表示被频率限制拦截
   */
  tryShowBubble(): boolean {
    this.checkDailyReset()

    if (this.dailyStopped) {
      return false
    }

    if (this.dailyCount >= DAILY_MAX_BUBBLES) {
      return false
    }

    return true
  }

  /**
   * 气泡已展示时调用，递增当天计数。
   */
  onBubbleShown(): void {
    this.checkDailyReset()
    this.dailyCount++
  }

  /**
   * 用户关闭气泡时调用，记录关闭时间戳。
   * 若 10 分钟内关闭次数 ≥3，则当天停止主动气泡。
   */
  onBubbleClosed(): void {
    this.checkDailyReset()
    const now = Date.now()
    this.recentDismissals.push(now)
    // 清理过期记录（超过 10 分钟）
    this.recentDismissals = this.recentDismissals.filter(
      ts => now - ts < DISMISS_WINDOW_MS
    )
    if (this.recentDismissals.length >= DISMISS_THRESHOLD) {
      this.dailyStopped = true
      console.log(
        `[FrequencyLimiter] 10 分钟内关闭 ${this.recentDismissals.length} 次，当天停止主动气泡`
      )
    }
  }

  /** 重置当天频率限制（跨日时自动调用，也可手动调用） */
  resetDailyLimit(): void {
    this.dailyCount = 0
    this.recentDismissals = []
    this.dailyStopped = false
    this.dailyDate = this.todayString()
  }

  /** 获取当前频率限制统计 */
  getStats(): FrequencyStats {
    this.checkDailyReset()
    const now = Date.now()
    const validDismissals = this.recentDismissals.filter(
      ts => now - ts < DISMISS_WINDOW_MS
    )
    return {
      todayShown: this.dailyCount,
      todayClosedInWindow: validDismissals.length,
      blockedToday: this.dailyStopped,
      date: this.dailyDate
    }
  }

  /** 当天是否已被停止 */
  isBlockedToday(): boolean {
    this.checkDailyReset()
    return this.dailyStopped
  }

  /** 获取当前 Mascot 样式（从 SettingsStore 读取） */
  getMascotStyle(): string {
    try {
      return SettingsStore.getMascotStyle()
    } catch {
      return 'note'
    }
  }

  /** 跨日重置检测 */
  private checkDailyReset(): void {
    const today = this.todayString()
    if (today !== this.dailyDate) {
      this.resetDailyLimit()
    }
  }

  /** 今日日期字符串 YYYY-MM-DD */
  private todayString(): string {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
}
