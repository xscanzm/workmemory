/**
 * EpisodeManager：Episode 编排层单例
 *
 * 整合 EpisodeBuilder + OneLineSummary + EntityExtractor。
 *
 * 职责：
 *  - initialize()：app ready 后调用，监听 OcrQueue 和 CaptureManager 事件
 *  - 监听 OcrQueue 的 'ocr-completed' 事件 → 触发 rebuildEpisodesForDate(今日)
 *  - 监听 CaptureManager 的 'segment-merged' 事件 → 触发重建
 *  - rebuild(date)：协调 EpisodeBuilder 重建 + EntityExtractor 提取 + OneLineSummary 生成
 *  - 暴露 IPC：episode:getByDate、episode:update、episode:setOneLineSummary、
 *    episode:getDailySummary、episode:setDailySummary
 *
 * 事件：
 *  - 'episodes-rebuilt'(date)：Episode 重建完成（转发自 EpisodeBuilder）
 *
 * 单例导出 getEpisodeManager()。
 */
import { EventEmitter } from 'node:events'
import type { Episode } from '@/types'
import { EpisodeBuilder } from './EpisodeBuilder'
import { OneLineSummary } from './OneLineSummary'
import { EntityExtractor } from './EntityExtractor'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { getCaptureManager } from './CaptureManager'
import { getOcrManager } from '../ocr/OcrManager'

/** 重建防抖时长（毫秒）：避免短时间内频繁重建 */
const REBUILD_DEBOUNCE_MS = 2000

/**
 * EpisodeManager：Episode 编排层。
 */
export class EpisodeManager extends EventEmitter {
  private builder: EpisodeBuilder
  private summary: OneLineSummary
  private extractor: EntityExtractor
  private initialized = false

  /** 重建防抖计时器（按日期分组） */
  private rebuildTimers: Map<string, NodeJS.Timeout> = new Map()

  constructor() {
    super()
    this.builder = new EpisodeBuilder()
    this.summary = new OneLineSummary()
    this.extractor = new EntityExtractor()
    // 转发 EpisodeBuilder 的 'episodes-rebuilt' 事件，供 WikiIngestManager 等监听
    this.builder.on('episodes-rebuilt', (date: string) => {
      this.emit('episodes-rebuilt', date)
    })
  }

  /**
   * 初始化：app ready 后调用。
   * 监听 OcrQueue 和 CaptureManager 事件。
   */
  initialize(): void {
    if (this.initialized) return

    // 监听 OcrQueue 的 'ocr-completed' 事件
    const ocrManager = getOcrManager()
    const queue = ocrManager.getQueue()
    queue.on('ocr-completed', (segmentId: string) => {
      this.onOcrCompleted(segmentId)
    })

    // 监听 CaptureManager 的 'segment-merged' 事件
    const captureManager = getCaptureManager()
    captureManager.on('segment-created', (segment) => {
      this.scheduleRebuild(segment.date)
    })
    captureManager.on('segment-merged', () => {
      // 合并事件触发今日重建
      this.scheduleRebuild(this.getTodayDate())
    })

    // 启动时也重建今日，修复上次 OCR 失败或退出前未聚合导致的首页空数据。
    this.scheduleRebuild(this.getTodayDate())

    this.initialized = true
    console.log('[EpisodeManager] 初始化完成')
  }

  /** OCR 完成回调：获取 Segment 日期并触发重建 */
  private onOcrCompleted(segmentId: string): void {
    const segment = SegmentRepository.getById(segmentId)
    if (!segment) return
    this.scheduleRebuild(segment.date)
  }

  /**
   * 调度重建（防抖）。
   * 同一日期在 DEBOUNCE_MS 内只重建一次。
   */
  scheduleRebuild(date: string): void {
    const existingTimer = this.rebuildTimers.get(date)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    const timer = setTimeout(() => {
      this.rebuildTimers.delete(date)
      this.rebuild(date)
    }, REBUILD_DEBOUNCE_MS)

    this.rebuildTimers.set(date, timer)
  }

  /**
   * 重建指定日期的 Episodes + 实体 + 每日总结。
   *
   * 流程：
   *  1. EpisodeBuilder.rebuildEpisodesForDate(date) — 重建 Episodes
   *  2. EntityExtractor.extractAndSaveForDate(date) — 提取实体
   *  3. OneLineSummary.generateDailySummary(date) — 生成每日总结
   */
  rebuild(date: string): Episode[] {
    try {
      // 1. 重建 Episodes
      const episodes = this.builder.rebuildEpisodesForDate(date)

      // 2. 提取实体
      this.extractor.extractAndSaveForDate(date)

      // 3. 生成每日总结（受 userEdited 保护）
      this.summary.generateDailySummary(date)

      return episodes
    } catch (e) {
      console.error(`[EpisodeManager] 重建 ${date} Episodes 失败:`, e instanceof Error ? e.message : String(e))
      return []
    }
  }

  // ===================== IPC 暴露方法 =====================

  /** 获取指定日期的 Episodes */
  getByDate(date: string): Episode[] {
    return EpisodeRepository.getByDate(date)
  }

  /** 获取 Episode by id */
  getById(id: string): Episode | null {
    return EpisodeRepository.getById(id)
  }

  /** 更新 Episode */
  update(id: string, patch: Partial<Episode>): Episode | null {
    return EpisodeRepository.update(id, patch)
  }

  /**
   * 设置 Episode 一句话总结（含 userEdited 保护）。
   * 返回 false 表示因 userEdited 保护而拒绝覆盖。
   */
  setOneLineSummary(id: string, summary: string): boolean {
    return EpisodeRepository.setOneLineSummary(id, summary)
  }

  /** 获取每日总结 */
  getDailySummary(date: string): string {
    return this.summary.getDailySummary(date)
  }

  /** 设置每日总结（用户手动改写，标记 user_edited=true） */
  setDailySummary(date: string, text: string): boolean {
    return this.summary.setDailySummary(date, text)
  }

  // ===================== 工具方法 =====================

  /** 获取今日日期字符串 YYYY-MM-DD */
  private getTodayDate(): string {
    const now = new Date()
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  /** 停止管理器 */
  stop(): void {
    for (const timer of this.rebuildTimers.values()) {
      clearTimeout(timer)
    }
    this.rebuildTimers.clear()
    this.initialized = false
  }
}

// ===================== 单例 =====================

let managerInstance: EpisodeManager | null = null

/** 获取 EpisodeManager 单例 */
export function getEpisodeManager(): EpisodeManager {
  if (!managerInstance) {
    managerInstance = new EpisodeManager()
  }
  return managerInstance
}

/** 重置单例（仅供测试） */
export function resetEpisodeManager(): void {
  if (managerInstance) {
    managerInstance.stop()
    managerInstance = null
  }
}
