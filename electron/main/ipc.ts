/**
 * IPC 处理器注册
 * 全部通过 validatedHandler 包装，入参经 Zod schema 校验，
 * 返回值统一为 { ok, data?, error? } 信封形态。
 */
import { dialog, BrowserWindow, clipboard } from 'electron'
import fs from 'node:fs'
import { getMainWindow } from './window'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { CleanEpisodeRepository } from '../db/repositories/CleanEpisodeRepository'
import { WikiRepository } from '../db/repositories/WikiRepository'
import { ReportRepository } from '../db/repositories/ReportRepository'
import { PrivacyRuleRepository } from '../db/repositories/PrivacyRuleRepository'
import { SearchRepository } from '../db/repositories/SearchRepository'
import { SettingsStore } from '../db/SettingsStore'
import { DataManager } from '../db/DataManager'
import { getAiManager } from '../ai/AiManager'
import { getDistillManager } from '../ai/DistillManager'
import type { GenerateReportPayload } from '../ai/ReportGenerator'
import { getTemplateList } from '../ai/templates'
import { getCaptureManager } from '../capture/CaptureManager'
import { getOcrManager } from '../ocr/OcrManager'
import { getOcrRuntimeManager } from '../ocr/OcrRuntimeManager'
import { getEpisodeManager } from '../capture/EpisodeManager'
import {
  WindowChannels,
  SegmentChannels,
  EpisodeChannels,
  CleanEpisodeChannels,
  WikiChannels,
  ReportChannels,
  PrivacyChannels,
  CaptureChannels,
  OcrChannels,
  AiChannels,
  SettingsChannels,
  DataChannels,
  SystemChannels,
  MascotChannels,
  InsightsChannels,
  SearchChannels
} from '../types/ipc'
import type {
  AppSettings,
  WorkSegment,
  Episode,
  CleanEpisode,
  EntityRef,
  WikiPage,
  Report,
  PrivacyRule,
  WikiType,
  OcrModel,
  ReportTemplate
} from '@/types'
import { getWikiIngestManager } from '../wiki/WikiIngestManager'
import { getInsightsManager } from '../insights/InsightsManager'
import { getMascotManager } from '../mascot/MascotManager'
import { validatedHandler } from '../ipc/validatedHandler'
import {
  segmentSchemas,
  episodeSchemas,
  cleanEpisodeSchemas,
  wikiSchemas,
  reportSchemas,
  privacySchemas,
  settingsSchemas,
  aiSchemas,
  mascotSchemas,
  ocrSchemas,
  captureSchemas,
  insightsSchemas,
  dataSchemas,
  windowSchemas,
  systemSchemas,
  searchSchemas
} from '../ipc/schemas'

