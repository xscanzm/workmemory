/**
 * WorkMemory 领域模型 TypeScript 类型定义
 * 覆盖 WorkSegment / Episode / EntityRef / WikiPage / Report / PrivacyRule
 * 及全部状态、模板、设置等枚举类型。
 */

/** Segment 来源处理状态 */
export type SourceStatus = 'pending' | 'ocr_done' | 'ocr_failed' | 'no_text' | 'private'

/** OCR / capture evidence source quality */
export type SourceQuality = 'high' | 'medium' | 'low' | 'failed' | 'private'

/** 截图来源类型 */
export type CaptureSource = 'active_window' | 'full_screen_fallback' | 'privacy_placeholder' | 'unknown'

/** 全局记录状态 */
export type RecordingState = 'recording' | 'paused' | 'idle' | 'privacy'

/** 桌面伙伴形象 */
export type MascotStyle = 'note' | 'film' | 'copilot' | 'cursor' | 'paper'

/** 桌面伙伴状态 */
export type MascotState = 'recording' | 'paused' | 'privacy' | 'ocr_scanning' | 'report_ready'

/** 日报模板 */
export type ReportTemplate = 'enhanced' | 'concise' | 'okr'

/** 本地 OCR 模型 */
export type OcrModel = 'tiny' | 'small'

/** 报告状态 */
export type ReportStatus = 'draft' | 'exported'

/** 报告类型：日报 / 周报 / 复盘 */
export type ReportType = 'daily' | 'weekly' | 'review'

/** Wiki 审核状态 */
export type WikiReviewStatus = 'needs_review' | 'reviewed'

/** Wiki 页类型 */
export type WikiType = 'person' | 'project' | 'customer' | 'topic' | 'decision' | 'meeting' | 'issue'

/** 隐私规则类型 */
export type PrivacyRuleType = 'app_name' | 'process_name' | 'window_title' | 'url'

/** 隐私规则匹配模式 */
export type PrivacyMatchMode = 'contains' | 'equals' | 'regex'

/** 隐私过滤动作 */
export type PrivacyAction = 'skip' | 'placeholder' | 'allow'

/** 实体引用类型 */
export type EntityRefType = 'person' | 'project' | 'document' | 'url'

/** 实体引用（从 Episode 提取的人/项目/文档/URL） */
export interface EntityRef {
  type: EntityRefType
  name: string
  value?: string
  /** 置信度 0-1，自动抽取实体的可信度，低置信不进入 Wiki/报告默认选择 */
  confidence: number
  /** 用户已确认（确认后视为高可信，不再被低置信过滤） */
  userConfirmed?: boolean
}

/** OCR 文本块证据，v1 允许为空数组，后续由 OCR adapter 填充 boxes。 */
export interface OcrBlock {
  text: string
  box: { x: number; y: number; w: number; h: number }
  confidence: number
}

export interface BoundsRect {
  x: number
  y: number
  width: number
  height: number
}

/** 原始工作片段：一次窗口活动 + OCR 结果 */
export interface WorkSegment {
  id: string
  /** YYYY-MM-DD */
  date: string
  /** ISO 时间戳或 HH:MM:SS */
  startTime: string
  endTime: string
  /** 持续秒数 */
  durationSeconds: number
  appName: string
  processName: string
  windowTitle: string
  ocrText: string
  ocrSummary: string
  /** 局部图像哈希，用于去重合并判定 */
  imageHash: string
  /** 截图文件路径（OCR 后默认删除，可选保留） */
  screenshotPath: string
  isSelectedForReport: boolean
  isPrivate: boolean
  isImportant: boolean
  isDeleted: boolean
  sourceStatus: SourceStatus
  userTitle: string
  userSummary: string
  userNote: string
  /** 项目/主题标签 */
  tags: string[]
  /** OCR block 元数据；当前 OCR 后端若未返回 block，则为空数组。 */
  ocrBlocks?: OcrBlock[]
  /** OCR 平均置信度 0-1 */
  ocrConfidence?: number
  /** 截图来源 */
  captureSource?: CaptureSource
  /** 来源质量 */
  sourceQuality?: SourceQuality
  /** 活跃窗口范围 */
  activeWindowBounds?: BoundsRect | null
  /** 整屏降级时的屏幕范围 */
  displayBounds?: BoundsRect | null
  /** OCR 原始文本（未清洗） */
  ocrRawText?: string
  /** 噪声评分，用于过滤低质量片段 */
  noiseScore?: number
}

/** Episode：语义合并后的工作事件 */
export interface Episode {
  id: string
  date: string
  startTime: string
  endTime: string
  title: string
  oneLineSummary: string
  segmentIds: string[]
  entities: EntityRef[]
  topics: string[]
  /** 用户手动编辑过一句话总结，此后自动更新永不覆盖 */
  userEdited: boolean
  reportEligible: boolean
  wikiEligible: boolean
}

export type MemoryKind =
  | 'work'
  | 'research'
  | 'communication'
  | 'coding'
  | 'planning'
  | 'review'
  | 'admin'
  | 'idle_uncertain'

export type WikiStatus = 'none' | 'candidate' | 'auto_upserted' | 'needs_review' | 'rejected'

export interface EvidenceRef {
  segmentId: string
  quote: string
  reason: string
}

export interface CleanEpisode {
  id: string
  date: string
  hourBucket: string
  startTime: string
  endTime: string
  title: string
  summary: string
  memoryKind: MemoryKind
  project: string
  entities: EntityRef[]
  topics: string[]
  materials: string[]
  outputs: string[]
  todos: string[]
  blockers: string[]
  segmentIds: string[]
  evidenceRefs: EvidenceRef[]
  sourceQuality: SourceQuality
  confidence: number
  reportEligible: boolean
  wikiEligible: boolean
  wikiStatus: WikiStatus
  createdAt: string
  updatedAt: string
  modelName: string
  distillVersion: string
}

