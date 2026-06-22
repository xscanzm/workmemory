/**
 * WorkMemory IPC 通道类型定义
 * 主进程 ↔ 渲染进程的全部 invoke/handle 通道名与参数/返回类型。
 * 阶段 0/1 实现 window:* 与数据层（segment/episode/wiki/report/privacy）通道；
 * capture/ocr/ai/mascot/settings 通道为后续阶段预留契约定义。
 */
import type {
  AppSettings,
  CleanEpisode,
  Episode,
  PrivacyMatchResult,
  PrivacyRule,
  Report,
  ReportTemplate,
  ReportType,
  WikiPage,
  WorkSegment
} from '@/types'

/* ===================== 通道名常量 ===================== */

export const WindowChannels = {
  Minimize: 'window:minimize',
  Maximize: 'window:maximize',
  Close: 'window:close',
  IsMaximized: 'window:isMaximized',
  MaximizeChanged: 'window:maximizeChanged'
} as const

export const SegmentChannels = {
  /** segment:insert 已删除 — segments 由 CaptureManager 自动创建 */
  Update: 'segment:update',
  GetById: 'segment:getById',
  GetByDate: 'segment:getByDate',
  GetActiveByDate: 'segment:getActiveByDate',
  SetSelectedForReport: 'segment:setSelectedForReport',
  SetImportant: 'segment:setImportant',
  SoftDelete: 'segment:softDelete',
  HardDelete: 'segment:hardDelete',
  GetPrivateByDate: 'segment:getPrivateByDate'
} as const

export const EpisodeChannels = {
  Insert: 'episode:insert',
  Update: 'episode:update',
  GetById: 'episode:getById',
  GetByDate: 'episode:getByDate',
  SetOneLineSummary: 'episode:setOneLineSummary',
  SetReportEligible: 'episode:setReportEligible',
  SetWikiEligible: 'episode:setWikiEligible',
  GetDailySummary: 'episode:getDailySummary',
  SetDailySummary: 'episode:setDailySummary',
  /** 确认实体（标记 userConfirmed=true，不再被低置信过滤） */
  ConfirmEntity: 'episode:confirmEntity',
  /** 修正实体名（更新 name 并标记 userConfirmed=true） */
  CorrectEntity: 'episode:correctEntity',
  /** 忽略实体（从 episode.entities 中移除） */
  IgnoreEntity: 'episode:ignoreEntity'
} as const

export const CleanEpisodeChannels = {
  GetById: 'cleanEpisode:getById',
  GetByDate: 'cleanEpisode:getByDate',
  GetByHour: 'cleanEpisode:getByHour',
  GetByDateRange: 'cleanEpisode:getByDateRange',
  Update: 'cleanEpisode:update'
} as const

export const WikiChannels = {
  Insert: 'wiki:insert',
  Update: 'wiki:update',
  Delete: 'wiki:delete',
  GetById: 'wiki:getById',
  GetByType: 'wiki:getByType',
  GetByTitle: 'wiki:getByTitle',
  GetAll: 'wiki:getAll',
  SearchByTitle: 'wiki:searchByTitle',
  AddToReviewQueue: 'wiki:addToReviewQueue',
  GetReviewQueue: 'wiki:getReviewQueue',
  ConfirmReview: 'wiki:confirmReview',
  RejectReview: 'wiki:rejectReview',
  UpdateBacklinks: 'wiki:updateBacklinks',
  GetBacklinks: 'wiki:getBacklinks',
  FindBrokenLinks: 'wiki:findBrokenLinks',
  // 阶段 7：Wiki Ingest 编排层
  ScanNow: 'wiki:scanNow',
  PreviewIngest: 'wiki:previewIngest',
  ConfirmIngest: 'wiki:confirmIngest',
  RejectIngest: 'wiki:rejectIngest',
  GetBrokenLinks: 'wiki:getBrokenLinks',
  RebuildBacklinks: 'wiki:rebuildBacklinks'
} as const

export const ReportChannels = {
  /** report:insert 已删除 — reports 由 AiManager.generateReport 自动创建 */
  Update: 'report:update',
  /** 业务 action：保存草稿（status 强制为 draft） */
  SaveDraft: 'report:saveDraft',
  GetById: 'report:getById',
  GetByDate: 'report:getByDate',
  GetAllHistory: 'report:getAllHistory',
  SetStatus: 'report:setStatus'
} as const

