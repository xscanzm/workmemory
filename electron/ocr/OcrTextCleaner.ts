/**
 * OcrTextCleaner：OCR 文本去噪器
 *
 * 对 OCR 原始文本执行去噪处理，去除 UI 通用噪声（菜单栏、状态栏、按钮、地址栏 URL），
 * 合并碎片短行，去重重复行，输出清洗后文本与噪声评分。
 *
 * 职责：
 *  - clean(rawText)：去噪 + 行合并 + 去重 + 空行折叠
 *  - noiseScore = 噪声行数 / 总非空行数（0-1），空文本返回 1
 *
 * 噪声判定：一行文本若完全由噪声词组成，或匹配 URL/时间/电池等噪声模式，则视为噪声行。
 * 英文噪声词匹配大小写不敏感。
 *
 * 词表导出供 EpisodeBuilder.extractKeywords 等下游模块复用（保持词表一致）。
 */

/** 清洗结果 */
export interface CleanResult {
  /** 清洗后的文本（已 trim，连续空行折叠至最多 1 行） */
  cleanedText: string
  /** 噪声评分 0-1，空文本返回 1 */
  noiseScore: number
}

/** 中文菜单栏噪声词 */
export const CHINESE_MENU_WORDS: readonly string[] = [
  '文件',
  '编辑',
  '视图',
  '收藏',
  '工具',
  '帮助',
  '设置',
  '窗口'
]

/** 英文菜单栏噪声词（匹配时大小写不敏感） */
export const ENGLISH_MENU_WORDS: readonly string[] = [
  'File',
  'Edit',
  'View',
  'Favorites',
  'Tools',
  'Help',
  'Settings',
  'Window'
]

/** 中文按钮噪声词 */
export const CHINESE_BUTTON_WORDS: readonly string[] = [
  '确定',
  '取消',
  '保存',
  '关闭',
  '刷新',
  '返回',
  '搜索',
  '登录',
  '注册'
]

/** 英文按钮噪声词（匹配时大小写不敏感） */
export const ENGLISH_BUTTON_WORDS: readonly string[] = [
  'OK',
  'Cancel',
  'Save',
  'Close',
  'Refresh',
  'Back',
  'Search',
  'Login',
  'Register'
]

/** 状态栏网络指示噪声词（匹配时大小写不敏感） */
export const NETWORK_INDICATOR_WORDS: readonly string[] = [
  'WiFi',
  'Wi-Fi',
  'Bluetooth',
  '蓝牙',
  'Ethernet',
  '以太网',
  '5G',
  '4G',
  'LTE'
]

/**
 * 全部噪声词集合（英文转小写，用于大小写不敏感匹配）。
 * 中文词原样存入；英文词转小写后存入。
 */
const NOISE_WORDS_LOWER: Set<string> = new Set<string>([
  ...CHINESE_MENU_WORDS,
  ...CHINESE_BUTTON_WORDS,
  ...NETWORK_INDICATOR_WORDS,
  ...ENGLISH_MENU_WORDS.map((w) => w.toLowerCase()),
  ...ENGLISH_BUTTON_WORDS.map((w) => w.toLowerCase())
])

/** URL 噪声模式：http/https 开头的完整 URL 行 */
const URL_PATTERN = /^https?:\/\/\S+$/i

/** 时间格式噪声模式：HH:MM 或 HH:MM:SS，可选 上午/下午/AM/PM 前缀 */
const TIME_PATTERN = /^(?:(?:上午|下午|AM|PM)\s*)?\d{1,2}:\d{2}(?::\d{2})?$/i

/** 日期格式噪声模式：YYYY-MM-DD 或 YYYY/MM/DD */
const DATE_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/

/** 日期时间格式噪声模式：YYYY-MM-DD HH:MM[:SS] */
const DATETIME_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?$/

/** 电池百分比噪声模式：如 100%、50% */
const BATTERY_PATTERN = /^\d+%$/

/** 短行阈值：≤15 字视为短行，参与合并 */
const SHORT_LINE_MAX_LENGTH = 15

/** 句末标点（句号/问号/感叹号，中英文） */
const TERMINAL_PUNCTUATION = /[。？！.?!]/

/**
 * 判断一行文本是否为噪声行。
 *
 * 判定规则（满足任一即为噪声行）：
 *  1. 匹配 URL 模式（http/https 开头）
 *  2. 匹配时间 / 日期 / 日期时间模式
 *  3. 匹配电池百分比模式
 *  4. 按空白拆分后所有 token 均为噪声词（英文大小写不敏感）
 *
 * 空行（trim 后为空）不是噪声行。
 */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false

  if (URL_PATTERN.test(trimmed)) return true
  if (TIME_PATTERN.test(trimmed) || DATE_PATTERN.test(trimmed) || DATETIME_PATTERN.test(trimmed)) {
    return true
  }
  if (BATTERY_PATTERN.test(trimmed)) return true

  const tokens = trimmed.split(/\s+/)
  if (tokens.length === 0) return false
  for (const token of tokens) {
    if (!NOISE_WORDS_LOWER.has(token.toLowerCase())) {
      return false
    }
  }
  return true
}

