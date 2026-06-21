/**
 * IPC 入参 Zod schema 定义
 *
 * 为每个 IPC 通道定义严格的入参校验 schema。
 * 设计原则：
 *  - 无参通道用 z.undefined()
 *  - 有参通道用 z.object({...})，preload 端将多参数打包为单对象
 *  - id 是 string(min 1)，date 是 YYYY-MM-DD，枚举值用 z.enum
 *  - 禁止 z.any()/z.unknown() 敷衍；动态字段需注释说明
 */
import { z } from 'zod'

/* ===================== 公共基础 schema ===================== */

/** YYYY-MM-DD 日期字符串 */
const dateString = z
  .string()
  .min(1)
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD')

/** 非空 ID 字符串 */
const idString = z.string().min(1)

/** 无参通道 payload（ipcRenderer.invoke 不传第二参数时 payload 为 undefined） */
const voidSchema = z.undefined()

/* ===================== 枚举 ===================== */

const reportTemplateEnum = z.enum(['enhanced', 'concise', 'okr', 'structured'])
const sourceQualityEnum = z.enum(['high', 'medium', 'low', 'failed', 'private'])
const memoryKindEnum = z.enum([
  'work',
  'research',
  'communication',
  'coding',
  'planning',
  'review',
  'admin',
  'idle_uncertain'
])
const wikiStatusEnum = z.enum(['none', 'candidate', 'auto_upserted', 'needs_review', 'rejected'])
const reportStatusEnum = z.enum(['draft', 'exported'])
const reportTypeEnum = z.enum(['daily', 'weekly', 'review'])
const ocrModelEnum = z.enum(['tiny', 'small'])
const mascotStyleEnum = z.enum(['note', 'film', 'copilot', 'cursor', 'paper'])
const mascotStateEnum = z.enum([
  'recording',
  'paused',
  'privacy',
  'ocr_scanning',
  'report_ready'
])
const wikiTypeEnum = z.enum([
  'person',
  'project',
  'customer',
  'topic',
  'decision',
  'meeting',
  'issue'
])
const wikiReviewStatusEnum = z.enum(['needs_review', 'reviewed'])
const privacyRuleTypeEnum = z.enum([
  'app_name',
  'process_name',
  'window_title',
  'url'
])
const privacyMatchModeEnum = z.enum(['contains', 'equals', 'regex'])

/** 实体类型枚举（用于实体确认/修正/忽略通道） */
const entityTypeEnum = z.enum(['person', 'project', 'document', 'url'])

/* ===================== 领域对象 schema ===================== */

const entityRefSchema = z.object({
  type: z.enum(['person', 'project', 'document', 'url']),
  name: z.string(),
  value: z.string().optional(),
  confidence: z.number().min(0).max(1),
  userConfirmed: z.boolean().optional()
})

/** Episode 完整对象 */
const episodeSchema = z.object({
  id: z.string(),
  date: dateString,
  startTime: z.string(),
  endTime: z.string(),
  title: z.string(),
  oneLineSummary: z.string(),
  segmentIds: z.array(z.string()),
  entities: z.array(entityRefSchema),
  topics: z.array(z.string()),
  userEdited: z.boolean(),
  reportEligible: z.boolean(),
  wikiEligible: z.boolean()
})

const evidenceRefSchema = z.object({
  segmentId: z.string(),
  quote: z.string(),
  reason: z.string()
})

const reportSnapshotItemSchema = z.object({
  id: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  title: z.string(),
  summary: z.string(),
  project: z.string(),
  topics: z.array(z.string()),
  entities: z.array(entityRefSchema),
  evidenceRefs: z.array(evidenceRefSchema),
  segmentIds: z.array(z.string()),
  sourceQuality: sourceQualityEnum,
  confidence: z.number().min(0).max(1)
})

