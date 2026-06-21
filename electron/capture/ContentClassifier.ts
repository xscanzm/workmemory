/**
 * ContentClassifier：内容类型分类器
 *
 * 识别屏幕内容类型（chat/webpage/document/code/video/forum/product/other）
 * 并提取类型特定结构化数据。
 *
 * 分类策略（应用名优先 → 窗口标题增强 → OCR 文本模式验证）：
 *  - 应用名优先：微信/飞书/Slack → chat 候选，Chrome/Edge → webpage 候选
 *  - 窗口标题增强：URL/标题特征、文件扩展名、平台名等
 *  - OCR 文本模式验证：对话气泡、价格模式、播放控件、帖子列表等
 *
 * 置信度计算：每个候选类型有 3 条规则（app / title / ocr），
 *   confidence = 匹配规则数 / 3；取所有候选中最高分；
 *   若最高分 ≥ 0.5 则赋该类型，否则返回 'other'。
 *   并列时优先 app 命中的类型（应用名优先原则）。
 */
import type { ContentType, OcrBlock } from '@/types'

/** 分类输入：与 WorkSegment 的关键字段对齐 */
export interface ContentSegmentInput {
  appName: string
  windowTitle: string
  ocrText: string
  ocrBlocks?: OcrBlock[]
}

/** 分类输出 */
export interface ContentClassification {
  contentType: ContentType
  contentData: Record<string, unknown>
  confidence: number
}

/** 置信度阈值：≥ 此值才赋具体内容类型，否则 other */
const CONFIDENCE_THRESHOLD = 0.5

/** 每个候选类型的规则总数（app / title / ocr 各一条） */
const RULES_PER_TYPE = 3

/** 候选内容类型规则集 */
interface ContentRuleSet {
  appKeywords: string[]
  titlePatterns: RegExp[]
  ocrMatch: (ocrText: string, blocks: OcrBlock[]) => boolean
}

// ===================== 通用正则 =====================

/** URL 特征 */
const URL_REGEX = /https?:\/\/[^\s<>"'，。、；：！？）】}]+/i

/** 浏览器标题后缀（"xxx - Google Chrome" 等） */
const BROWSER_TITLE_SUFFIX_REGEX = / - (google chrome|microsoft edge|mozilla firefox|firefox|safari|brave|opera|vivaldi|arc|chromium)\s*$/i

/** 顶级域名片段 */
const TLD_REGEX = /\.(com|org|net|cn|io|dev|edu|gov|info|biz|co)\b/i

/** 浏览器常见 UI 词 */
const BROWSER_UI_REGEX = /(搜索|search|登录|login|sign in|注册|首页|home|导航|navigation|收藏|bookmark|刷新|refresh|后退|back|前进|forward)/i

/** 代码文件扩展名 */
const CODE_FILE_EXT_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|scala|go|rs|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|clj|ex|exs|erl|hs|ml|lua|pl|sh|bash|zsh|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less|json|yaml|yml|toml|ini|xml|gradle|csproj|cs|fs|fsx)\b/i

/** 代码关键词 */
const CODE_KEYWORD_REGEX = /\b(function|class|import|export|const|let|var|def|return|public|private|protected|void|interface|extends|implements|async|await|namespace|struct|enum|package|require|module|func|fn|typedef|new|throw|try|catch|finally|elif|endif|endfunc|endclass)\b/

/** 代码符号特征（箭头函数 / 行尾分号 / include 指令） */
const CODE_SYMBOL_REGEX = /=>|#(include|define|pragma|import|ifndef|ifdef)|;\s*$/

/** 文档扩展名 */
const DOC_FILE_EXT_REGEX = /\.(docx?|md|markdown|txt|rtf|pages|odt|tex|rst|org|pdf|epub|mobi)\b/i

/** 长段落特征：含两个及以上句末标点的连续文本 */
const LONG_PARAGRAPH_REGEX = /[。！？.!?].{15,}[。！？.!?]/

/** 长行特征：单行 40 字符以上 */
function hasLongLine(text: string): boolean {
  for (const line of text.split('\n')) {
    if (line.trim().length >= 40) return true
  }
  return false
}