export const PrivacyChannels = {
  Insert: 'privacy:insert',
  Update: 'privacy:update',
  Delete: 'privacy:delete',
  GetAll: 'privacy:getAll',
  GetEnabled: 'privacy:getEnabled',
  MatchRule: 'privacy:matchRule'
} as const

/** 后续阶段预留通道名（契约定义，阶段 2+ 实现 handler） */
export const CaptureChannels = {
  Start: 'capture:start',
  Stop: 'capture:stop',
  Pause: 'capture:pause',
  Resume: 'capture:resume',
  GetState: 'capture:getState'
} as const

export const OcrChannels = {
  Recognize: 'ocr:recognize',
  SetModel: 'ocr:setModel',
  GetModel: 'ocr:getModel',
  GetStatus: 'ocr:getStatus',
  Reprocess: 'ocr:reprocess',
  GetRuntimeStatus: 'ocr:getRuntimeStatus',
  TestRecognize: 'ocr:testRecognize',
  OpenInstallDir: 'ocr:openInstallDir'
} as const

export const AiChannels = {
  GenerateReport: 'ai:generateReport',
  ExtractWiki: 'ai:extractWiki',
  DistillHour: 'ai:distillHour',
  RunDueDistill: 'ai:runDueDistill',
  TestConnection: 'ai:testConnection',
  GetTemplates: 'ai:getTemplates',
  EstimateChars: 'ai:estimateChars',
  ExportMarkdown: 'ai:exportMarkdown',
  ExportWord: 'ai:exportWord',
  ExportJson: 'ai:exportJson'
} as const

export const MascotChannels = {
  // 设置/获取形象与状态（主窗口调用）
  SetStyle: 'mascot:setStyle',
  GetStyle: 'mascot:getStyle',
  SetState: 'mascot:setState',
  Show: 'mascot:show',
  Hide: 'mascot:hide',
  // 主动气泡（主窗口/ReminderScheduler 调用）
  ShowBubble: 'mascot:showBubble',
  // 灵感捕捉
  GhostCapture: 'mascot:ghostCapture',
  // 频率限制统计
  GetStats: 'mascot:getStats',
  // Mascot 渲染进程初始化时获取当前状态/形象
  GetInitialState: 'mascot:getInitialState',
  // Mascot 渲染进程 → 主进程：交互事件
  LeftClick: 'mascot:leftClick',
  RightClick: 'mascot:rightClick',
  RightDoubleClick: 'mascot:rightDoubleClick',
  BubbleClosed: 'mascot:bubbleClosed',
  MouseEnter: 'mascot:mouseEnter',
  MouseLeave: 'mascot:mouseLeave',
  DragStart: 'mascot:dragStart',
  DragEnd: 'mascot:dragEnd',
  // Mascot 渲染进程 → 主进程：导航
  Navigate: 'mascot:navigate',
  // 主进程 → Mascot 渲染进程：状态/形象/气泡变更广播
  StateChanged: 'mascot:stateChanged',
  StyleChanged: 'mascot:styleChanged',
  BubbleShow: 'mascot:bubbleShow',
  // 主进程 → 主窗口：导航指令（Mascot/托盘触发跳转）
  NavigateMain: 'mascot:navigateMain',
  // 无痕模式检测广播（主进程 → 渲染进程）
  IncognitoDetected: 'mascot:incognito-detected',
  IncognitoCleared: 'mascot:incognito-cleared'
} as const

/** 捕获状态变化广播通道（主进程 → 渲染进程） */
export const CaptureBroadcastChannels = {
  StateChanged: 'capture:state-changed'
} as const

export const SettingsChannels = {
  Get: 'settings:get',
  Set: 'settings:set',
  Reset: 'settings:reset',
  SetApiKey: 'settings:setApiKey',
  ClearApiKey: 'settings:clearApiKey'
} as const

export const DataChannels = {
  Cleanup: 'data:cleanup',
  ClearDay: 'data:clearDay',
  ClearAll: 'data:clearAll',
  GetStats: 'data:getStats'
} as const

export const SystemChannels = {
  SaveFile: 'system:saveFile',
  WriteClipboard: 'system:writeClipboard'
} as const

/** 阶段 8：主动洞察层通道 */
export const InsightsChannels = {
  GetAudit: 'insights:getAudit',
  GetAnomalies: 'insights:getAnomalies',
  GetTrend: 'insights:getTrend',
  GetInsights: 'insights:getInsights',
  PushInsight: 'insights:pushInsight'
} as const

