/**
 * WindowWatcher：活跃窗口监听器
 *
 * 通过 Windows API（koffi 调用 user32.dll / kernel32.dll）轮询前台窗口，
 * 检测窗口切换 / 标题改变 / 页面滚动停止（基于标题稳定推断）/ 关键帧（5 分钟）。
 *
 * 架构：
 *  - IWindowInfoProvider：窗口信息获取抽象接口
 *  - Win32WindowInfoProvider：真实 Windows 实现（koffi FFI 调 user32/kernel32）
 *  - StubWindowInfoProvider：非 Windows 环境降级（仅日志警告，不伪造数据）
 *
 * 硬约束：本模块仅监听窗口句柄切换与标题变化，绝不监听键盘/鼠标硬件输入。
 */
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { LibraryHandle, KoffiFunc } from 'koffi'

/** 前台窗口信息 */
export interface WindowInfo {
  /** 窗口句柄（Windows HWND 数值；非 Windows 环境为 0） */
  hwnd: number
  /** 进程名，如 chrome.exe */
  processName: string
  /** 进程可执行文件完整路径 */
  processPath: string
  /** 窗口标题 */
  windowTitle: string
  /** 应用名（进程名去除扩展名） */
  appName: string
}

/** 窗口信息提供者抽象接口 */
export interface IWindowInfoProvider {
  /** 提供者是否可用（真实 Windows API 已加载） */
  isAvailable(): boolean
  /** 获取当前前台窗口信息；不可用时返回 null（不伪造） */
  getActiveWindow(): WindowInfo | null
}

// ===================== Win32 实现 =====================

/** koffi 函数类型 */
type KoffiFunction = KoffiFunc<(...args: unknown[]) => unknown>

/** Windows 进程查询权限标志 */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

/**
 * Win32WindowInfoProvider：通过 koffi 调用 Windows API 获取前台窗口信息。
 * 调用链：GetForegroundWindow → GetWindowTextW → GetWindowThreadProcessId →
 *         OpenProcess → QueryFullProcessImageNameW → CloseHandle
 */
export class Win32WindowInfoProvider implements IWindowInfoProvider {
  private user32: LibraryHandle | null = null
  private kernel32: LibraryHandle | null = null
  private fnGetForegroundWindow: KoffiFunction | null = null
  private fnGetWindowTextW: KoffiFunction | null = null
  private fnGetWindowTextLengthW: KoffiFunction | null = null
  private fnGetWindowThreadProcessId: KoffiFunction | null = null
  private fnOpenProcess: KoffiFunction | null = null
  private fnQueryFullProcessImageNameW: KoffiFunction | null = null
  private fnCloseHandle: KoffiFunction | null = null
  private available = false

  constructor() {
    this.tryInit()
  }

  private tryInit(): void {
    try {
      // 动态 require koffi，避免在 koffi 缺失时整个模块加载失败
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi') as typeof import('koffi')
      this.user32 = koffi.load('user32.dll')
      this.kernel32 = koffi.load('kernel32.dll')

      this.fnGetForegroundWindow = this.user32.func('void *GetForegroundWindow()')
      this.fnGetWindowTextW = this.user32.func(
        'int32_t GetWindowTextW(void *hwnd, uint16_t *lpString, int32_t nMaxCount)'
      )
      this.fnGetWindowTextLengthW = this.user32.func('int32_t GetWindowTextLengthW(void *hwnd)')
      this.fnGetWindowThreadProcessId = this.user32.func(
        'uint32_t GetWindowThreadProcessId(void *hwnd, uint32_t *lpdwProcessId)'
      )

      this.fnOpenProcess = this.kernel32.func(
        'void *OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'
      )
      this.fnQueryFullProcessImageNameW = this.kernel32.func(
        'bool QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, uint16_t *lpExeName, uint32_t *lpdwSize)'
      )
      this.fnCloseHandle = this.kernel32.func('bool CloseHandle(void *hObject)')

      this.available = true
    } catch (e) {
      console.warn(
        '[Win32WindowInfoProvider] Windows API 库加载失败（非 Windows 环境或 koffi 不可用），将降级到 StubWindowInfoProvider:',
        e instanceof Error ? e.message : String(e)
      )
      this.available = false
    }
  }

  isAvailable(): boolean {
    return this.available
  }

