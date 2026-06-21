/**
 * LayoutAnalyzer：UI 布局分析器
 *
 * 基于 OCR 文本块的坐标分布识别屏幕布局类型
 * （form/list/article/editor/chat/dashboard/other），
 * 增强对屏幕内容的结构化理解。
 *
 * 识别策略（基于 OCR 块坐标分布）：
 *  - form: "标签 + 输入框"交替排列 + 按钮文字
 *  - list: 多行等间距短文本块
 *  - article: 长段落连续排列，无交互元素
 *  - editor: 代码缩进/行号特征 + 等宽字体区域
 *  - chat: 左右分栏对话气泡 + 头像区域 + 昵称模式
 *  - dashboard: 网格布局 + 数据卡片
 *
 * 置信度计算：每个候选类型有 3 条规则，
 *   confidence = 匹配规则数 / 3；取所有候选中最高分；
 *   若最高分 ≥ 0.5 则赋该类型，否则返回 'other'。
 *   并列时按迭代顺序靠前者优先（专用类型前置，list 兜底）。
 */
import type { LayoutRegion, LayoutType, OcrBlock } from '@/types'

/** 分析结果 */
export interface LayoutAnalysis {
  layoutType: LayoutType
  regions: LayoutRegion[]
  confidence: number
}

/** 置信度阈值：≥ 此值才赋具体布局类型，否则 other */
const CONFIDENCE_THRESHOLD = 0.5

/** 每个候选类型的规则总数 */
const RULES_PER_TYPE = 3

// ===================== 通用正则 =====================

/** 按钮文字关键词（中英文）。中文不用 \b（\b 在汉字后不生效），英文保留 \b 防止子串误匹配。 */
const BUTTON_KEYWORDS = /(提交|取消|确定|保存|重置|登录|注册|搜索|应用|关闭|确认)|(?:\b(?:submit|cancel|save|reset|login|sign in|sign up|search|apply|confirm|close|ok)\b)/i

/** 标签冒号模式（"姓名：" / "Name:" 结尾） */
const LABEL_COLON_REGEX = /[:：]\s*$/

/** 行号模式（行首数字 + 空格） */
const LINE_NUMBER_REGEX = /^\d{1,4}\s+/

/** 代码缩进特征（行首 2+ 空格或 tab） */
const CODE_INDENT_REGEX = /^(\s{2,}|\t+)/

/** 代码关键词（用于辅助识别代码块） */
const CODE_KEYWORD_REGEX = /\b(function|class|import|export|const|let|var|def|return|public|private|protected|void|interface|extends|implements|async|await|namespace|struct|enum|package|require|module|func|fn|if|else|for|while|switch|case|try|catch|finally|elif|endif)\b/

/** 昵称模式（"姓名:" 或 "姓名：" 开头） */
const NICKNAME_COLON_REGEX = /^[\u4e00-\u9fff\w]{1,12}\s*[:：]/

/** 数字模式（含小数、百分号、单位） */
const NUMERIC_REGEX = /\b\d+(\.\d+)?\s*(%|k|m|万|亿)?\b/

// ===================== 工具函数 =====================

/**
 * 从 OcrBlock 构造 LayoutRegion。
 * bounds 直接复用 block.box（{ x, y, w, h }），confidence 继承自源 block。
 */
function makeRegion(type: string, block: OcrBlock): LayoutRegion {
  return {
    type,
    bounds: { x: block.box.x, y: block.box.y, w: block.box.w, h: block.box.h },
    text: block.text,
    confidence: block.confidence
  }
}

/** 保留两位小数（与 ActivityClassifier 等模块的置信度精度一致） */
function round2(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

/** 计算变异系数 CV（标准差 / 均值），用于衡量离散程度 */
function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

/** 将相近的值（差值 < threshold）归为一类，返回聚类数组 */
function clusterValues(values: number[], threshold: number): number[][] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const clusters: number[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < threshold) {
      clusters[clusters.length - 1].push(sorted[i])
    } else {
      clusters.push([sorted[i]])
    }
  }
  return clusters
}

// ===================== 布局检测器 =====================

/**
 * form 检测：表单布局
 *  - labelInputPairs: 标签（冒号结尾短文本）+ 同行右侧较宽输入框，≥ 2 对
 *  - hasButton: 含按钮文字（提交/取消/Submit 等）
 *  - verticalStack: ≥ 3 个不同 y 坐标的标签（垂直排列的表单字段）
 */
