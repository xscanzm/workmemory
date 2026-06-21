/**
 * IncognitoDetector：无痕模式检测器
 *
 * 从 PrivacyGuard 拆出的独立检测器，便于复用。
 * 检测 Chrome/Edge/Firefox 窗口标题中的隐私浏览关键词，
 * 订阅 WindowWatcher 的 window-change 事件，实时 emit 检测/清除事件。
 *
 * 硬约束：仅处理窗口标题文本信息，不监听键盘/鼠标。
 */
import { EventEmitter } from 'node:events'
import type { WindowWatcher, WindowInfo } from './WindowWatcher'

/** 无痕模式关键词（小写匹配） */
const INCOGNITO_KEYWORDS = [
  'incognito',
  'inprivate',
  'private browsing',
  '隐私浏览',
  '无痕'
]

/** 支持检测的浏览器进程名（小写） */
const BROWSER_PROCESSES = ['chrome.exe', 'msedge.exe', 'firefox.exe']

/**
 * IncognitoDetector：订阅 WindowWatcher，检测无痕浏览窗口。
 *
 * 事件：
 *  - 'incognito-detected'：检测到无痕窗口，携带 WindowInfo
 *  - 'incognito-cleared'：离开无痕窗口（切换到非无痕窗口）
 */
export class IncognitoDetector extends EventEmitter {
  private watcher: WindowWatcher | null = null
  private incognitoActive = false
  private boundHandler: ((info: WindowInfo) => void) | null = null

  /**
   * 检测给定窗口信息是否为无痕浏览窗口。
   * 仅检测浏览器进程（chrome/msedge/firefox）且标题含无痕关键词。
   */
  detect(windowInfo: WindowInfo): boolean {
    const processName = windowInfo.processName.toLowerCase()
    if (!BROWSER_PROCESSES.includes(processName)) return false
    const title = windowInfo.windowTitle.toLowerCase()
    return INCOGNITO_KEYWORDS.some(kw => title.includes(kw))
  }

  /** 当前是否处于无痕模式 */
  isIncognitoActive(): boolean {
    return this.incognitoActive
  }

  /**
   * 订阅 WindowWatcher 的 window-change 事件。
   * 检测到无痕窗口时 emit 'incognito-detected'，离开时 emit 'incognito-cleared'。
   */
  watch(watcher: WindowWatcher): void {
    // 若已订阅先解绑
    this.unwatch()
    this.watcher = watcher
    this.boundHandler = (info: WindowInfo) => {
      const isIncognito = this.detect(info)
      if (isIncognito && !this.incognitoActive) {
        this.incognitoActive = true
        this.emit('incognito-detected', info)
      } else if (!isIncognito && this.incognitoActive) {
        this.incognitoActive = false
        this.emit('incognito-cleared', info)
      }
    }
    this.watcher.on('window-change', this.boundHandler)
  }

  /** 取消订阅 WindowWatcher 事件 */
  unwatch(): void {
    if (this.watcher && this.boundHandler) {
      this.watcher.removeListener('window-change', this.boundHandler)
    }
    this.watcher = null
    this.boundHandler = null
    this.incognitoActive = false
  }
}