export function registerIpcHandlers(): void {
  /* ============ 窗口控制 ============ */
  validatedHandler(WindowChannels.Minimize, windowSchemas.Minimize, () => {
    getMainWindow()?.minimize()
  })
  validatedHandler(WindowChannels.Maximize, windowSchemas.Maximize, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  validatedHandler(WindowChannels.Close, windowSchemas.Close, () => {
    getMainWindow()?.close()
  })
  validatedHandler(
    WindowChannels.IsMaximized,
    windowSchemas.IsMaximized,
    () => getMainWindow()?.isMaximized() ?? false
  )

  /* ============ Segment ============ */
  /** segment:insert 已删除 — segments 由 CaptureManager 自动创建 */
  validatedHandler(
    SegmentChannels.Update,
    segmentSchemas.Update,
    (_e, { id, patch }) => SegmentRepository.update(id, patch as Partial<WorkSegment>)
  )
  validatedHandler(SegmentChannels.GetById, segmentSchemas.GetById, (_e, { id }) =>
    SegmentRepository.getById(id)
  )
  validatedHandler(SegmentChannels.GetByDate, segmentSchemas.GetByDate, (_e, { date }) =>
    SegmentRepository.getByDate(date)
  )
  validatedHandler(
    SegmentChannels.GetActiveByDate,
    segmentSchemas.GetActiveByDate,
    (_e, { date }) => SegmentRepository.getActiveByDate(date)
  )
  validatedHandler(
    SegmentChannels.SetSelectedForReport,
    segmentSchemas.SetSelectedForReport,
    (_e, { id, selected }) => SegmentRepository.setSelectedForReport(id, selected)
  )
  validatedHandler(
    SegmentChannels.SetImportant,
    segmentSchemas.SetImportant,
    (_e, { id, important }) => SegmentRepository.setImportant(id, important)
  )
  validatedHandler(SegmentChannels.SoftDelete, segmentSchemas.SoftDelete, (_e, { id }) =>
    SegmentRepository.softDelete(id)
  )
  validatedHandler(SegmentChannels.HardDelete, segmentSchemas.HardDelete, (_e, { id }) =>
    SegmentRepository.hardDelete(id)
  )
  validatedHandler(
    SegmentChannels.GetPrivateByDate,
    segmentSchemas.GetPrivateByDate,
    (_e, { date }) => SegmentRepository.getPrivateByDate(date)
  )

  /* ============ Episode ============ */
  validatedHandler(EpisodeChannels.Insert, episodeSchemas.Insert, (_e, { episode }) =>
    EpisodeRepository.insert(episode as Episode)
  )
  validatedHandler(
    EpisodeChannels.Update,
    episodeSchemas.Update,
    (_e, { id, patch }) => EpisodeRepository.update(id, patch as Partial<Episode>)
  )
  validatedHandler(EpisodeChannels.GetById, episodeSchemas.GetById, (_e, { id }) =>
    EpisodeRepository.getById(id)
  )
  validatedHandler(EpisodeChannels.GetByDate, episodeSchemas.GetByDate, (_e, { date }) =>
    EpisodeRepository.getByDate(date)
  )
  validatedHandler(
    EpisodeChannels.SetOneLineSummary,
    episodeSchemas.SetOneLineSummary,
    (_e, { id, summary }) => EpisodeRepository.setOneLineSummary(id, summary)
  )
  validatedHandler(
    EpisodeChannels.SetReportEligible,
    episodeSchemas.SetReportEligible,
    (_e, { id, eligible }) => EpisodeRepository.setReportEligible(id, eligible)
  )
  validatedHandler(
    EpisodeChannels.SetWikiEligible,
    episodeSchemas.SetWikiEligible,
    (_e, { id, eligible }) => EpisodeRepository.setWikiEligible(id, eligible)
  )
  validatedHandler(
    EpisodeChannels.GetDailySummary,
    episodeSchemas.GetDailySummary,
    (_e, { date }) => getEpisodeManager().getDailySummary(date)
  )
  validatedHandler(
    EpisodeChannels.SetDailySummary,
    episodeSchemas.SetDailySummary,
    (_e, { date, text }) => getEpisodeManager().setDailySummary(date, text)
  )
  validatedHandler(
    EpisodeChannels.ConfirmEntity,
    episodeSchemas.ConfirmEntity,
    (_e, { id, entityType, entityName }) =>
      EpisodeRepository.confirmEntity(
        id,
        entityType as EntityRef['type'],
        entityName
      )
  )
  validatedHandler(
    EpisodeChannels.CorrectEntity,
    episodeSchemas.CorrectEntity,
    (_e, { id, entityType, entityName, newName }) =>
      EpisodeRepository.correctEntity(
        id,
        entityType as EntityRef['type'],
        entityName,
        newName
      )
  )
  validatedHandler(
    EpisodeChannels.IgnoreEntity,
    episodeSchemas.IgnoreEntity,
    (_e, { id, entityType, entityName }) =>
      EpisodeRepository.ignoreEntity(
        id,
        entityType as EntityRef['type'],
        entityName
      )
  )

  /* ============ CleanEpisode（工作记忆事件） ============ */
  validatedHandler(CleanEpisodeChannels.GetById, cleanEpisodeSchemas.GetById, (_e, { id }) =>
    CleanEpisodeRepository.getById(id)
  )
  validatedHandler(CleanEpisodeChannels.GetByDate, cleanEpisodeSchemas.GetByDate, (_e, { date }) =>
    CleanEpisodeRepository.getByDate(date)
  )
  validatedHandler(
    CleanEpisodeChannels.GetByHour,
    cleanEpisodeSchemas.GetByHour,
    (_e, { date, hourBucket }) => CleanEpisodeRepository.getByHour(date, hourBucket)
  )
  validatedHandler(
    CleanEpisodeChannels.GetByDateRange,
    cleanEpisodeSchemas.GetByDateRange,
    (_e, { startDate, endDate }) => CleanEpisodeRepository.getByDateRange(startDate, endDate)
  )
  validatedHandler(
    CleanEpisodeChannels.Update,
    cleanEpisodeSchemas.Update,
    (_e, { id, patch }) => CleanEpisodeRepository.update(id, patch as Partial<CleanEpisode>)
  )

  /* ============ Wiki ============ */
  validatedHandler(WikiChannels.Insert, wikiSchemas.Insert, (_e, { page }) =>
    WikiRepository.insert(page as WikiPage)
  )
  validatedHandler(
    WikiChannels.Update,
    wikiSchemas.Update,
    (_e, { id, patch }) => WikiRepository.update(id, patch as Partial<WikiPage>)
  )
  validatedHandler(WikiChannels.Delete, wikiSchemas.Delete, (_e, { id }) =>
    WikiRepository.delete(id)
  )
  validatedHandler(WikiChannels.GetById, wikiSchemas.GetById, (_e, { id }) =>
    WikiRepository.getById(id)
  )
  validatedHandler(WikiChannels.GetByType, wikiSchemas.GetByType, (_e, { type }) =>
    WikiRepository.getByType(type as WikiType)
  )
  validatedHandler(WikiChannels.GetByTitle, wikiSchemas.GetByTitle, (_e, { title }) =>
    WikiRepository.getByTitle(title)
  )
  validatedHandler(WikiChannels.GetAll, wikiSchemas.GetAll, () => WikiRepository.getAll())
  validatedHandler(
    WikiChannels.SearchByTitle,
    wikiSchemas.SearchByTitle,
    (_e, { keyword }) => WikiRepository.searchByTitle(keyword)
  )
  validatedHandler(
    WikiChannels.AddToReviewQueue,
    wikiSchemas.AddToReviewQueue,
    (_e, { page }) => WikiRepository.addToReviewQueue(page)
  )
  validatedHandler(WikiChannels.GetReviewQueue, wikiSchemas.GetReviewQueue, () =>
    WikiRepository.getReviewQueue()
  )
  validatedHandler(WikiChannels.ConfirmReview, wikiSchemas.ConfirmReview, (_e, { id }) =>
    WikiRepository.confirmReview(id)
  )
  validatedHandler(WikiChannels.RejectReview, wikiSchemas.RejectReview, (_e, { id }) =>
    WikiRepository.rejectReview(id)
  )
  validatedHandler(WikiChannels.UpdateBacklinks, wikiSchemas.UpdateBacklinks, (_e, { id }) =>
    WikiRepository.updateBacklinks(id)
  )
  validatedHandler(WikiChannels.GetBacklinks, wikiSchemas.GetBacklinks, (_e, { title }) =>
    WikiRepository.getBacklinks(title)
  )
  validatedHandler(WikiChannels.FindBrokenLinks, wikiSchemas.FindBrokenLinks, () =>
    WikiRepository.findBrokenLinks()
  )

  /* ============ Wiki Ingest 编排层（阶段 7） ============ */
  validatedHandler(WikiChannels.ScanNow, wikiSchemas.ScanNow, async () =>
    getWikiIngestManager().scanAndEnqueue()
  )
  validatedHandler(WikiChannels.PreviewIngest, wikiSchemas.PreviewIngest, (_e, { reviewItemId }) =>
    getWikiIngestManager().previewIngest(reviewItemId)
  )
  validatedHandler(
    WikiChannels.ConfirmIngest,
    wikiSchemas.ConfirmIngest,
    (_e, { reviewItemId, edits }) =>
      getWikiIngestManager().confirmIngest(reviewItemId, edits)
  )
  validatedHandler(WikiChannels.RejectIngest, wikiSchemas.RejectIngest, (_e, { reviewItemId }) =>
    getWikiIngestManager().rejectIngest(reviewItemId)
  )
  validatedHandler(WikiChannels.GetBrokenLinks, wikiSchemas.GetBrokenLinks, () =>
    getWikiIngestManager().getBrokenLinks()
  )
  validatedHandler(WikiChannels.RebuildBacklinks, wikiSchemas.RebuildBacklinks, () =>
    getWikiIngestManager().rebuildBacklinks()
  )

  /* ============ Report ============ */
  /** report:insert 已删除 — reports 由 AiManager.generateReport 自动创建 */
  validatedHandler(
    ReportChannels.Update,
    reportSchemas.Update,
    (_e, { id, patch }) => ReportRepository.update(id, patch as Partial<Report>)
  )
  /** 业务 action：保存草稿（status 强制为 draft） */
  validatedHandler(ReportChannels.SaveDraft, reportSchemas.SaveDraft, (_e, draft) => {
    const report: Report = {
      id: draft.id || '',
      date: draft.date,
      templateId: draft.templateId as ReportTemplate,
      templateName: draft.templateName,
      segmentIds: draft.segmentIds,
      aiInputSnapshot: draft.aiInputSnapshot,
      markdownContent: draft.markdownContent,
      status: 'draft',
      reportType: draft.reportType ?? 'daily'
    }
    return ReportRepository.insert(report)
  })
  validatedHandler(ReportChannels.GetById, reportSchemas.GetById, (_e, { id }) =>
    ReportRepository.getById(id)
  )
  validatedHandler(ReportChannels.GetByDate, reportSchemas.GetByDate, (_e, { date }) =>
    ReportRepository.getByDate(date)
  )
  validatedHandler(ReportChannels.GetAllHistory, reportSchemas.GetAllHistory, () =>
    ReportRepository.getAllHistory()
  )
  validatedHandler(ReportChannels.SetStatus, reportSchemas.SetStatus, (_e, { id, status }) =>
    ReportRepository.setStatus(id, status as Report['status'])
  )

  /* ============ Privacy ============ */
  validatedHandler(PrivacyChannels.Insert, privacySchemas.Insert, (_e, { rule }) =>
    PrivacyRuleRepository.insert(rule as Omit<PrivacyRule, 'id'>)
  )
  validatedHandler(
    PrivacyChannels.Update,
    privacySchemas.Update,
    (_e, { id, patch }) => PrivacyRuleRepository.update(id, patch as Partial<PrivacyRule>)
  )
  validatedHandler(PrivacyChannels.Delete, privacySchemas.Delete, (_e, { id }) =>
    PrivacyRuleRepository.delete(id)
  )
  validatedHandler(PrivacyChannels.GetAll, privacySchemas.GetAll, () =>
    PrivacyRuleRepository.getAll()
  )
  validatedHandler(PrivacyChannels.GetEnabled, privacySchemas.GetEnabled, () =>
    PrivacyRuleRepository.getEnabled()
  )
  validatedHandler(PrivacyChannels.MatchRule, privacySchemas.MatchRule, (_e, { appName, processName, windowTitle, url }) =>
    PrivacyRuleRepository.matchRule(appName, processName, windowTitle, url)
  )

  /* ============ Capture ============ */
  validatedHandler(CaptureChannels.Start, captureSchemas.Start, () =>
    getCaptureManager().startCapture()
  )
  validatedHandler(CaptureChannels.Stop, captureSchemas.Stop, () =>
    getCaptureManager().stopCapture()
  )
  validatedHandler(CaptureChannels.Pause, captureSchemas.Pause, () =>
    getCaptureManager().pauseCapture()
  )
  validatedHandler(CaptureChannels.Resume, captureSchemas.Resume, () =>
    getCaptureManager().resumeCapture()
  )
  validatedHandler(CaptureChannels.GetState, captureSchemas.GetState, () =>
    getCaptureManager().getRecordingState()
  )

  /* ============ OCR ============ */
  validatedHandler(OcrChannels.GetStatus, ocrSchemas.GetStatus, () =>
    getOcrManager().getStatus()
  )
  validatedHandler(OcrChannels.SetModel, ocrSchemas.SetModel, (_e, { model }) => {
    SettingsStore.set({ ocrModel: model as OcrModel })
    return getOcrManager().setModel(model as OcrModel)
  })
  validatedHandler(OcrChannels.GetModel, ocrSchemas.GetModel, () => getOcrManager().getModel())
  validatedHandler(OcrChannels.Reprocess, ocrSchemas.Reprocess, (_e, { segmentId }) =>
    getOcrManager().reprocess(segmentId)
  )
  validatedHandler(OcrChannels.Recognize, ocrSchemas.Recognize, async (_e, { imagePath }) =>
    getOcrManager().recognizeImagePath(imagePath)
  )
  validatedHandler(OcrChannels.GetRuntimeStatus, ocrSchemas.GetRuntimeStatus, () =>
    getOcrRuntimeManager().getRuntimeStatus()
  )
  validatedHandler(OcrChannels.TestRecognize, ocrSchemas.TestRecognize, async (_e, { imagePath }) =>
    getOcrRuntimeManager().testRecognize(imagePath)
  )
  validatedHandler(OcrChannels.OpenInstallDir, ocrSchemas.OpenInstallDir, async () =>
    getOcrRuntimeManager().openInstallDir()
  )

  /* ============ Settings ============ */
  validatedHandler(SettingsChannels.Get, settingsSchemas.Get, () => SettingsStore.get())
  validatedHandler(SettingsChannels.Set, settingsSchemas.Set, (_e, { patch }) => {
    const updated = SettingsStore.set(patch as Partial<AppSettings>)
    // 立即生效：整屏降级开关同步到 CaptureManager（下发到 CaptureDecision）
    if (patch.allowFullScreenshotFallback !== undefined) {
      getCaptureManager().setAllowFullScreenshotFallback(patch.allowFullScreenshotFallback)
    }
    return updated
  })
  validatedHandler(SettingsChannels.Reset, settingsSchemas.Reset, () => {
    const reset = SettingsStore.reset()
    // 重置后整屏降级回到默认 false，同步到 CaptureManager
    getCaptureManager().setAllowFullScreenshotFallback(reset.allowFullScreenshotFallback)
    return reset
  })
  validatedHandler(SettingsChannels.SetApiKey, settingsSchemas.SetApiKey, (_e, { key }) => {
    SettingsStore.setApiKey(key)
  })
  validatedHandler(SettingsChannels.ClearApiKey, settingsSchemas.ClearApiKey, () => {
    SettingsStore.clearApiKey()
  })

  /* ============ AI ============ */
  validatedHandler(
    AiChannels.GenerateReport,
    aiSchemas.GenerateReport,
    async (_e, { payload }) =>
      getAiManager().generateReport(payload as GenerateReportPayload)
  )
  validatedHandler(AiChannels.TestConnection, aiSchemas.TestConnection, async () =>
    getAiManager().testConnection()
  )
  validatedHandler(AiChannels.GetTemplates, aiSchemas.GetTemplates, () => getTemplateList())
  validatedHandler(AiChannels.EstimateChars, aiSchemas.EstimateChars, (_e, { episodeIds, notes }) =>
    getAiManager().estimateChars(episodeIds, notes)
  )
  validatedHandler(AiChannels.ExportMarkdown, aiSchemas.ExportMarkdown, (_e, { report }) =>
    getAiManager().exportMarkdown(report as Report)
  )
  // C2：Word 导出升级为原生 .docx。主进程生成 Buffer 后弹出保存对话框写入文件。
  validatedHandler(
    AiChannels.ExportWord,
    aiSchemas.ExportWord,
    async (_e, { markdown, title, date }) => {
      const buffer = await getAiManager().exportWord(markdown, { title, date })
      const win = getMainWindow() ?? BrowserWindow.getFocusedWindow()
      const defaultName = `workmemory-daily-${date}.docx`
      const options: Electron.SaveDialogOptions = {
        defaultPath: defaultName,
        filters: [{ name: 'Word 文档', extensions: ['docx'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      fs.writeFileSync(result.filePath, buffer)
      return result.filePath
    }
  )
  validatedHandler(AiChannels.ExportJson, aiSchemas.ExportJson, (_e, { report }) =>
    getAiManager().exportJson(report as Report)
  )
  validatedHandler(AiChannels.ExtractWiki, aiSchemas.ExtractWiki, async () => {
    // 阶段 7：触发 Wiki Ingest 扫描，返回新增 Review Queue 项数量
    const enqueued = await getWikiIngestManager().scanAndEnqueue()
    return `已扫描并加入 ${enqueued} 个 Wiki 候选到审核队列`
  })
  validatedHandler(AiChannels.DistillHour, aiSchemas.DistillHour, async (_e, { date, hourBucket }) =>
    getDistillManager().distillHour(date, hourBucket)
  )
  validatedHandler(AiChannels.RunDueDistill, aiSchemas.RunDueDistill, async () =>
    getDistillManager().runDueDistill()
  )

  /* ============ Mascot（主窗口调用的控制接口） ============ */
  // 注：Mascot 渲染进程的交互事件（LeftClick/RightClick/DragStart 等）由
  // MascotManager.setupIpcHandlers() 自行注册。
  // 此处仅注册主窗口（设置页等）调用的控制接口，委托给 MascotManager 单例。
  validatedHandler(MascotChannels.SetStyle, mascotSchemas.SetStyle, (_e, { style }) => {
    getMascotManager().setStyle(style as AppSettings['mascotStyle'])
    return true
  })
  validatedHandler(MascotChannels.GetStyle, mascotSchemas.GetStyle, () =>
    getMascotManager().getStyle()
  )
  validatedHandler(MascotChannels.ShowBubble, mascotSchemas.ShowBubble, (_e, { text }) => {
    // 主窗口触发的气泡（用户主动行为，不受频率限制）
    getMascotManager().showBubbleDirect({
      title: '提示',
      message: text,
      action: 'today'
    })
    return true
  })
  validatedHandler(MascotChannels.Hide, mascotSchemas.Hide, () => {
    getMascotManager().hide()
    return true
  })

  /* ============ Data Management ============ */
  validatedHandler(DataChannels.Cleanup, dataSchemas.Cleanup, () => DataManager.cleanup())
  validatedHandler(DataChannels.ClearDay, dataSchemas.ClearDay, (_e, { date }) =>
    DataManager.clearDay(date)
  )
  validatedHandler(DataChannels.ClearAll, dataSchemas.ClearAll, () => DataManager.clearAll())
  validatedHandler(DataChannels.GetStats, dataSchemas.GetStats, () => DataManager.getStats())

  /* ============ Insights 主动洞察层（阶段 8） ============ */
  validatedHandler(InsightsChannels.GetAudit, insightsSchemas.GetAudit, (_e, { dateRange }) =>
    getInsightsManager().getAudit(dateRange)
  )
  validatedHandler(
    InsightsChannels.GetAnomalies,
    insightsSchemas.GetAnomalies,
    (_e, { dateRange }) => getInsightsManager().getAnomalies(dateRange)
  )
  validatedHandler(InsightsChannels.GetTrend, insightsSchemas.GetTrend, (_e, { days }) =>
    getInsightsManager().getTrend(days)
  )
  validatedHandler(InsightsChannels.GetInsights, insightsSchemas.GetInsights, (_e, { dateRange }) =>
    getInsightsManager().getInsights(dateRange)
  )
  validatedHandler(
    InsightsChannels.PushInsight,
    insightsSchemas.PushInsight,
    (_e, { title, message, navigatePage }) =>
      getInsightsManager().pushInsight(title, message, navigatePage)
  )

  /* ============ Search (FTS5 全文搜索) ============ */
  validatedHandler(SearchChannels.Fts, searchSchemas.Fts, (_e, { query }) =>
    SearchRepository.search(query)
  )

  /* ============ System (文件保存对话框) ============ */
  validatedHandler(SystemChannels.SaveFile, systemSchemas.SaveFile, async (_e, { defaultName, content, filters }) => {
    const win = getMainWindow() ?? BrowserWindow.getFocusedWindow()
    const options: Electron.SaveDialogOptions = {
      defaultPath: defaultName,
      filters: filters ?? [{ name: '所有文件', extensions: ['*'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    fs.writeFileSync(result.filePath, content, 'utf-8')
    return result.filePath
  })

  /* ============ System (剪贴板富文本写入) ============ */
  validatedHandler(SystemChannels.WriteClipboard, systemSchemas.WriteClipboard, (_e, { text, html }) => {
    // 同时写入 text/plain 与 text/html，粘贴到 Word/飞书时优先使用 html 保留格式
    clipboard.write({ text, html })
    return { ok: true as const }
  })
}
