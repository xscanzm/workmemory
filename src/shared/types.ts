// ============================================================
// WorkMemory Shared Types
// 基于 PRD V0.2 数据模型
// ============================================================

// --- Recorder Status ---
export type RecorderStatus =
  | "recording"
  | "paused"
  | "privacy_mode"
  | "error"
  | "initializing";

// --- Window Snapshot ---
export interface WindowSnapshot {
  capturedAt: string;
  appName: string;
  processName: string;
  processPath?: string;
  windowTitle: string;
  windowHandle: string;
  monitorId?: string;
  isIdle: boolean;
}

// --- Work Segment ---
export interface WorkSegment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  appName: string;
  processName: string;
  windowTitle: string;
  windowTitleSanitized?: string;
  monitorId?: string;
  ocrText?: string;
  ocrSummary?: string;
  ocrConfidence?: number;
  imageHash?: string;
  textHash?: string;
  screenshotPath?: string;
  screenshotSaved: boolean;
  isSelectedForReport: boolean;
  isPrivate: boolean;
  isImportant: boolean;
  isDeleted: boolean;
  sourceStatus: SegmentSourceStatus;
  userTitle?: string;
  userSummary?: string;
  userNote?: string;
  tags: string[];
  // 人/事/时间串联维度
  people?: string[];
  event?: string;
  createdAt: string;
  updatedAt: string;
}

export type SegmentSourceStatus =
  | "pending"
  | "ocr_done"
  | "ocr_failed"
  | "no_text"
  | "private";

// --- App Config ---
export interface AppConfig {
  launchAtStartup: boolean;
  saveScreenshots: boolean;
  screenshotRetentionDays: number;
  ocrProvider: "paddleocr" | "windows_ocr" | "mock";
  ocrLanguage: "ch" | "en" | "ch_en";
  minScreenshotIntervalSeconds: number;
  maxSegmentDurationMinutes: number;
  idleThresholdMinutes: number;
  privacyAction: "skip" | "placeholder";
  defaultReportTemplateId?: string;
  aiProviderConfigId?: string;
  // 桌面常驻形象
  petEnabled: boolean;
  petCharacter: PetCharacter;
  // 主动智能
  insightsEnabled: boolean;
  smartReminderEnabled: boolean;
  anomalyDetectionEnabled: boolean;
  // 叙事复盘
  narrativeEnabled?: boolean;
}

export type PetCharacter = "cat" | "robot" | "ghost" | "droplet" | "fox" | "star";

export const PET_CHARACTERS: PetCharacter[] = ["cat", "robot", "ghost", "droplet", "fox", "star"];

export const PET_CHARACTER_LABELS: Record<PetCharacter, string> = {
  cat: "猫咪",
  robot: "机器人",
  ghost: "小幽灵",
  droplet: "水滴",
  fox: "狐狸",
  star: "星星精灵",
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  launchAtStartup: false,
  saveScreenshots: false,
  screenshotRetentionDays: 0,
  ocrProvider: "paddleocr",
  ocrLanguage: "ch_en",
  minScreenshotIntervalSeconds: 30,
  maxSegmentDurationMinutes: 60,
  idleThresholdMinutes: 5,
  privacyAction: "skip",
  petEnabled: true,
  petCharacter: "cat",
  insightsEnabled: true,
  smartReminderEnabled: true,
  anomalyDetectionEnabled: true,
  narrativeEnabled: true,
};