function detectForm(blocks: OcrBlock[]): { matched: number; regions: LayoutRegion[] } {
  if (blocks.length === 0) return { matched: 0, regions: [] }

  const regions: LayoutRegion[] = []
  let matched = 0

  const sorted = [...blocks].sort((a, b) => a.box.y - b.box.y)
  const labels = sorted.filter(b => {
    const t = b.text.trim()
    return t.length <= 10 && LABEL_COLON_REGEX.test(t)
  })

  // 规则1：标签 + 输入框交替排列（≥ 2 对）
  let pairs = 0
  for (const label of labels) {
    const inputBlock = sorted.find(
      b =>
        b !== label &&
        Math.abs(b.box.y - label.box.y) < label.box.h * 0.8 &&
        b.box.x > label.box.x + label.box.w &&
        b.box.w > label.box.w * 1.5
    )
    if (inputBlock) {
      pairs++
      regions.push(makeRegion('label', label))
      regions.push(makeRegion('input', inputBlock))
    }
  }
  if (pairs >= 2) matched++

  // 规则2：按钮文字
  const buttons = blocks.filter(b => BUTTON_KEYWORDS.test(b.text.trim()))
  if (buttons.length >= 1) matched++
  for (const btn of buttons) {
    regions.push(makeRegion('button', btn))
  }

  // 规则3：垂直排列的表单字段（≥ 3 个不同 y 坐标的标签）
  const distinctY = new Set(labels.map(l => Math.round(l.box.y / 10)))
  if (labels.length >= 3 && distinctY.size >= 3) matched++
  // 为未配对的标签补充 label region
  for (const label of labels) {
    if (!regions.some(r => r.type === 'label' && r.text === label.text)) {
      regions.push(makeRegion('label', label))
    }
  }

  return { matched, regions }
}

/**
 * list 检测：列表布局
 *  - equalSpacing: 行间距均匀（CV < 0.3 且间距非负）
 *  - shortText: 文本长度相近且较短（平均长度 < 30，CV < 0.5）
 *  - lineCount: 行数 ≥ 5
 */
function detectList(blocks: OcrBlock[]): { matched: number; regions: LayoutRegion[] } {
  if (blocks.length < 2) return { matched: 0, regions: [] }

  const regions: LayoutRegion[] = []
  let matched = 0

  const sorted = [...blocks].sort((a, b) => a.box.y - b.box.y)

  // 规则1：行间距均匀
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].box.y - (sorted[i - 1].box.y + sorted[i - 1].box.h))
  }
  const gapCV = coefficientOfVariation(gaps)
  if (gaps.length >= 2 && gapCV < 0.3 && gaps.every(g => g >= 0)) matched++

  // 规则2：文本长度相近且较短
  const lengths = sorted.map(b => b.text.trim().length)
  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length
  const lenCV = coefficientOfVariation(lengths)
  if (avgLen > 0 && avgLen < 30 && lenCV < 0.5) matched++

  // 规则3：行数 ≥ 5
  if (sorted.length >= 5) {
    matched++
    for (const b of sorted) {
      regions.push(makeRegion('list-item', b))
    }
  }

  return { matched, regions }
}

/**
 * article 检测：文章布局
 *  - longParagraphs: 长段落占比 ≥ 50%（文本长度 ≥ 40）
 *  - noInteractive: 无交互元素（无按钮、无标签冒号）
 *  - paragraphSpacing: 段落间有空行（y 间距大于平均行高 0.5 倍）
 */
function detectArticle(blocks: OcrBlock[]): { matched: number; regions: LayoutRegion[] } {
  if (blocks.length === 0) return { matched: 0, regions: [] }

  const regions: LayoutRegion[] = []
  let matched = 0

  // 规则1：长段落占比 ≥ 50%
  const longBlocks = blocks.filter(b => b.text.trim().length >= 40)
  if (blocks.length > 0 && longBlocks.length / blocks.length >= 0.5) {
    matched++
    for (const b of longBlocks) {
      regions.push(makeRegion('paragraph', b))
    }
  }

  // 规则2：无交互元素（无按钮、无标签冒号）
  const hasButton = blocks.some(b => BUTTON_KEYWORDS.test(b.text.trim()))
  const hasLabel = blocks.some(b => LABEL_COLON_REGEX.test(b.text.trim()))
  if (!hasButton && !hasLabel) matched++

  // 规则3：段落间有空行
  const sorted = [...blocks].sort((a, b) => a.box.y - b.box.y)
  const avgH = sorted.reduce((s, b) => s + b.box.h, 0) / sorted.length
  let bigGaps = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].box.y - (sorted[i - 1].box.y + sorted[i - 1].box.h)
    if (gap > avgH * 0.5) bigGaps++
  }
  if (sorted.length >= 2 && bigGaps >= 1) matched++

  return { matched, regions }
}

