/**
 * WikiIngestManager：Wiki Ingest 编排层单例
 *
 * 整合 HighValueSignalDetector + WikiExtractor + WikiRepository + WikiLinkEngine。
 *
 * 职责：
 *  - scanAndEnqueue()：扫描近期 Episodes（最近 7 天）→ detectFromEpisodes →
 *    对每个 candidate 调 WikiExtractor.extractFromCandidate → addToReviewQueue
 *  - 定时扫描：每小时执行一次 scanAndEnqueue（setInterval）
 *  - 监听 EpisodeManager 的 'episodes-rebuilt' 事件 → 触发 scanAndEnqueue（防抖 30 秒）
 *  - confirmIngest(reviewItemId, edits?)：用户确认 → confirmReview → updateBacklinks
 *  - rejectIngest(reviewItemId)：用户忽略 → 从 review queue 删除
 *  - previewIngest(reviewItemId)：返回 WikiExtractor 生成的 Markdown 供前端预览
 *  - 暴露 IPC：wiki:scanNow、wiki:previewIngest、wiki:confirmIngest、wiki:rejectIngest、
 *    wiki:getBrokenLinks、wiki:rebuildBacklinks
 *
 * 单例导出 getWikiIngestManager()。
 */
import type { WikiPage } from '@/types'
import type { CleanEpisode, WikiType } from '@/types'
import { WikiRepository } from '../db/repositories/WikiRepository'
import { CleanEpisodeRepository } from '../db/repositories/CleanEpisodeRepository'
import type { IngestCandidate } from './HighValueSignalDetector'
import type { WikiExtractionResult } from './WikiExtractor'
import { WikiLinkEngine, getWikiLinkEngine } from './WikiLinkEngine'
import type { BrokenLink } from './WikiLinkEngine'
import { recordFeedback } from '../ai/FeedbackLoop'

/** 扫描窗口（天）：最近 7 天 */
const SCAN_WINDOW_DAYS = 7
/** 定时扫描间隔（毫秒）：1 小时 */
const SCAN_INTERVAL_MS = 60 * 60 * 1000
/** 自动沉淀阈值 */
const AUTO_UPSERT_CONFIDENCE_THRESHOLD = 0.82
/** Review Queue 阈值 */
const REVIEW_CONFIDENCE_THRESHOLD = 0.5

/** Review Queue 项的元数据键（存入 WikiPage 的 sources 中前缀标记） */
const REVIEW_META_PREFIX = '__candidate__:'

/** 预览结果 */
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

/**
 * WikiIngestManager：Wiki Ingest 编排层。
 */
export class WikiIngestManager {
  private linkEngine: WikiLinkEngine

  private scanTimer: NodeJS.Timeout | null = null
  private initialized = false

  /** 候选 ID → 提取结果缓存（供 previewIngest 使用） */
  private extractionCache: Map<string, WikiExtractionResult> = new Map()

  constructor() {
    this.linkEngine = getWikiLinkEngine()
  }

  /**
   * 初始化：app ready 后调用。
   * 启动定时扫描 + 监听 EpisodeManager 事件。
   */
  initialize(): void {
    if (this.initialized) return

    // 启动定时扫描（每小时）
    this.scanTimer = setInterval(() => {
      this.scanAndEnqueue().catch(e => {
        console.error('[WikiIngestManager] 定时扫描失败:', e instanceof Error ? e.message : String(e))
      })
    }, SCAN_INTERVAL_MS)

    this.initialized = true
    console.log('[WikiIngestManager] 初始化完成，定时扫描已启动')

    // 初始化时立即执行一次扫描
    this.scanAndEnqueue().catch(e => {
      console.error('[WikiIngestManager] 初始扫描失败:', e instanceof Error ? e.message : String(e))
    })
  }

