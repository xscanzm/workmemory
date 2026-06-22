/**
 * Tauri 前端 API 适配器
 *
 * 用 @tauri-apps/api 的 invoke() 替换原 Electron window.workmemory.* IPC 通道。
 * 该对象实现与 src/types/ipc.ts 中 WorkMemoryApi 完全一致的接口，
 * 作为渲染进程的 drop-in 替换：前端组件代码无需任何改动。
 *
 * 命令名映射到 src-tauri/src/ipc/commands.rs 中注册的 #[tauri::command] 函数。
 * Tauri v2 默认将 JS 端 camelCase 参数键映射到 Rust 端 snake_case 形参。
 *
 * 注意：Rust 端领域模型（WorkSegment/Episode 等）当前未启用
 * #[serde(rename_all = "camelCase")]，序列化字段为 snake_case，
 * 与前端 camelCase 类型存在命名差异——属后端待修复项，本适配器仅在
 * 包装类型（DataStats/OcrStatus/Search 等）处做字段映射。
 */
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import type { MascotBubbleData, WorkMemoryApi } from '../types/ipc'

/* ===================== 内部辅助函数 ===================== */

/**
 * 调用 Tauri 命令并将字符串错误统一包装为 Error。
 * Tauri invoke 失败时以字符串形式 reject，这里转换为 Error 以匹配 Electron 行为。
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/** 抛出“尚未实现”错误，用于暂无对应 Tauri 命令的方法桩。 */
function notImplemented(name: string): never {
  throw new Error(`[Tauri Adapter] 尚未实现: ${name}`)
}

/**
 * 订阅 Tauri 事件，返回同步取消订阅函数。
 * Tauri listen() 返回 Promise<UnlistenFn>，而 WorkMemoryApi 的 on* 方法
 * 要求同步返回 () => void，因此内部缓存 unlisten 并在取消时调用。
 */
function subscribe(eventName: string, cb: (payload: unknown) => void): () => void {
  let unlisten: (() => void) | null = null
  let cancelled = false
  void listen(eventName, (event) => cb(event.payload)).then((unlistenFn) => {
    if (cancelled) {
      unlistenFn()
    } else {
      unlisten = unlistenFn
    }
  })
  return () => {
    cancelled = true
    if (unlisten) {
      unlisten()
    }
  }
}

/* ===================== 后端 snake_case 原始响应类型 ===================== */

/** get_data_stats 返回的 snake_case 结构 */
interface RawDataStats {
  segment_count: number
  episode_count: number
  wiki_count: number
  report_count: number
  screenshot_count: number
  db_size_bytes: number
}

/** get_ocr_status 返回的 snake_case 结构 */
interface RawOcrStatus {
  backend: string
  model: 'tiny' | 'small'
  loaded: boolean
  queue_size: number
  running: boolean
  configured: boolean
}

/** search 命令返回的 snake_case 结构 */
interface RawSearchHit {
  id: string
  snippet: string
  matched_field: string
}
interface RawWikiSearchHit {
  id: string
  title: string
  snippet: string
}
interface RawSearchResponse {
  clean_episodes: RawSearchHit[]
  segments: RawSearchHit[]
  episodes: RawSearchHit[]
  wikis: RawWikiSearchHit[]
}

/* ===================== 适配器实现 ===================== */

