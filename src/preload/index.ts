import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/types";

const api = {
  // Recorder
  getRecorderStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GET_RECORDER_STATUS),
  setRecorderStatus: (status: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_RECORDER_STATUS, status),
  onRecorderStatusChange: (callback: (status: string) => void) => {
    const handler = (_event: any, status: string) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.ON_RECORDER_STATUS_CHANGE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ON_RECORDER_STATUS_CHANGE, handler);
    };
  },

  // Segments
  getSegments: (date: string) => ipcRenderer.invoke(IPC_CHANNELS.GET_SEGMENTS, date),
  getSegment: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GET_SEGMENT, id),
  updateSegment: (id: string, updates: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SEGMENT, id, updates),
  deleteSegment: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_SEGMENT, id),
  toggleSegmentSelection: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TOGGLE_SEGMENT_SELECTION, id),
  clearToday: (date: string) => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_TODAY, date),
  clearAll: () => ipcRenderer.invoke(IPC_CHANNELS.CLEAR_ALL),

  // Config
  getAppConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_CONFIG),
  saveAppConfig: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_APP_CONFIG, config),

  // Privacy
  getPrivacyRules: () => ipcRenderer.invoke(IPC_CHANNELS.GET_PRIVACY_RULES),
  savePrivacyRule: (rule: any) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_PRIVACY_RULE, rule),
  updatePrivacyRule: (id: string, updates: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_PRIVACY_RULE, id, updates),
  deletePrivacyRule: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_PRIVACY_RULE, id),

  // AI
  getAiConfigs: () => ipcRenderer.invoke(IPC_CHANNELS.GET_AI_CONFIGS),
  saveAiConfig: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_AI_CONFIG, config),
  deleteAiConfig: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_AI_CONFIG, id),
  testAiConnection: (configId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEST_AI_CONNECTION, configId),
  generateReport: (params: { date: string; templateId: string; userNotes?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.GENERATE_REPORT, params),

  // Templates
  getTemplates: () => ipcRenderer.invoke(IPC_CHANNELS.GET_TEMPLATES),
  saveTemplate: (template: any) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_TEMPLATE, template),
  deleteTemplate: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.DELETE_TEMPLATE, id),

  // Reports
  getReports: () => ipcRenderer.invoke(IPC_CHANNELS.GET_REPORTS),
  saveReport: (report: any) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_REPORT, report),
  exportMarkdown: (content: string, filename: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_MARKDOWN, content, filename),
  exportWord: (htmlContent: string, filename: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXPORT_WORD, htmlContent, filename),
  copyRichText: (markdown: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COPY_RICH_TEXT, markdown),

  // App
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_VERSION),
  quitApp: () => ipcRenderer.invoke(IPC_CHANNELS.QUIT_APP),

  // Calendar & Daily Summary
  getCalendarMonth: (year: number, month: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_CALENDAR_MONTH, year, month),
  getDailySummary: (date: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_DAILY_SUMMARY, date),
  generateDailySummary: (date: string, force?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.GENERATE_DAILY_SUMMARY, date, force),
  getSegmentsByDate: (date: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SEGMENTS_BY_DATE, date),

  // Search
  searchSegments: (query: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SEGMENTS, query),

  // Stats
  getWorkStats: (startDate: string, endDate: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_WORK_STATS, startDate, endDate),

  // Export Date Range
  exportDateRange: (
    startDate: string,
    endDate: string,
    format: "markdown" | "json"
  ) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_DATE_RANGE, startDate, endDate, format),

  // === Pet (桌面常驻形象) ===
  petClick: () => ipcRenderer.send(IPC_CHANNELS.PET_CLICK),
  petDrag: (deltaX: number, deltaY: number) =>
    ipcRenderer.send(IPC_CHANNELS.PET_DRAG, deltaX, deltaY),
  petCycleCharacter: () => ipcRenderer.send(IPC_CHANNELS.PET_CYCLE_CHARACTER),
  petToggleMain: () => ipcRenderer.send(IPC_CHANNELS.PET_TOGGLE_MAIN),
  onPetStatus: (callback: (status: string) => void) => {
    const handler = (_event: any, status: string) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.PET_STATUS, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PET_STATUS, handler);
    };
  },
  onPetCharacterChange: (callback: (character: string) => void) => {
    const handler = (_event: any, character: string) => callback(character);
    ipcRenderer.on(IPC_CHANNELS.PET_CHARACTER_CHANGE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PET_CHARACTER_CHANGE, handler);
    };
  },
  setPetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_PET_ENABLED, enabled),
  setPetCharacter: (character: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_PET_CHARACTER, character),
  getPetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_PET_CONFIG),

  // === Memory Graph (人/事/时间串联) ===
  getMemoryGraph: (startDate?: string, endDate?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_MEMORY_GRAPH, startDate, endDate),
  getSegmentsByPerson: (person: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SEGMENTS_BY_PERSON, person),
  getSegmentsByEvent: (event: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_SEGMENTS_BY_EVENT, event),
  updateSegmentPeopleEvent: (id: string, people: string[], event?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SEGMENT_PEOPLE_EVENT, id, people, event),

  // === Wiki Knowledge Base (知识库双链) ===
  wikiGetNodes: () => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_NODES),
  wikiGetNode: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_NODE, id),
  wikiSaveNode: (node: any) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_SAVE_NODE, node),
  wikiDeleteNode: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_DELETE_NODE, id),
  wikiSearch: (query: string) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_SEARCH, query),
  wikiGetLinks: (nodeId: string) => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_LINKS, nodeId),
  wikiGetGraph: () => ipcRenderer.invoke(IPC_CHANNELS.WIKI_GET_GRAPH),
  wikiExtractFromSegments: (segmentIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.WIKI_EXTRACT_FROM_SEGMENTS, segmentIds),

  // === Proactive Intelligence (主动智能) ===
  insightsGet: (includeDismissed?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_GET, includeDismissed),
  insightsDismiss: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_DISMISS, id),
  insightsGetReminders: (includeDismissed?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_GET_REMINDERS, includeDismissed),
  insightsDismissReminder: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_DISMISS_REMINDER, id),
  insightsGetAnomalies: (includeDismissed?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_GET_ANOMALIES, includeDismissed),
  insightsRefresh: () => ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_REFRESH),

  // === Ultimate Experience (终极体验) ===
  memorySearchInstant: (keyword: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SEARCH_INSTANT, keyword),
  memoryGetTimelapse: (segmentId: string, timestamp: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_TIMELAPSE, segmentId, timestamp),
  aiExtractInsight: (ocrText: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AI_EXTRACT_INSIGHT, ocrText),
  knowledgeDirectFeed: (content: string, source: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.KNOWLEDGE_DIRECT_FEED, content, source),
  onPetSyncEmotions: (callback: (state: string) => void) => {
    const handler = (_event: any, state: string) => callback(state);
    ipcRenderer.on(IPC_CHANNELS.PET_SYNC_EMOTIONS, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.PET_SYNC_EMOTIONS, handler);
    };
  },
  insightsFetchNarrative: (weekId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.INSIGHTS_FETCH_NARRATIVE, weekId),

  // Navigation listener
  onNavigate: (callback: (route: string) => void) => {
    const handler = (_event: any, route: string) => callback(route);
    ipcRenderer.on("navigate", handler);
    return () => {
      ipcRenderer.removeListener("navigate", handler);
    };
  },

  // Segment change listener (real-time updates from recorder)
  onSegmentChange: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.ON_SEGMENT_CHANGE, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ON_SEGMENT_CHANGE, handler);
    };
  },
};

contextBridge.exposeInMainWorld("workmemory", api);

export type WorkMemoryApi = typeof api;