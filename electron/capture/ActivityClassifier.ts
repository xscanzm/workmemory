/**
 * ActivityClassifier：活动类型识别器
 *
 * 基于 appName / windowTitle / ocrText 推断用户当前的活动类型。
 *
 * 分类策略（应用名优先 → 窗口标题增强 → OCR 文本模式验证）：
 *  - 应用名优先：VS Code→coding 候选，微信/飞书/Slack→chatting 候选，Chrome/Edge→browsing 候选
 *  - 窗口标题增强：文件扩展名、文档名、URL、会议/群聊关键词等
 *  - OCR 文本模式验证：代码关键词、对话气泡（短行+时间戳）、段落结构（长段落）等
 *
 * 置信度计算：每个候选类型有 3 条规则（app / title / ocr），
 *   confidence = 匹配规则数 / 3；取所有候选中最高分；
 *   若最高分 ≥ 0.6 则赋该类型，否则返回 'idle'。
 *   并列时优先 app 命中的类型（应用名优先原则）。
 */
import type { ActivityType, OcrBlock } from '@/types'

/** 分类输入：与 WorkSegment 的关键字段对齐 */
export interface ActivitySegmentInput {
  appName: string
  windowTitle: string
  ocrText: string
  ocrBlocks?: OcrBlock[]
}

/** 分类输出 */
export interface ActivityClassification {
  activityType: ActivityType
  confidence: number
}

/** 置信度阈值：≥ 此值才赋具体活动类型，否则 idle */
const CONFIDENCE_THRESHOLD = 0.6

/** 每个候选类型的规则总数（app / title / ocr 各一条） */
const RULES_PER_TYPE = 3

/**
 * 候选活动类型规则集。
 * - appKeywords：应用名小写包含匹配
 * - titlePatterns：窗口标题正则匹配（大小写不敏感，无 g 标志以保证 test 无状态）
 * - ocrMatch：OCR 文本模式验证函数（代码关键词 / 对话气泡 / 段落结构等）
 */
interface ActivityRuleSet {
  appKeywords: string[]
  titlePatterns: RegExp[]
  ocrMatch: (ocrText: string, blocks: OcrBlock[]) => boolean
}

/** 代码文件扩展名（窗口标题中出现 → coding 标题增强） */
const CODE_FILE_EXT_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|scala|go|rs|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|clj|ex|exs|erl|hs|ml|lua|pl|sh|bash|zsh|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less|json|yaml|yml|toml|ini|xml|gradle|csproj|cs|fs|fsx)\b/i

/** 代码关键词（OCR 文本中出现 → coding OCR 验证） */
const CODE_KEYWORD_REGEX = /\b(function|class|import|export|const|let|var|def|return|public|private|protected|void|interface|extends|implements|async|await|namespace|struct|enum|package|require|module|func|fn|typedef|new|throw|try|catch|finally|elif|endif|endfunc|endclass)\b/

/** 代码符号特征（箭头函数 / 行尾分号 / include 指令） */
const CODE_SYMBOL_REGEX = /=>|#(include|define|pragma|import|ifndef|ifdef)|;\s*$/

/** 文档扩展名（窗口标题中出现 → writing 标题增强） */
const DOC_FILE_EXT_REGEX = /\.(docx?|md|markdown|txt|rtf|pages|odt|tex|rst|org)\b/i

/** 长段落特征：含两个及以上句末标点的连续文本（中英文） */
const LONG_PARAGRAPH_REGEX = /[。！？.!?].{15,}[。！？.!?]/

/** 长行特征：单行 40 字符以上（写作/阅读的段落结构） */
function hasLongLine(text: string): boolean {
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.trim().length >= 40) return true
  }
  return false
}

/** 阅读材料扩展名（PDF/EPUB 等 → reading 标题增强） */
const READING_FILE_EXT_REGEX = /\.(pdf|epub|mobi|azw3?|djvu?|cbz|cbr)\b/i

/** 页码特征（x/y 或 第 x 页 → reading OCR 验证） */
const PAGE_NUMBER_REGEX = /(\b\d+\s*[/／]\s*\d+\b)|(第\s*\d+\s*页)/

/** URL 特征（窗口标题或 OCR 中出现 → browsing） */
const URL_REGEX = /https?:\/\//i

/** 浏览器标题后缀（"xxx - Google Chrome" 等 → browsing 标题增强） */
const BROWSER_TITLE_SUFFIX_REGEX = / - (google chrome|microsoft edge|mozilla firefox|firefox|safari|brave|opera|vivaldi|arc|chromium)\s*$/i

