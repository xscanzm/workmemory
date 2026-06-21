/**
 * CaptureDecision：截图决策核心
 *
 * 接收 WindowWatcher 事件 + PrivacyGuard 判断 + ImageHash 比对，决定：
 *  合并至前一片段 / 新建 WorkSegment / 跳过 / 生成隐私占位
 *
 * 截图频率约束：
 *  - 快速切换节流：2 秒内频繁切换暂缓，等窗口稳定 3 秒后再截取最终画面（debounce）
 *  - 静止阅读降频：仅 scroll-stop 事件触发截图（标题稳定 2 秒推断）
 *  - 空闲检测：3 分钟无窗口变化标记 idle，停止队列；重新检测到变化恢复
 *
 * 流程：
 *  事件 → PrivacyGuard.check(windowInfo) →
 *    skip → 跳过
 *    placeholder → 生成隐私占位 Segment（is_private=1, source_status='private'）
 *    allow → 截图 → calculateImageHash → 与前一截图 isSimilar →
 *      相似 → 合并（更新前一片段 end_time、duration）
 *      不相似 → 新建 Segment（source_status='pending'，交给 OCR 队列）
 *
 * 硬约束：不监听键盘，仅处理窗口信息。
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { WorkSegment, RecordingState } from '@/types'
import { WindowWatcher } from './WindowWatcher'
import type { WindowInfo } from './WindowWatcher'
import { Screenshot } from './Screenshot'
import type { ScreenshotResult, ScreenshotSuccess, DisplayBounds } from './Screenshot'
import { PrivacyGuard } from './PrivacyGuard'
import type { PrivacyCheckResult } from './PrivacyGuard'

/** 截图决策事件 payload */
export interface SegmentCreatedPayload {
  segment: WorkSegment
  screenshotBuffer: Buffer | null
  /**
   * 整屏降级元数据：仅当本次截图经由"整屏降级"获得时携带，
   * 包含所截取的屏幕范围（display bounds），供 CaptureManager 写入日志/元数据审计。
   */
  fallbackDisplayBounds?: DisplayBounds
}

