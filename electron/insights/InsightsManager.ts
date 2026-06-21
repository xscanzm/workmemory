/**
 * InsightsManager：洞察编排层单例
 *
 * 整合 TimeAuditEngine + AnomalyDetector + ReminderScheduler。
 *
 * 职责：
 *  - getInsights(dateRange)：返回 { timeAudit, anomalies, dailyTrend }
 *  - 暴露 IPC：insights:getAudit、insights:getAnomalies、insights:getTrend
 *  - 启动 ReminderScheduler
 *
 * 单例导出 getInsightsManager()。
 */
import { TimeAuditEngine } from './TimeAuditEngine'
import type { DateRange, TimeAuditResult, DailyTrendItem } from './TimeAuditEngine'
import { AnomalyDetector } from './AnomalyDetector'
import type { Insight } from './AnomalyDetector'
import { ReminderScheduler } from './ReminderScheduler'
import type { Reminder } from './ReminderScheduler'

/** 综合洞察结果 */
export interface InsightsResult {
  timeAudit: TimeAuditResult
  anomalies: Insight[]
  dailyTrend: DailyTrendItem[]
}

/** 默认趋势天数 */
const DEFAULT_TREND_DAYS = 7

/**
 * InsightsManager：洞察编排层。
 */
export class InsightsManager {
  private auditEngine: TimeAuditEngine
  private anomalyDetector: AnomalyDetector
  private reminderScheduler: ReminderScheduler
  private initialized = false

  constructor() {
    this.auditEngine = new TimeAuditEngine()
    this.anomalyDetector = new AnomalyDetector()
    this.reminderScheduler = new ReminderScheduler()
  }

  /**
   * 初始化：app ready 后调用。
   * 启动 ReminderScheduler 定时检查。
   */
  initialize(): void {
    if (this.initialized) return
    this.reminderScheduler.start()
    this.initialized = true
    console.log('[InsightsManager] 初始化完成，ReminderScheduler 已启动')
  }

  /**
   * 获取综合洞察：时间审计 + 异常检测 + 每日趋势。
   *
   * @param dateRange 日期范围（可选，默认今日）
   */
  getInsights(dateRange?: DateRange): InsightsResult {
    const range = dateRange ?? this.todayRange()
    const timeAudit = this.auditEngine.computeTimeAudit(range)
    const anomalies = this.anomalyDetector.detect(range)
    const dailyTrend = this.auditEngine.getDailyTrend(DEFAULT_TREND_DAYS)
    return { timeAudit, anomalies, dailyTrend }
  }

  /** 获取时间审计 */
  getAudit(dateRange?: DateRange): TimeAuditResult {
    const range = dateRange ?? this.todayRange()
    return this.auditEngine.computeTimeAudit(range)
  }

  /** 获取异常检测 */
  getAnomalies(dateRange?: DateRange): Insight[] {
    const range = dateRange ?? this.todayRange()
    return this.anomalyDetector.detect(range)
  }

  /** 获取每日趋势 */
  getTrend(days?: number): DailyTrendItem[] {
    return this.auditEngine.getDailyTrend(days ?? DEFAULT_TREND_DAYS)
  }

  /** 获取 ReminderScheduler 实例（供外部监听事件或推送洞察） */
  getReminderScheduler(): ReminderScheduler {
    return this.reminderScheduler
  }

  /**
   * 主动推送洞察气泡。
   * @returns true 表示推送成功
   */
  pushInsight(title: string, message: string, navigatePage?: string): boolean {
    return this.reminderScheduler.pushInsight(title, message, navigatePage)
  }

  /** 监听提醒到期事件 */
  onReminderDue(callback: (reminder: Reminder) => void): void {
    this.reminderScheduler.on('reminder-due', callback)
  }

  /** 停止管理器 */
  stop(): void {
    this.reminderScheduler.stop()
    this.initialized = false
  }

  // ===================== 内部工具 =====================

  /** 获取今日日期范围 */
  private todayRange(): DateRange {
    const today = this.todayString()
    return { start: today, end: today }
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

// ===================== 单例 =====================

let managerInstance: InsightsManager | null = null

/** 获取 InsightsManager 单例 */
export function getInsightsManager(): InsightsManager {
  if (!managerInstance) {
    managerInstance = new InsightsManager()
  }
  return managerInstance
}

/** 重置单例（仅供测试） */
export function resetInsightsManager(): void {
  if (managerInstance) {
    managerInstance.stop()
    managerInstance = null
  }
}
