/**
 * MascotWindow：桌面伙伴独立窗口管理
 *
 * 创建透明无边框置顶窗口，加载 mascot 渲染页面（#/mascot 路由）。
 * 功能：
 *  - 创建 BrowserWindow：frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true
 *  - 初始位置：屏幕右下角（留 20px 边距）
 *  - 拖拽与边缘吸附：松开后检测靠近边缘（<50px），自动吸附 + 半透明 0.5
 *  - 鼠标悬停恢复 opacity:1.0，拖拽时 opacity:0.8
 *  - show()/hide()/setPosition()/setOpacity()
 *  - IPC 通信：向渲染进程发送 state/style/bubble，接收点击/拖拽事件
 *
 * 沙箱降级：Linux 环境下 transparent 可能不完美，启动时 try-catch 降级。
 */
import { BrowserWindow, screen, ipcMain, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { MascotStyle, MascotState } from '@/types'
import { MascotChannels } from '../types/ipc'

/** Mascot 窗口尺寸 */
const MASCOT_WIDTH = 340
const MASCOT_HEIGHT = 146

/** 边缘吸附阈值（像素） */
const EDGE_SNAP_THRESHOLD = 50

/** 边缘吸附后的透明度 */
const EDGE_OPACITY = 0.5

/** 拖拽时的透明度 */
const DRAG_OPACITY = 0.8

/** 正常透明度 */
const NORMAL_OPACITY = 1.0

/** 拖拽轮询间隔（毫秒，~60fps） */
const DRAG_POLL_INTERVAL = 16

function logMascot(message: string): void {
  try {
    const filePath = path.join(app.getPath('userData'), 'runtime.log')
    fs.appendFileSync(filePath, `[${new Date().toISOString()}] [mascot] ${message}\n`, 'utf-8')
  } catch {
    // ignore logging failures
  }
}

/**
 * MascotWindow：桌面伙伴窗口管理器。
 */
export class MascotWindow {
  private window: BrowserWindow | null = null
  /** 当前是否已吸附到边缘 */
  private snappedToEdge = false
  /** 拖拽轮询计时器 */
  private dragTimer: NodeJS.Timeout | null = null
  /** 拖拽起始光标位置 */
  private dragStartCursor = { x: 0, y: 0 }
  /** 拖拽起始窗口位置 */
  private dragStartWindow = { x: 0, y: 0 }
  /** 当前状态 */
  private currentState: MascotState = 'recording'
  /** 当前形象 */
  private currentStyle: MascotStyle = 'note'

  /**
   * 创建并显示 Mascot 窗口。
   * 沙箱环境下若 transparent 失败，降级为非透明窗口。
   */
  create(): void {
    if (this.window && !this.window.isDestroyed()) return

    try {
      this.window = this.createTransparentWindow()
    } catch (e) {
      console.warn(
        '[MascotWindow] 透明窗口创建失败，降级为非透明:',
        e instanceof Error ? e.message : String(e)
      )
      this.window = this.createFallbackWindow()
    }

    this.setupWindowEvents()
    this.setupIpcHandlers()
    this.loadMascotPage()
  }

  /** 创建透明无边框置顶窗口 */
  private createTransparentWindow(): BrowserWindow {
    const { x, y } = this.getInitialPosition()
    return new BrowserWindow({
      width: MASCOT_WIDTH,
      height: MASCOT_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true
      }
    })
  }

  /** 降级窗口（非透明，适用于不支持 transparent 的环境） */
  private createFallbackWindow(): BrowserWindow {
    const { x, y } = this.getInitialPosition()
    return new BrowserWindow({
      width: MASCOT_WIDTH,
      height: MASCOT_HEIGHT,
      x,
      y,
      frame: false,
      transparent: false,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      show: false,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true
      }
    })
  }

  /** 计算初始位置：屏幕右下角，留 20px 边距 */
  private getInitialPosition(): { x: number; y: number } {
    const display = screen.getPrimaryDisplay()
    const { width, height } = display.workAreaSize
    return {
      x: width - MASCOT_WIDTH - 20,
      y: height - MASCOT_HEIGHT - 20
    }
  }

  /** 设置窗口事件监听 */
  private setupWindowEvents(): void {
    if (!this.window) return

    this.window.once('ready-to-show', () => {
      this.window?.setOpacity(NORMAL_OPACITY)
      this.window?.show()
      logMascot('show mascot: ready-to-show')
    })
    this.window.webContents.once('did-finish-load', () => {
      if (this.window && !this.window.isDestroyed() && !this.window.isVisible()) {
        this.window.setOpacity(NORMAL_OPACITY)
        this.window.show()
        logMascot('show mascot: did-finish-load')
      }
    })
    this.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      logMascot(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
    })
    this.window.webContents.on('render-process-gone', (_event, details) => {
      logMascot(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    })
    setTimeout(() => {
      if (this.window && !this.window.isDestroyed() && !this.window.isVisible()) {
        this.window.setOpacity(NORMAL_OPACITY)
        this.window.show()
        logMascot('show mascot: fallback-timeout')
      }
    }, 3000)

    // 窗口移动后检测边缘吸附
    this.window.on('move', () => {
      // 拖拽中由 dragTimer 处理，这里仅处理非拖拽的移动
    })

    this.window.on('closed', () => {
      this.window = null
    })
  }

  /** 设置 IPC 处理器（接收来自 mascot 渲染进程的事件） */
  private setupIpcHandlers(): void {
    // 拖拽开始
    ipcMain.handle(MascotChannels.DragStart, () => {
      this.startDrag()
      return true
    })

    // 拖拽结束
    ipcMain.handle(MascotChannels.DragEnd, () => {
      this.endDrag()
      return true
    })
  }

  /** 加载 mascot 渲染页面 */
  private loadMascotPage(): void {
    if (!this.window) return

    const devUrl = process.env.VITE_DEV_SERVER_URL
    if (devUrl) {
      logMascot(`loadURL ${devUrl}#/mascot`)
      void this.window.loadURL(`${devUrl}#/mascot`)
    } else {
      const filePath = path.join(__dirname, '../../dist/index.html')
      logMascot(`loadFile ${filePath}#mascot`)
      void this.window.loadFile(
        filePath,
        { hash: 'mascot' }
      ).catch((e) => {
        logMascot(`loadFile failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    }
  }

  // ===================== 拖拽与边缘吸附 =====================

  /** 开始拖拽：记录起始位置，启动轮询计时器 */
  private startDrag(): void {
    if (!this.window || this.dragTimer) return

    this.dragStartCursor = screen.getCursorScreenPoint()
    const [winX, winY] = this.window.getPosition()
    this.dragStartWindow = { x: winX, y: winY }
    this.window.setOpacity(DRAG_OPACITY)
    this.snappedToEdge = false

    this.dragTimer = setInterval(() => {
      this.onDragPoll()
    }, DRAG_POLL_INTERVAL)
  }

  /** 拖拽轮询：根据光标移动窗口 */
  private onDragPoll(): void {
    if (!this.window) return

    const cursor = screen.getCursorScreenPoint()
    const dx = cursor.x - this.dragStartCursor.x
    const dy = cursor.y - this.dragStartCursor.y
    const newX = this.dragStartWindow.x + dx
    const newY = this.dragStartWindow.y + dy
    this.window.setPosition(newX, newY)
  }

  /** 结束拖拽：停止轮询，检测边缘吸附 */
  private endDrag(): void {
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }

    if (!this.window) return

    this.checkEdgeSnap()
  }

  /** 检测边缘吸附：靠近边缘（<50px）则吸附并半透明 */
  private checkEdgeSnap(): void {
    if (!this.window) return

    const winBounds = this.window.getBounds()
    const display = screen.getDisplayMatching(winBounds)
    const workArea = display.workArea

    const nearLeft = winBounds.x <= workArea.x + EDGE_SNAP_THRESHOLD
    const nearRight =
      winBounds.x + winBounds.width >= workArea.x + workArea.width - EDGE_SNAP_THRESHOLD
    const nearTop = winBounds.y <= workArea.y + EDGE_SNAP_THRESHOLD
    const nearBottom =
      winBounds.y + winBounds.height >= workArea.y + workArea.height - EDGE_SNAP_THRESHOLD

    if (nearLeft || nearRight || nearTop || nearBottom) {
      // 吸附到最近的边缘
      let snapX = winBounds.x
      let snapY = winBounds.y

      if (nearLeft) snapX = workArea.x
      else if (nearRight) snapX = workArea.x + workArea.width - winBounds.width

      if (nearTop) snapY = workArea.y
      else if (nearBottom) snapY = workArea.y + workArea.height - winBounds.height

      this.window.setPosition(snapX, snapY)
      this.snappedToEdge = true
      this.window.setOpacity(EDGE_OPACITY)
    } else {
      this.snappedToEdge = false
      this.window.setOpacity(NORMAL_OPACITY)
    }
  }

  /** 鼠标悬停恢复透明度（由渲染进程通过 IPC 调用） */
  onMouseEnter(): void {
    if (!this.window) return
    if (this.snappedToEdge) {
      this.window.setOpacity(NORMAL_OPACITY)
    }
  }

  /** 鼠标离开恢复吸附透明度（由渲染进程通过 IPC 调用） */
  onMouseLeave(): void {
    if (!this.window) return
    if (this.snappedToEdge) {
      this.window.setOpacity(EDGE_OPACITY)
    }
  }

  // ===================== 窗口控制 =====================

  /** 显示窗口 */
  show(): void {
    if (!this.window) return
    this.window.show()
  }

  /** 隐藏窗口 */
  hide(): void {
    if (!this.window) return
    this.window.hide()
  }

  /** 窗口是否可见 */
  isVisible(): boolean {
    if (!this.window) return false
    return this.window.isVisible()
  }

  /** 设置窗口位置 */
  setPosition(x: number, y: number): void {
    if (!this.window) return
    this.window.setPosition(x, y)
  }

  /** 设置透明度 */
  setOpacity(opacity: number): void {
    if (!this.window) return
    this.window.setOpacity(opacity)
  }

  /** 获取窗口实例 */
  getWindow(): BrowserWindow | null {
    return this.window
  }

  // ===================== 状态/形象/气泡 =====================

  /** 向渲染进程发送状态变更 */
  sendState(state: MascotState): void {
    this.currentState = state
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send(MascotChannels.StateChanged, state)
  }

  /** 向渲染进程发送形象变更 */
  sendStyle(style: MascotStyle): void {
    this.currentStyle = style
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send(MascotChannels.StyleChanged, style)
  }

  /** 向渲染进程发送气泡展示命令 */
  sendBubble(payload: {
    title: string
    message: string
    action?: string
  }): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send(MascotChannels.BubbleShow, payload)
  }

  /** 获取当前状态 */
  getCurrentState(): MascotState {
    return this.currentState
  }

  /** 获取当前形象 */
  getCurrentStyle(): MascotStyle {
    return this.currentStyle
  }

  /** 设置当前状态（不发送 IPC，仅内部记录） */
  setCurrentState(state: MascotState): void {
    this.currentState = state
  }

  /** 设置当前形象（不发送 IPC，仅内部记录） */
  setCurrentStyle(style: MascotStyle): void {
    this.currentStyle = style
  }

  /** 销毁窗口 */
  destroy(): void {
    if (this.dragTimer) {
      clearInterval(this.dragTimer)
      this.dragTimer = null
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
  }
}
