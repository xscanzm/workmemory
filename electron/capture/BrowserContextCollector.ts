/**
 * BrowserContextCollector：浏览器上下文采集器
 *
 * 采集浏览器窗口的 URL 上下文，增强对"浏览网页"活动的理解。
 *
 * 采集策略（首期实现）：
 *  - 标题解析通道：从 "页面标题 - 浏览器名" 格式提取页面标题
 *  - domain 推断：从 windowTitle 中匹配常见域名模式（如 "github.com"）
 *  - 隐私模式：调用 IncognitoDetector 检测无痕模式，无痕时返回空 URL
 *  - 浏览器扩展通道：首期不实现扩展通信，但 method 字段保留 'extension' 枚举值，
 *    为未来扩展预留接口
 *
 * 置信度：
 *  - 标题解析成功：0.6
 *  - 含域名匹配：0.8
 *  - 无痕/非浏览器：0
 *
 * 硬约束：仅处理窗口标题文本信息，不监听键盘/鼠标。
 */
import { IncognitoDetector } from './IncognitoDetector'
import type { WindowInfo } from './WindowWatcher'

/** 采集输入：浏览器窗口的关键字段 */
export interface BrowserWindowInput {
  processName: string
  windowTitle: string
}

/** 采集方法：title_parse=标题解析 / extension=浏览器扩展（首期未实现）/ none=未采集 */
export type BrowserContextMethod = 'title_parse' | 'extension' | 'none'

/** 采集结果 */
export interface BrowserContext {
  /** 推断的 URL（首期可能仅含 domain 或为空） */
  url: string
  /** 采集方法 */
  method: BrowserContextMethod
  /** 置信度 0-1 */
  confidence: number
}

/** 支持识别的浏览器进程名（小写，含/不含 .exe 后缀） */
const BROWSER_PROCESSES = new Set([
  'chrome.exe', 'chrome',
  'chromium.exe', 'chromium',
  'msedge.exe', 'msedge',
  'firefox.exe', 'firefox',
  'brave.exe', 'brave',
  'safari.exe', 'safari',
  'opera.exe', 'opera',
  'vivaldi.exe', 'vivaldi'
])

/** 浏览器标题后缀正则："页面标题 - 浏览器名" 格式（支持 - – — 三种连字符） */
const BROWSER_TITLE_SUFFIX_REGEX = /\s+[-–—]\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Firefox|Safari|Brave|Opera|Vivaldi|Chromium|Arc)\s*$/i
const EDGE_PROFILE_SUFFIX_REGEX = /\s+[-–—]\s+[^–—-]+?\s+[-–—]\s+Microsoft\s*Edge\s*$/i

/** 常见域名匹配正则（标题中直接出现的完整域名，含常见 TLD） */
const DOMAIN_REGEX = /\b([a-z0-9-]+\.(?:com|org|net|cn|io|dev|edu|gov|info|biz|co|ai|app|cloud|me|tv|us|uk|de|fr|jp|kr|ru|br|in|au|ca))\b/i

/** 无痕检测器实例（复用 IncognitoDetector 的纯检测逻辑） */
const incognitoDetector = new IncognitoDetector()

/**
 * 判断进程是否为支持的浏览器。
 */
function isBrowserProcess(processName: string): boolean {
  const normalized = processName.toLowerCase().trim()
  return BROWSER_PROCESSES.has(normalized)
}

/**
 * 从窗口标题中提取页面标题（去除浏览器名后缀）。
 * 例如 "WorkMemory - GitHub - Google Chrome" → "WorkMemory - GitHub"
 */
function parsePageTitle(windowTitle: string): string | null {
  const match = windowTitle.match(BROWSER_TITLE_SUFFIX_REGEX)
  if (match && match.index !== undefined) {
    const title = windowTitle.slice(0, match.index).trim()
    return title.length > 0 ? title : null
  }

  const edgeProfileMatch = windowTitle.match(EDGE_PROFILE_SUFFIX_REGEX)
  if (edgeProfileMatch && edgeProfileMatch.index !== undefined) {
    const title = windowTitle.slice(0, edgeProfileMatch.index).trim()
    return title.length > 0 ? title : null
  }

  return null
}

/**
 * 从窗口标题中提取域名（如标题中出现的 "github.com"）。
 */
function extractDomain(windowTitle: string): string | null {
  const match = windowTitle.match(DOMAIN_REGEX)
  return match ? match[1].toLowerCase() : null
}

/**
 * 采集浏览器 URL 上下文。
 *
 * 流程：
 *  1. 非浏览器进程 → { url: '', method: 'none', confidence: 0 }
 *  2. 无痕模式（IncognitoDetector 命中）→ { url: '', method: 'none', confidence: 0 }
 *  3. 标题解析失败（无浏览器后缀）→ { url: '', method: 'none', confidence: 0 }
 *  4. 标题解析成功 + 域名匹配 → { url: 'https://domain', method: 'title_parse', confidence: 0.8 }
 *  5. 标题解析成功（无域名）→ { url: '', method: 'title_parse', confidence: 0.6 }
 *
 * @param windowInfo 包含 processName 和 windowTitle 的窗口信息
 * @returns { url, method, confidence }
 */
export function collectBrowserUrl(windowInfo: BrowserWindowInput): BrowserContext {
  const processName = windowInfo.processName ?? ''
  const windowTitle = windowInfo.windowTitle ?? ''

  // 1. 非浏览器进程：直接返回 none
  if (!isBrowserProcess(processName)) {
    return { url: '', method: 'none', confidence: 0 }
  }

  // 2. 隐私模式检测：构造完整 WindowInfo 供 IncognitoDetector 使用
  //    IncognitoDetector.detect 仅使用 processName 和 windowTitle 字段
  const fullWindowInfo: WindowInfo = {
    hwnd: 0,
    processName,
    processPath: '',
    windowTitle,
    appName: processName.replace(/\.(exe|EXE)$/, '')
  }
  if (incognitoDetector.detect(fullWindowInfo)) {
    return { url: '', method: 'none', confidence: 0 }
  }

  // 3. 标题解析通道
  const pageTitle = parsePageTitle(windowTitle)
  if (!pageTitle) {
    // 浏览器进程但标题无法解析（如新标签页/空白页/无后缀）
    return { url: '', method: 'none', confidence: 0 }
  }

  // 4. domain 推断：从原始标题中匹配域名
  const domain = extractDomain(windowTitle)
  if (domain) {
    return {
      url: `https://${domain}`,
      method: 'title_parse',
      confidence: 0.8
    }
  }

  // 5. 仅标题解析成功，无域名匹配
  return {
    url: '',
    method: 'title_parse',
    confidence: 0.6
  }
}