/** 聊天时间戳（HH:MM） */
const CHAT_TIMESTAMP_REGEX = /\b\d{1,2}:\d{2}\b/

/** 聊天"姓名:消息"特征（中英文冒号） */
const CHAT_NAME_COLON_REGEX = /[\u4e00-\u9fff\w]{1,12}\s*[:：]\s*[\u4e00-\u9fff\w]/

/** 聊天动作词 */
const CHAT_ACTION_REGEX = /(发送|回复|转发|表情|语音|视频通话|在线|离线|已读|未读|输入中|send|reply|forward|emoji)/i

/** 聊天表情占位（[微笑] 等） */
const CHAT_EMOJI_PLACEHOLDER_REGEX = /\[[^\]\n]{1,8}\]/

/** 视频播放控件词 */
const VIDEO_CONTROL_REGEX = /(播放|暂停|play|pause|下一个|next|倍速|speed|画质|quality|全屏|fullscreen|弹幕|danmaku|字幕|subtitle|cc)/i

/** 视频进度条模式（"0:39 / 5:23" 或 "00:39 / 05:23"） */
const VIDEO_PROGRESS_REGEX = /\b\d{1,2}:\d{2}(:\d{2})?\s*[/／]\s*\d{1,2}:\d{2}(:\d{2})?\b/

/** 视频弹幕/平台词 */
const VIDEO_DANMAKU_REGEX = /(弹幕|danmaku|bili|哔哩|三连|投币|收藏|点赞)/i

/** 论坛帖子列表特征词 */
const FORUM_LIST_REGEX = /(回复|reply|查看|view|浏览|主题|topic|帖子|post|板块|节点|node|楼主|板凳|沙发)/i

/** 论坛作者/回复数元数据模式 */
const FORUM_POST_META_REGEX = /(@[\u4e00-\u9fff\w]+|\d+\s*(回复|reply|评论|comment|查看|view|浏览))/i

/** 商品价格模式（¥/$/￥ + 数字，含千分位和小数） */
const PRODUCT_PRICE_REGEX = /[¥￥$]\s*\d{1,3}(,\d{3})*(\.\d+)?/

/** 商品购物 UI 词 */
const PRODUCT_UI_REGEX = /(加入购物车|立即购买|加入心愿单|add to cart|buy now|add to wishlist|收藏|评价|评论|月销|已售|销量|库存|发货|包邮|正品)/i

/** 聊天关键消息关键词（用于提取 keyMessages） */
const CHAT_KEY_MESSAGE_REGEX = /(需求|问题|会议|明天|今天|紧急|重要|todo|任务|项目|deadline|urgent|important|meeting|today|tomorrow|上线|发布|修复|bug)/i

// ===================== 应用名 → 平台映射（长键优先以避免子串误匹配） =====================

/** 聊天应用 → 平台名 */
const CHAT_APP_PLATFORM: Record<string, string> = {
  '企业微信': 'wechat-work',
  '微信': 'wechat', 'wechat': 'wechat',
  '飞书': 'lark', 'lark': 'lark',
  'slack': 'slack', 'discord': 'discord', 'telegram': 'telegram',
  '钉钉': 'dingtalk', 'dingtalk': 'dingtalk',
  'qq': 'qq', 'tim': 'qq',
  'skype': 'skype', 'whatsapp': 'whatsapp', 'signal': 'signal',
  'imessage': 'imessage', 'messages': 'imessage', 'line': 'line'
}

/** 视频应用 → 平台名 */
const VIDEO_APP_PLATFORM: Record<string, string> = {
  '哔哩哔哩': 'bilibili', 'bilibili': 'bilibili', '哔哩': 'bilibili',
  'youtube': 'youtube', 'netflix': 'netflix',
  '腾讯视频': 'tencent-video', 'qq视频': 'tencent-video',
  '优酷': 'youku', 'youku': 'youku',
  '爱奇艺': 'iqiyi', 'iqiyi': 'iqiyi',
  'potplayer': 'potplayer', 'quicktime': 'quicktime',
  'mpc-hc': 'mpc', 'mpc-be': 'mpc', 'mpc': 'mpc',
  'kmplayer': 'kmplayer', 'mplayer': 'mplayer',
  'vlc': 'vlc', 'mpv': 'mpv',
  '暴风影音': 'baofeng', '迅雷看看': 'xunlei'
}