  getActiveWindow(): WindowInfo | null {
    if (!this.available || !this.fnGetForegroundWindow) return null
    try {
      const hwndPtr = this.fnGetForegroundWindow()
      if (!hwndPtr) return null

      const hwnd = this.ptrToNumber(hwndPtr)
      const windowTitle = this.getWindowText(hwndPtr)
      const pid = this.getProcessId(hwndPtr)
      const processPath = this.queryProcessPath(pid)
      const processName = processPath ? path.basename(processPath) : ''
      const appName = processName ? processName.replace(/\.[^.]+$/, '') : ''

      return { hwnd, processName, processPath, windowTitle, appName }
    } catch (e) {
      console.warn('[Win32WindowInfoProvider] 获取前台窗口失败:', e instanceof Error ? e.message : String(e))
      return null
    }
  }

  private ptrToNumber(ptr: unknown): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi') as typeof import('koffi')
      const addr = koffi.address(ptr)
      return Number(addr)
    } catch {
      return 0
    }
  }

  private getWindowText(hwndPtr: unknown): string {
    if (!this.fnGetWindowTextLengthW || !this.fnGetWindowTextW) return ''
    const len = this.fnGetWindowTextLengthW(hwndPtr) as number
    if (len <= 0) return ''
    const buf = Buffer.alloc((len + 1) * 2)
    this.fnGetWindowTextW(hwndPtr, buf, len + 1)
    return buf.toString('utf16le', 0, len * 2)
  }

  private getProcessId(hwndPtr: unknown): number {
    if (!this.fnGetWindowThreadProcessId) return 0
    const pidBuf = Buffer.alloc(4)
    this.fnGetWindowThreadProcessId(hwndPtr, pidBuf)
    return pidBuf.readUInt32LE(0)
  }

  private queryProcessPath(pid: number): string {
    if (!this.fnOpenProcess || !this.fnQueryFullProcessImageNameW || !this.fnCloseHandle) return ''
    if (pid === 0) return ''
    try {
      const hProcess = this.fnOpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
      if (!hProcess) return ''
      try {
        const sizeBuf = Buffer.alloc(4)
        sizeBuf.writeUInt32LE(1024, 0)
        const nameBuf = Buffer.alloc(1024 * 2)
        const ok = this.fnQueryFullProcessImageNameW(hProcess, 0, nameBuf, sizeBuf)
        if (!ok) return ''
        const size = sizeBuf.readUInt32LE(0)
        return nameBuf.toString('utf16le', 0, size * 2)
      } finally {
        this.fnCloseHandle(hProcess)
      }
    } catch {
      return ''
    }
  }
}

// ===================== Stub 降级实现 =====================

/**
 * StubWindowInfoProvider：非 Windows 环境降级提供者。
 * 不伪造任何窗口数据，getActiveWindow 始终返回 null。
 * 这不是 mock——真实 Windows 上会使用 Win32WindowInfoProvider。
 */
export class StubWindowInfoProvider implements IWindowInfoProvider {
  private warned = false

  isAvailable(): boolean {
    return false
  }

  getActiveWindow(): WindowInfo | null {
    if (!this.warned) {
      console.warn(
        '[StubWindowInfoProvider] 当前环境无 Windows API 支持，窗口监听处于降级模式，不会产生任何窗口事件或片段。'
      )
      this.warned = true
    }
    return null
  }
}

// ===================== 提供者工厂 =====================

/**
 * 根据运行环境选择窗口信息提供者。
 * 优先使用 Win32WindowInfoProvider；若 koffi 或 user32.dll 不可用则降级到 Stub。
 */
export function createWindowInfoProvider(): IWindowInfoProvider {
  if (process.platform === 'win32') {
    const win32 = new Win32WindowInfoProvider()
    if (win32.isAvailable()) return win32
    console.warn('[WindowWatcher] Win32WindowInfoProvider 不可用，降级到 StubWindowInfoProvider')
  } else {
    console.warn(
      `[WindowWatcher] 当前平台 ${process.platform} 非 Windows，使用 StubWindowInfoProvider 降级模式`
    )
  }
  return new StubWindowInfoProvider()
}

// ===================== WindowWatcher =====================

/** WindowWatcher 事件名 */
export interface WindowWatcherEvents {
  /** 窗口切换（hwnd 或进程变化） */
  windowChange: 'window-change'
  /** 窗口标题变化（同一窗口内标题改变） */
  titleChange: 'title-change'
  /** 页面滚动停止推断（标题稳定 2 秒） */
  scrollStop: 'scroll-stop'
  /** 关键帧（同一窗口标题持续 5 分钟） */
  keyframe: 'keyframe'
}

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 1000
/** 标题稳定判定时长（毫秒），用于推断滚动停止 */
const TITLE_STABLE_MS = 2000
/** 关键帧触发时长（毫秒），同一标题持续 5 分钟 */
const KEYFRAME_MS = 5 * 60 * 1000