  /**
   * 扫描近期 Episodes → 检测高价值信号 → 提取 Wiki → 加入 Review Queue。
   * 返回新增的 Review Queue 项数量。
   */
  async scanAndEnqueue(): Promise<number> {
    try {
      const candidates = CleanEpisodeRepository.getWikiCandidates(SCAN_WINDOW_DAYS)
      if (candidates.length === 0) {
        console.log('[WikiIngestManager] 近期无工作记忆 Wiki 候选，跳过扫描')
        return 0
      }

      let changedCount = 0
      const existingQueueTitles = new Set(WikiRepository.getReviewQueue().map(p => p.title))
      for (const cleanEpisode of candidates) {
        try {
          if (!this.hasConcreteWikiTitle(cleanEpisode)) {
            CleanEpisodeRepository.update(cleanEpisode.id, { wikiStatus: 'rejected' })
            continue
          }
          const pageDraft = this.buildWikiPageDraft(cleanEpisode)
          if (cleanEpisode.confidence >= AUTO_UPSERT_CONFIDENCE_THRESHOLD) {
            const existing = WikiRepository.getByTitle(pageDraft.title)
            if (existing) {
              WikiRepository.update(existing.id, {
                content: this.mergeWikiContent(existing.content, pageDraft.content),
                sources: [...new Set([...existing.sources, ...pageDraft.sources])],
                confidence: Math.max(existing.confidence, pageDraft.confidence),
                reviewStatus: 'reviewed'
              })
              this.linkEngine.onWikiPageUpdated(existing.id)
            } else {
              const saved = WikiRepository.insert({
                ...pageDraft,
                id: '',
                reviewStatus: 'reviewed',
                createdAt: '',
                updatedAt: ''
              })
              this.linkEngine.onWikiPageUpdated(saved.id)
            }
            CleanEpisodeRepository.update(cleanEpisode.id, { wikiStatus: 'auto_upserted' })
            changedCount++
            continue
          }

          if (cleanEpisode.confidence >= REVIEW_CONFIDENCE_THRESHOLD && !existingQueueTitles.has(pageDraft.title)) {
            WikiRepository.addToReviewQueue({
              ...pageDraft,
              sources: [`${REVIEW_META_PREFIX}${cleanEpisode.id}`, ...pageDraft.sources]
            })
            CleanEpisodeRepository.update(cleanEpisode.id, { wikiStatus: 'needs_review' })
            existingQueueTitles.add(pageDraft.title)
            changedCount++
          }
        } catch (e) {
          console.error(
            `[WikiIngestManager] 工作记忆事件「${cleanEpisode.title}」提取失败:`,
            e instanceof Error ? e.message : String(e)
          )
        }
      }

      console.log(`[WikiIngestManager] 扫描完成，处理 ${changedCount} 个 Wiki 候选`)
      return changedCount
    } catch (e) {
      console.error('[WikiIngestManager] scanAndEnqueue 失败:', e instanceof Error ? e.message : String(e))
      return 0
    }
  }

  /**
   * 预览 Review Queue 项的 Markdown 内容。
   * 若缓存中有提取结果则返回缓存，否则从 WikiPage.content 读取。
   */
  previewIngest(reviewItemId: string): WikiIngestPreview | null {
    const page = WikiRepository.getById(reviewItemId)
    if (!page) return null

    // 从 sources 中提取候选 ID
    const candidateId = this.extractCandidateId(page.sources)

    // 优先使用缓存的提取结果
    if (candidateId) {
      const cached = this.extractionCache.get(candidateId)
      if (cached) {
        return {
          reviewItemId,
          title: page.title,
          type: page.type,
          confidence: page.confidence,
          evidence: this.extractEvidenceFromContent(page.content),
          markdown: page.content,
          oneLineSummary: cached.oneLineSummary,
          keyFacts: cached.keyFacts,
          pendingQuestions: cached.pendingQuestions,
          extractedLinks: cached.extractedLinks
        }
      }
    }

    // 降级：直接返回 WikiPage 内容
    return {
      reviewItemId,
      title: page.title,
      type: page.type,
      confidence: page.confidence,
      evidence: this.extractEvidenceFromContent(page.content),
      markdown: page.content,
      oneLineSummary: this.extractSectionFromMarkdown(page.content, '一句话总结'),
      keyFacts: this.extractListSectionFromMarkdown(page.content, '关键事实'),
      pendingQuestions: this.extractListSectionFromMarkdown(page.content, '待确认'),
      extractedLinks: this.extractListLinksFromMarkdown(page.content, '相关链接')
    }
  }