// --- Privacy Rule ---
export interface PrivacyRule {
  id: string;
  type: "app_name" | "process_name" | "window_title" | "url_keyword";
  pattern: string;
  matchMode: "contains" | "equals" | "regex";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- AI Provider Config ---
export interface AiProviderConfig {
  id: string;
  name: string;
  providerType: "openai_compatible" | "platform";
  baseUrl: string;
  apiKeyEncrypted: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  timeoutSeconds: number;
  stream: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Report Template ---
export interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  type: "daily" | "weekly" | "review" | "custom";
  prompt: string;
  outputFormat: "rich_text" | "markdown";
  isBuiltIn: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Report ---
export interface Report {
  id: string;
  date: string;
  templateId: string;
  templateName: string;
  segmentIds: string[];
  userNotes?: string;
  promptSnapshot: string;
  aiInputSnapshot: string;
  markdownContent: string;
  richTextContent?: string;
  status: "draft" | "generated" | "edited" | "exported";
  createdAt: string;
  updatedAt: string;
}

// --- OCR ---
export interface OcrRequest {
  imagePath: string;
  language: "ch" | "en" | "ch_en";
  segmentId: string;
}

export interface OcrResult {
  segmentId: string;
  text: string;
  confidence?: number;
  blocks?: Array<{
    text: string;
    confidence?: number;
    box?: number[];
  }>;
  durationMs: number;
  error?: string;
}

// --- AI Generation ---
export interface AiGenerationInput {
  date: string;
  template: string;
  segments: AiSegmentInput[];
  constraints: {
    do_not_fabricate: true;
    only_use_selected_segments: true;
    language: "zh-CN";
  };
}

export interface AiSegmentInput {
  start_time: string;
  end_time: string;
  app_name: string;
  title: string;
  summary: string;
  user_note?: string;
  tags: string[];
}

// --- IPC Channel Names ---
export const IPC_CHANNELS = {
  // Recorder
  GET_RECORDER_STATUS: "recorder:get-status",
  SET_RECORDER_STATUS: "recorder:set-status",
  ON_RECORDER_STATUS_CHANGE: "recorder:on-status-change",

  // Segments
  GET_SEGMENTS: "segments:get-all",
  GET_SEGMENT: "segments:get-one",
  UPDATE_SEGMENT: "segments:update",
  DELETE_SEGMENT: "segments:delete",
  TOGGLE_SEGMENT_SELECTION: "segments:toggle-selection",
  MERGE_SEGMENTS: "segments:merge",
  SPLIT_SEGMENT: "segments:split",
  CLEAR_TODAY: "segments:clear-today",
  CLEAR_ALL: "segments:clear-all",
  ON_SEGMENT_CHANGE: "segments:on-change",

  // Config
  GET_APP_CONFIG: "config:get",
  SAVE_APP_CONFIG: "config:save",

  // Privacy
  GET_PRIVACY_RULES: "privacy:get-all",
  SAVE_PRIVACY_RULE: "privacy:save",
  UPDATE_PRIVACY_RULE: "privacy:update",
  DELETE_PRIVACY_RULE: "privacy:delete",

  // AI
  GET_AI_CONFIGS: "ai:get-configs",
  SAVE_AI_CONFIG: "ai:save-config",
  DELETE_AI_CONFIG: "ai:delete-config",
  TEST_AI_CONNECTION: "ai:test-connection",
  GENERATE_REPORT: "ai:generate-report",

  // Templates
  GET_TEMPLATES: "templates:get-all",
  SAVE_TEMPLATE: "templates:save",
  DELETE_TEMPLATE: "templates:delete",

  // Reports
  GET_REPORTS: "reports:get-all",
  SAVE_REPORT: "reports:save",
  EXPORT_MARKDOWN: "reports:export-markdown",
  EXPORT_WORD: "reports:export-word",
  COPY_RICH_TEXT: "reports:copy-rich-text",

  // App
  GET_APP_VERSION: "app:get-version",
  MINIMIZE_TO_TRAY: "app:minimize-to-tray",
  QUIT_APP: "app:quit",

  // Calendar & Daily Summary
  GET_CALENDAR_MONTH: "calendar:get-month",
  GET_DAILY_SUMMARY: "calendar:get-summary",
  GENERATE_DAILY_SUMMARY: "calendar:generate-summary",
  GET_SEGMENTS_BY_DATE: "segments:get-by-date",

  // Search
  SEARCH_SEGMENTS: "search:segments",

  // Stats
  GET_WORK_STATS: "stats:get",

  // Export
  EXPORT_DATE_RANGE: "export:date-range",

  // Pet (桌面常驻形象)
  PET_CLICK: "pet:click",
  PET_DRAG: "pet:drag",
  PET_CYCLE_CHARACTER: "pet:cycle-character",
  PET_TOGGLE_MAIN: "pet:toggle-main",
  PET_STATUS: "pet:status",
  PET_CHARACTER_CHANGE: "pet:character",
  SET_PET_ENABLED: "pet:set-enabled",
  SET_PET_CHARACTER: "pet:set-character",
  GET_PET_CONFIG: "pet:get-config",

  // Memory Graph (人/事/时间串联)
  GET_MEMORY_GRAPH: "memory-graph:get",
  GET_PEOPLE_LIST: "memory-graph:people",
  GET_EVENTS_LIST: "memory-graph:events",
  GET_SEGMENTS_BY_PERSON: "memory-graph:by-person",
  GET_SEGMENTS_BY_EVENT: "memory-graph:by-event",
  UPDATE_SEGMENT_PEOPLE_EVENT: "memory-graph:update-segment",

  // Wiki Knowledge Base (知识库双链)
  WIKI_GET_NODES: "wiki:get-nodes",
  WIKI_GET_NODE: "wiki:get-node",
  WIKI_SAVE_NODE: "wiki:save-node",
  WIKI_DELETE_NODE: "wiki:delete-node",
  WIKI_SEARCH: "wiki:search",
  WIKI_GET_LINKS: "wiki:get-links",
  WIKI_GET_GRAPH: "wiki:get-graph",
  WIKI_EXTRACT_FROM_SEGMENTS: "wiki:extract-from-segments",

  // Proactive Intelligence (主动智能)
  INSIGHTS_GET: "insights:get",
  INSIGHTS_DISMISS: "insights:dismiss",
  INSIGHTS_GET_REMINDERS: "insights:get-reminders",
  INSIGHTS_DISMISS_REMINDER: "insights:dismiss-reminder",
  INSIGHTS_GET_ANOMALIES: "insights:get-anomalies",
  INSIGHTS_REFRESH: "insights:refresh",

  // Ultimate Experience (终极体验)
  MEMORY_SEARCH_INSTANT: "memory:search-instant",
  MEMORY_GET_TIMELAPSE: "memory:get-timelapse",
  AI_EXTRACT_INSIGHT: "ai:extract-insight",
  KNOWLEDGE_DIRECT_FEED: "knowledge:direct-feed",
  PET_SYNC_EMOTIONS: "pet:sync-emotions",
  INSIGHTS_FETCH_NARRATIVE: "insights:fetch-narrative",
} as const;

// --- Daily Summary (每日一句话总结) ---
export interface DailySummary {
  date: string;
  summary: string;
  totalDurationSeconds: number;
  segmentCount: number;
  topApps: string[];
  generatedBy: "ai" | "rule";
  generatedAt: string;
}

// --- Calendar Day Info (日历每日信息) ---
export interface CalendarDayInfo {
  date: string;
  hasData: boolean;
  totalDurationSeconds: number;
  segmentCount: number;
  topApp?: string;
  summary?: string;
}

// --- Search Result (搜索结果) ---
export interface SegmentSearchResult {
  segment: WorkSegment;
  matchedFields: string[];
  snippet: string;
}

// --- Work Stats (工作统计) ---
export interface WorkStats {
  totalDurationSeconds: number;
  totalSegments: number;
  appDistribution: Array<{ app: string; durationSeconds: number; percentage: number }>;
  hourlyDistribution: number[]; // 24 个时段
  dailyTrend: Array<{ date: string; durationSeconds: number }>;
  topApps: Array<{ app: string; durationSeconds: number; count: number }>;
}

// --- App Error ---
export interface AppError {
  type: AppErrorType;
  message: string;
  module: string;
  timestamp: string;
  recoverable: boolean;
}

export type AppErrorType =
  | "window_permission_error"
  | "screenshot_failed"
  | "ocr_failed"
  | "database_error"
  | "ai_auth_failed"
  | "ai_rate_limited"
  | "ai_timeout"
  | "export_failed";

// ============================================================
// Module 2: Memory Graph (人/事/时间串联)
// ============================================================

export interface MemoryGraphData {
  people: Array<{ name: string; segmentCount: number; totalDurationSeconds: number; lastSeen: string }>;
  events: Array<{ name: string; segmentCount: number; totalDurationSeconds: number; lastSeen: string; date: string }>;
  timeline: Array<{ date: string; segmentCount: number; totalDurationSeconds: number }>;
}

// ============================================================
// Module 3: Wiki Knowledge Base (双链知识库)
// 参考 llm_wiki 项目：双链 [[]] 语法 + 知识图谱
// ============================================================

export interface KnowledgeNode {
  id: string;
  title: string;
  content: string;       // Markdown 内容，支持 [[]] 双链
  summary?: string;      // AI/规则生成的摘要
  tags: string[];
  source: "manual" | "extracted" | "imported";  // 来源
  sourceSegmentIds?: string[];  // 关联的片段 ID
  linkedNodeIds?: string[];     // 缓存的双链目标（解析后）
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeLink {
  sourceId: string;
  targetId: string;
  context?: string;  // 链接出现的上下文
}

export interface KnowledgeGraphData {
  nodes: Array<{
    id: string;
    title: string;
    summary?: string;
    tags: string[];
    linkCount: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
  }>;
}

// ============================================================
// Module 4: Proactive Intelligence (主动智能)
// ============================================================

export type InsightType =
  | "work_pattern"       // 工作模式洞察
  | "time_anomaly"       // 时间异常
  | "app_usage"          // 应用使用洞察
  | "productivity"       // 生产力建议
  | "break_reminder"     // 休息提醒
  | "focus_session"      // 专注会话识别
  | "comparison";        // 对比洞察

export type InsightSeverity = "info" | "warning" | "positive";

export interface InsightCard {
  id: string;
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  content: string;
  actionLabel?: string;      // 建议动作标签
  actionRoute?: string;      // 点击跳转路由
  metadata?: Record<string, any>;
  createdAt: string;
  dismissed: boolean;
}

export type ReminderType =
  | "daily_summary"     // 每日总结提醒
  | "long_session"      // 长时间会话提醒
  | "idle_reminder"     // 空闲提醒
  | "end_of_day"        // 下班提醒
  | "weekly_review";    // 周报提醒

export interface SmartReminder {
  id: string;
  type: ReminderType;
  title: string;
  message: string;
  scheduledAt: string;
  dismissed: boolean;
  metadata?: Record<string, any>;
}

export interface AnomalyDetection {
  id: string;
  type: "unusual_app" | "unusual_time" | "unusual_duration" | "privacy_risk";
  title: string;
  description: string;
  detectedAt: string;
  severity: "low" | "medium" | "high";
  dismissed: boolean;
  metadata?: Record<string, any>;
}

// ============================================================
// Module 5: Ultimate Experience (终极体验)
// ============================================================

// --- Pet Emotion State (心流情绪状态) ---
export type PetEmotionState = "DEEP_WORK" | "ANXIOUS" | "IDLE";

// --- AI Extract Result (闪电萃取结果) ---
export interface AiExtractResult {
  goldSentence: string;
  tags: string[];
}

// --- Narrative Result (叙事复盘结果) ---
export interface NarrativeResult {
  narrativeText: string;
  weekId: number;
  generatedAt: string;
  generatedBy: "ai" | "rule";
}

// --- Direct Feed Payload (灵感投喂载荷) ---
export interface DirectFeedPayload {
  content: string;
  source: "PET_BAG" | "MANUAL";
}