/**
 * Preload 安全上下文
 * 使用 contextBridge 暴露受限的 window.workmemory API。
 * 渲染进程仅能通过此 API 经 ipcRenderer.invoke 访问主进程能力，无法直接访问 Node。
 *
 * 所有 IPC 调用经 unwrapResult 解包：
 *  - 主进程返回 { ok: true, data } → 解包返回 data
 *  - 主进程返回 { ok: false, error } → 抛 Error 给 renderer
 * renderer 代码仍可 `await window.workmemory.xxx.yyy()` 直接拿数据，错误时 try-catch。
 */
import { contextBridge, ipcRenderer } from 'electron'
import {
  WindowChannels,
  SegmentChannels,
  EpisodeChannels,
  CleanEpisodeChannels,
  WikiChannels,
  ReportChannels,
  PrivacyChannels,
  CaptureChannels,
  CaptureBroadcastChannels,
  MascotChannels,
  OcrChannels,
  AiChannels,
  SettingsChannels,
  DataChannels,
  SystemChannels,
  InsightsChannels,
  SearchChannels
} from '../types/ipc'
import type { SaveFileFilter } from '../types/ipc'
import { unwrapResult, type IpcResult } from '../ipc/validatedHandler'

/**
 * 调用 IPC 通道并解包结果。
 * @param channel IPC 通道名
 * @param payload 入参（无参通道传 undefined）
 * @returns 解包后的业务数据
 */
async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>
  return unwrapResult(result)
}