  /**
   * 确认 Ingest：用户确认 → confirmReview 写入正式 wiki_pages → 重建反链。
   * @param reviewItemId Review Queue 项 ID
   * @param edits 用户编辑后的 Markdown（可选，覆盖自动提取内容）
   */
  confirmIngest(reviewItemId: string, edits?: { content?: string; title?: string }): WikiPage | null {
    const existing = WikiRepository.getById(reviewItemId)
    if (!existing) return null

    // 若有编辑，先更新内容
    if (edits) {
      const patch: Partial<WikiPage> = {}
      if (edits.content !== undefined) patch.content = edits.content
      if (edits.title !== undefined) patch.title = edits.title
      if (Object.keys(patch).length > 0) {
        WikiRepository.update(reviewItemId, patch)
      }
    }

    // 确认审核（review_status → reviewed）
    const confirmed = WikiRepository.confirmReview(reviewItemId)
    if (!confirmed) return null

    // 清理 sources 中的候选元数据标记
    const cleanSources = confirmed.sources.filter(s => !s.startsWith(REVIEW_META_PREFIX))
    const cleaned = WikiRepository.update(confirmed.id, { sources: cleanSources })

    // 重建反链（本页 + 本页引用的其他页）
    this.linkEngine.onWikiPageUpdated(confirmed.id)

    // 清理缓存
    const candidateId = this.extractCandidateId(confirmed.sources)
    if (candidateId) {
      this.extractionCache.delete(candidateId)
    }

    return cleaned ?? confirmed
  }

  /**
   * 拒绝 Ingest：用户忽略 → 从 Review Queue 删除。
   * 同时记录反馈事件（wiki_rejected），供 FeedbackLoop 分析拒绝模式。
   */
  rejectIngest(reviewItemId: string): boolean {
    const existing = WikiRepository.getById(reviewItemId)
    if (!existing) return false

    // 记录用户拒绝反馈：before 为 Wiki 标题，after 为空（表示整体拒绝）
    recordFeedback({
      type: 'wiki_rejected',
      targetId: reviewItemId,
      before: existing.title,
      after: '',
      timestamp: new Date().toISOString()
    })

    // 清理缓存
    const candidateId = this.extractCandidateId(existing.sources)
    if (candidateId) {
      this.extractionCache.delete(candidateId)
    }

    return WikiRepository.rejectReview(reviewItemId)
  }

  /** 获取 Review Queue（转发 WikiRepository） */
  getReviewQueue(): WikiPage[] {
    return WikiRepository.getReviewQueue()
  }

  /** 获取断链列表（使用 WikiLinkEngine） */
  getBrokenLinks(): BrokenLink[] {
    return this.linkEngine.findBrokenLinks()
  }

  /** 重建全库反链（使用 WikiLinkEngine） */
  rebuildBacklinks(): number {
    return this.linkEngine.rebuildAllBacklinks()
  }