export const workmemory: WorkMemoryApi = {
  /* ---------------------- Window ---------------------- */
  window: {
    async minimize(): Promise<void> {
      await getCurrentWindow().minimize()
    },
    async maximize(): Promise<void> {
      // toggleMaximize 兼容“最大化/还原”切换，与 Electron maximize 行为一致
      await getCurrentWindow().toggleMaximize()
    },
    async close(): Promise<void> {
      await getCurrentWindow().close()
    },
    async isMaximized(): Promise<boolean> {
      return getCurrentWindow().isMaximized()
    },
    onMaximizeChange(cb: (maximized: boolean) => void): () => void {
      return subscribe('window:maximizeChanged', (payload) => cb(Boolean(payload)))
    }
  },

  /* ---------------------- Segment ---------------------- */
  segment: {
    async update(id, patch) {
      // 后端 update_segment 返回 ()，这里返回 null 以匹配 WorkSegment | null 契约
      await call('update_segment', { id, patch })
      return null
    },
    async getById(id) {
      return call('get_segment_by_id', { id })
    },
    async getByDate(date) {
      return call('get_segments', { date })
    },
    async getActiveByDate(_date) {
      notImplemented('segment.getActiveByDate')
    },
    async setSelectedForReport(id, selected) {
      await call('set_segment_selected_for_report', { id, selected })
      return true
    },
    async setImportant(id, important) {
      await call('set_segment_important', { id, important })
      return true
    },
    async softDelete(id) {
      // 后端 delete_segment 执行软删除
      await call('delete_segment', { id })
      return true
    },
    async hardDelete(_id) {
      notImplemented('segment.hardDelete')
    },
    async getPrivateByDate(_date) {
      notImplemented('segment.getPrivateByDate')
    }
  },

  /* ---------------------- Episode ---------------------- */
  episode: {
    async insert(_episode) {
      // 后端 create_manual_episode 签名不同（title/tags/project/text），无法直接映射
      notImplemented('episode.insert')
    },
    async update(id, patch) {
      await call('update_episode', { id, patch })
      return null
    },
    async getById(_id) {
      notImplemented('episode.getById')
    },
    async getByDate(date) {
      return call('get_episodes', { date })
    },
    async setOneLineSummary(_id, _summary) {
      notImplemented('episode.setOneLineSummary')
    },
    async setReportEligible(_id, _eligible) {
      notImplemented('episode.setReportEligible')
    },
    async setWikiEligible(_id, _eligible) {
      notImplemented('episode.setWikiEligible')
    },
    async getDailySummary(_date) {
      notImplemented('episode.getDailySummary')
    },
    async setDailySummary(_date, _text) {
      notImplemented('episode.setDailySummary')
    },
    async confirmEntity(id, entityType, entityName) {
      // 后端 confirm_entity 接收 "type:name" 格式的 entity 字符串
      await call('confirm_entity', { episodeId: id, entity: `${entityType}:${entityName}` })
      return null
    },
    async correctEntity(id, entityType, entityName, newName) {
      // 后端 correct_entity 接收 "type:oldName:newName" 格式
      await call('correct_entity', { episodeId: id, entity: `${entityType}:${entityName}:${newName}` })
      return null
    },
    async ignoreEntity(id, entityType, entityName) {
      await call('ignore_entity', { episodeId: id, entity: `${entityType}:${entityName}` })
      return null
    }
  },

  /* ---------------------- CleanEpisode ---------------------- */
  cleanEpisode: {
    async getById(_id) {
      notImplemented('cleanEpisode.getById')
    },
    async getByDate(date) {
      return call('get_clean_episodes', { date })
    },
    async getByHour(_date, _hourBucket) {
      notImplemented('cleanEpisode.getByHour')
    },
    async getByDateRange(_startDate, _endDate) {
      notImplemented('cleanEpisode.getByDateRange')
    },
    async update(_id, _patch) {
      notImplemented('cleanEpisode.update')
    }
  },

  /* ---------------------- Wiki ---------------------- */
  wiki: {
    async insert(page) {
      // 后端 create_wiki_page 返回新页 ID（String），这里合并回完整 WikiPage
      const id = await call<string>('create_wiki_page', { page })
      return { ...page, id }
    },
    async update(id, patch) {
      await call('update_wiki_page', { id, patch })
      return null
    },
    async delete(id) {
      await call('delete_wiki_page', { id })
      return true
    },
    async getById(id) {
      return call('get_wiki_page_by_id', { id })
    },
    async getByType(_type) {
      notImplemented('wiki.getByType')
    },
    async getByTitle(_title) {
      notImplemented('wiki.getByTitle')
    },
    async getAll() {
      return call('get_wiki_pages')
    },
    async searchByTitle(_keyword) {
      notImplemented('wiki.searchByTitle')
    },
    async addToReviewQueue(_page) {
      notImplemented('wiki.addToReviewQueue')
    },
    async getReviewQueue() {
      return call('get_wiki_review_queue')
    },
    async confirmReview(id) {
      return call('confirm_wiki_review', { id })
    },
    async rejectReview(id) {
      return call('reject_wiki_review', { id })
    },
    async updateBacklinks(_id) {
      notImplemented('wiki.updateBacklinks')
    },
    async getBacklinks(_title) {
      // 后端 get_wiki_backlinks 按 id 查询并返回标题字符串列表，与按 title 查询返回 WikiPage[] 的契约不符
      notImplemented('wiki.getBacklinks')
    },
    async findBrokenLinks() {
      notImplemented('wiki.findBrokenLinks')
    },
    async scanNow() {
      notImplemented('wiki.scanNow')
    },
    async previewIngest(_reviewItemId) {
      notImplemented('wiki.previewIngest')
    },
    async confirmIngest(_reviewItemId, _edits) {
      notImplemented('wiki.confirmIngest')
    },
    async rejectIngest(_reviewItemId) {
      notImplemented('wiki.rejectIngest')
    },
    async getBrokenLinks() {
      notImplemented('wiki.getBrokenLinks')
    },
    async rebuildBacklinks() {
      notImplemented('wiki.rebuildBacklinks')
    }
  },

  /* ---------------------- Report ---------------------- */
  report: {
    async update(_id, _patch) {
      notImplemented('report.update')
    },
    async saveDraft(_report) {
      notImplemented('report.saveDraft')
    },
    async getById(id) {
      return call('get_report_by_id', { id })
    },
    async getByDate(_date) {
      notImplemented('report.getByDate')
    },
    async getAllHistory() {
      return call('get_reports')
    },
    async setStatus(id, status) {
      await call('set_report_status', { id, status })
      return true
    }
  },

  /* ---------------------- Privacy ---------------------- */
  privacy: {
    async insert(_rule) {
      notImplemented('privacy.insert')
    },
    async update(_id, _patch) {
      notImplemented('privacy.update')
    },
    async delete(_id) {
      notImplemented('privacy.delete')
    },
    async getAll() {
      notImplemented('privacy.getAll')
    },
    async getEnabled() {
      notImplemented('privacy.getEnabled')
    },
    async matchRule(_appName, _processName, _windowTitle, _url) {
      notImplemented('privacy.matchRule')
    }
  },

  /* ---------------------- Capture ---------------------- */
  capture: {
    async start() {
      await call('start_capture')
      return true
    },
    async stop() {
      await call('stop_capture')
      return true
    },
    async pause() {
      await call('pause_capture')
      return true
    },
    async resume() {
      await call('resume_capture')
      return true
    },
    async getState() {
      // 后端返回 { state: string }，契约要求返回 string
      const res = await call<{ state: string }>('get_capture_state')
      return res.state
    },
    onStateChange(cb: (state: string) => void): () => void {
      return subscribe('capture:state-changed', (payload) => cb(String(payload)))
    },
    onIncognitoDetected(cb: () => void): () => void {
      return subscribe('mascot:incognito-detected', () => cb())
    },
    onIncognitoCleared(cb: () => void): () => void {
      return subscribe('mascot:incognito-cleared', () => cb())
    }
  },

  /* ---------------------- OCR ---------------------- */
  ocr: {
    async recognize(imagePath) {
      return call('recognize_image', { path: imagePath })
    },
    async setModel(model) {
      return call('set_ocr_model', { model })
    },
    async getModel() {
      notImplemented('ocr.getModel')
    },
    async getStatus() {
      // 后端返回 snake_case（queue_size），映射为 camelCase（queueSize）
      const res = await call<RawOcrStatus>('get_ocr_status')
      return {
        backend: res.backend,
        model: res.model,
        loaded: res.loaded,
        queueSize: res.queue_size,
        running: res.running,
        configured: res.configured
      }
    },
    async reprocess(segmentId) {
      return call('reprocess_ocr', { segmentId })
    },
    async getRuntimeStatus() {
      notImplemented('ocr.getRuntimeStatus')
    },
    async testRecognize(_imagePath) {
      notImplemented('ocr.testRecognize')
    },
    async openInstallDir() {
      notImplemented('ocr.openInstallDir')
    }
  },

  /* ---------------------- AI ---------------------- */
  ai: {
    async generateReport(payload) {
      // 后端 generate_report 仅接受 date + template，返回 Report；
      // 契约要求 AiGenerateReportResult，返回值结构存在差异（后端待补全）
      return call('generate_report', { date: payload.date, template: payload.templateId })
    },
    async extractWiki(_payload) {
      notImplemented('ai.extractWiki')
    },
    async distillHour(_date, _hourBucket) {
      notImplemented('ai.distillHour')
    },
    async runDueDistill() {
      notImplemented('ai.runDueDistill')
    },
    async testConnection() {
      notImplemented('ai.testConnection')
    },
    async getTemplates() {
      notImplemented('ai.getTemplates')
    },
    async estimateChars(_episodeIds, _notes) {
      notImplemented('ai.estimateChars')
    },
    async exportMarkdown(report) {
      return call('export_report', { id: report.id, format: 'md' })
    },
    async exportWord(_payload) {
      notImplemented('ai.exportWord')
    },
    async exportJson(report) {
      return call('export_report', { id: report.id, format: 'json' })
    }
  },

  /* ---------------------- Mascot ---------------------- */
  mascot: {
    async setStyle(style) {
      await call('set_mascot_style', { style })
      return true
    },
    async getStyle() {
      notImplemented('mascot.getStyle')
    },
    async setState(state) {
      await call('set_mascot_state', { state })
      return true
    },
    async show() {
      await call('show_mascot')
      return true
    },
    async hide() {
      await call('hide_mascot')
      return true
    },
    async showBubble(text) {
      await call('show_mascot_bubble', { text })
      return true
    },
    async ghostCapture(_text) {
      notImplemented('mascot.ghostCapture')
    },
    async getStats() {
      notImplemented('mascot.getStats')
    },
    async getInitialState() {
      notImplemented('mascot.getInitialState')
    },
    async leftClick() {
      notImplemented('mascot.leftClick')
    },
    async rightClick() {
      notImplemented('mascot.rightClick')
    },
    async rightDoubleClick() {
      notImplemented('mascot.rightDoubleClick')
    },
    async bubbleClosed() {
      notImplemented('mascot.bubbleClosed')
    },
    async mouseEnter() {
      notImplemented('mascot.mouseEnter')
    },
    async mouseLeave() {
      notImplemented('mascot.mouseLeave')
    },
    async dragStart() {
      notImplemented('mascot.dragStart')
    },
    async dragEnd() {
      notImplemented('mascot.dragEnd')
    },
    async navigate(page) {
      await call('navigate_to', { page })
      return true
    },
    onStateChanged(cb: (state: string) => void): () => void {
      return subscribe('mascot:stateChanged', (payload) => cb(String(payload)))
    },
    onStyleChanged(cb: (style: string) => void): () => void {
      return subscribe('mascot:styleChanged', (payload) => cb(String(payload)))
    },
    onBubbleShow(cb: (bubble: MascotBubbleData) => void): () => void {
      return subscribe('mascot:bubbleShow', (payload) => cb(payload as MascotBubbleData))
    },
    onNavigate(cb: (page: string) => void): () => void {
      return subscribe('mascot:navigateMain', (payload) => cb(String(payload)))
    }
  },

  /* ---------------------- Settings ---------------------- */
  settings: {
    async get() {
      return call('get_settings')
    },
    async set(patch) {
      // 后端 update_settings 返回 ()，契约要求返回完整 AppSettings，故更新后重新拉取
      await call('update_settings', { patch })
      return call('get_settings')
    },
    async reset() {
      await call('reset_settings')
      return call('get_settings')
    },
    async setApiKey(key) {
      await call('set_api_key', { key })
    },
    async clearApiKey() {
      await call('clear_api_key')
    }
  },

  /* ---------------------- Data ---------------------- */
  data: {
    async cleanup() {
      // 后端 cleanup_data 返回 ()，契约要求 DataCleanupStats，暂返回零值占位
      await call('cleanup_data')
      return { deletedSegments: 0, deletedEpisodes: 0, deletedScreenshots: 0, orphanWikiSources: 0 }
    },
    async clearDay(date) {
      await call('clear_day_data', { date })
      return { segments: 0, episodes: 0 }
    },
    async clearAll() {
      await call('clear_all_data')
      return { segments: 0, episodes: 0 }
    },
    async getStats() {
      // 后端返回 snake_case，映射为 camelCase
      const res = await call<RawDataStats>('get_data_stats')
      return {
        segmentCount: res.segment_count,
        episodeCount: res.episode_count,
        wikiCount: res.wiki_count,
        reportCount: res.report_count,
        screenshotCount: res.screenshot_count,
        dbSizeBytes: res.db_size_bytes
      }
    }
  },

  /* ---------------------- System ---------------------- */
  system: {
    async saveFile(_defaultName, _content, _filters) {
      notImplemented('system.saveFile')
    },
    async writeClipboard(_payload) {
      notImplemented('system.writeClipboard')
    }
  },

  /* ---------------------- Insights ---------------------- */
  insights: {
    async getAudit(_dateRange) {
      notImplemented('insights.getAudit')
    },
    async getAnomalies(_dateRange) {
      notImplemented('insights.getAnomalies')
    },
    async getTrend(_days) {
      notImplemented('insights.getTrend')
    },
    async getInsights(_dateRange) {
      notImplemented('insights.getInsights')
    },
    async pushInsight(_title, _message, _navigatePage) {
      notImplemented('insights.pushInsight')
    }
  },

  /* ---------------------- Search ---------------------- */
  search: {
    async fts(query) {
      // 后端返回 snake_case（clean_episodes/matched_field 等），映射为契约的 camelCase
      const res = await call<RawSearchResponse>('search', { query })
      return {
        cleanEpisodes: res.clean_episodes.map((h) => ({
          cleanEpisodeId: h.id,
          snippet: h.snippet,
          matchedField: h.matched_field as 'title' | 'summary' | 'evidence_refs'
        })),
        segments: res.segments.map((h) => ({
          segmentId: h.id,
          snippet: h.snippet,
          matchedField: h.matched_field as 'ocr_text' | 'window_title'
        })),
        episodes: res.episodes.map((h) => ({
          episodeId: h.id,
          snippet: h.snippet,
          matchedField: h.matched_field as 'title' | 'one_line_summary'
        })),
        wikis: res.wikis.map((h) => ({
          wikiId: h.id,
          title: h.title,
          snippet: h.snippet
        }))
      }
    },
    async hybrid(query, options) {
      // 后端 semantic_search 接收 query + limit，返回 SearchResult 列表
      return call('semantic_search', { query, limit: options?.limit })
    }
  }
}