/** FTS5 全文搜索通道 */
export const SearchChannels = {
  Fts: 'search:fts',
  Hybrid: 'search:hybrid'
} as const

/* ===================== preload 暴露的 API 契约 ===================== */

export interface WindowApi {
  minimize(): Promise<void>
  maximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (maximized: boolean) => void): () => void
}

export interface SegmentApi {
  /** segment.insert 已删除 — segments 由 CaptureManager 自动创建 */
  update(id: string, patch: Partial<WorkSegment>): Promise<WorkSegment | null>
  getById(id: string): Promise<WorkSegment | null>
  getByDate(date: string): Promise<WorkSegment[]>
  getActiveByDate(date: string): Promise<WorkSegment[]>
  setSelectedForReport(id: string, selected: boolean): Promise<boolean>
  setImportant(id: string, important: boolean): Promise<boolean>
  softDelete(id: string): Promise<boolean>
  hardDelete(id: string): Promise<boolean>
  getPrivateByDate(date: string): Promise<WorkSegment[]>
}

export interface EpisodeApi {
  insert(episode: Episode): Promise<Episode>
  update(id: string, patch: Partial<Episode>): Promise<Episode | null>
  getById(id: string): Promise<Episode | null>
  getByDate(date: string): Promise<Episode[]>
  /** 返回 false 表示因 userEdited 保护而拒绝覆盖 */
  setOneLineSummary(id: string, summary: string): Promise<boolean>
  setReportEligible(id: string, eligible: boolean): Promise<boolean>
  setWikiEligible(id: string, eligible: boolean): Promise<boolean>
  getDailySummary(date: string): Promise<string>
  setDailySummary(date: string, text: string): Promise<boolean>
  /** 确认实体：标记 userConfirmed=true，使其不再被低置信过滤 */
  confirmEntity(id: string, entityType: 'person' | 'project' | 'document' | 'url', entityName: string): Promise<Episode | null>
  /** 修正实体名：更新 name 并标记 userConfirmed=true */
  correctEntity(id: string, entityType: 'person' | 'project' | 'document' | 'url', entityName: string, newName: string): Promise<Episode | null>
  /** 忽略实体：从 episode.entities 中移除 */
  ignoreEntity(id: string, entityType: 'person' | 'project' | 'document' | 'url', entityName: string): Promise<Episode | null>
}

export interface CleanEpisodeApi {
  getById(id: string): Promise<CleanEpisode | null>
  getByDate(date: string): Promise<CleanEpisode[]>
  getByHour(date: string, hourBucket: string): Promise<CleanEpisode[]>
  getByDateRange(startDate: string, endDate: string): Promise<CleanEpisode[]>
  update(id: string, patch: Partial<CleanEpisode>): Promise<CleanEpisode | null>
}

export interface WikiApi {
  insert(page: WikiPage): Promise<WikiPage>
  update(id: string, patch: Partial<WikiPage>): Promise<WikiPage | null>
  delete(id: string): Promise<boolean>
  getById(id: string): Promise<WikiPage | null>
  getByType(type: WikiPage['type']): Promise<WikiPage[]>
  getByTitle(title: string): Promise<WikiPage | null>
  getAll(): Promise<WikiPage[]>
  searchByTitle(keyword: string): Promise<WikiPage[]>
  addToReviewQueue(page: Omit<WikiPage, 'id' | 'reviewStatus' | 'createdAt' | 'updatedAt'>): Promise<WikiPage>
  getReviewQueue(): Promise<WikiPage[]>
  confirmReview(id: string): Promise<WikiPage | null>
  rejectReview(id: string): Promise<boolean>
  updateBacklinks(id: string): Promise<string[]>
  getBacklinks(title: string): Promise<WikiPage[]>
  findBrokenLinks(): Promise<Array<{ fromTitle: string; brokenLink: string }>>
  // 阶段 7：Wiki Ingest 编排
  scanNow(): Promise<number>
  previewIngest(reviewItemId: string): Promise<WikiIngestPreview | null>
  confirmIngest(reviewItemId: string, edits?: { content?: string; title?: string }): Promise<WikiPage | null>
  rejectIngest(reviewItemId: string): Promise<boolean>
  getBrokenLinks(): Promise<Array<{ fromPageId: string; fromTitle: string; linkText: string }>>
  rebuildBacklinks(): Promise<number>
}