/**
 * editor 检测：代码编辑器布局
 *  - codeFeatures: 代码缩进或关键词特征（≥ 3 个块）
 *  - lineNumber: 行号特征（行首数字 + 空格，连续递增 ≥ 2）
 *  - monospace: 等宽字体区域（字符宽度 CV < 0.3）
 */
function detectEditor(blocks: OcrBlock[]): { matched: number; regions: LayoutRegion[] } {
  if (blocks.length === 0) return { matched: 0, regions: [] }

  const regions: LayoutRegion[] = []
  let matched = 0

  // 规则1：代码缩进或关键词特征
  const codeBlocks = blocks.filter(
    b => CODE_INDENT_REGEX.test(b.text) || CODE_KEYWORD_REGEX.test(b.text)
  )
  if (codeBlocks.length >= 3) matched++

  // 规则2：行号特征（行首数字 + 空格，连续递增）
  const lineNumberBlocks = blocks.filter(b => LINE_NUMBER_REGEX.test(b.text.trim()))
  if (lineNumberBlocks.length >= 3) {
    const nums = lineNumberBlocks.map(
      b => parseInt(b.text.trim().match(/^\d+/)?.[0] ?? '0', 10)
    )
    let consecutive = 0
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === nums[i - 1] + 1) consecutive++
    }
    if (consecutive >= 2) {
      matched++
      for (const b of lineNumberBlocks) {
        regions.push(makeRegion('code-line', b))
      }
    }
  }

  // 规则3：等宽字体区域（字符宽度均匀）
  const charWidths = blocks
    .filter(b => b.text.trim().length >= 3)
    .map(b => b.box.w / b.text.trim().length)
  if (charWidths.length >= 3) {
    const cv = coefficientOfVariation(charWidths)
    if (cv < 0.3) matched++
  }

  return { matched, regions }
}

/**
 * chat 检测：聊天布局
 *  - leftRightSplit: 左右分栏对话气泡（左侧 ≥ 2 块，右侧 ≥ 2 块且靠右对齐）
 *  - avatarArea: 头像区域（小宽度 + 短文本 ≤ 2 字符，≥ 2 个）
 *  - nicknamePattern: 昵称模式（"姓名:" 开头，≥ 2 个）
 */
function detectChat(blocks: OcrBlock[]): { matched: number; regions: LayoutRegion[] } {
  if (blocks.length < 4) return { matched: 0, regions: [] }

  const regions: LayoutRegion[] = []
  let matched = 0

  // 计算 x 坐标范围
  const rightEdges = blocks.map(b => b.box.x + b.box.w)
  const minX = Math.min(...blocks.map(b => b.box.x))
  const maxX = Math.max(...rightEdges)
  const midX = (minX + maxX) / 2

  // 规则1：左右分栏对话气泡
  const leftBlocks = blocks.filter(b => b.box.x + b.box.w / 2 < midX)
  const rightBlocks = blocks.filter(b => b.box.x + b.box.w / 2 >= midX)
  if (leftBlocks.length >= 2 && rightBlocks.length >= 2) {
    // 右侧文本块靠右对齐（右边缘接近 maxX）
    const tolerance = (midX - minX) * 0.3
    const rightAligned = rightBlocks.filter(b => maxX - (b.box.x + b.box.w) < tolerance)
    if (rightAligned.length >= 1) {
      matched++
      for (const b of leftBlocks) {
        regions.push(makeRegion('bubble', b))
      }
      for (const b of rightBlocks) {
        regions.push(makeRegion('bubble', b))
      }
    }
  }

  // 规则2：头像区域（小宽度 + 短文本）
  const avgW = blocks.reduce((s, b) => s + b.box.w, 0) / blocks.length
  const avatars = blocks.filter(
    b => b.box.w < avgW * 0.5 && b.text.trim().length <= 2 && b.text.trim().length > 0
  )
  if (avatars.length >= 2) {
    matched++
    for (const b of avatars) {
      regions.push(makeRegion('avatar', b))
    }
  }

  // 规则3：昵称模式（"姓名:" 开头）
  const nicknames = blocks.filter(b => NICKNAME_COLON_REGEX.test(b.text.trim()))
  if (nicknames.length >= 2) {
    matched++
    for (const b of nicknames) {
      regions.push(makeRegion('nickname', b))
    }
  }

  return { matched, regions }
}

