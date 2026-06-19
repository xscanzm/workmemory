import type {
  WorkSegment,
  AppConfig,
  PrivacyRule,
  AiProviderConfig,
  ReportTemplate,
  Report,
  RecorderStatus,
  CalendarDayInfo,
  DailySummary,
  SegmentSearchResult,
  WorkStats,
  MemoryGraphData,
  KnowledgeNode,
  KnowledgeLink,
  KnowledgeGraphData,
  InsightCard,
  SmartReminder,
  AnomalyDetection,
  PetCharacter,
  AiExtractResult,
  NarrativeResult,
  PetEmotionState,
} from "../../shared/types";

export interface WorkMemoryApi {
  // Recorder
  getRecorderStatus: () => Promise<RecorderStatus>;
  setRecorderStatus: (status: string) => Promise<RecorderStatus>;
  onRecorderStatusChange: (callback: (status: string) => void) => () => void;

  // Segments
  getSegments: (date: string) => Promise<WorkSegment[]>;
  getSegment: (id: string) => Promise<WorkSegment | null>;
  updateSegment: (id: string, updates: Partial<WorkSegment>) => Promise<WorkSegment | null>;
  deleteSegment: (id: string) => Promise<boolean>;
  toggleSegmentSelection: (id: string) => Promise<WorkSegment | null>;
  clearToday: (date: string) => Promise<boolean>;
  clearAll: () => Promise<boolean>;

  // Config
  getAppConfig: () => Promise<AppConfig>;
  saveAppConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;

  // Privacy
  getPrivacyRules: () => Promise<PrivacyRule[]>;
  savePrivacyRule: (rule: Omit<PrivacyRule, "id" | "createdAt" | "updatedAt">) => Promise<PrivacyRule>;
  updatePrivacyRule: (id: string, updates: Partial<PrivacyRule>) => Promise<PrivacyRule[]>;
  deletePrivacyRule: (id: string) => Promise<boolean>;

  // AI
  getAiConfigs: () => Promise<AiProviderConfig[]>;
  saveAiConfig: (config: Omit<AiProviderConfig, "id" | "createdAt" | "updatedAt">) => Promise<AiProviderConfig>;
  deleteAiConfig: (id: string) => Promise<boolean>;
  testAiConnection: (configId?: string) => Promise<{ success: boolean; error?: string }>;
  generateReport: (params: {
    date: string;
    templateId: string;
    userNotes?: string;
  }) => Promise<{
    content?: string;
    error?: string;
    reportId?: string;
    inputSnapshot?: string;
    segments?: Array<{
      start_time: string;
      end_time: string;
      app_name: string;
      title: string;
      summary: string;
      user_note?: string;
      tags: string[];
    }>;
  }>;

  // Templates
  getTemplates: () => Promise<ReportTemplate[]>;
  saveTemplate: (template: Omit<ReportTemplate, "id" | "createdAt" | "updatedAt">) => Promise<ReportTemplate>;
  deleteTemplate: (id: string) => Promise<boolean>;

  // Reports
  getReports: () => Promise<Report[]>;
  saveReport: (report: Partial<Report> & { markdownContent?: string; richTextContent?: string; status?: Report["status"] }) => Promise<Report | null>;
  exportMarkdown: (content: string, filename: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  exportWord: (htmlContent: string, filename: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  copyRichText: (markdown: string) => Promise<string>;

  // App
  getAppVersion: () => Promise<string>;
  quitApp: () => Promise<boolean>;

  // Calendar & Daily Summary
  getCalendarMonth: (year: number, month: number) => Promise<CalendarDayInfo[]>;
  getDailySummary: (date: string) => Promise<DailySummary | null>;
  generateDailySummary: (date: string, force?: boolean) => Promise<DailySummary | null>;
  getSegmentsByDate: (date: string) => Promise<WorkSegment[]>;

  // Search
  searchSegments: (query: string) => Promise<SegmentSearchResult[]>;

  // Stats
  getWorkStats: (startDate: string, endDate: string) => Promise<WorkStats>;

  // Export Date Range
  exportDateRange: (
    startDate: string,
    endDate: string,
    format: "markdown" | "json"
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>;

  // Pet (桌面常驻形象)
  petClick: () => void;
  petDrag: (deltaX: number, deltaY: number) => void;
  petCycleCharacter: () => void;
  petToggleMain: () => void;
  onPetStatus: (callback: (status: string) => void) => () => void;
  onPetCharacterChange: (callback: (character: string) => void) => () => void;
  setPetEnabled: (enabled: boolean) => Promise<{ enabled: boolean; character: PetCharacter }>;
  setPetCharacter: (character: string) => Promise<{ enabled: boolean; character: PetCharacter }>;
  getPetConfig: () => Promise<{ enabled: boolean; character: PetCharacter }>;

  // Memory Graph (人/事/时间串联)
  getMemoryGraph: (startDate?: string, endDate?: string) => Promise<MemoryGraphData>;
  getSegmentsByPerson: (person: string) => Promise<WorkSegment[]>;
  getSegmentsByEvent: (event: string) => Promise<WorkSegment[]>;
  updateSegmentPeopleEvent: (id: string, people: string[], event?: string) => Promise<WorkSegment | null>;

  // Wiki Knowledge Base (知识库双链)
  wikiGetNodes: () => Promise<KnowledgeNode[]>;
  wikiGetNode: (id: string) => Promise<KnowledgeNode | null>;
  wikiSaveNode: (node: Partial<KnowledgeNode> & { title: string; content: string }) => Promise<KnowledgeNode>;
  wikiDeleteNode: (id: string) => Promise<boolean>;
  wikiSearch: (query: string) => Promise<KnowledgeNode[]>;
  wikiGetLinks: (nodeId: string) => Promise<{ outgoing: KnowledgeLink[]; incoming: KnowledgeLink[] }>;
  wikiGetGraph: () => Promise<KnowledgeGraphData>;
  wikiExtractFromSegments: (segmentIds: string[]) => Promise<{ extracted: number; nodes: KnowledgeNode[] }>;

  // Proactive Intelligence (主动智能)
  insightsGet: (includeDismissed?: boolean) => Promise<InsightCard[]>;
  insightsDismiss: (id: string) => Promise<boolean>;
  insightsGetReminders: (includeDismissed?: boolean) => Promise<SmartReminder[]>;
  insightsDismissReminder: (id: string) => Promise<boolean>;
  insightsGetAnomalies: (includeDismissed?: boolean) => Promise<AnomalyDetection[]>;
  insightsRefresh: () => Promise<{ insights: number; anomalies: number }>;

  // Ultimate Experience (终极体验)
  memorySearchInstant: (keyword: string) => Promise<SegmentSearchResult[]>;
  memoryGetTimelapse: (segmentId: string, timestamp: number) => Promise<string[]>;
  aiExtractInsight: (ocrText: string) => Promise<AiExtractResult | null>;
  knowledgeDirectFeed: (content: string, source: string) => Promise<KnowledgeNode>;
  onPetSyncEmotions: (callback: (state: PetEmotionState) => void) => () => void;
  insightsFetchNarrative: (weekId: number) => Promise<NarrativeResult | null>;

  // Navigation
  onNavigate: (callback: (route: string) => void) => () => void;

  // Segment change listener (real-time updates from recorder)
  onSegmentChange: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    workmemory: WorkMemoryApi;
  }
}

export {};