const reportInputSnapshotSchema = z.object({
  date: dateString,
  templateId: reportTemplateEnum,
  userNotes: z.string(),
  createdAt: z.string(),
  sourceType: z.enum(['clean_episodes', 'raw_fallback']),
  items: z.array(reportSnapshotItemSchema),
  segmentIds: z.array(z.string()),
  cleanEpisodeIds: z.array(z.string()),
  maskedCount: z.number().int().min(0)
})

/** WikiPage 完整对象 */
const wikiPageSchema = z.object({
  id: z.string(),
  type: wikiTypeEnum,
  title: z.string(),
  aliases: z.array(z.string()),
  content: z.string(),
  sources: z.array(z.string()),
  backlinks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  reviewStatus: wikiReviewStatusEnum,
  createdAt: z.string(),
  updatedAt: z.string()
})

/** Report 完整对象 */
const reportSchema = z.object({
  id: z.string(),
  date: dateString,
  templateId: reportTemplateEnum,
  templateName: z.string(),
  segmentIds: z.array(z.string()),
  aiInputSnapshot: z.string(),
  markdownContent: z.string(),
  status: reportStatusEnum,
  reportType: reportTypeEnum
})

/** PrivacyRule 完整对象（不含 id，供 insert） */
const privacyRuleInsertSchema = z.object({
  type: privacyRuleTypeEnum,
  pattern: z.string().min(1),
  matchMode: privacyMatchModeEnum,
  enabled: z.boolean()
})

/* ===================== Segment 通道 schema ===================== */

export const segmentSchemas = {
  /** segment:insert 已删除 — segments 由 CaptureManager 自动创建 */
  Update: z.object({
    id: idString,
    patch: z
      .object({
        userTitle: z.string().optional(),
        userSummary: z.string().optional(),
        userNote: z.string().optional(),
        tags: z.array(z.string()).optional(),
        isSelectedForReport: z.boolean().optional(),
        isImportant: z.boolean().optional()
      })
      .strict()
  }),
  GetById: z.object({ id: idString }),
  GetByDate: z.object({ date: dateString }),
  GetActiveByDate: z.object({ date: dateString }),
  SetSelectedForReport: z.object({ id: idString, selected: z.boolean() }),
  SetImportant: z.object({ id: idString, important: z.boolean() }),
  SoftDelete: z.object({ id: idString }),
  HardDelete: z.object({ id: idString }),
  GetPrivateByDate: z.object({ date: dateString })
} as const

/* ===================== Episode 通道 schema ===================== */

export const episodeSchemas = {
  Insert: z.object({ episode: episodeSchema }),
  Update: z.object({
    id: idString,
    patch: z
      .object({
        date: dateString.optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        title: z.string().optional(),
        oneLineSummary: z.string().optional(),
        segmentIds: z.array(z.string()).optional(),
        entities: z.array(entityRefSchema).optional(),
        topics: z.array(z.string()).optional(),
        userEdited: z.boolean().optional(),
        reportEligible: z.boolean().optional(),
        wikiEligible: z.boolean().optional()
      })
      .strict()
  }),
  GetById: z.object({ id: idString }),
  GetByDate: z.object({ date: dateString }),
  SetOneLineSummary: z.object({ id: idString, summary: z.string() }),
  SetReportEligible: z.object({ id: idString, eligible: z.boolean() }),
  SetWikiEligible: z.object({ id: idString, eligible: z.boolean() }),
  GetDailySummary: z.object({ date: dateString }),
  SetDailySummary: z.object({ date: dateString, text: z.string() }),
  /** 确认实体：标记 userConfirmed=true */
  ConfirmEntity: z.object({ id: idString, entityType: entityTypeEnum, entityName: z.string().min(1) }),
  /** 修正实体名：更新 name 并标记 userConfirmed=true */
  CorrectEntity: z.object({
    id: idString,
    entityType: entityTypeEnum,
    entityName: z.string().min(1),
    newName: z.string().min(1)
  }),
  /** 忽略实体：从 episode.entities 中移除 */
  IgnoreEntity: z.object({ id: idString, entityType: entityTypeEnum, entityName: z.string().min(1) })
} as const

