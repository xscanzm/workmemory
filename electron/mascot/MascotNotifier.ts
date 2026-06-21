/**
 * MascotNotifier：桌面伙伴通知接口 + 安全实现
 *
 * 依赖倒置：ReminderScheduler 等模块依赖 IMascotNotifier 接口，
 * 阶段 10 实现 MascotManager 后注入真实实例。
 *
 * 当前 SafeMascotNotifier 实现：
 *  - 实现完整频率限制逻辑（每天最多 2 次；10 分钟内 3 次关闭则当天停止）
 *  - 不弹窗，仅日志记录（Null Object 模式，非 mock）
 *  - 阶段 10 替换为真实 MascotManager 后，频率限制由真实实现接管
 */

/** 气泡动作（点击气泡后跳转目标） */
export interface MascotBubbleAction {
  type: 'navigate'
  page: string
}

/** 气泡类型 */
export type MascotBubbleType = 'insight' | 'reminder' | 'info'

/** 气泡 payload */
export interface MascotBubblePayload {
  type: MascotBubbleType
  title: string
  message: string
  action?: MascotBubbleAction
}

/**
 * 桌面伙伴通知接口。
 * 阶段 10 的 MascotManager 须实现此接口并注入到 ReminderScheduler。
 */
export interface IMascotNotifier {
  /**
   * 尝试展示气泡。受频率限制约束。
   * @returns true 表示已展示（或日志记录）；false 表示被频率限制拦截
   */
  tryShowBubble(payload: MascotBubblePayload): boolean

  /**
   * 用户关闭气泡时调用。
   * 用于频率限制器记录关闭次数（10 分钟内 3 次关闭则当天停止）。
   */
  onBubbleDismissed(): void

  /** 重置当天频率限制（跨日时调用） */
  resetDailyLimit(): void
}

/** 每天主动气泡最大次数 */
const DAILY_MAX_BUBBLES = 2
/** 关闭冷却窗口（毫秒）：10 分钟 */
const DISMISS_WINDOW_MS = 10 * 60 * 1000
/** 冷却窗口内最大关闭次数：3 次则当天停止 */
const DISMISS_THRESHOLD = 3

/**
 * SafeMascotNotifier：安全实现（仅日志，不弹窗）。
 *
 * 实现完整频率限制逻辑，确保阶段 10 替换前的行为正确性。
 * 真实 MascotManager 实现后，可复用此频率限制逻辑或自行实现。
 */
export class SafeMascotNotifier implements IMascotNotifier {
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

  tryShowBubble(payload: MascotBubblePayload): boolean {
    this.checkDailyReset()

    if (this.dailyStopped) {
      console.log(
        `[MascotNotifier] 气泡被频率限制拦截（当天关闭冷却）：${payload.title}`
      )
      return false
    }

    if (this.dailyCount >= DAILY_MAX_BUBBLES) {
      console.log(
        `[MascotNotifier] 气泡被频率限制拦截（当天已达上限 ${DAILY_MAX_BUBBLES} 次）：${payload.title}`
      )
      return false
    }

    this.dailyCount++
    console.log(
      `[MascotNotifier] 展示气泡 [${payload.type}] "${payload.title}": ${payload.message}` +
        (payload.action ? ` → 跳转 ${payload.action.page}` : '')
    )
    return true
  }

  onBubbleDismissed(): void {
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
        `[MascotNotifier] 10 分钟内关闭 ${this.recentDismissals.length} 次，当天停止主动气泡`
      )
    }
  }

  resetDailyLimit(): void {
    this.dailyCount = 0
    this.recentDismissals = []
    this.dailyStopped = false
    this.dailyDate = this.todayString()
  }

  /** 跨日重置检测 */
  private checkDailyReset(): void {
    const today = this.todayString()
    if (today !== this.dailyDate) {
      this.resetDailyLimit()
    }
  }

  private todayString(): string {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
}

/** 单例：默认使用 SafeMascotNotifier，阶段 10 可注入真实实现 */
let notifierInstance: IMascotNotifier | null = null

/** 获取当前 MascotNotifier 单例（默认 SafeMascotNotifier） */
export function getMascotNotifier(): IMascotNotifier {
  if (!notifierInstance) {
    notifierInstance = new SafeMascotNotifier()
  }
  return notifierInstance
}

/** 注入真实 MascotNotifier（阶段 10 调用） */
export function setMascotNotifier(notifier: IMascotNotifier): void {
  notifierInstance = notifier
}