/** 顶级域名片段（标题/OCR 中出现 → browsing） */
const TLD_REGEX = /\.(com|org|net|cn|io|dev|edu|gov|info|biz|co)\b/i

/** 浏览器常见 UI 词（搜索/登录/首页等 → browsing OCR 验证） */
const BROWSER_UI_REGEX = /(搜索|search|登录|login|sign in|注册|首页|home|导航|navigation|收藏|bookmark|刷新|refresh|后退|back|前进|forward)/i

/** 聊天时间戳（HH:MM → chatting OCR 验证） */
const CHAT_TIMESTAMP_REGEX = /\b\d{1,2}:\d{2}\b/

/** 聊天"姓名:消息"特征（中英文冒号 → chatting OCR 验证） */
const CHAT_NAME_COLON_REGEX = /[\u4e00-\u9fff\w]{1,12}\s*[:：]\s*[\u4e00-\u9fff\w]/

/** 聊天动作词（发送/回复/转发等 → chatting OCR 验证） */
const CHAT_ACTION_REGEX = /(发送|回复|转发|表情|语音|视频通话|在线|离线|已读|未读|输入中|send|reply|forward|emoji)/i

/** 聊天表情占位（[微笑] 等 → chatting OCR 验证） */
const CHAT_EMOJI_PLACEHOLDER_REGEX = /\[[^\]\n]{1,8}\]/

/** 设计工具 UI 词（图层/画布/对齐等 → designing OCR 验证） */
const DESIGN_UI_REGEX = /(工具|图层|layer|canvas|画布|画板|artboard|对齐|align|描边|stroke|填充|fill|矢量|vector|组件|component|蒙版|mask)/i

/** 设计尺寸/单位（px/mm/cm/pt/% → designing OCR 验证） */
const DESIGN_UNIT_REGEX = /\b\d+(\.\d+)?\s*(px|mm|cm|pt|vw|vh|em|rem)\b/i