export const cleanEpisodeSchemas = {
  GetById: z.object({ id: idString }),
  GetByDate: z.object({ date: dateString }),
  GetByHour: z.object({ date: dateString, hourBucket: z.string().regex(/^\d{2}:00$/) }),
  GetByDateRange: z.object({ startDate: dateString, endDate: dateString }),
  Update: z.object({
    id: idString,
    patch: z
      .object({
        title: z.string().optional(),
        summary: z.string().optional(),
        memoryKind: memoryKindEnum.optional(),
        project: z.string().optional(),
        entities: z.array(entityRefSchema).optional(),
        topics: z.array(z.string()).optional(),
        materials: z.array(z.string()).optional(),
        outputs: z.array(z.string()).optional(),
        todos: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
        evidenceRefs: z.array(evidenceRefSchema).optional(),
        sourceQuality: sourceQualityEnum.optional(),
        confidence: z.number().min(0).max(1).optional(),
        reportEligible: z.boolean().optional(),
        wikiEligible: z.boolean().optional(),
        wikiStatus: wikiStatusEnum.optional()
      })
      .strict()
  })
} as const

/* ===================== Wiki 通道 schema ===================== */

export const wikiSchemas = {
  Insert: z.object({ page: wikiPageSchema }),
  Update: z.object({
    id: idString,
    patch: z
      .object({
        type: wikiTypeEnum.optional(),
        title: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        content: z.string().optional(),
        sources: z.array(z.string()).optional(),
        backlinks: z.array(z.string()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        reviewStatus: wikiReviewStatusEnum.optional()
      })
      .strict()
  }),
  Delete: z.object({ id: idString }),
  GetById: z.object({ id: idString }),
  GetByType: z.object({ type: wikiTypeEnum }),
  GetByTitle: z.object({ title: z.string().min(1) }),
  GetAll: voidSchema,
  SearchByTitle: z.object({ keyword: z.string().min(1) }),
  AddToReviewQueue: z.object({
    page: z.object({
      type: wikiTypeEnum,
      title: z.string(),
      aliases: z.array(z.string()),
      content: z.string(),
      sources: z.array(z.string()),
      backlinks: z.array(z.string()),
      confidence: z.number().min(0).max(1)
    })
  }),
  GetReviewQueue: voidSchema,
  ConfirmReview: z.object({ id: idString }),
  RejectReview: z.object({ id: idString }),
  UpdateBacklinks: z.object({ id: idString }),
  GetBacklinks: z.object({ title: z.string().min(1) }),
  FindBrokenLinks: voidSchema,
  ScanNow: voidSchema,
  PreviewIngest: z.object({ reviewItemId: idString }),
  ConfirmIngest: z.object({
    reviewItemId: idString,
    edits: z
      .object({
        content: z.string().optional(),
        title: z.string().optional()
      })
      .optional()
  }),
  RejectIngest: z.object({ reviewItemId: idString }),
  GetBrokenLinks: voidSchema,
  RebuildBacklinks: voidSchema
} as const

/* ===================== Report 通道 schema ===================== */

export const reportSchemas = {
  /** report:insert 已删除 — reports 由 AiManager.generateReport 自动创建 */
  Update: z.object({
    id: idString,
    patch: z
      .object({
        date: dateString.optional(),
        templateId: reportTemplateEnum.optional(),
        templateName: z.string().optional(),
        segmentIds: z.array(z.string()).optional(),
        aiInputSnapshot: z.string().optional(),
        markdownContent: z.string().optional(),
        status: reportStatusEnum.optional(),
        reportType: reportTypeEnum.optional()
      })
      .strict()
  }),
  /** 业务 action：保存草稿（status 强制为 draft） */
  SaveDraft: z.object({
    id: z.string().optional(),
    date: dateString,
    templateId: reportTemplateEnum,
    templateName: z.string(),
    segmentIds: z.array(z.string()),
    aiInputSnapshot: z.string(),
    markdownContent: z.string(),
    reportType: reportTypeEnum.optional()
  }),
  GetById: z.object({ id: idString }),
  GetByDate: z.object({ date: dateString }),
  GetAllHistory: voidSchema,
  SetStatus: z.object({ id: idString, status: reportStatusEnum })
} as const

/* ===================== Privacy 通道 schema ===================== */

export const privacySchemas = {
  Insert: z.object({ rule: privacyRuleInsertSchema }),
  Update: z.object({
    id: idString,
    patch: z
      .object({
        type: privacyRuleTypeEnum.optional(),
        pattern: z.string().min(1).optional(),
        matchMode: privacyMatchModeEnum.optional(),
        enabled: z.boolean().optional()
      })
      .strict()
  }),
  Delete: z.object({ id: idString }),
  GetAll: voidSchema,
  GetEnabled: voidSchema,
  MatchRule: z.object({
    appName: z.string(),
    processName: z.string(),
    windowTitle: z.string(),
    url: z.string()
  })
} as const

/* ===================== Settings 通道 schema ===================== */

/**
 * settings.set 可写字段白名单。
 * apiKey 不在此白名单（走专门 setApiKey）；
 * apiKeyMasked 不可写（派生字段，由 SettingsStore 从加密 blob 派生）。
 */
export const settingsSetPatchSchema = z
  .object({
    autoStart: z.boolean().optional(),
    screenshotRetentionDays: z.number().int().min(0).max(7).optional(),
    ocrModel: ocrModelEnum.optional(),
    apiBaseUrl: z.string().min(1).optional(),
    modelName: z.string().min(1).optional(),
    mascotStyle: mascotStyleEnum.optional(),
    saveScreenshots: z.boolean().optional(),
    allowFullScreenshotFallback: z.boolean().optional(),
    aiAutoDistillEnabled: z.boolean().optional(),
    aiAutoDistillFirstConsentAt: z.string().optional(),
    aiDistillSchedule: z.literal('hourly').optional(),
    aiDistillLastRunAt: z.string().optional(),
    aiDistillSendScreenshots: z.literal(false).optional()
  })
  .strict()

export const settingsSchemas = {
  Get: voidSchema,
  Set: z.object({ patch: settingsSetPatchSchema }),
  Reset: voidSchema,
  SetApiKey: z.object({ key: z.string() }),
  ClearApiKey: voidSchema
} as const

/* ===================== AI 通道 schema ===================== */

export const aiSchemas = {
  GenerateReport: z.object({
    payload: z.object({
      date: dateString,
      templateId: reportTemplateEnum,
      episodeIds: z.array(z.string()),
      notes: z.string(),
      reportInputSnapshot: reportInputSnapshotSchema.optional()
    })
  }),
  ExtractWiki: voidSchema,
  DistillHour: z.object({
    date: dateString,
    hourBucket: z.string().regex(/^\d{2}:00$/)
  }),
  RunDueDistill: voidSchema,
  TestConnection: voidSchema,
  GetTemplates: voidSchema,
  EstimateChars: z.object({
    episodeIds: z.array(z.string()),
    notes: z.string()
  }),
  ExportMarkdown: z.object({ report: reportSchema }),
  /**
   * Word 导出：接收 markdown 源文本与元数据，主进程生成 .docx 后弹出保存对话框写入文件。
   * 返回保存路径或 null（用户取消）。
   */
  ExportWord: z.object({
    markdown: z.string(),
    title: z.string(),
    date: dateString
  }),
  ExportJson: z.object({ report: reportSchema })
} as const

/* ===================== Mascot 通道 schema ===================== */

export const mascotSchemas = {
  SetStyle: z.object({ style: mascotStyleEnum }),
  GetStyle: voidSchema,
  SetState: z.object({ state: mascotStateEnum }),
  Show: voidSchema,
  Hide: voidSchema,
  ShowBubble: z.object({ text: z.string() }),
  GhostCapture: z.object({ text: z.string() }),
  GetStats: voidSchema,
  GetInitialState: voidSchema,
  LeftClick: voidSchema,
  RightClick: voidSchema,
  RightDoubleClick: voidSchema,
  BubbleClosed: voidSchema,
  MouseEnter: voidSchema,
  MouseLeave: voidSchema,
  DragStart: voidSchema,
  DragEnd: voidSchema,
  Navigate: z.object({ page: z.string().min(1) })
} as const

/* ===================== OCR 通道 schema ===================== */

export const ocrSchemas = {
  Recognize: z.object({ imagePath: z.string().min(1) }),
  SetModel: z.object({ model: ocrModelEnum }),
  GetModel: voidSchema,
  GetStatus: voidSchema,
  Reprocess: z.object({ segmentId: idString }),
  GetRuntimeStatus: voidSchema,
  TestRecognize: z.object({ imagePath: z.string().min(1) }),
  OpenInstallDir: voidSchema
} as const

/* ===================== Capture 通道 schema ===================== */

export const captureSchemas = {
  Start: voidSchema,
  Stop: voidSchema,
  Pause: voidSchema,
  Resume: voidSchema,
  GetState: voidSchema
} as const

/* ===================== Insights 通道 schema ===================== */

const insightsDateRangeSchema = z.object({
  start: dateString,
  end: dateString
})

export const insightsSchemas = {
  GetAudit: z.object({ dateRange: insightsDateRangeSchema.optional() }),
  GetAnomalies: z.object({ dateRange: insightsDateRangeSchema.optional() }),
  GetTrend: z.object({ days: z.number().int().min(1).max(365).optional() }),
  GetInsights: z.object({ dateRange: insightsDateRangeSchema.optional() }),
  PushInsight: z.object({
    title: z.string().min(1),
    message: z.string().min(1),
    navigatePage: z.string().optional()
  })
} as const

/* ===================== Data 通道 schema ===================== */

export const dataSchemas = {
  Cleanup: voidSchema,
  ClearDay: z.object({ date: dateString }),
  ClearAll: voidSchema,
  GetStats: voidSchema
} as const

/* ===================== Window 通道 schema ===================== */

export const windowSchemas = {
  Minimize: voidSchema,
  Maximize: voidSchema,
  Close: voidSchema,
  IsMaximized: voidSchema
} as const

/* ===================== System 通道 schema ===================== */

/**
 * system.saveFile 限制：
 *  - defaultName 是合法文件名（不含路径分隔符 / \）
 *  - filters 扩展名白名单：md/doc/docx/json/png/txt（doc 兼容旧 HTML 导出，C2 升级后移除）
 *  - content 是 string
 */
const allowedExtensions = z.enum(['md', 'doc', 'docx', 'json', 'png', 'txt', '*'])

const fileFilterSchema = z.object({
  name: z.string().min(1),
  extensions: z.array(allowedExtensions).min(1)
})

export const systemSchemas = {
  SaveFile: z.object({
    defaultName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\\/]+$/, '文件名不得包含路径分隔符'),
    content: z.string(),
    filters: z.array(fileFilterSchema).optional()
  }),
  WriteClipboard: z.object({
    text: z.string(),
    html: z.string()
  })
} as const

/* ===================== Search 通道 schema ===================== */

export const searchSchemas = {
  /** FTS5 全文搜索：入参为非空查询字符串 */
  Fts: z.object({ query: z.string().min(1) }),
  /** 混合检索：FTS5 关键词 + 语义向量，入参为查询字符串 + 可选权重/limit */
  Hybrid: z.object({
    query: z.string().min(1),
    options: z
      .object({
        limit: z.number().int().min(1).max(100).optional(),
        keywordWeight: z.number().min(0).optional(),
        semanticWeight: z.number().min(0).optional()
      })
      .optional()
  })
} as const