/** Wiki Ingest 预览结果 */
export interface WikiIngestPreview {
  reviewItemId: string
  title: string
  type: WikiPage['type']
  confidence: number
  evidence: string[]
  markdown: string
  oneLineSummary: string
  keyFacts: string[]
  pendingQuestions: string[]
  extractedLinks: string[]
}

export interface ReportApi {
  /** report.insert 已删除 — reports 由 AiManager.generateReport 自动创建 */
  update(id: string, patch: Partial<Report>): Promise<Report | null>
  /** 业务 action：保存草稿（status 强制为 draft，id 可选自动生成） */
  saveDraft(report: Omit<Report, 'status'> & { id?: string; reportType?: ReportType }): Promise<Report>
  getById(id: string): Promise<Report | null>
  getByDate(date: string): Promise<Report[]>
  getAllHistory(): Promise<Report[]>
  setStatus(id: string, status: Report['status']): Promise<boolean>
}

export interface PrivacyApi {
  insert(rule: Omit<PrivacyRule, 'id'>): Promise<PrivacyRule>
  update(id: string, patch: Partial<PrivacyRule>): Promise<PrivacyRule | null>
  delete(id: string): Promise<boolean>
  getAll(): Promise<PrivacyRule[]>
  getEnabled(): Promise<PrivacyRule[]>
  matchRule(
    appName: string,
    processName: string,
    windowTitle: string,
    url: string
  ): Promise<PrivacyMatchResult>
}

export interface CaptureApi {
  start(): Promise<boolean>
  stop(): Promise<boolean>
  pause(): Promise<boolean>
  resume(): Promise<boolean>
  getState(): Promise<string>
  onStateChange(cb: (state: string) => void): () => void
  onIncognitoDetected(cb: () => void): () => void
  onIncognitoCleared(cb: () => void): () => void
}

/** OCR 后端类型 */
export type OcrBackendType = 'paddleocr' | 'tesseract' | 'unconfigured'

/** OCR runtime 状态 */
export interface OcrRuntimeStatus {
  type: OcrBackendType
  modelPath?: string
  available: boolean
}

/** OCR 测试识别结果 */
export interface OcrTestRecognizeResult {
  ok: boolean
  text?: string
  elapsedMs?: number
  error?: string
}

/** OCR 打开安装目录结果 */
export interface OcrOpenInstallDirResult {
  ok: boolean
  path?: string
  error?: string
}

export interface OcrApi {
  recognize(imagePath: string): Promise<string>
  setModel(model: 'tiny' | 'small'): Promise<boolean>
  getModel(): Promise<'tiny' | 'small'>
  getStatus(): Promise<{
    backend: string
    model: 'tiny' | 'small'
    loaded: boolean
    queueSize: number
    running: boolean
    configured: boolean
  }>
  reprocess(segmentId: string): Promise<boolean>
  /** 获取 OCR runtime 状态：后端类型/模型路径/可用性 */
  getRuntimeStatus(): Promise<OcrRuntimeStatus>
  /** 测试识别指定图片，返回成功/失败与识别文本/耗时 */
  testRecognize(imagePath: string): Promise<OcrTestRecognizeResult>
  /** 打开 OCR 安装目录（resources/ocr），若不存在则创建 */
  openInstallDir(): Promise<OcrOpenInstallDirResult>
}

/** AI 日报生成请求载荷 */
export interface AiGenerateReportPayload {
  date: string
  templateId: ReportTemplate
  episodeIds: string[]
  notes: string
  reportInputSnapshot?: import('@/types').ReportInputSnapshot
}

/** AI 日报生成结果 */
export interface AiGenerateReportResult {
  markdown: string
  aiInputSnapshot: string
  segmentIds: string[]
  /** 已保存到数据库的报告 ID */
  reportId: string
  /** 已保存的 Report 对象（status='draft'） */
  report: Report
  /** token 用量 */
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  /** 交叉校验警告（若为空字符串则无警告） */
  warning: string
  /** 已脱敏的敏感信息数量（手机号/邮箱/身份证/银行卡） */
  maskedCount: number
}