/**
 * 判断一行文本是否为短行（参与合并）。
 * 短行定义：trim 后非空、长度 ≤15、不含句末标点（。？！.?!）。
 */
function isShortLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  if (trimmed.length > SHORT_LINE_MAX_LENGTH) return false
  if (TERMINAL_PUNCTUATION.test(trimmed)) return false
  return true
}

/**
 * 合并连续短行：同一组连续短行合并为一行（空格连接），
 * 空行作为段落分隔保留，非短行独立成段。
 */
function mergeShortLines(lines: string[]): string[] {
  const result: string[] = []
  let currentGroup: string[] = []

  const flushGroup = (): void => {
    if (currentGroup.length > 0) {
      result.push(currentGroup.join(' '))
      currentGroup = []
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      flushGroup()
      result.push('')
    } else if (isShortLine(trimmed)) {
      currentGroup.push(trimmed)
    } else {
      flushGroup()
      result.push(trimmed)
    }
  }
  flushGroup()

  return result
}

/**
 * 行级去重：完全相同的非空行只保留首次出现，空行不参与去重。
 */
function deduplicateLines(lines: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      result.push('')
      continue
    }
    if (seen.has(line)) continue
    seen.add(line)
    result.push(line)
  }
  return result
}

/**
 * 折叠连续空行：最多保留 1 个连续空行。
 */
function collapseEmptyLines(lines: string[]): string[] {
  const result: string[] = []
  let prevEmpty = false
  for (const line of lines) {
    const isEmpty = line.trim() === ''
    if (isEmpty) {
      if (prevEmpty) continue
      prevEmpty = true
      result.push('')
    } else {
      prevEmpty = false
      result.push(line)
    }
  }
  return result
}

/**
 * OcrTextCleaner：OCR 文本去噪器。
 *
 * 使用方式：
 *  - `new OcrTextCleaner().clean(rawText)`
 *  - `getOcrTextCleaner().clean(rawText)`（单例）
 */
export class OcrTextCleaner {
  /**
   * 清洗 OCR 原始文本。
   *
   * 处理流程：
   *  1. 空文本 / 纯空白文本 → { cleanedText: '', noiseScore: 1 }
   *  2. 规范化换行（\r\n / \r → \n）并拆分
   *  3. 统计噪声行与总非空行数，计算 noiseScore
   *  4. 移除噪声行（保留空行结构作为段落分隔）
   *  5. 合并连续短行（≤15 字且无句末标点）为一行
   *  6. 行级去重（完全相同的行只保留首次出现）
   *  7. 折叠连续空行（最多 1 行）
   *  8. trim 最终文本
   *
   * @param rawText OCR 原始文本
   * @returns 清洗结果（含 cleanedText 与 noiseScore）
   */
  clean(rawText: string): CleanResult {
    // 1. 空文本 / 纯空白文本
    if (!rawText || rawText.trim() === '') {
      return { cleanedText: '', noiseScore: 1 }
    }

    // 2. 规范化换行并拆分
    const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lines = normalized.split('\n')

    // 3. 统计噪声行 + 移除噪声行（一次遍历）
    let noiseLines = 0
    let totalNonEmptyLines = 0
    const nonNoiseLines: string[] = []

    for (const line of lines) {
      if (line.trim() === '') {
        nonNoiseLines.push('')
        continue
      }
      totalNonEmptyLines += 1
      if (isNoiseLine(line)) {
        noiseLines += 1
      } else {
        nonNoiseLines.push(line)
      }
    }

    // 全部为空行 → noiseScore = 1
    const noiseScore = totalNonEmptyLines === 0 ? 1 : noiseLines / totalNonEmptyLines

    // 4. 合并连续短行
    const merged = mergeShortLines(nonNoiseLines)

    // 5. 去重
    const deduped = deduplicateLines(merged)

    // 6. 折叠空行
    const collapsed = collapseEmptyLines(deduped)

    // 7. trim 最终文本（去除首尾空行）
    const cleanedText = collapsed.join('\n').trim()

    return { cleanedText, noiseScore }
  }
}

// ===================== 单例 =====================

let cleanerInstance: OcrTextCleaner | null = null

/** 获取 OcrTextCleaner 单例 */
export function getOcrTextCleaner(): OcrTextCleaner {
  if (!cleanerInstance) {
    cleanerInstance = new OcrTextCleaner()
  }
  return cleanerInstance
}

/** 重置单例（仅供测试） */
export function resetOcrTextCleaner(): void {
  cleanerInstance = null
}