/**
 * dashboard 检测：仪表盘布局
 *  - gridLayout: 网格布局（x 聚类 ≥ 2 列 + y 聚类 ≥ 2 行）
 *  - dataCards: 数据卡片（数字块附近有短文本标签，≥ 2 组）
 *  - numericData: 多个数字文本块（≥ 3 个）
 */
function detectDashboard(blocks: OcrBlock[]): { matched: number; regions: LayoutRegion[] } {
  if (blocks.length < 4) return { matched: 0, regions: [] }

  const regions: LayoutRegion[] = []
  let matched = 0

  // 规则1：网格布局（x 聚类 ≥ 2 列 + y 聚类 ≥ 2 行）
  const xs = blocks.map(b => b.box.x)
  const ys = blocks.map(b => b.box.y)
  const xClusters = clusterValues(xs, 20)
  const yClusters = clusterValues(ys, 20)
  if (xClusters.length >= 2 && yClusters.length >= 2) matched++

  // 规则2：数据卡片（数字块附近有短文本标签）
  const numericBlocks = blocks.filter(b => NUMERIC_REGEX.test(b.text.trim()))
  let cardCount = 0
  for (const num of numericBlocks) {
    const nearbyLabel = blocks.find(
      b =>
        b !== num &&
        Math.abs(b.box.y - num.box.y) < num.box.h * 2 &&
        b.text.trim().length <= 10 &&
        !NUMERIC_REGEX.test(b.text.trim())
    )
    if (nearbyLabel) {
      cardCount++
      regions.push(makeRegion('card', num))
      regions.push(makeRegion('card-label', nearbyLabel))
    }
  }
  if (cardCount >= 2) matched++

  // 规则3：多个数字文本块
  if (numericBlocks.length >= 3) matched++

  return { matched, regions }
}

// ===================== 主分析器 =====================

/**
 * 候选布局检测器列表。
 * 顺序即并列时的优先级（专用类型前置，list 作为兜底靠后）。
 */
const DETECTORS: Array<{
  type: Exclude<LayoutType, 'other'>
  detect: (blocks: OcrBlock[]) => { matched: number; regions: LayoutRegion[] }
}> = [
  { type: 'editor', detect: detectEditor },
  { type: 'chat', detect: detectChat },
  { type: 'dashboard', detect: detectDashboard },
  { type: 'form', detect: detectForm },
  { type: 'article', detect: detectArticle },
  { type: 'list', detect: detectList }
]

/**
 * 分析 OCR 文本块的布局类型。
 *
 * 基于 OCR 块的坐标分布识别屏幕布局（form/list/article/editor/chat/dashboard），
 * 并提取布局区域（button/input/label/paragraph/bubble/avatar/card 等）。
 *
 * @param ocrBlocks OCR 文本块数组
 * @returns { layoutType, regions, confidence }；置信度不足时 layoutType='other'
 */
export function analyzeLayout(ocrBlocks: OcrBlock[]): LayoutAnalysis {
  if (!ocrBlocks || ocrBlocks.length === 0) {
    return { layoutType: 'other', regions: [], confidence: 0 }
  }

  let best: { type: LayoutType; score: number; regions: LayoutRegion[] } = {
    type: 'other',
    score: 0,
    regions: []
  }

  for (const { type, detect } of DETECTORS) {
    const { matched, regions } = detect(ocrBlocks)
    const score = matched / RULES_PER_TYPE
    if (score > best.score) {
      best = { type, score, regions }
    }
  }

  const confidence = round2(best.score)
  if (confidence >= CONFIDENCE_THRESHOLD) {
    return { layoutType: best.type, regions: best.regions, confidence }
  }
  return { layoutType: 'other', regions: [], confidence }
}