export interface AiApi {
  generateReport(payload: AiGenerateReportPayload): Promise<AiGenerateReportResult>
  extractWiki(payload: unknown): Promise<string>
  distillHour(date: string, hourBucket: string): Promise<{ created: number; skipped: boolean; message: string }>
  runDueDistill(): Promise<{ created: number; skipped: boolean; message: string }>
  testConnection(): Promise<{ ok: boolean; message: string }>
  getTemplates(): Promise<Array<{ id: ReportTemplate; name: string; description: string }>>
  /** 估算发送字符数（供前端确认面板显示） */
  estimateChars(episodeIds: string[], notes: string): Promise<number>
  /** 导出为 Markdown 文件内容 */
  exportMarkdown(report: Report): Promise<string>
  /**
   * 导出为原生 .docx 文件：主进程生成 .docx 后弹出保存对话框写入用户选定路径。
   * 返回保存路径；用户取消返回 null。
   */
  exportWord(payload: { markdown: string; title: string; date: string }): Promise<string | null>
  /** 导出为 JSON 文件内容 */
  exportJson(report: Report): Promise<string>
}

/** Mascot 气泡数据 */
export interface MascotBubbleData {
  title: string
  message: string
  action?: string
}

/** Mascot 初始状态响应 */
export interface MascotInitialState {
  state: string
  style: string
}

/** Mascot 频率限制统计 */
export interface MascotFrequencyStats {
  todayShown: number
  todayClosedInWindow: number
  blockedToday: boolean
  date: string
}

export interface MascotApi {
  // 设置/获取形象与状态
  setStyle(style: string): Promise<boolean>
  getStyle(): Promise<string>
  setState(state: string): Promise<boolean>
  show(): Promise<boolean>
  hide(): Promise<boolean>
  // 主动气泡
  showBubble(text: string): Promise<boolean>
  // 灵感捕捉
  ghostCapture(text: string): Promise<boolean>
  // 频率限制统计
  getStats(): Promise<MascotFrequencyStats>
  // Mascot 渲染进程初始化
  getInitialState(): Promise<MascotInitialState>
  // Mascot 渲染进程 → 主进程：交互事件
  leftClick(): Promise<boolean>
  rightClick(): Promise<boolean>
  rightDoubleClick(): Promise<boolean>
  bubbleClosed(): Promise<boolean>
  mouseEnter(): Promise<boolean>
  mouseLeave(): Promise<boolean>
  dragStart(): Promise<boolean>
  dragEnd(): Promise<boolean>
  // 导航
  navigate(page: string): Promise<boolean>
  // 主进程 → Mascot 渲染进程：事件监听
  onStateChanged(cb: (state: string) => void): () => void
  onStyleChanged(cb: (style: string) => void): () => void
  onBubbleShow(cb: (bubble: MascotBubbleData) => void): () => void
  onNavigate(cb: (page: string) => void): () => void
}

export interface SettingsApi {
  get(): Promise<AppSettings>
  set(patch: Partial<AppSettings>): Promise<AppSettings>
  reset(): Promise<AppSettings>
  /** 加密保存 API Key（经 safeStorage 加密后存为 apiKeyEncrypted） */
  setApiKey(key: string): Promise<void>
  /** 清空 API Key（删除 apiKeyEncrypted） */
  clearApiKey(): Promise<void>
}

/** 数据清理统计 */
export interface DataCleanupStats {
  deletedSegments: number
  deletedEpisodes: number
  deletedScreenshots: number
  orphanWikiSources: number
}

export interface DataClearResult {
  segments: number
  episodes: number
  wikiPages?: number
  reports?: number
}

export interface DataStats {
  segmentCount: number
  episodeCount: number
  wikiCount: number
  reportCount: number
  screenshotCount: number
  dbSizeBytes: number
}

export interface DataApi {
  cleanup(): Promise<DataCleanupStats>
  clearDay(date: string): Promise<DataClearResult>
  clearAll(): Promise<DataClearResult>
  getStats(): Promise<DataStats>
}

/** system.saveFile 允许的扩展名白名单 */
export type SaveFileExtension = 'md' | 'doc' | 'docx' | 'json' | 'png' | 'txt' | '*'

/** 文件保存过滤器 */
export interface SaveFileFilter {
  name: string
  extensions: SaveFileExtension[]
}

export interface SystemApi {
  /** 弹出保存文件对话框并写入内容，返回保存路径或 null（用户取消） */
  saveFile(
    defaultName: string,
    content: string,
    filters?: SaveFileFilter[]
  ): Promise<string | null>
  /** 同时写入 text/plain 与 text/html 到系统剪贴板（用于富文本粘贴到 Word/飞书） */
  writeClipboard(payload: { text: string; html: string }): Promise<{ ok: true }>
}