/** 商品应用 → 来源平台 */
const PRODUCT_APP_SOURCE: Record<string, string> = {
  '京东商城': 'jd', '京东': 'jd', 'jd': 'jd',
  '淘宝': 'taobao', 'taobao': 'taobao',
  '亚马逊': 'amazon', 'amazon': 'amazon',
  '拼多多': 'pinduoduo', 'pinduoduo': 'pinduoduo',
  '天猫': 'tmall', 'tmall': 'tmall',
  '苏宁': 'suning', 'suning': 'suning',
  '唯品会': 'vipshop', 'vipshop': 'vipshop',
  '当当': 'dangdang', 'dangdang': 'dangdang',
  '闲鱼': 'xianyu'
}

/** 论坛应用 → 平台名 */
const FORUM_APP_PLATFORM: Record<string, string> = {
  'reddit': 'reddit', 'v2ex': 'v2ex',
  '掘金': 'juejin', 'juejin': 'juejin',
  '知乎': 'zhihu', 'zhihu': 'zhihu',
  '贴吧': 'tieba', 'tieba': 'tieba',
  'hacker news': 'hacker-news', 'lobsters': 'lobsters',
  'discourse': 'discourse', 'nodeseek': 'nodeseek'
}

// ===================== 规则集 =====================

const RULE_SETS: Record<Exclude<ContentType, 'other'>, ContentRuleSet> = {
  chat: {
    appKeywords: Object.keys(CHAT_APP_PLATFORM),
    titlePatterns: [
      /(聊天|群|消息|会话|chat|channel|direct message|\bdm\b|群聊)/i,
      /(微信|飞书|slack|discord|telegram|钉钉|qq)/i
    ],
    ocrMatch: (text, blocks) => {
      const patternHit =
        CHAT_TIMESTAMP_REGEX.test(text) ||
        CHAT_NAME_COLON_REGEX.test(text) ||
        CHAT_ACTION_REGEX.test(text) ||
        CHAT_EMOJI_PLACEHOLDER_REGEX.test(text)
      if (patternHit) return true
      // 对话气泡结构：多个短文本块
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
  video: {
    appKeywords: Object.keys(VIDEO_APP_PLATFORM),
    titlePatterns: [
      /(视频|video|播放|player|movie|电影|剧集|番剧|直播|live|bilibili|youtube|netflix|优酷|爱奇艺|腾讯视频)/i
    ],
    ocrMatch: (text) =>
      VIDEO_CONTROL_REGEX.test(text) ||
      VIDEO_PROGRESS_REGEX.test(text) ||
      VIDEO_DANMAKU_REGEX.test(text)
  },
  forum: {
    appKeywords: Object.keys(FORUM_APP_PLATFORM),
    titlePatterns: [
      /(帖子|主题|thread|post|板块|节点|node|讨论区|社区|forum|reddit|v2ex|掘金|知乎|贴吧)/i
    ],
    ocrMatch: (text) => FORUM_LIST_REGEX.test(text) || FORUM_POST_META_REGEX.test(text)
  },
  product: {
    appKeywords: Object.keys(PRODUCT_APP_SOURCE),
    titlePatterns: [
      /(商品|详情|product|item|shop|店铺|购物车|cart|淘宝|京东|亚马逊|拼多多|天猫)/i
    ],
    ocrMatch: (text) => PRODUCT_PRICE_REGEX.test(text) || PRODUCT_UI_REGEX.test(text)
  },
  code: {
    appKeywords: [
      'visual studio code', 'vscode', 'code', 'cursor', 'sublime', 'neovim',
      'nvim', 'vim', 'emacs', 'atom', 'eclipse', 'intellij', 'idea',
      'webstorm', 'goland', 'pycharm', 'rubymine', 'phpstorm', 'android studio',
      'xcode', 'visual studio', 'netbeans', 'fleet', 'zed', 'helix', 'textmate',
      'code - oss', 'vscodium'
    ],
    titlePatterns: [
      CODE_FILE_EXT_REGEX,
      /\bgit\b/i,
      /\b(branch|commit|pull request|merge|rebase|stash|diff|conflict)\b/i
    ],
    ocrMatch: (text) =>
      CODE_KEYWORD_REGEX.test(text) ||
      CODE_SYMBOL_REGEX.test(text) ||
      /\bfunction\s*\(/.test(text)
  },
  document: {
    appKeywords: [
      'word', 'winword', 'wps', 'notion', 'obsidian', 'typora', 'markdown',
      'pages', 'google docs', 'onedrive', 'onenote', 'evernote', '印象笔记',
      '有道云笔记', '语雀', '腾讯文档', '石墨文档', 'bear', 'ulysses',
      'scrivener', 'ia writer', 'marktext', 'zettlr', '飞书文档',
      'acrobat', 'foxit', 'pdf', 'calibre', 'kindle', 'preview', '预览',
      '阅读器', 'books', 'adobe reader', 'sumatrapdf', 'pdfexpert', 'pdfpen',
      'zotero', 'mendeley', 'wps pdf', '福昕', 'edge pdf'
    ],
    titlePatterns: [
      DOC_FILE_EXT_REGEX,
      /(文档|笔记|日记|草稿|大纲|memo|note|journal|draft|阅读模式|reader mode)/i
    ],
    ocrMatch: (text) =>
      LONG_PARAGRAPH_REGEX.test(text) ||
      hasLongLine(text) ||
      /\b(第\s*\d+\s*页|page\s+\d+)\b/i.test(text)
  },
  webpage: {
    appKeywords: [
      'chrome', 'edge', 'firefox', 'safari', 'brave', 'opera', 'vivaldi',
      'arc', 'chromium', 'duckduckgo', 'maxthon', '360se', '360浏览器',
      '猎豹', 'qq浏览器', '搜狗浏览器', 'uc浏览器', 'yandex', 'tor browser'
    ],
    titlePatterns: [URL_REGEX, BROWSER_TITLE_SUFFIX_REGEX, TLD_REGEX],
    ocrMatch: (text) =>
      URL_REGEX.test(text) || BROWSER_UI_REGEX.test(text) || TLD_REGEX.test(text)
  }
}

/** 候选类型迭代顺序（并列时靠前者优先，更专用的工具类前置） */
const TYPE_ORDER: Array<Exclude<ContentType, 'other'>> = [
  'chat', 'video', 'forum', 'product', 'code', 'document', 'webpage'
]

// ===================== 结构化提取器 =====================

/**
 * 提取聊天结构化数据。
 * - participants: 从 "Name:" 模式提取昵称
 * - messageCount: 非空非纯时间戳行数
 * - keyMessages: 含关键词的行
 * - platform: 从 appName 推断
 */
function extractChatData(
  ocrText: string,
  blocks: OcrBlock[],
  appName: string
): { participants: string[]; messageCount: number; keyMessages: string[]; platform: string } {
  const text = ocrText.trim().length > 0 ? ocrText : blocks.map(b => b.text).join('\n')
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)

  // 提取参与者（行首 "Name:" 或 "Name：" 模式）
  const participants: string[] = []
  const seen = new Set<string>()
  const nameColonRegex = /^([\u4e00-\u9fff\w]{1,12})\s*[:：]\s*/
  for (const line of lines) {
    const m = line.match(nameColonRegex)
    if (m && !seen.has(m[1])) {
      seen.add(m[1])
      participants.push(m[1])
    }
  }

  // 消息数：非空非纯时间戳行
  const messageCount = lines.filter(l => !/^\d{1,2}:\d{2}$/.test(l)).length

  // 关键消息：含关键词的行
  const keyMessages = lines.filter(l => CHAT_KEY_MESSAGE_REGEX.test(l)).slice(0, 10)

  const platform = detectPlatform(appName, CHAT_APP_PLATFORM)

  return { participants, messageCount, keyMessages, platform }
}

/**
 * 提取网页结构化数据。
 * - url: 从 windowTitle 或 ocrText 提取
 * - pageTitle: windowTitle 去除浏览器后缀和 URL
 * - domain: 从 url 提取主机名
 * - keyParagraphs: 连续长文本行（≥ 30 字符）
 */
function extractWebpageData(
  windowTitle: string,
  ocrText: string,
  blocks: OcrBlock[]
): { url: string; pageTitle: string; domain: string; keyParagraphs: string[] } {
  const text = ocrText.trim().length > 0 ? ocrText : blocks.map(b => b.text).join('\n')

  // 提取 URL（优先 windowTitle，其次 ocrText）
  let url = ''
  const titleUrlMatch = windowTitle.match(/(https?:\/\/[^\s<>"'，。、；：！？）】}]+)/i)
  if (titleUrlMatch) {
    url = titleUrlMatch[1]
  } else {
    const textUrlMatch = text.match(/(https?:\/\/[^\s<>"'，。、；：！？）】}]+)/i)
    if (textUrlMatch) url = textUrlMatch[1]
  }

  // 解析页面标题：去除浏览器后缀和 URL
  let pageTitle = windowTitle
    .replace(BROWSER_TITLE_SUFFIX_REGEX, '')
    .replace(/https?:\/\/[^\s]+/i, '')
    .replace(/\s*-\s*$/, '')
    .trim()

  // 提取 domain
  let domain = ''
  if (url) {
    const hostMatch = url.match(/^https?:\/\/([^/?#]+)/i)
    if (hostMatch) domain = hostMatch[1]
  } else if (TLD_REGEX.test(windowTitle)) {
    const domainMatch = windowTitle.match(/([\w-]+\.(com|org|net|cn|io|dev|edu|gov|info|biz|co))/i)
    if (domainMatch) domain = domainMatch[1]
  }

  // 提取正文段落：长文本行（≥ 30 字符）
  const keyParagraphs = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length >= 30)
    .slice(0, 5)

  return { url, pageTitle, domain, keyParagraphs }
}

/**
 * 提取视频结构化数据。
 * - platform: 从 appName 推断
 * - title: 从 windowTitle 提取（去除平台后缀）
 * - duration: 识别 "0:39 / 5:23" 进度条模式或 "时长: 05:23" 标签模式
 * - subtitles: 提取字幕文本（短行，排除 UI 控件和时间戳）
 */
function extractVideoData(
  windowTitle: string,
  ocrText: string,
  blocks: OcrBlock[],
  appName: string
): { platform: string; title: string; duration: string; subtitles: string[] } {
  const text = ocrText.trim().length > 0 ? ocrText : blocks.map(b => b.text).join('\n')

  const platform = detectPlatform(appName, VIDEO_APP_PLATFORM)

  // 标题：去除平台后缀
  let title = windowTitle
  const suffixPatterns = [
    / - (bilibili|哔哩哔哩|youtube|netflix|优酷|爱奇艺|腾讯视频|vlc|potplayer|mpv)\s*$/i,
    /_(bilibili|哔哩哔哩|youtube|netflix|优酷|爱奇艺|腾讯视频)\s*$/i,
    /【[^】]*】\s*$/
  ]
  for (const p of suffixPatterns) {
    title = title.replace(p, '').trim()
  }

  // 时长：优先进度条模式 "00:39 / 05:23"，其次标签模式 "时长: 05:23"
  let duration = ''
  const progressMatch = text.match(/\b\d{1,2}:\d{2}(:\d{2})?\s*[/／]\s*(\d{1,2}:\d{2}(:\d{2})?)\b/)
  if (progressMatch) {
    duration = progressMatch[2]
  } else {
    const labelMatch = text.match(/(?:时长|duration|total)[：:]\s*(\d{1,2}:\d{2}(:\d{2})?)/i)
    if (labelMatch) duration = labelMatch[1]
  }

  // 字幕：短行（2-50 字符），排除 UI 控件、时间戳、进度条
  const subtitles = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => {
      if (l.length < 2 || l.length > 50) return false
      if (VIDEO_CONTROL_REGEX.test(l)) return false
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(l)) return false
      if (VIDEO_PROGRESS_REGEX.test(l)) return false
      return true
    })
    .slice(0, 10)

  return { platform, title, duration, subtitles }
}

/**
 * 提取论坛结构化数据。
 * - threadTitle: 从 windowTitle 提取（去除论坛名后缀）
 * - posts: 帖子数（基于元数据行/作者数估算）
 * - authors: 作者列表（@name 或 "作者：name" 模式）
 */
function extractForumData(
  windowTitle: string,
  ocrText: string,
  blocks: OcrBlock[]
): { threadTitle: string; posts: number; authors: string[] } {
  const text = ocrText.trim().length > 0 ? ocrText : blocks.map(b => b.text).join('\n')

  // 帖子标题：去除论坛名后缀
  let threadTitle = windowTitle
    .replace(/ - (reddit|v2ex|掘金|知乎|贴吧|hacker news|lobsters|discourse)\s*$/i, '')
    .replace(/\s*[|｜]\s*(reddit|v2ex|掘金|知乎|贴吧).*$/i, '')
    .trim()

  // 作者：@name 模式或 "作者：name" / "by name" 模式
  const authors: string[] = []
  const seen = new Set<string>()
  const atRegex = /@([\u4e00-\u9fff\w]{2,15})/g
  let m: RegExpExecArray | null
  while ((m = atRegex.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      authors.push(m[1])
    }
  }
  const authorLabelRegex = /(?:作者|by|来自)[：:]\s*([\u4e00-\u9fff\w]{2,15})/gi
  while ((m = authorLabelRegex.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      authors.push(m[1])
    }
  }

  // 帖子数：统计含回复/查看/@作者元数据的行
  const postMetaLines = text.split('\n').filter(l => FORUM_POST_META_REGEX.test(l))
  const posts = Math.max(postMetaLines.length, authors.length, 1)

  return { threadTitle, posts, authors }
}

/**
 * 提取商品结构化数据。
 * - name: 从 windowTitle 提取（去除平台后缀）
 * - price: 正则匹配 ¥/$/￥ + 数字
 * - source: 从 appName 推断
 */
function extractProductData(
  windowTitle: string,
  ocrText: string,
  blocks: OcrBlock[],
  appName: string
): { name: string; price: string; source: string } {
  const text = ocrText.trim().length > 0 ? ocrText : blocks.map(b => b.text).join('\n')

  // 商品名：windowTitle 去除平台后缀
  let name = windowTitle
    .replace(/ - (淘宝|京东|天猫|拼多多|亚马逊|amazon|taobao|jd|tmall|pinduoduo)\s*$/i, '')
    .replace(/\s*[|｜]\s*(淘宝|京东|天猫|拼多多|亚马逊).*$/i, '')
    .trim()

  // 价格：匹配 ¥/$/￥ + 数字
  let price = ''
  const priceMatch = text.match(/[¥￥$]\s*\d{1,3}(,\d{3})*(\.\d+)?/)
  if (priceMatch) {
    price = priceMatch[0].replace(/\s+/g, '')
  }

  const source = detectPlatform(appName, PRODUCT_APP_SOURCE)

  return { name, price, source }
}

/** 提取文档结构化数据：标题 + 段落 */
function extractDocumentData(
  windowTitle: string,
  ocrText: string
): { title: string; paragraphs: string[] } {
  const paragraphs = ocrText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length >= 20)
    .slice(0, 10)
  return { title: windowTitle, paragraphs }
}

/** 代码文件扩展名 → 语言映射 */
const CODE_EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', java: 'java', kt: 'kotlin', scala: 'scala',
  go: 'go', rs: 'rust', c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  h: 'c', hpp: 'cpp', hxx: 'cpp',
  rb: 'ruby', php: 'php', swift: 'swift',
  vue: 'vue', svelte: 'svelte', astro: 'astro',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  sql: 'sql', md: 'markdown', markdown: 'markdown'
}

/** 提取代码结构化数据：文件名 + 语言 */
function extractCodeData(
  windowTitle: string,
  ocrText: string
): { fileName: string; language: string } {
  const fileNameMatch = windowTitle.match(/([\w\u4e00-\u9fff.-]+\.(ts|tsx|js|jsx|mjs|cjs|py|java|kt|scala|go|rs|c|cpp|cc|cxx|h|hpp|hxx|rb|php|swift|vue|svelte|astro|html|htm|css|scss|sass|less|json|yaml|yml|toml|xml|sh|bash|zsh|ps1|sql|md|markdown))/i)
  const fileName = fileNameMatch ? fileNameMatch[1] : windowTitle

  let language = 'unknown'
  const ext = fileNameMatch?.[2]?.toLowerCase()
  if (ext && CODE_EXT_LANGUAGE[ext]) {
    language = CODE_EXT_LANGUAGE[ext]
  } else if (/\bdef\s+\w+\s*\(/.test(ocrText)) {
    language = 'python'
  } else if (/\bfunc\s+\w+/.test(ocrText)) {
    language = 'go'
  } else if (/\bfn\s+\w+/.test(ocrText)) {
    language = 'rust'
  } else if (/\bpublic\s+(class|static)\b/.test(ocrText)) {
    language = 'java'
  }

  return { fileName, language }
}

/** 从 appName 推断平台名（长键优先匹配） */
function detectPlatform(appName: string, mapping: Record<string, string>): string {
  const lower = appName.toLowerCase()
  for (const key of Object.keys(mapping)) {
    if (lower.includes(key.toLowerCase())) {
      return mapping[key]
    }
  }
  return 'unknown'
}

/** 根据类型调用对应提取器 */
function extractDataForType(
  type: Exclude<ContentType, 'other'>,
  input: { appName: string; windowTitle: string; ocrText: string; blocks: OcrBlock[] }
): Record<string, unknown> {
  switch (type) {
    case 'chat':
      return extractChatData(input.ocrText, input.blocks, input.appName)
    case 'webpage':
      return extractWebpageData(input.windowTitle, input.ocrText, input.blocks)
    case 'video':
      return extractVideoData(input.windowTitle, input.ocrText, input.blocks, input.appName)
    case 'forum':
      return extractForumData(input.windowTitle, input.ocrText, input.blocks)
    case 'product':
      return extractProductData(input.windowTitle, input.ocrText, input.blocks, input.appName)
    case 'document':
      return extractDocumentData(input.windowTitle, input.ocrText)
    case 'code':
      return extractCodeData(input.windowTitle, input.ocrText)
    default:
      return {}
  }
}

/** 保留两位小数（与 ActivityClassifier 等模块的置信度精度一致） */
function round2(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

// ===================== 主分类器 =====================

/**
 * ContentClassifier：内容类型分类器。
 */
export class ContentClassifier {
  /**
   * 推断单个 segment 的内容类型并提取结构化数据。
   *
   * @param segment 包含 appName / windowTitle / ocrText / ocrBlocks 的片段
   * @returns { contentType, contentData, confidence }；置信度不足时 contentType='other'
   */
  classifyContent(segment: ContentSegmentInput): ContentClassification {
    const appName = (segment.appName ?? '').toLowerCase()
    const windowTitle = segment.windowTitle ?? ''
    const ocrText = segment.ocrText ?? ''
    const blocks = segment.ocrBlocks ?? []

    // ocrText 为空时从 blocks 聚合，保证 OCR 验证可用
    const effectiveOcrText = ocrText.trim().length > 0 ? ocrText : blocks.map(b => b.text).join('\n')

    let best: { type: Exclude<ContentType, 'other'> | null; score: number; appMatched: boolean } = {
      type: null,
      score: 0,
      appMatched: false
    }

    for (const type of TYPE_ORDER) {
      const rules = RULE_SETS[type]
      const appMatched = rules.appKeywords.some(k => appName.includes(k.toLowerCase()))
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
    if (best.type && confidence >= CONFIDENCE_THRESHOLD) {
      const contentData = extractDataForType(best.type, {
        appName: segment.appName ?? '',
        windowTitle,
        ocrText: effectiveOcrText,
        blocks
      })
      return { contentType: best.type, contentData, confidence }
    }
    return { contentType: 'other', contentData: {}, confidence }
  }
}

/** 默认实例，供独立函数复用 */
const defaultClassifier = new ContentClassifier()

/**
 * 独立分类函数：推断单个 segment 的内容类型并提取结构化数据。
 * 等价于 `new ContentClassifier().classifyContent(segment)`。
 */
export function classifyContent(segment: ContentSegmentInput): ContentClassification {
  return defaultClassifier.classifyContent(segment)
}
