/**
 * CaptureManager：编排层
 *
 * 整合 WindowWatcher + Screenshot + CaptureDecision + PrivacyGuard + IncognitoDetector + SegmentRepository。
 *
 * 职责：
 *  - 启动/停止/暂停/恢复全链路捕获
 *  - 监听 CaptureDecision 事件，持久化 Segment 到数据库
 *  - 监听 IncognitoDetector 事件，广播 IPC 通知渲染进程（桌面伙伴遮眼拉帘）
 *  - 管理截图持久化设置（saveScreenshots / retentionDays）
 *  - 单例导出 getCaptureManager()
 *
 * 硬约束：不监听键盘，仅编排窗口/截图/隐私模块。
 */
import { EventEmitter } from 'node:events'
import { powerMonitor } from 'electron'
import type { RecordingState } from '@/types'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { WindowWatcher } from './WindowWatcher'
import { Screenshot } from './Screenshot'
import { PrivacyGuard } from './PrivacyGuard'
import { CaptureDecision } from './CaptureDecision'
import type {
  SegmentCreatedPayload,
  SegmentMergedPayload,
  PrivacyPlaceholderPayload,
  StateChangePayload
} from './CaptureDecision'
import { getMainWindow } from '../main/window'

/** IPC 广播通道名：无痕模式检测到 / 清除 */
const IPC_INCOGNITO_DETECTED = 'mascot:incognito-detected'
const IPC_INCOGNITO_CLEARED = 'mascot:incognito-cleared'
/** 与 CaptureDecision 空闲阈值对齐：3 分钟无活动进入 idle */
const SYSTEM_IDLE_THRESHOLD_SECONDS = 3 * 60
/** 系统活动轮询间隔（毫秒） */
const ACTIVITY_POLL_INTERVAL_MS = 15000

/**
 * CaptureManager：捕获全链路编排单例。
 *
 * 事件：
 *  - 'state-change'：记录状态变化，携带 RecordingState
 *  - 'segment-created'：片段已创建并持久化，携带 WorkSegment
 *  - 'segment-merged'：片段已合并
 *  - 'privacy-placeholder'：隐私占位已创建
 */
export class CaptureManager extends EventEmitter {
  private watcher: WindowWatcher
  private screenshot: typeof Screenshot
  private privacyGuard: PrivacyGuard
  private decision: CaptureDecision
  private activityTimer: NodeJS.Timeout | null = null

  /** 基础状态（不含 privacy 覆盖） */
  private baseState: RecordingState = 'idle'
  /** 是否处于隐私模式（无痕窗口激活时） */
  private privacyMode = false

  /** 截图持久化设置 */
  private saveScreenshots = false
  private screenshotRetentionDays = 0
  /**
   * 是否允许活跃窗口截图失败后整屏降级。默认 false（隐私安全）。
   * 由 setAllowFullScreenshotFallback 同步自 SettingsStore，并下发到 CaptureDecision。
   */
  private allowFullScreenshotFallback = false

  constructor() {
    super()
    this.watcher = new WindowWatcher()
    this.screenshot = Screenshot
    this.privacyGuard = new PrivacyGuard()
    this.decision = new CaptureDecision(this.watcher, this.screenshot, this.privacyGuard)
    this.setupEventListeners()
  }

  // ===================== 捕获控制 =====================

  /** 启动全链路捕获 */
  startCapture(): boolean {
    this.privacyGuard.seedDefaultRules()
    this.watcher.start()
    this.decision.start()
    this.setBaseState('recording')
    this.startActivityMonitor()
    // 启动时清理过期截图
    if (this.screenshotRetentionDays > 0) {
      this.screenshot.cleanExpiredScreenshots(this.screenshotRetentionDays)
    }
    return true
  }

  /** 停止捕获 */
  stopCapture(): boolean {
    this.stopActivityMonitor()
    this.decision.stop()
    this.watcher.stop()
    this.setBaseState('idle')
    return true
  }

  /** 暂停捕获 */
  pauseCapture(): boolean {
    this.stopActivityMonitor()
    this.decision.pause()
    this.setBaseState('paused')
    return true
  }

  /** 恢复捕获 */
  resumeCapture(): boolean {
    this.decision.resume()
    this.setBaseState('recording')
    this.startActivityMonitor()
    this.handleUserBecameActive()
    return true
  }

  /** 获取当前记录状态（含 privacy 覆盖） */
  getRecordingState(): RecordingState {
    return this.privacyMode ? 'privacy' : this.baseState
  }

  // ===================== 模块访问 =====================

  getPrivacyGuard(): PrivacyGuard {
    return this.privacyGuard
  }

  getWindowWatcher(): WindowWatcher {
    return this.watcher
  }

  getCaptureDecision(): CaptureDecision {
    return this.decision
  }

  // ===================== 设置 =====================

  /** 设置是否持久保存截图 */
  setSaveScreenshots(enabled: boolean): void {
    this.saveScreenshots = enabled
  }

  /** 设置截图保留天数 */
  setScreenshotRetentionDays(days: number): void {
    this.screenshotRetentionDays = Math.max(0, Math.min(7, days))
  }

  /**
   * 设置是否允许活跃窗口截图失败后整屏降级，并立即下发到 CaptureDecision。
   * 默认 false：窗口截图失败即跳过，绝不自动整屏。
   */
  setAllowFullScreenshotFallback(enabled: boolean): void {
    this.allowFullScreenshotFallback = enabled
    this.decision.setAllowFullScreenshotFallback(enabled)
  }