  /** 停止管理器 */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    this.initialized = false
  }

  // ===================== 内部工具 =====================

  private hasConcreteWikiTitle(cleanEpisode: CleanEpisode): boolean {
    const title = cleanEpisode.project || cleanEpisode.materials[0] || cleanEpisode.entities[0]?.name || cleanEpisode.title
    const normalized = title.replace(/\s+/g, '')
    if (normalized.length < 2) return false
    return !/^(推进|梳理|配置|笔记|工作推进|工作片段)$/.test(normalized)
  }

  private inferWikiType(cleanEpisode: CleanEpisode): WikiType {
    if (cleanEpisode.entities.some((e) => e.type === 'person')) return 'person'
    if (cleanEpisode.project || cleanEpisode.entities.some((e) => e.type === 'project')) return 'project'
    if (cleanEpisode.blockers.length > 0) return 'issue'
    if (cleanEpisode.memoryKind === 'communication') return 'meeting'
    return 'topic'
  }

  private buildWikiPageDraft(cleanEpisode: CleanEpisode): Omit<WikiPage, 'id' | 'reviewStatus' | 'createdAt' | 'updatedAt'> {
    const title = cleanEpisode.project || cleanEpisode.materials[0] || cleanEpisode.entities[0]?.name || cleanEpisode.title
    const evidence = cleanEpisode.evidenceRefs.map((ev) => `- [${ev.segmentId}] ${ev.quote}`).join('\n') || '- （无证据摘录）'
    const content = [
      `# ${title}`,
      '',
      '## 一句话总结',
      cleanEpisode.summary,
      '',
      '## 当前进展',
      cleanEpisode.outputs.length > 0
        ? cleanEpisode.outputs.map((o) => `- ${o}`).join('\n')
        : `- ${cleanEpisode.title}`,
      '',
      '## 待办与阻塞',
      cleanEpisode.todos.length > 0 ? cleanEpisode.todos.map((t) => `- [待办] ${t}`).join('\n') : '- （暂无明确待办）',
      cleanEpisode.blockers.length > 0 ? cleanEpisode.blockers.map((b) => `- [阻塞] ${b}`).join('\n') : '',
      '',
      '## 来源证据',
      evidence,
      '',
      '## 来源标识',
      `- cleanEpisodeId: ${cleanEpisode.id}`,
      `- segmentIds: ${cleanEpisode.segmentIds.join(', ')}`,
      `- updatedAt: ${new Date().toISOString()}`
    ].filter(Boolean).join('\n')
    return {
      type: this.inferWikiType(cleanEpisode),
      title,
      aliases: cleanEpisode.topics.slice(0, 5),
      content,
      sources: [cleanEpisode.id, ...cleanEpisode.segmentIds],
      backlinks: [],
      confidence: cleanEpisode.confidence
    }
  }

  private mergeWikiContent(existing: string, next: string): string {
    return `${existing}\n\n---\n\n${next}`
  }

  /** 从 sources 中提取候选 ID */
  private extractCandidateId(sources: string[]): string | null {
    for (const s of sources) {
      if (s.startsWith(REVIEW_META_PREFIX)) {
        return s.slice(REVIEW_META_PREFIX.length)
      }
    }
    return null
  }

  /** 从 Markdown content 中提取 evidence（简化：从来源片段节提取） */
  private extractEvidenceFromContent(content: string): string[] {
    const evidence: string[] = []
    const lines = content.split('\n')
    let inSourcesSection = false
    for (const line of lines) {
      if (line.startsWith('## 来源片段')) {
        inSourcesSection = true
        continue
      }
      if (inSourcesSection) {
        if (line.startsWith('## ')) break
        if (line.startsWith('- ')) {
          evidence.push(line.slice(2).trim())
        }
      }
    }
    return evidence
  }

  /** 从 Markdown 中提取指定章节的文本内容 */
  private extractSectionFromMarkdown(content: string, sectionTitle: string): string {
    const lines = content.split('\n')
    let inSection = false
    const parts: string[] = []
    for (const line of lines) {
      if (line.startsWith(`## ${sectionTitle}`)) {
        inSection = true
        continue
      }
      if (inSection) {
        if (line.startsWith('## ')) break
        if (line.trim().length > 0 && !line.startsWith('- ')) {
          parts.push(line.trim())
        }
      }
    }
    return parts.join(' ')
  }

  /** 从 Markdown 中提取指定章节的列表项 */
  private extractListSectionFromMarkdown(content: string, sectionTitle: string): string[] {
    const items: string[] = []
    const lines = content.split('\n')
    let inSection = false
    for (const line of lines) {
      if (line.startsWith(`## ${sectionTitle}`)) {
        inSection = true
        continue
      }
      if (inSection) {
        if (line.startsWith('## ')) break
        if (line.startsWith('- ')) {
          items.push(line.slice(2).trim())
        }
      }
    }
    return items
  }

  /** 从 Markdown 相关链接章节提取 [[link]] 目标 */
  private extractListLinksFromMarkdown(content: string, sectionTitle: string): string[] {
    const items = this.extractListSectionFromMarkdown(content, sectionTitle)
    const links: string[] = []
    for (const item of items) {
      const match = item.match(/\[\[([^\]]+)\]\]/)
      if (match) {
        const inner = match[1]
        const pipeIdx = inner.indexOf('|')
        links.push(pipeIdx >= 0 ? inner.slice(0, pipeIdx).trim() : inner.trim())
      }
    }
    return links
  }
}

// ===================== 单例 =====================

let managerInstance: WikiIngestManager | null = null

/** 获取 WikiIngestManager 单例 */
export function getWikiIngestManager(): WikiIngestManager {
  if (!managerInstance) {
    managerInstance = new WikiIngestManager()
  }
  return managerInstance
}

/** 重置单例（仅供测试） */
export function resetWikiIngestManager(): void {
  if (managerInstance) {
    managerInstance.stop()
    managerInstance = null
  }
}

/** 重新导出 IngestCandidate 类型供外部使用 */
export type { IngestCandidate }