/** 日期范围 */
export interface InsightsDateRange {
  start: string
  end: string
}

/** 时间审计结果（与 TimeAuditEngine.TimeAuditResult 对应） */
export interface TimeAuditResult {
  byProject: Array<{ name: string; seconds: number; episodeCount: number }>
  byPerson: Array<{ name: string; seconds: number; episodeCount: number }>
  byWorkType: Array<{ type: string; label: string; seconds: number; percentage: number }>
  totalSeconds: number
}

/** 异常洞察 */
export interface InsightItem {
  type: string
  severity: 'info' | 'warning' | 'danger'
  title: string
  message: string
  suggestion: string
  date: string
  metric?: number
}

/** 每日趋势项 */
export interface DailyTrendItem {
  date: string
  seconds: number
  episodeCount: number
}

/** 综合洞察结果 */
export interface InsightsResult {
  timeAudit: TimeAuditResult
  anomalies: InsightItem[]
  dailyTrend: DailyTrendItem[]
}

export interface InsightsApi {
  getAudit(dateRange?: InsightsDateRange): Promise<TimeAuditResult>
  getAnomalies(dateRange?: InsightsDateRange): Promise<InsightItem[]>
  getTrend(days?: number): Promise<DailyTrendItem[]>
  getInsights(dateRange?: InsightsDateRange): Promise<InsightsResult>
  pushInsight(title: string, message: string, navigatePage?: string): Promise<boolean>
}

/** FTS5 段落匹配结果 */
export interface FtsSegmentMatch {
  segmentId: string
  snippet: string
  matchedField: 'ocr_text' | 'window_title'
}

/** FTS5 事件匹配结果 */
export interface FtsEpisodeMatch {
  episodeId: string
  snippet: string
  matchedField: 'title' | 'one_line_summary'
}

export interface FtsCleanEpisodeMatch {
  cleanEpisodeId: string
  snippet: string
  matchedField: 'title' | 'summary' | 'evidence_refs'
}

/** FTS5 Wiki 匹配结果 */
export interface FtsWikiMatch {
  wikiId: string
  title: string
  snippet: string
}

/** FTS5 综合搜索结果 */
export interface FtsSearchResult {
  cleanEpisodes: FtsCleanEpisodeMatch[]
  segments: FtsSegmentMatch[]
  episodes: FtsEpisodeMatch[]
  wikis: FtsWikiMatch[]
}

/** 混合检索匹配类型 */
export type HybridMatchType = 'keyword' | 'semantic' | 'hybrid'

/** 混合检索选项（渲染进程 → 主进程） */
export interface HybridSearchOptions {
  limit?: number
  keywordWeight?: number
  semanticWeight?: number
}

/** 混合检索单条结果（主进程 → 渲染进程） */
export interface HybridSearchResult {
  memCellId: string
  score: number
  matchType: HybridMatchType
  keywordScore?: number
  semanticScore?: number
  memCell?: {
    id: string
    cleanEpisodeId: string
    episode: string
    facts: string[]
    foresight: Array<{
      statement: string
      validFrom: string
      validTo: string
      confidence: number
    }>
    metadata: {
      segmentIds: string[]
      timestamp: string
      confidence: number
      activityType?: string
      contentType?: string
    }
    createdAt: string
  }
  snippet?: string
}

export interface SearchApi {
  /** FTS5 全文搜索：返回 segments/episodes/wikis 三类匹配 + snippet */
  fts(query: string): Promise<FtsSearchResult>
  /** 混合检索：FTS5 关键词 + 语义向量，返回 MemCell 匹配结果 + matchType */
  hybrid(query: string, options?: HybridSearchOptions): Promise<HybridSearchResult[]>
}

/** 渲染进程通过 window.workmemory 访问的完整 API */
export interface WorkMemoryApi {
  window: WindowApi
  segment: SegmentApi
  episode: EpisodeApi
  wiki: WikiApi
  cleanEpisode: CleanEpisodeApi
  report: ReportApi
  privacy: PrivacyApi
  capture: CaptureApi
  ocr: OcrApi
  ai: AiApi
  mascot: MascotApi
  settings: SettingsApi
  data: DataApi
  system: SystemApi
  insights: InsightsApi
  search: SearchApi
}