  /** 查询当前是否允许整屏降级 */
  isFullScreenshotFallbackAllowed(): boolean {
    return this.allowFullScreenshotFallback
  }

  /** 立即清理过期截图 */
  cleanExpiredScreenshots(): void {
    if (this.screenshotRetentionDays > 0) {
      this.screenshot.cleanExpiredScreenshots(this.screenshotRetentionDays)
    }
  }

  // ===================== 事件监听 =====================

  private setupEventListeners(): void {
    // CaptureDecision → 持久化 Segment
    this.decision.on('segment-created', (payload: SegmentCreatedPayload) => {
      this.onSegmentCreated(payload)
    })

    this.decision.on('segment-merged', (payload: SegmentMergedPayload) => {
      SegmentRepository.update(payload.id, payload.patch)
      this.emit('segment-merged', payload)
    })

    this.decision.on('privacy-placeholder', (payload: PrivacyPlaceholderPayload) => {
      const segment = SegmentRepository.insert(payload.segment)
      this.emit('privacy-placeholder', segment)
    })

    this.decision.on('state-change', (payload: StateChangePayload) => {
      // CaptureDecision 的 idle 检测会 emit idle 状态
      if (payload.state === 'idle') {
        this.setBaseState('idle')
      }
    })

    // IncognitoDetector → 广播 IPC + 隐私模式
    const incognitoDetector = this.privacyGuard.getIncognitoDetector()
    incognitoDetector.watch(this.watcher)

    incognitoDetector.on('incognito-detected', () => {
      this.privacyMode = true
      this.broadcastState()
      this.broadcastToRenderer(IPC_INCOGNITO_DETECTED)
    })

    incognitoDetector.on('incognito-cleared', () => {
      this.privacyMode = false
      this.broadcastState()
      this.broadcastToRenderer(IPC_INCOGNITO_CLEARED)
    })
  }

  /** 片段创建回调：持久化到数据库，可选保存截图 */
  private onSegmentCreated(payload: SegmentCreatedPayload): void {
    const segment = SegmentRepository.insert(payload.segment)
    // 整屏降级元数据审计：若本次截图经由整屏降级获得，记录所截取的屏幕范围与 segment id
    if (payload.fallbackDisplayBounds) {
      const b = payload.fallbackDisplayBounds
      console.warn(
        `[CaptureManager] segment ${segment.id} 由整屏降级捕获，` +
          `displayBounds={x:${b.x},y:${b.y},width:${b.width},height:${b.height}} ` +
          `app=${segment.appName} date=${segment.date}`
      )
    }
    // 若开启截图保存，持久化截图到 userData/screenshots/
    if (this.saveScreenshots && payload.screenshotBuffer) {
      const persistentPath = this.screenshot.saveScreenshot(
        payload.screenshotBuffer,
        segment.date,
        segment.id
      )
      if (persistentPath) {
        const updated = SegmentRepository.update(segment.id, { screenshotPath: persistentPath })
        if (updated) {
          this.emit('segment-created', updated)
          return
        }
      }
    }
    this.emit('segment-created', segment)
  }

  // ===================== 内部工具 =====================

  private setBaseState(state: RecordingState): void {
    this.baseState = state
    this.broadcastState()
  }

  private startActivityMonitor(): void {
    if (this.activityTimer) return

    const poll = (): void => {
      if (this.baseState === 'paused') return

      try {
        const idleSeconds = powerMonitor.getSystemIdleTime()

        if (idleSeconds >= SYSTEM_IDLE_THRESHOLD_SECONDS) {
          if (!this.privacyMode && this.baseState !== 'idle') {
            this.setBaseState('idle')
          }
          return
        }

        this.handleUserBecameActive()
      } catch (e) {
        console.warn('[CaptureManager] 读取系统空闲时间失败:', e instanceof Error ? e.message : String(e))
      }
    }

    poll()
    this.activityTimer = setInterval(poll, ACTIVITY_POLL_INTERVAL_MS)
  }

  private stopActivityMonitor(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer)
      this.activityTimer = null
    }
  }

  private handleUserBecameActive(): void {
    if (this.baseState === 'paused') return

    const activeWindow = this.watcher.getActiveWindowSnapshot() ?? this.watcher.getLastWindowInfo()
    this.decision.wakeFromActivity(activeWindow)

    if (!this.privacyMode && this.baseState === 'idle') {
      this.setBaseState('recording')
    }
  }

  private broadcastState(): void {
    const state = this.getRecordingState()
    this.emit('state-change', state)
    // 同步通知渲染进程状态变化
    this.broadcastToRenderer('capture:state-changed', state)
  }

  private broadcastToRenderer(channel: string, ...args: unknown[]): void {
    try {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    } catch (e) {
      console.warn('[CaptureManager] 广播 IPC 失败:', e instanceof Error ? e.message : String(e))
    }
  }
}

// ===================== 单例 =====================

let managerInstance: CaptureManager | null = null

/** 获取 CaptureManager 单例 */
export function getCaptureManager(): CaptureManager {
  if (!managerInstance) {
    managerInstance = new CaptureManager()
  }
  return managerInstance
}

/** 重置单例（仅供测试） */
export function resetCaptureManager(): void {
  if (managerInstance) {
    managerInstance.stopCapture()
    managerInstance = null
  }
}