/**
 * WindowWatcher：轮询前台窗口，检测变化并 emit 事件。
 *
 * 事件：
 *  - 'window-change'：窗口切换（hwnd 或进程名变化）
 *  - 'title-change'：同一窗口标题变化
 *  - 'scroll-stop'：标题稳定 2 秒后推断页面滚动停止
 *  - 'keyframe'：同一窗口标题持续 5 分钟触发关键帧
 */
export class WindowWatcher extends EventEmitter {
  private provider: IWindowInfoProvider
  private pollTimer: NodeJS.Timeout | null = null
  private titleStableTimer: NodeJS.Timeout | null = null
  private keyframeTimer: NodeJS.Timeout | null = null

  private lastWindowInfo: WindowInfo | null = null
  private lastTitle = ''
  private titleChangedAt = 0
  private running = false

  constructor(provider?: IWindowInfoProvider) {
    super()
    this.provider = provider ?? createWindowInfoProvider()
  }

  /** 提供者是否可用 */
  isProviderAvailable(): boolean {
    return this.provider.isAvailable()
  }

  /** 启动轮询 */
  start(): void {
    if (this.running) return
    this.running = true
    if (!this.provider.isAvailable()) {
      console.warn('[WindowWatcher] 提供者不可用，轮询不会产生事件')
    }
    this.poll()
  }

  /** 停止轮询并清理所有定时器 */
  stop(): void {
    this.running = false
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.titleStableTimer) {
      clearTimeout(this.titleStableTimer)
      this.titleStableTimer = null
    }
    if (this.keyframeTimer) {
      clearTimeout(this.keyframeTimer)
      this.keyframeTimer = null
    }
  }

  /** 获取最近一次窗口信息 */
  getLastWindowInfo(): WindowInfo | null {
    return this.lastWindowInfo
  }

  /** 立即读取一次当前活动窗口快照（不依赖轮询事件） */
  getActiveWindowSnapshot(): WindowInfo | null {
    try {
      return this.provider.getActiveWindow()
    } catch (e) {
      console.warn('[WindowWatcher] 获取活动窗口快照失败:', e instanceof Error ? e.message : String(e))
      return null
    }
  }

  private poll(): void {
    if (!this.running) return
    try {
      const info = this.provider.getActiveWindow()
      if (info) {
        this.handleWindowInfo(info)
      }
    } catch (e) {
      console.warn('[WindowWatcher] 轮询异常:', e instanceof Error ? e.message : String(e))
    }
    this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS)
  }

  private handleWindowInfo(info: WindowInfo): void {
    const prev = this.lastWindowInfo

    if (!prev || prev.hwnd !== info.hwnd || prev.processName !== info.processName) {
      // 窗口切换
      this.lastWindowInfo = info
      this.lastTitle = info.windowTitle
      this.titleChangedAt = Date.now()
      this.resetKeyframeTimer()
      this.emit('window-change', info)
      this.scheduleTitleStableCheck(info)
    } else if (prev.windowTitle !== info.windowTitle) {
      // 同一窗口标题变化
      this.lastWindowInfo = info
      this.lastTitle = info.windowTitle
      this.titleChangedAt = Date.now()
      this.resetKeyframeTimer()
      this.emit('title-change', info)
      this.scheduleTitleStableCheck(info)
    } else {
      // 标题未变化，保持 keyframe 计时
      this.lastWindowInfo = info
    }
  }

  private scheduleTitleStableCheck(info: WindowInfo): void {
    if (this.titleStableTimer) {
      clearTimeout(this.titleStableTimer)
    }
    this.titleStableTimer = setTimeout(() => {
      // 标题已稳定 TITLE_STABLE_MS，推断滚动停止
      if (this.lastWindowInfo && this.lastWindowInfo.windowTitle === info.windowTitle) {
        this.emit('scroll-stop', this.lastWindowInfo)
      }
      this.titleStableTimer = null
    }, TITLE_STABLE_MS)
  }

  private resetKeyframeTimer(): void {
    if (this.keyframeTimer) {
      clearTimeout(this.keyframeTimer)
    }
    this.keyframeTimer = setTimeout(() => {
      // 同一窗口标题持续 KEYFRAME_MS，触发关键帧
      if (this.lastWindowInfo) {
        this.emit('keyframe', this.lastWindowInfo)
      }
      // 重置以支持后续周期性关键帧
      this.resetKeyframeTimer()
    }, KEYFRAME_MS)
  }
}