const api = {
  window: {
    minimize: () => invoke<void>(WindowChannels.Minimize),
    maximize: () => invoke<void>(WindowChannels.Maximize),
    close: () => invoke<void>(WindowChannels.Close),
    isMaximized: () => invoke<boolean>(WindowChannels.IsMaximized),
    onMaximizeChange: (cb: (maximized: boolean) => void) => {
      const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on(WindowChannels.MaximizeChanged, listener)
      return () => {
        ipcRenderer.removeListener(WindowChannels.MaximizeChanged, listener)
      }
    }
  },
  segment: {
    /** segment.insert 已删除 — segments 由 CaptureManager 自动创建 */
    update: (id: string, patch: unknown) =>
      invoke(SegmentChannels.Update, { id, patch }),
    getById: (id: string) => invoke(SegmentChannels.GetById, { id }),
    getByDate: (date: string) => invoke(SegmentChannels.GetByDate, { date }),
    getActiveByDate: (date: string) =>
      invoke(SegmentChannels.GetActiveByDate, { date }),
    setSelectedForReport: (id: string, selected: boolean) =>
      invoke(SegmentChannels.SetSelectedForReport, { id, selected }),
    setImportant: (id: string, important: boolean) =>
      invoke(SegmentChannels.SetImportant, { id, important }),
    softDelete: (id: string) => invoke(SegmentChannels.SoftDelete, { id }),
    hardDelete: (id: string) => invoke(SegmentChannels.HardDelete, { id }),
    getPrivateByDate: (date: string) =>
      invoke(SegmentChannels.GetPrivateByDate, { date })
  },
  episode: {
    insert: (episode: unknown) => invoke(EpisodeChannels.Insert, { episode }),
    update: (id: string, patch: unknown) =>
      invoke(EpisodeChannels.Update, { id, patch }),
    getById: (id: string) => invoke(EpisodeChannels.GetById, { id }),
    getByDate: (date: string) => invoke(EpisodeChannels.GetByDate, { date }),
    setOneLineSummary: (id: string, summary: string) =>
      invoke(EpisodeChannels.SetOneLineSummary, { id, summary }),
    setReportEligible: (id: string, eligible: boolean) =>
      invoke(EpisodeChannels.SetReportEligible, { id, eligible }),
    setWikiEligible: (id: string, eligible: boolean) =>
      invoke(EpisodeChannels.SetWikiEligible, { id, eligible }),
    getDailySummary: (date: string) =>
      invoke<string>(EpisodeChannels.GetDailySummary, { date }),
    setDailySummary: (date: string, text: string) =>
      invoke<boolean>(EpisodeChannels.SetDailySummary, { date, text }),
    confirmEntity: (
      id: string,
      entityType: 'person' | 'project' | 'document' | 'url',
      entityName: string
    ) => invoke(EpisodeChannels.ConfirmEntity, { id, entityType, entityName }),
    correctEntity: (
      id: string,
      entityType: 'person' | 'project' | 'document' | 'url',
      entityName: string,
      newName: string
    ) =>
      invoke(EpisodeChannels.CorrectEntity, {
        id,
        entityType,
        entityName,
        newName
      }),
    ignoreEntity: (
      id: string,
      entityType: 'person' | 'project' | 'document' | 'url',
      entityName: string
    ) => invoke(EpisodeChannels.IgnoreEntity, { id, entityType, entityName })
  },
  cleanEpisode: {
    getById: (id: string) => invoke(CleanEpisodeChannels.GetById, { id }),
    getByDate: (date: string) => invoke(CleanEpisodeChannels.GetByDate, { date }),
    getByHour: (date: string, hourBucket: string) =>
      invoke(CleanEpisodeChannels.GetByHour, { date, hourBucket }),
    getByDateRange: (startDate: string, endDate: string) =>
      invoke(CleanEpisodeChannels.GetByDateRange, { startDate, endDate }),
    update: (id: string, patch: unknown) =>
      invoke(CleanEpisodeChannels.Update, { id, patch })
  },
  wiki: {
    insert: (page: unknown) => invoke(WikiChannels.Insert, { page }),
    update: (id: string, patch: unknown) =>
      invoke(WikiChannels.Update, { id, patch }),
    delete: (id: string) => invoke(WikiChannels.Delete, { id }),
    getById: (id: string) => invoke(WikiChannels.GetById, { id }),
    getByType: (type: string) => invoke(WikiChannels.GetByType, { type }),
    getByTitle: (title: string) => invoke(WikiChannels.GetByTitle, { title }),
    getAll: () => invoke(WikiChannels.GetAll),
    searchByTitle: (keyword: string) =>
      invoke(WikiChannels.SearchByTitle, { keyword }),
    addToReviewQueue: (page: unknown) =>
      invoke(WikiChannels.AddToReviewQueue, { page }),
    getReviewQueue: () => invoke(WikiChannels.GetReviewQueue),
    confirmReview: (id: string) => invoke(WikiChannels.ConfirmReview, { id }),
    rejectReview: (id: string) => invoke(WikiChannels.RejectReview, { id }),
    updateBacklinks: (id: string) => invoke(WikiChannels.UpdateBacklinks, { id }),
    getBacklinks: (title: string) => invoke(WikiChannels.GetBacklinks, { title }),
    findBrokenLinks: () => invoke(WikiChannels.FindBrokenLinks),
    // 阶段 7：Wiki Ingest 编排
    scanNow: () => invoke<number>(WikiChannels.ScanNow),
    previewIngest: (reviewItemId: string) =>
      invoke(WikiChannels.PreviewIngest, { reviewItemId }),
    confirmIngest: (reviewItemId: string, edits?: { content?: string; title?: string }) =>
      invoke(WikiChannels.ConfirmIngest, { reviewItemId, edits }),
    rejectIngest: (reviewItemId: string) =>
      invoke(WikiChannels.RejectIngest, { reviewItemId }),
    getBrokenLinks: () => invoke(WikiChannels.GetBrokenLinks),
    rebuildBacklinks: () => invoke<number>(WikiChannels.RebuildBacklinks)
  },
  report: {
    /** report.insert 已删除 — 使用 saveDraft 业务 action */
    update: (id: string, patch: unknown) =>
      invoke(ReportChannels.Update, { id, patch }),
    saveDraft: (report: unknown) => invoke(ReportChannels.SaveDraft, report),
    getById: (id: string) => invoke(ReportChannels.GetById, { id }),
    getByDate: (date: string) => invoke(ReportChannels.GetByDate, { date }),
    getAllHistory: () => invoke(ReportChannels.GetAllHistory),
    setStatus: (id: string, status: string) =>
      invoke(ReportChannels.SetStatus, { id, status })
  },
  privacy: {
    insert: (rule: unknown) => invoke(PrivacyChannels.Insert, { rule }),
    update: (id: string, patch: unknown) =>
      invoke(PrivacyChannels.Update, { id, patch }),
    delete: (id: string) => invoke(PrivacyChannels.Delete, { id }),
    getAll: () => invoke(PrivacyChannels.GetAll),
    getEnabled: () => invoke(PrivacyChannels.GetEnabled),
    matchRule: (appName: string, processName: string, windowTitle: string, url: string) =>
      invoke(PrivacyChannels.MatchRule, { appName, processName, windowTitle, url })
  },
  capture: {
    start: () => invoke(CaptureChannels.Start),
    stop: () => invoke(CaptureChannels.Stop),
    pause: () => invoke(CaptureChannels.Pause),
    resume: () => invoke(CaptureChannels.Resume),
    getState: () => invoke<string>(CaptureChannels.GetState),
    onStateChange: (cb: (state: string) => void) => {
      const listener = (_e: unknown, state: string): void => cb(state)
      ipcRenderer.on(CaptureBroadcastChannels.StateChanged, listener)
      return () => {
        ipcRenderer.removeListener(CaptureBroadcastChannels.StateChanged, listener)
      }
    },
    onIncognitoDetected: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(MascotChannels.IncognitoDetected, listener)
      return () => {
        ipcRenderer.removeListener(MascotChannels.IncognitoDetected, listener)
      }
    },
    onIncognitoCleared: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(MascotChannels.IncognitoCleared, listener)
      return () => {
        ipcRenderer.removeListener(MascotChannels.IncognitoCleared, listener)
      }
    }
  },
  ocr: {
    recognize: (imagePath: string) =>
      invoke<string>(OcrChannels.Recognize, { imagePath }),
    getStatus: () =>
      invoke<{
        backend: string
        model: 'tiny' | 'small'
        loaded: boolean
        queueSize: number
        running: boolean
        configured: boolean
      }>(OcrChannels.GetStatus),
    setModel: (model: 'tiny' | 'small') =>
      invoke<boolean>(OcrChannels.SetModel, { model }),
    getModel: () => invoke<'tiny' | 'small'>(OcrChannels.GetModel),
    reprocess: (segmentId: string) =>
      invoke<boolean>(OcrChannels.Reprocess, { segmentId }),
    getRuntimeStatus: () =>
      invoke<{
        type: 'paddleocr' | 'tesseract' | 'unconfigured'
        modelPath?: string
        available: boolean
      }>(OcrChannels.GetRuntimeStatus),
    testRecognize: (imagePath: string) =>
      invoke<{
        ok: boolean
        text?: string
        elapsedMs?: number
        error?: string
      }>(OcrChannels.TestRecognize, { imagePath }),
    openInstallDir: () =>
      invoke<{
        ok: boolean
        path?: string
        error?: string
      }>(OcrChannels.OpenInstallDir)
  },
  ai: {
    generateReport: (payload: unknown) =>
      invoke(AiChannels.GenerateReport, { payload }),
    extractWiki: (payload: unknown) => invoke(AiChannels.ExtractWiki, payload),
    distillHour: (date: string, hourBucket: string) =>
      invoke(AiChannels.DistillHour, { date, hourBucket }),
    runDueDistill: () => invoke(AiChannels.RunDueDistill),
    testConnection: () => invoke(AiChannels.TestConnection),
    getTemplates: () => invoke(AiChannels.GetTemplates),
    estimateChars: (episodeIds: string[], notes: string) =>
      invoke<number>(AiChannels.EstimateChars, { episodeIds, notes }),
    exportMarkdown: (report: unknown) =>
      invoke<string>(AiChannels.ExportMarkdown, { report }),
    exportWord: (payload: { markdown: string; title: string; date: string }) =>
      invoke<string | null>(AiChannels.ExportWord, payload),
    exportJson: (report: unknown) =>
      invoke<string>(AiChannels.ExportJson, { report })
  },
  mascot: {
    // 设置/获取形象与状态
    setStyle: (style: string) =>
      invoke<boolean>(MascotChannels.SetStyle, { style }),
    getStyle: () => invoke<string>(MascotChannels.GetStyle),
    setState: (state: string) =>
      invoke<boolean>(MascotChannels.SetState, { state }),
    show: () => invoke<boolean>(MascotChannels.Show),
    hide: () => invoke<boolean>(MascotChannels.Hide),
    // 主动气泡
    showBubble: (text: string) =>
      invoke<boolean>(MascotChannels.ShowBubble, { text }),
    // 灵感捕捉
    ghostCapture: (text: string) =>
      invoke<boolean>(MascotChannels.GhostCapture, { text }),
    // 频率限制统计
    getStats: () => invoke(MascotChannels.GetStats),
    // Mascot 渲染进程初始化
    getInitialState: () => invoke(MascotChannels.GetInitialState),
    // Mascot 渲染进程 → 主进程：交互事件
    leftClick: () => invoke<boolean>(MascotChannels.LeftClick),
    rightClick: () => invoke<boolean>(MascotChannels.RightClick),
    rightDoubleClick: () => invoke<boolean>(MascotChannels.RightDoubleClick),
    bubbleClosed: () => invoke<boolean>(MascotChannels.BubbleClosed),
    mouseEnter: () => invoke<boolean>(MascotChannels.MouseEnter),
    mouseLeave: () => invoke<boolean>(MascotChannels.MouseLeave),
    dragStart: () => invoke<boolean>(MascotChannels.DragStart),
    dragEnd: () => invoke<boolean>(MascotChannels.DragEnd),
    // 导航
    navigate: (page: string) =>
      invoke<boolean>(MascotChannels.Navigate, { page }),
    // 主进程 → Mascot 渲染进程：事件监听
    onStateChanged: (cb: (state: string) => void) => {
      const listener = (_e: unknown, state: string): void => cb(state)
      ipcRenderer.on(MascotChannels.StateChanged, listener)
      return () => {
        ipcRenderer.removeListener(MascotChannels.StateChanged, listener)
      }
    },
    onStyleChanged: (cb: (style: string) => void) => {
      const listener = (_e: unknown, style: string): void => cb(style)
      ipcRenderer.on(MascotChannels.StyleChanged, listener)
      return () => {
        ipcRenderer.removeListener(MascotChannels.StyleChanged, listener)
      }
    },
    onBubbleShow: (cb: (bubble: unknown) => void) => {
      const listener = (_e: unknown, bubble: unknown): void => cb(bubble)
      ipcRenderer.on(MascotChannels.BubbleShow, listener)
      return () => {
        ipcRenderer.removeListener(MascotChannels.BubbleShow, listener)
      }
    },
    onNavigate: (cb: (page: string) => void) => {
      const listener = (_e: unknown, page: string): void => cb(page)
      ipcRenderer.on(MascotChannels.NavigateMain, listener)
      return () => {
        ipcRenderer.removeListener(MascotChannels.NavigateMain, listener)
      }
    }
  },
  settings: {
    get: () => invoke(SettingsChannels.Get),
    set: (patch: unknown) => invoke(SettingsChannels.Set, { patch }),
    reset: () => invoke(SettingsChannels.Reset),
    setApiKey: (key: string) =>
      invoke<void>(SettingsChannels.SetApiKey, { key }),
    clearApiKey: () => invoke<void>(SettingsChannels.ClearApiKey)
  },
  data: {
    cleanup: () => invoke(DataChannels.Cleanup),
    clearDay: (date: string) => invoke(DataChannels.ClearDay, { date }),
    clearAll: () => invoke(DataChannels.ClearAll),
    getStats: () => invoke(DataChannels.GetStats)
  },
  system: {
    saveFile: (defaultName: string, content: string, filters?: SaveFileFilter[]) =>
      invoke<string | null>(SystemChannels.SaveFile, { defaultName, content, filters }),
    writeClipboard: (payload: { text: string; html: string }) =>
      invoke<{ ok: true }>(SystemChannels.WriteClipboard, payload)
  },
  insights: {
    getAudit: (dateRange?: { start: string; end: string }) =>
      invoke(InsightsChannels.GetAudit, { dateRange }),
    getAnomalies: (dateRange?: { start: string; end: string }) =>
      invoke(InsightsChannels.GetAnomalies, { dateRange }),
    getTrend: (days?: number) => invoke(InsightsChannels.GetTrend, { days }),
    getInsights: (dateRange?: { start: string; end: string }) =>
      invoke(InsightsChannels.GetInsights, { dateRange }),
    pushInsight: (title: string, message: string, navigatePage?: string) =>
      invoke<boolean>(InsightsChannels.PushInsight, { title, message, navigatePage })
  },
  search: {
    fts: (query: string) => invoke(SearchChannels.Fts, { query }),
    hybrid: (query: string, options?: { limit?: number; keywordWeight?: number; semanticWeight?: number }) =>
      invoke(SearchChannels.Hybrid, { query, options })
  }
}

contextBridge.exposeInMainWorld('workmemory', api)