export interface HourRepresentativeFrame {
  segmentId: string
  startTime: string
  endTime: string
  appName: string
  windowTitle: string
  text: string
  sourceQuality: SourceQuality
}

export interface HourChangePoint {
  at: string
  segmentId: string
  reason: string
  appName: string
  windowTitle: string
  textPreview: string
}

export interface HourWindowTimelineItem {
  startTime: string
  endTime: string
  appName: string
  windowTitle: string
  segmentIds: string[]
}

export interface HourContextPack {
  date: string
  hourBucket: string
  startTime: string
  endTime: string
  segmentIds: string[]
  representativeFrames: HourRepresentativeFrame[]
  changePoints: HourChangePoint[]
  windowTimeline: HourWindowTimelineItem[]
  localStats: {
    segmentCount: number
    representativeFrameCount: number
    appCount: number
    ocrDoneCount: number
    lowQualityCount: number
  }
  privacySummary: {
    privateCount: number
    excludedCount: number
  }
}

export interface ReportSnapshotItem {
  id: string
  startTime: string
  endTime: string
  title: string
  summary: string
  project: string
  topics: string[]
  entities: EntityRef[]
  evidenceRefs: EvidenceRef[]
  segmentIds: string[]
  sourceQuality: SourceQuality
  confidence: number
}

export interface ReportInputSnapshot {
  date: string
  templateId: ReportTemplate
  userNotes: string
  createdAt: string
  sourceType: 'clean_episodes' | 'raw_fallback'
  items: ReportSnapshotItem[]
  segmentIds: string[]
  cleanEpisodeIds: string[]
  maskedCount: number
}

/** Wiki 知识页（双链沉淀） */
export interface WikiPage {
  id: string
  type: WikiType
  title: string
  aliases: string[]
  /** Markdown 正文 */
  content: string
  /** 来源 Episode/Segment id 列表 */
  sources: string[]
  /** 反向链接的 Wiki 页标题列表 */
  backlinks: string[]
  /** 置信度 0-1 */
  confidence: number
  reviewStatus: WikiReviewStatus
  createdAt: string
  updatedAt: string
}

/** 日报/周报 */
export interface Report {
  id: string
  date: string
  templateId: ReportTemplate
  templateName: string
  segmentIds: string[]
  /** 发送给 AI 的输入快照（仅文本摘要，不含截图） */
  aiInputSnapshot: string
  markdownContent: string
  status: ReportStatus
  /** 报告类型：daily/weekly/review，P0 仅暴露 daily */
  reportType: ReportType
}

/** 隐私规则 */
export interface PrivacyRule {
  id: string
  type: PrivacyRuleType
  pattern: string
  matchMode: PrivacyMatchMode
  enabled: boolean
}

/** 隐私规则匹配结果 */
export interface PrivacyMatchResult {
  action: PrivacyAction
  matchedRule: PrivacyRule | null
}

/** 应用设置（UI 可见字段，不含明文 API Key） */
export interface AppSettings {
  /** 开机自启 */
  autoStart: boolean
  /** 保存截图天数 0-7（0 表示 OCR 后即删） */
  screenshotRetentionDays: number
  ocrModel: OcrModel
  /** API Key 掩码（如 sk-****xxxx），空字符串表示未配置；由 SettingsStore 从加密 blob 派生，永不回填明文 */
  apiKeyMasked: string
  apiBaseUrl: string
  modelName: string
  mascotStyle: MascotStyle
  /** 是否保存截图 */
  saveScreenshots: boolean
  /**
   * 是否允许活跃窗口截图失败后整屏降级。默认 true：
   * false → 窗口截图失败即跳过该次捕获；
   * true  → 窗口截图失败后回退到整屏截图，保证屏幕识别可用。
   */
  allowFullScreenshotFallback: boolean
  /** 是否启用整点 AI 理解批处理 */
  aiAutoDistillEnabled: boolean
  /** 首次授权时间，空字符串表示尚未授权 */
  aiAutoDistillFirstConsentAt: string
  /** 当前仅支持 hourly */
  aiDistillSchedule: 'hourly'
  /** 最近一次 distill 完成时间 */
  aiDistillLastRunAt: string
  /** v1 固定 false：不发送截图 */
  aiDistillSendScreenshots: boolean
}

/** 默认设置 */
export const defaultAppSettings: AppSettings = {
  autoStart: false,
  screenshotRetentionDays: 0,
  ocrModel: 'tiny',
  apiKeyMasked: '',
  apiBaseUrl: 'https://api.openai.com/v1',
  modelName: 'gpt-4o-mini',
  mascotStyle: 'note',
  saveScreenshots: false,
  allowFullScreenshotFallback: true,
  aiAutoDistillEnabled: false,
  aiAutoDistillFirstConsentAt: '',
  aiDistillSchedule: 'hourly',
  aiDistillLastRunAt: '',
  aiDistillSendScreenshots: false
}

/**
 * 用户活动类型（由 ActivityClassifier 基于 appName/windowTitle/ocrText 推断）。
 * idle 为置信度不足时的默认兜底值。
 */
export type ActivityType =
  | 'coding'
  | 'writing'
  | 'reading'
  | 'browsing'
  | 'chatting'
  | 'designing'
  | 'meeting'
  | 'managing'
  | 'idle'

/**
 * 屏幕内容类型（由 ContentClassifier 基于 appName/windowTitle/ocrText 推断）。
 * other 为置信度不足时的默认兜底值。
 */
export type ContentType =
  | 'chat'
  | 'webpage'
  | 'document'
  | 'code'
  | 'video'
  | 'forum'
  | 'product'
  | 'other'
