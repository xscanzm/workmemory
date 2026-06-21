/**
 * MascotManager：桌面伙伴编排层单例
 *
 * 整合 MascotWindow + FrequencyLimiter + TrayManager + 状态联动。
 *
 * 职责：
 *  - 实现 IMascotNotifier 接口（替换 SafeMascotNotifier 注入到 ReminderScheduler）
 *  - setState(state)：更新 Mascot 表情
 *  - setStyle(style)：切换形象
 *  - tryShowBubble(payload)：受频率限制的主动气泡
 *  - showBubbleDirect(payload)：用户触发的气泡（不受频率限制）
 *  - showContextMenu()：右键菜单
 *  - ghostCapture(text)：灵感捕捉，存入 SegmentRepository
 *  - 状态联动：订阅 CaptureManager.onStateChange / onIncognitoDetected / OcrQueue
 *  - 交互：左键单击（今日总结气泡 → 跳转）、右键双击（隐藏至托盘）
 *
 * 单例导出 getMascotManager()。
 */
import { Menu, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { MascotStyle, MascotState, WorkSegment } from '@/types'
import { MascotWindow } from './MascotWindow'
import { FrequencyLimiter } from './FrequencyLimiter'
import type { FrequencyStats } from './FrequencyLimiter'
import { TrayManager } from './TrayManager'
import {
  IMascotNotifier,
  MascotBubblePayload,
  setMascotNotifier
} from './MascotNotifier'
import { getCaptureManager } from '../capture/CaptureManager'
import { getOcrManager } from '../ocr/OcrManager'
import { getEpisodeManager } from '../capture/EpisodeManager'
import { getInsightsManager } from '../insights/InsightsManager'
import { showMainWindow } from '../main/window'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { SettingsStore } from '../db/SettingsStore'
import { MascotChannels } from '../types/ipc'
import type { RecordingState } from '@/types'
import { validatedHandler } from '../ipc/validatedHandler'
import { mascotSchemas } from '../ipc/schemas'

/** OCR 完成后显示扫描状态的间隔（每 N 次完成显示一次） */
const OCR_SCAN_INTERVAL = 5

/** 扫描状态持续时间（毫秒） */
const OCR_SCAN_DURATION_MS = 2000

/** 今日总结气泡自动重置时间（毫秒） */
const SUMMARY_BUBBLE_RESET_MS = 10000

/** Mascot 形象列表 */
const MASCOT_STYLES: Array<{ id: MascotStyle; label: string }> = [
  { id: 'note', label: '小记（便签）' },
  { id: 'film', label: '胶片（复看）' },
  { id: 'copilot', label: '副驾驶（技术）' },
  { id: 'cursor', label: '极简光标' },
  { id: 'paper', label: '纸页精灵（文档）' }
]

/**
 * MascotManager：桌面伙伴编排层。
 *
 * 实现 IMascotNotifier 接口，替换 SafeMascotNotifier 注入到 ReminderScheduler。
 */
export class MascotManager implements IMascotNotifier {
  private mascotWindow: MascotWindow
  private frequencyLimiter: FrequencyLimiter
  private trayManager: TrayManager
  private initialized = false

  /** 当前状态 */
  private currentState: MascotState = 'recording'
  /** 当前形象 */
  private currentStyle: MascotStyle = 'note'
  /** OCR 完成计数（用于偶发显示扫描状态） */
  private ocrCompletionCount = 0
  /** 扫描状态恢复计时器 */
  private scanStateTimer: NodeJS.Timeout | null = null
  /** 今日总结气泡是否已展示（用于左键单击的二次点击跳转） */
  private summaryBubbleShown = false
  /** 今日总结气泡重置计时器 */
  private summaryResetTimer: NodeJS.Timeout | null = null
  /** 隐私模式前的状态（用于恢复） */
  private prePrivacyState: MascotState = 'recording'

  constructor() {
    this.mascotWindow = new MascotWindow()
    this.frequencyLimiter = new FrequencyLimiter()
    this.trayManager = new TrayManager()
    this.currentStyle = this.loadStyleFromSettings()
  }

  // ===================== 初始化 =====================

  /**
   * 初始化：app ready 后调用。
   * 创建 Mascot 窗口 + 托盘，订阅事件，注入到 ReminderScheduler。
   */
  initialize(): void {
    if (this.initialized) return

    try {
      this.mascotWindow.create()
    } catch (e) {
      console.warn(
        '[MascotManager] Mascot 窗口创建失败（沙箱降级）:',
        e instanceof Error ? e.message : String(e)
      )
    }

    try {
      this.trayManager.create()
      this.trayManager.onNavigate = (page: string) => {
        this.navigateTo(page)
      }
      this.trayManager.onGenerateReport = () => {
        this.navigateTo('reports')
      }
    } catch (e) {
      console.warn(
        '[MascotManager] 托盘创建失败:',
        e instanceof Error ? e.message : String(e)
      )
    }

    this.setupIpcHandlers()
    this.setupStateLinkage()
    this.setMascotNotifierForScheduler()

    this.initialized = true
    console.log('[MascotManager] 初始化完成')
  }

  /** 从设置加载 Mascot 样式 */
  private loadStyleFromSettings(): MascotStyle {
    try {
      return SettingsStore.getMascotStyle()
    } catch {
      return 'note'
    }
  }

  /** 将自身注入到 ReminderScheduler（替换 SafeMascotNotifier） */
  private setMascotNotifierForScheduler(): void {
    // 1. 更新全局单例（供后续新建的 ReminderScheduler 使用）
    setMascotNotifier(this)
    // 2. 更新已存在的 ReminderScheduler 实例的 notifier 引用
    // （InsightsManager 在构造时已创建 ReminderScheduler 并持有旧 SafeMascotNotifier）
    try {
      const scheduler = getInsightsManager().getReminderScheduler()
      scheduler.setNotifier(this)
      console.log('[MascotManager] 已注入到 ReminderScheduler')
    } catch (e) {
      console.warn('[MascotManager] 注入 ReminderScheduler 失败:', e)
    }
  }

  // ===================== IMascotNotifier 实现 =====================

  /**
   * 尝试展示主动气泡（受频率限制）。
   * @returns true 表示已展示；false 表示被频率限制拦截
   */
  tryShowBubble(payload: MascotBubblePayload): boolean {
    if (!this.frequencyLimiter.tryShowBubble()) {
      console.log(
        `[MascotManager] 主动气泡被频率限制拦截：${payload.title}`
      )
      // 频率限制下仅显示表情动作（如递出小信封），不展示文字弹框
      this.setState('report_ready')
      setTimeout(() => {
        this.restoreStateFromCapture()
      }, 3000)
      return false
    }

    this.frequencyLimiter.onBubbleShown()
    this.sendBubbleToWindow({
      title: payload.title,
      message: payload.message,
      action: payload.action?.page
    })
    return true
  }

  /** 用户关闭气泡时调用（频率限制器记录关闭次数） */
  onBubbleDismissed(): void {
    this.frequencyLimiter.onBubbleClosed()
  }

  /** 重置当天频率限制（跨日时调用） */
  resetDailyLimit(): void {
    this.frequencyLimiter.resetDailyLimit()
  }

  // ===================== 状态/形象控制 =====================

  /** 设置 Mascot 状态 */
  setState(state: MascotState): void {
    this.currentState = state
    this.mascotWindow.setCurrentState(state)
    this.mascotWindow.sendState(state)
    this.trayManager.updateIcon(state)
  }

  /** 设置 Mascot 形象 */
  setStyle(style: MascotStyle): void {
    this.currentStyle = style
    this.mascotWindow.setCurrentStyle(style)
    this.mascotWindow.sendStyle(style)
    try {
      SettingsStore.setMascotStyle(style)
    } catch (e) {
      console.warn('[MascotManager] 保存 Mascot 样式失败:', e)
    }
  }

  /** 获取当前状态 */
  getState(): MascotState {
    return this.currentState
  }

  /** 获取当前形象 */
  getStyle(): MascotStyle {
    return this.currentStyle
  }

  /** 获取频率限制统计 */
  getStats(): FrequencyStats {
    return this.frequencyLimiter.getStats()
  }

  // ===================== 气泡控制 =====================

  /**
   * 用户触发的气泡（不受频率限制）。
   * 用于左键单击的今日总结等用户主动行为。
   */
  showBubbleDirect(payload: {
    title: string
    message: string
    action?: string
  }): void {
    this.sendBubbleToWindow(payload)
  }

  /** 向 Mascot 窗口发送气泡展示命令 */
  private sendBubbleToWindow(payload: {
    title: string
    message: string
    action?: string
  }): void {
    this.mascotWindow.sendBubble(payload)
  }

  // ===================== 窗口控制 =====================

  /** 显示 Mascot */
  show(): void {
    this.mascotWindow.show()
  }

  /** 隐藏 Mascot（至托盘） */
  hide(): void {
    this.mascotWindow.hide()
  }

  /** Mascot 是否可见 */
  isVisible(): boolean {
    return this.mascotWindow.isVisible()
  }

  // ===================== 交互处理 =====================

  /** 左键单击：首次显示今日总结气泡，再次点击跳转今日页 */
  onLeftClick(): void {
    if (this.summaryBubbleShown) {
      // 第二次点击：跳转今日页
      this.summaryBubbleShown = false
      if (this.summaryResetTimer) {
        clearTimeout(this.summaryResetTimer)
        this.summaryResetTimer = null
      }
      this.navigateTo('today')
    } else {
      // 第一次点击：显示今日总结气泡
      this.summaryBubbleShown = true
      const summary = this.getTodaySummary()
      this.showBubbleDirect({
        title: '今日总结',
        message: summary,
        action: 'today'
      })
      // 超时后重置（允许再次点击显示总结）
      this.summaryResetTimer = setTimeout(() => {
        this.summaryBubbleShown = false
        this.summaryResetTimer = null
      }, SUMMARY_BUBBLE_RESET_MS)
    }
  }

  /** 右键单击：显示上下文菜单 */
  onRightClick(): void {
    this.showContextMenu()
  }

  /** 右键双击：隐藏至托盘 */
  onRightDoubleClick(): void {
    this.hide()
  }

  /** 显示右键上下文菜单 */
  showContextMenu(): void {
    const captureManager = getCaptureManager()
    const recordingState = captureManager.getRecordingState()
    const isPaused = recordingState === 'paused' || recordingState === 'privacy'

    const styleSubmenu = MASCOT_STYLES.map(s => ({
      label: s.label,
      type: 'radio' as const,
      checked: this.currentStyle === s.id,
      click: (): void => {
        this.setStyle(s.id)
      }
    }))

    const menu = Menu.buildFromTemplate([
      {
        label: '打开今日页',
        click: (): void => {
          this.navigateTo('today')
        }
      },
      {
        label: isPaused ? '恢复记录' : '一键暂停记录',
        click: (): void => {
          if (isPaused) {
            captureManager.resumeCapture()
          } else {
            captureManager.pauseCapture()
          }
        }
      },
      {
        label: '快捷开启隐私模式',
        click: (): void => {
          this.togglePrivacyMode()
        }
      },
      {
        label: '灵感快速捕捉',
        click: (): void => {
          void this.showGhostCaptureDialog()
        }
      },
      {
        label: '生成今日日报',
        click: (): void => {
          this.navigateTo('reports')
        }
      },
      { type: 'separator' },
      {
        label: '进入设置',
        click: (): void => {
          this.navigateTo('settings')
        }
      },
      {
        label: '选择伙伴形象',
        submenu: styleSubmenu
      }
    ])

    menu.popup()
  }

  /** 切换隐私模式 */
  private togglePrivacyMode(): void {
    const captureManager = getCaptureManager()
    const current = captureManager.getRecordingState()
    if (current === 'privacy' || current === 'paused') {
      captureManager.resumeCapture()
    } else {
      this.prePrivacyState = this.currentState
      captureManager.pauseCapture()
      this.setState('privacy')
    }
  }

  // ===================== Ghost Capture =====================

  /**
   * 灵感捕捉：弹输入框，记录用户即时想法为 note segment。
   * 创建 source_status='no_text' 的 Segment，windowTitle='[灵感捕捉] '+text。
   */
  async ghostCapture(text: string): Promise<boolean> {
    const trimmed = text.trim()
    if (!trimmed) return false

    try {
      const now = new Date()
      const segment: WorkSegment = {
        id: randomUUID(),
        date: this.todayString(),
        startTime: now.toTimeString().slice(0, 8),
        endTime: now.toTimeString().slice(0, 8),
        durationSeconds: 0,
        appName: 'WorkMemory',
        processName: 'WorkMemory',
        windowTitle: `[灵感捕捉] ${trimmed}`,
        ocrText: '',
        ocrSummary: '',
        imageHash: '',
        screenshotPath: '',
        isSelectedForReport: false,
        isPrivate: false,
        isImportant: false,
        isDeleted: false,
        sourceStatus: 'no_text',
        userTitle: '',
        userSummary: '',
        userNote: trimmed,
        tags: ['灵感捕捉']
      }
      SegmentRepository.insert(segment)

      // 显示捕捉成功气泡
      this.setState('report_ready')
      setTimeout(() => {
        this.restoreStateFromCapture()
      }, 2000)

      return true
    } catch (e) {
      console.error('[MascotManager] 灵感捕捉失败:', e instanceof Error ? e.message : String(e))
      return false
    }
  }

  /**
   * 显示灵感捕捉输入对话框。
   * 使用 BrowserWindow + data URL 创建简易输入框。
   */
  private async showGhostCaptureDialog(): Promise<void> {
    const text = await this.showInputDialog(
      '灵感捕捉',
      '记录此刻的想法...'
    )
    if (text) {
      await this.ghostCapture(text)
    }
  }

  /**
   * 显示输入对话框（BrowserWindow + data URL + executeJavaScript）。
   * @returns 用户输入的文本，或 null（取消）
   */
  private showInputDialog(title: string, placeholder: string): Promise<string | null> {
    return new Promise(resolve => {
      let resolved = false
      const win = new BrowserWindow({
        width: 420,
        height: 180,
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      })

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background: #f5f7fa; padding: 16px; height: 100vh;
    display: flex; flex-direction: column; gap: 12px;
    -webkit-font-smoothing: antialiased;
  }
  h3 { font-size: 14px; color: #1a2332; font-weight: 600; }
  input {
    width: 100%; padding: 8px 10px; font-size: 13px;
    border: 1px solid #e1e7ef; border-radius: 6px;
    outline: none; color: #1a2332; background: #fff;
  }
  input:focus { border-color: #2b7fff; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }
  button {
    padding: 6px 14px; border-radius: 6px; font-size: 12px;
    cursor: pointer; font-family: inherit;
  }
  .cancel { border: 1px solid #e1e7ef; background: #fff; color: #5a6a7e; }
  .cancel:hover { background: #eef2f7; }
  .ok { border: none; background: #2b7fff; color: #fff; }
  .ok:hover { background: #1a6fef; }
</style>
</head>
<body>
  <h3>${this.escapeHtml(title)}</h3>
  <input id="input" type="text" placeholder="${this.escapeHtml(placeholder)}" autofocus />
  <div class="actions">
    <button class="cancel" id="cancel">取消</button>
    <button class="ok" id="ok">捕捉</button>
  </div>
</body>
</html>`

      const handleResult = (result: string | null): void => {
        if (resolved) return
        resolved = true
        if (!win.isDestroyed()) win.close()
        resolve(result)
      }

      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))

      win.webContents.on('did-finish-load', () => {
        win.show()
        win.focus()
        win.webContents
          .executeJavaScript(
            `new Promise((resolve) => {
              const input = document.getElementById('input');
              document.getElementById('ok').onclick = () => resolve(input.value);
              document.getElementById('cancel').onclick = () => resolve(null);
              input.onkeydown = (e) => {
                if (e.key === 'Enter') resolve(input.value);
                if (e.key === 'Escape') resolve(null);
              };
            })`
          )
          .then((result: unknown) => {
            handleResult(result as string | null)
          })
          .catch(() => {
            handleResult(null)
          })
      })

      win.on('closed', () => {
        handleResult(null)
      })
    })
  }

  /** HTML 转义 */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  // ===================== 导航 =====================

  /** 导航到主窗口指定页面 */
  navigateTo(page: string): void {
    const win = showMainWindow()
    win.webContents.send(MascotChannels.NavigateMain, page)
  }

  // ===================== IPC 处理器 =====================

  /** 设置 IPC 处理器（接收来自 mascot 渲染进程和主窗口的事件） */
  private setupIpcHandlers(): void {
    // 获取初始状态和形象（mascot 渲染进程启动时调用）
    validatedHandler(MascotChannels.GetInitialState, mascotSchemas.GetInitialState, () => {
      return {
        state: this.currentState,
        style: this.currentStyle
      }
    })

    // 左键单击
    validatedHandler(MascotChannels.LeftClick, mascotSchemas.LeftClick, () => {
      this.onLeftClick()
      return true
    })

    // 右键单击（上下文菜单）
    validatedHandler(MascotChannels.RightClick, mascotSchemas.RightClick, () => {
      this.onRightClick()
      return true
    })

    // 右键双击（隐藏至托盘）
    validatedHandler(
      MascotChannels.RightDoubleClick,
      mascotSchemas.RightDoubleClick,
      () => {
        this.onRightDoubleClick()
        return true
      }
    )

    // 气泡关闭
    validatedHandler(MascotChannels.BubbleClosed, mascotSchemas.BubbleClosed, () => {
      this.onBubbleDismissed()
      return true
    })

    // 鼠标进入（恢复透明度）
    validatedHandler(MascotChannels.MouseEnter, mascotSchemas.MouseEnter, () => {
      this.mascotWindow.onMouseEnter()
      return true
    })

    // 鼠标离开（恢复吸附透明度）
    validatedHandler(MascotChannels.MouseLeave, mascotSchemas.MouseLeave, () => {
      this.mascotWindow.onMouseLeave()
      return true
    })

    // 设置状态（主窗口调用）
    validatedHandler(MascotChannels.SetState, mascotSchemas.SetState, (_e, { state }) => {
      this.setState(state)
      return true
    })

    // 显示 Mascot
    validatedHandler(MascotChannels.Show, mascotSchemas.Show, () => {
      this.show()
      return true
    })

    // Ghost Capture
    validatedHandler(MascotChannels.GhostCapture, mascotSchemas.GhostCapture, async (_e, { text }) => {
      return this.ghostCapture(text)
    })

    // 获取频率限制统计
    validatedHandler(MascotChannels.GetStats, mascotSchemas.GetStats, () => {
      return this.getStats()
    })

    // 导航（Mascot 气泡"查看详情"点击 → 跳转主窗口）
    validatedHandler(MascotChannels.Navigate, mascotSchemas.Navigate, (_e, { page }) => {
      this.navigateTo(page)
      return true
    })
  }

  // ===================== 状态联动 =====================

  /** 订阅 CaptureManager 和 OcrQueue 事件 */
  private setupStateLinkage(): void {
    const captureManager = getCaptureManager()

    // 订阅 CaptureManager 状态变化
    captureManager.on('state-change', (state: RecordingState) => {
      this.onCaptureStateChanged(state)
    })

    // 订阅无痕模式检测
    captureManager.on('segment-created', () => {
      // 片段创建时不做特殊处理
    })

    // 订阅 OcrQueue 的 ocr-completed 事件（偶发显示扫描状态）
    try {
      const ocrManager = getOcrManager()
      const queue = ocrManager.getQueue()
      queue.on('ocr-completed', () => {
        this.onOcrCompleted()
      })
    } catch (e) {
      console.warn('[MascotManager] 订阅 OcrQueue 失败:', e instanceof Error ? e.message : String(e))
    }
  }

  /** CaptureManager 状态变化回调 */
  private onCaptureStateChanged(state: RecordingState): void {
    // 隐私模式由 IncognitoDetector 单独处理（通过 onIncognitoDetected）
    // 这里处理 recording / paused / idle
    if (state === 'privacy') {
      this.prePrivacyState = this.currentState === 'privacy' ? this.prePrivacyState : this.currentState
      this.setState('privacy')
    } else if (state === 'recording') {
      this.setState('recording')
    } else if (state === 'paused') {
      this.setState('paused')
    } else if (state === 'idle') {
      this.setState('paused')
    }
  }

  /** OCR 完成回调（偶发显示扫描状态） */
  private onOcrCompleted(): void {
    this.ocrCompletionCount++
    if (this.ocrCompletionCount % OCR_SCAN_INTERVAL !== 0) return
    if (this.currentState === 'privacy') return

    // 清除之前的恢复计时器
    if (this.scanStateTimer) {
      clearTimeout(this.scanStateTimer)
    }

    this.setState('ocr_scanning')
    this.scanStateTimer = setTimeout(() => {
      this.scanStateTimer = null
      this.restoreStateFromCapture()
    }, OCR_SCAN_DURATION_MS)
  }

  /** 从 CaptureManager 状态恢复 Mascot 状态 */
  private restoreStateFromCapture(): void {
    try {
      const captureManager = getCaptureManager()
      const state = captureManager.getRecordingState()
      this.onCaptureStateChanged(state)
    } catch {
      this.setState('recording')
    }
  }

  // ===================== 工具方法 =====================

  /** 获取今日一句话总结 */
  private getTodaySummary(): string {
    try {
      const episodeManager = getEpisodeManager()
      const summary = episodeManager.getDailySummary(this.todayString())
      return summary || '今天还没有记录，开始工作吧～'
    } catch {
      return '今天还没有记录，开始工作吧～'
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

  /** 停止管理器 */
  stop(): void {
    if (this.scanStateTimer) {
      clearTimeout(this.scanStateTimer)
      this.scanStateTimer = null
    }
    if (this.summaryResetTimer) {
      clearTimeout(this.summaryResetTimer)
      this.summaryResetTimer = null
    }
    this.mascotWindow.destroy()
    this.trayManager.destroy()
    this.initialized = false
  }
}

// ===================== 单例 =====================

let managerInstance: MascotManager | null = null

/** 获取 MascotManager 单例 */
export function getMascotManager(): MascotManager {
  if (!managerInstance) {
    managerInstance = new MascotManager()
  }
  return managerInstance
}

/** 重置单例（仅供测试） */
export function resetMascotManager(): void {
  if (managerInstance) {
    managerInstance.stop()
    managerInstance = null
  }
}