function boundsToSegmentBounds(bounds: DisplayBounds | undefined): WorkSegment['displayBounds'] {
  if (!bounds) return null
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

export interface SegmentMergedPayload {
  id: string
  patch: Partial<WorkSegment>
}

export interface PrivacyPlaceholderPayload {
  segment: WorkSegment
}

export interface StateChangePayload {
  state: RecordingState
}

/** debounce 等待时长（毫秒）：窗口稳定 3 秒后截取 */
const DEBOUNCE_MS = 3000
/** 快速切换判定阈值（毫秒）：2 秒内事件视为频繁切换 */
const FAST_SWITCH_MS = 2000
/** 空闲检测时长（毫秒）：3 分钟无事件标记 idle */
const IDLE_MS = 3 * 60 * 1000

/**
 * CaptureDecision：截图决策核心。
 *
 * 事件：
 *  - 'segment-created'：新建片段，携带 SegmentCreatedPayload
 *  - 'segment-merged'：合并至前一片段，携带 SegmentMergedPayload
 *  - 'privacy-placeholder'：隐私占位片段，携带 PrivacyPlaceholderPayload
 *  - 'state-change'：状态变化，携带 StateChangePayload
 */
export class CaptureDecision extends EventEmitter {
  private watcher: WindowWatcher
  private screenshot: typeof Screenshot
  private privacyGuard: PrivacyGuard
  private state: RecordingState = 'idle'

  /**
   * 是否允许活跃窗口截图失败后整屏降级。默认 false（隐私安全）：
   * false → 窗口截图失败即跳过该次捕获（记 screenshot_failed 日志，不存图）；
   * true  → 窗口截图失败后回退到 captureScreen()，并记录所截取的屏幕范围。
   * 由 CaptureManager 经 setAllowFullScreenshotFallback 同步自 SettingsStore。
   */
  private allowFullScreenshotFallback = false

  // 事件绑定引用（用于解绑）
  private boundHandlers: Array<{ event: string; fn: (info: WindowInfo) => void }> = []

  // 定时器
  private debounceTimer: NodeJS.Timeout | null = null
  private idleTimer: NodeJS.Timeout | null = null

  // 当前片段追踪
  private currentSegmentId: string | null = null
  private currentSegmentStart: Date | null = null
  private currentSegmentIsPrivate = false
  private currentSegmentApp = ''
  private lastImageHash = ''
  private lastEventTime = 0
  private pendingWindowInfo: WindowInfo | null = null

  constructor(watcher: WindowWatcher, screenshot: typeof Screenshot, privacyGuard: PrivacyGuard) {
    super()
    this.watcher = watcher
    this.screenshot = screenshot
    this.privacyGuard = privacyGuard
  }

  /** 启动决策引擎 */
  start(): void {
    this.subscribeWatcher()
    this.state = 'recording'
    this.emit('state-change', { state: this.state })
  }

  /** 停止决策引擎 */
  stop(): void {
    this.unsubscribeWatcher()
    this.clearTimers()
    this.resetCurrentSegment()
    this.state = 'idle'
    this.emit('state-change', { state: this.state })
  }

  /** 暂停（不退出订阅，但停止处理事件） */
  pause(): void {
    this.clearDebounceTimer()
    this.state = 'paused'
    this.emit('state-change', { state: this.state })
  }

  /** 恢复处理 */
  resume(): void {
    this.state = 'recording'
    this.emit('state-change', { state: this.state })
  }

  /** 获取当前状态 */
  getState(): RecordingState {
    return this.state
  }

  /**
   * 外部活动唤醒。
   * 用于系统检测到用户重新活跃时，将 idle 恢复为 recording，
   * 并基于当前活动窗口重新走一遍常规捕获节流链路。
   */
  wakeFromActivity(info?: WindowInfo | null): void {
    if (this.state === 'paused') return

    this.resetIdleTimer()

    if (this.state === 'idle') {
      this.state = 'recording'
      this.emit('state-change', { state: this.state })
    }

    if (info) {
      this.handleEvent(info)
    }
  }

  /**
   * 设置是否允许整屏降级（由 CaptureManager 同步自 SettingsStore.allowFullScreenshotFallback）。
   * 默认 false：窗口截图失败即跳过，绝不自动整屏。
   */
  setAllowFullScreenshotFallback(enabled: boolean): void {
    this.allowFullScreenshotFallback = enabled
  }

  /** 查询当前是否允许整屏降级 */
  isFullScreenshotFallbackAllowed(): boolean {
    return this.allowFullScreenshotFallback
  }

  // ===================== 事件订阅 =====================

  private subscribeWatcher(): void {
    const events: Array<{ event: string; fn: (info: WindowInfo) => void }> = [
      { event: 'window-change', fn: (info) => this.handleEvent(info) },
      { event: 'title-change', fn: (info) => this.handleEvent(info) },
      { event: 'scroll-stop', fn: (info) => this.handleEvent(info) },
      { event: 'keyframe', fn: (info) => this.handleEvent(info) }
    ]
    for (const { event, fn } of events) {
      this.watcher.on(event, fn)
      this.boundHandlers.push({ event, fn })
    }
  }

  private unsubscribeWatcher(): void {
    for (const { event, fn } of this.boundHandlers) {
      this.watcher.removeListener(event, fn)
    }
    this.boundHandlers = []
  }

  // ===================== 事件处理 =====================

  private handleEvent(info: WindowInfo): void {
    if (this.state === 'paused') return

    // 重置空闲计时
    this.resetIdleTimer()

    // 从 idle 恢复到 recording
    if (this.state === 'idle') {
      this.state = 'recording'
      this.emit('state-change', { state: this.state })
    }

    // 隐私模式检查（无痕窗口）
    if (this.privacyGuard.isPrivacyMode()) {
      // 隐私模式下不截图，但仍记录窗口变化用于状态联动
      return
    }

    const now = Date.now()
    const isFastSwitch = now - this.lastEventTime < FAST_SWITCH_MS
    this.lastEventTime = now
    this.pendingWindowInfo = info

    if (isFastSwitch) {
      // 快速切换：暂缓截图，debounce 会等待稳定
    }

    // debounce：每次事件重置 3 秒定时器，等窗口稳定后截取
    this.resetDebounceTimer()
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      // 3 分钟无事件，标记 idle。保留当前片段上下文，避免短暂无窗口事件后恢复时断段。
      this.state = 'idle'
      this.pendingWindowInfo = null
      this.clearDebounceTimer()
      this.emit('state-change', { state: this.state })
      this.idleTimer = null
    }, IDLE_MS)
  }

  private resetDebounceTimer(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      if (this.pendingWindowInfo) {
        const info = this.pendingWindowInfo
        this.pendingWindowInfo = null
        void this.executeCapture(info)
      }
    }, DEBOUNCE_MS)
  }

  // ===================== 截图执行 =====================

  private async executeCapture(info: WindowInfo): Promise<void> {
    if (this.state === 'paused' || this.state === 'idle') return

    // 隐私检查
    const checkResult: PrivacyCheckResult = this.privacyGuard.check(info)
    if (checkResult.action === 'skip') {
      return
    }
    if (checkResult.action === 'placeholder') {
      this.handlePlaceholder(info)
      return
    }

    // allow → 截图
    await this.handleCapture(info)
  }

  /** 处理隐私占位 */
  private handlePlaceholder(info: WindowInfo): void {
    const now = new Date()
    const sameApp = this.currentSegmentIsPrivate && this.currentSegmentApp === info.appName

    if (sameApp && this.currentSegmentId && this.currentSegmentStart) {
      // 合并到现有隐私占位：延长结束时间，更新标题时间范围
      const endTimeStr = this.formatTimeShort(now)
      const startTimeStr = this.formatTimeShort(this.currentSegmentStart)
      const durationSeconds = Math.floor((now.getTime() - this.currentSegmentStart.getTime()) / 1000)
      const patch: Partial<WorkSegment> = {
        endTime: this.formatTime(now),
        durationSeconds,
        windowTitle: `[${startTimeStr} - ${endTimeStr} 隐私窗口被保护]`
      }
      this.emit('segment-merged', { id: this.currentSegmentId, patch })
    } else {
      // 新建隐私占位片段
      const startTimeStr = this.formatTimeShort(now)
      const segment = this.createPrivacySegment(info, now, startTimeStr)
      this.currentSegmentId = segment.id
      this.currentSegmentStart = now
      this.currentSegmentIsPrivate = true
      this.currentSegmentApp = info.appName
      this.lastImageHash = ''
      this.emit('privacy-placeholder', { segment })
    }
  }

  /** 处理截图捕获 */
  private async handleCapture(info: WindowInfo): Promise<void> {
    // 截取活跃窗口画面（找不到目标窗口返回 failed，绝不自动整屏）
    const shot: ScreenshotResult = await this.screenshot.captureActiveWindow(info.hwnd)

    let finalShot: ScreenshotSuccess | null = null
    let fallbackDisplayBounds: DisplayBounds | undefined

    if (shot.status === 'ok') {
      finalShot = shot
    } else {
      // 窗口截图失败：默认跳过该次捕获，绝不自动整屏降级
      console.warn(
        `[CaptureDecision] screenshot_failed reason=${shot.reason}` +
          `${shot.error ? ` error=${shot.error}` : ''}` +
          ` hwnd=${info.hwnd} app=${info.appName} title=${info.windowTitle}`
      )

      // 仅当用户显式开启整屏降级时，才回退到整屏截图
      if (this.allowFullScreenshotFallback) {
        const screenShot: ScreenshotResult = await this.screenshot.captureScreen()
        if (screenShot.status === 'ok') {
          finalShot = screenShot
          fallbackDisplayBounds = screenShot.displayBounds
          const b = screenShot.displayBounds
          console.warn(
            `[CaptureDecision] 整屏降级已启用，截取整屏作为替代。` +
              `displayBounds={x:${b?.x ?? 0},y:${b?.y ?? 0},width:${b?.width ?? 0},height:${b?.height ?? 0}}` +
              ` app=${info.appName} title=${info.windowTitle}`
          )
        } else {
          console.warn(
            `[CaptureDecision] 整屏降级亦失败 reason=${screenShot.reason}` +
              `${screenShot.error ? ` error=${screenShot.error}` : ''}，跳过该次捕获`
          )
        }
      }
    }

    if (!finalShot) {
      // 截图失败（且未启用/未成功整屏降级）：跳过该次捕获，不创建 segment
      return
    }

    // 计算图像哈希
    const hash = this.screenshot.calculateImageHash(finalShot.buffer)
    if (!hash) return

    // 保存临时截图
    const tempPath = this.screenshot.saveTempScreenshot(finalShot.buffer)

    const now = new Date()
    const sameApp = !this.currentSegmentIsPrivate && this.currentSegmentApp === info.appName
    const isSimilar = sameApp && this.lastImageHash && this.screenshot.isSimilar(hash, this.lastImageHash)

    if (isSimilar && this.currentSegmentId && this.currentSegmentStart) {
      // 合并到前一片段：更新结束时间和持续时间
      const durationSeconds = Math.floor((now.getTime() - this.currentSegmentStart.getTime()) / 1000)
      const patch: Partial<WorkSegment> = {
        endTime: this.formatTime(now),
        durationSeconds
      }
      this.emit('segment-merged', { id: this.currentSegmentId, patch })
      // 合并后删除临时截图（不需要 OCR 重复内容）
      this.screenshot.deleteTempScreenshot(tempPath)
    } else {
      // 新建片段
      const segment = this.createSegment(info, now, hash, tempPath, fallbackDisplayBounds)
      this.currentSegmentId = segment.id
      this.currentSegmentStart = now
      this.currentSegmentIsPrivate = false
      this.currentSegmentApp = info.appName
      this.lastImageHash = hash
      this.emit('segment-created', {
        segment,
        screenshotBuffer: finalShot.buffer,
        fallbackDisplayBounds
      })
      if (fallbackDisplayBounds) {
        console.warn(
          `[CaptureDecision] segment ${segment.id} 经整屏降级捕获，` +
            `displayBounds={x:${fallbackDisplayBounds.x},y:${fallbackDisplayBounds.y},width:${fallbackDisplayBounds.width},height:${fallbackDisplayBounds.height}}`
        )
      }
    }
  }

  // ===================== Segment 构造 =====================

  /** 创建普通片段（source_status='pending'，待 OCR） */
  private createSegment(
    info: WindowInfo,
    now: Date,
    hash: string,
    screenshotPath: string,
    fallbackDisplayBounds?: DisplayBounds
  ): WorkSegment {
    const timeStr = this.formatTime(now)
    return {
      id: randomUUID(),
      date: this.formatDate(now),
      startTime: timeStr,
      endTime: timeStr,
      durationSeconds: 0,
      appName: info.appName,
      processName: info.processName,
      windowTitle: info.windowTitle,
      ocrText: '',
      ocrSummary: '',
      imageHash: hash,
      screenshotPath,
      isSelectedForReport: false,
      isPrivate: false,
      isImportant: false,
      isDeleted: false,
      sourceStatus: 'pending',
      userTitle: '',
      userSummary: '',
      userNote: '',
      tags: [],
      ocrBlocks: [],
      ocrConfidence: 0,
      captureSource: fallbackDisplayBounds ? 'full_screen_fallback' : 'active_window',
      sourceQuality: fallbackDisplayBounds ? 'medium' : 'high',
      activeWindowBounds: null,
      displayBounds: boundsToSegmentBounds(fallbackDisplayBounds)
    }
  }

  /** 创建隐私占位片段（is_private=1, source_status='private'） */
  private createPrivacySegment(info: WindowInfo, now: Date, startTimeStr: string): WorkSegment {
    const timeStr = this.formatTime(now)
    return {
      id: randomUUID(),
      date: this.formatDate(now),
      startTime: timeStr,
      endTime: timeStr,
      durationSeconds: 0,
      appName: info.appName,
      processName: info.processName,
      windowTitle: `[${startTimeStr} - ${startTimeStr} 隐私窗口被保护]`,
      ocrText: '',
      ocrSummary: '',
      imageHash: '',
      screenshotPath: '',
      isSelectedForReport: false,
      isPrivate: true,
      isImportant: false,
      isDeleted: false,
      sourceStatus: 'private',
      userTitle: '',
      userSummary: '',
      userNote: '',
      tags: [],
      ocrBlocks: [],
      ocrConfidence: 0,
      captureSource: 'privacy_placeholder',
      sourceQuality: 'private',
      activeWindowBounds: null,
      displayBounds: null
    }
  }

  // ===================== 工具方法 =====================

  private resetCurrentSegment(): void {
    this.currentSegmentId = null
    this.currentSegmentStart = null
    this.currentSegmentIsPrivate = false
    this.currentSegmentApp = ''
    this.lastImageHash = ''
    this.pendingWindowInfo = null
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  private clearTimers(): void {
    this.clearDebounceTimer()
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private formatDate(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  private formatTime(d: Date): string {
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    const s = String(d.getSeconds()).padStart(2, '0')
    return `${h}:${m}:${s}`
  }

  private formatTimeShort(d: Date): string {
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
}