/** 颜色值（#hex / rgb() → designing OCR 验证） */
const COLOR_VALUE_REGEX = /(#[0-9a-fA-F]{6}\b)|(\b(rgb|hsl)\s*\()/

/** 设计文件扩展名（.fig/.psd 等 → designing 标题增强） */
const DESIGN_FILE_EXT_REGEX = /\.(fig|sketch|psd|ai|xd|indd|ase|afdesign|clip)\b/i

/** 会议控制词（静音/共享屏幕/参会者等 → meeting OCR 验证） */
const MEETING_CONTROL_REGEX = /(静音|取消静音|mute|unmute|共享屏幕|share screen|参会者|participants|摄像头|camera|麦克风|microphone|mic|举手|hand raise|离开会议|leave|结束会议|end meeting|邀请|invite)/i

/** 会议计时器（HH:MM:SS → meeting OCR 验证） */
const MEETING_TIMER_REGEX = /\b\d{1,2}:\d{2}:\d{2}\b/

/** 文件管理动作词（复制/粘贴/删除等 → managing OCR 验证） */
const FILE_ACTION_REGEX = /(文件夹|目录|新建文件夹|复制|粘贴|删除|重命名|属性|files|folder|new folder|copy|paste|delete|rename|properties|移动|剪切)/i

/** 文件大小（KB/MB/GB → managing OCR 验证，常见于文件列表） */
const FILE_SIZE_REGEX = /\b\d+(\.\d+)?\s*(KB|MB|GB|TB|字节|byte)\b/i

/** Windows 路径（C:\ → managing OCR 验证） */
const WINDOWS_PATH_REGEX = /\b[A-Za-z]:[\\/]/

/** Unix 路径（/home/Users 等 → managing OCR 验证） */
const UNIX_PATH_REGEX = /\/(home|Users|usr|etc|var|opt|tmp)\b/

/**
 * 各候选活动类型的规则集。
 * 顺序即并列时的优先级（更专用的工具类靠前）。
 */
const RULE_SETS: Record<Exclude<ActivityType, 'idle'>, ActivityRuleSet> = {
  coding: {
    appKeywords: [
      'visual studio code', 'vscode', 'code', 'cursor', 'sublime', 'neovim',
      'nvim', 'vim', 'emacs', 'atom', 'eclipse', 'intellij', 'idea',
      'webstorm', 'goland', 'pycharm', 'rubymine', 'phpstorm', 'android studio',
      'xcode', 'visual studio', 'netbeans', 'fleet', 'zed', 'helix', 'textmate',
      'code - oss', 'vscodium'
    ],
    titlePatterns: [CODE_FILE_EXT_REGEX, /\bgit\b/i, /\b(branch|commit|pull request|merge|rebase|stash|diff|conflict)\b/i],
    ocrMatch: (text) => CODE_KEYWORD_REGEX.test(text) || CODE_SYMBOL_REGEX.test(text) || /\bfunction\s*\(/.test(text)
  },
  designing: {
    appKeywords: [
      'figma', 'sketch', 'photoshop', 'illustrator', 'blender', 'adobe xd',
      'affinity', 'coreldraw', 'indesign', 'after effects', 'premiere',
      'canva', 'framer', 'principle', 'procreate', 'gimp', 'inkscape',
      'cinema 4d', 'c4d', 'lightroom', 'davinci'
    ],
    titlePatterns: [/(untitled|artboard|layer|canvas|画板|图层|画布|设计)/i, DESIGN_FILE_EXT_REGEX],
    ocrMatch: (text) => DESIGN_UI_REGEX.test(text) || DESIGN_UNIT_REGEX.test(text) || COLOR_VALUE_REGEX.test(text)
  },
  meeting: {
    appKeywords: [
      'zoom', '腾讯会议', 'tencent meeting', 'google meet', 'meet',
      'webex', 'gotomeeting', '钉钉会议', '飞书会议', 'lark meeting',
      'teams', '微软会议', 'voov', 'skype for business', '腾讯会议'
    ],
    titlePatterns: [/(会议|meeting|conference|通话|call|webinar|研讨会)/i, /(zoom|teams|webex|腾讯会议|钉钉会议|飞书会议|google meet)/i],
    ocrMatch: (text) => MEETING_CONTROL_REGEX.test(text) || MEETING_TIMER_REGEX.test(text)
  },
  chatting: {
    appKeywords: [
      '微信', 'wechat', '飞书', 'lark', 'slack', 'discord', 'telegram',
      'qq', '钉钉', 'dingtalk', 'skype', 'whatsapp', 'signal', 'imessage',
      'messages', 'line', '企业微信', 'tim', '飞书'
    ],
    titlePatterns: [/(聊天|群|消息|会话|chat|channel|direct message|\bdm\b|群聊)/i, /(微信|飞书|slack|discord|telegram|钉钉|qq)/i],
    ocrMatch: (text, blocks) => {
      // 文本模式：时间戳 / 姓名:消息 / 动作词 / 表情占位
      const patternHit =
        CHAT_TIMESTAMP_REGEX.test(text) ||
        CHAT_NAME_COLON_REGEX.test(text) ||
        CHAT_ACTION_REGEX.test(text) ||
        CHAT_EMOJI_PLACEHOLDER_REGEX.test(text)
      if (patternHit) return true
      // 对话气泡结构：多个短文本块（无坐标信息时退化为短行占比）
      if (blocks.length >= 4) {
        const shortRatio = blocks.filter(b => b.text.trim().length < 15).length / blocks.length
        return shortRatio >= 0.5
      }
      const lines = text.split('\n').filter(l => l.trim().length > 0)
      if (lines.length >= 4) {
        const shortRatio = lines.filter(l => l.trim().length < 15).length / lines.length
        return shortRatio >= 0.6
      }
      return false
    }
  },
  writing: {
    appKeywords: [
      'word', 'winword', 'wps', 'notion', 'obsidian', 'typora', 'markdown',
      'pages', 'google docs', 'onedrive', 'onenote', 'evernote', '印象笔记',
      '有道云笔记', '语雀', '腾讯文档', '石墨文档', 'bear', 'ulysses',
      'scrivener', 'ia writer', 'marktext', 'zettlr', '飞书文档'
    ],
    titlePatterns: [DOC_FILE_EXT_REGEX, /(文档|笔记|日记|草稿|大纲|memo|note|journal|draft)/i],
    ocrMatch: (text) => LONG_PARAGRAPH_REGEX.test(text) || hasLongLine(text)
  },
  reading: {
    appKeywords: [
      'acrobat', 'foxit', 'pdf', 'calibre', 'kindle', 'preview', '预览',
      '阅读器', 'books', 'adobe reader', 'sumatrapdf', 'pdfexpert', 'pdfpen',
      'zotero', 'mendeley', 'wps pdf', '福昕', 'edge pdf'
    ],
    titlePatterns: [READING_FILE_EXT_REGEX, /(阅读模式|reader mode|pdf)/i],
    ocrMatch: (text) => PAGE_NUMBER_REGEX.test(text) || (LONG_PARAGRAPH_REGEX.test(text) && hasLongLine(text))
  },
  browsing: {
    appKeywords: [
      'chrome', 'edge', 'firefox', 'safari', 'brave', 'opera', 'vivaldi',
      'arc', 'chromium', 'duckduckgo', 'maxthon', '360se', '360浏览器',
      '猎豹', 'qq浏览器', '搜狗浏览器', 'uc浏览器', 'yandex', 'tor browser'
    ],
    titlePatterns: [URL_REGEX, BROWSER_TITLE_SUFFIX_REGEX, TLD_REGEX],
    ocrMatch: (text) => URL_REGEX.test(text) || BROWSER_UI_REGEX.test(text) || TLD_REGEX.test(text)
  },
  managing: {
    appKeywords: [
      'explorer', '文件资源管理器', 'finder', '访达', 'settings', '设置',
      '控制面板', 'control panel', 'task manager', '任务管理器',
      'system preferences', '系统偏好', 'terminal', '终端', 'powershell',
      'cmd', 'registry', '注册表', '活动监视器', 'activity monitor',
      'nautilus', 'thunar', 'dolphin', '系统设置'
    ],
    titlePatterns: [/(文件夹|目录|files|folder|settings|设置|控制面板|任务管理器|system preferences|终端|terminal|资源管理器)/i],
    ocrMatch: (text) => FILE_ACTION_REGEX.test(text) || FILE_SIZE_REGEX.test(text) || WINDOWS_PATH_REGEX.test(text) || UNIX_PATH_REGEX.test(text)
  }
}

/** 候选类型迭代顺序（并列时靠前者优先，已将更专用的工具类前置） */
const TYPE_ORDER: Array<Exclude<ActivityType, 'idle'>> = [
  'coding', 'designing', 'meeting', 'chatting', 'writing', 'reading', 'browsing', 'managing'
]

/**
 * ActivityClassifier：活动类型识别器。
 */
export class ActivityClassifier {
  /**
   * 推断单个 segment 的活动类型。
   *
   * @param segment 包含 appName / windowTitle / ocrText / ocrBlocks 的片段
   * @returns { activityType, confidence }；置信度不足时 activityType='idle'
   */
  classifyActivity(segment: ActivitySegmentInput): ActivityClassification {
    const appName = (segment.appName ?? '').toLowerCase()
    const windowTitle = segment.windowTitle ?? ''
    const ocrText = segment.ocrText ?? ''
    const blocks = segment.ocrBlocks ?? []

    // ocrText 为空时从 blocks 聚合，保证 OCR 验证可用
    const effectiveOcrText = ocrText.trim().length > 0 ? ocrText : blocks.map(b => b.text).join('\n')

    let best: { type: ActivityType; score: number; appMatched: boolean } = {
      type: 'idle',
      score: 0,
      appMatched: false
    }

    for (const type of TYPE_ORDER) {
      const rules = RULE_SETS[type]
      const appMatched = rules.appKeywords.some(k => appName.includes(k))
      const titleMatched = rules.titlePatterns.some(p => p.test(windowTitle))
      const ocrMatched = rules.ocrMatch(effectiveOcrText, blocks)
      const matched = Number(appMatched) + Number(titleMatched) + Number(ocrMatched)
      const score = matched / RULES_PER_TYPE

      // 取最高分；并列时 app 命中者优先（应用名优先原则）；再并列则迭代顺序靠前者优先
      if (score > best.score || (score === best.score && appMatched && !best.appMatched)) {
        best = { type, score, appMatched }
      }
    }

    const confidence = round2(best.score)
    if (confidence >= CONFIDENCE_THRESHOLD) {
      return { activityType: best.type, confidence }
    }
    return { activityType: 'idle', confidence }
  }
}

/** 保留两位小数（与 EntityExtractor 等模块的置信度精度一致） */
function round2(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

/** 默认实例，供独立函数复用 */
const defaultClassifier = new ActivityClassifier()

/**
 * 独立分类函数：推断单个 segment 的活动类型。
 * 等价于 `new ActivityClassifier().classifyActivity(segment)`。
 */
export function classifyActivity(segment: ActivitySegmentInput): ActivityClassification {
  return defaultClassifier.classifyActivity(segment)
}
