/**
 * HighValueSignalDetector：高价值信号识别器
 *
 * 分析 Episodes，识别值得沉淀为 Wiki 页的高价值 Ingest 候选源。
 *
 * 三类信号：
 *  1. 文档反复编辑：同一 document 实体在 ≥3 个 Episode 的 entities 中出现，
 *     且 OCR 文本含编辑动作词（编写、修改、撰写、更新、编辑）
 *  2. 主题词重复搜索：同一关键词在 ≥3 个 Episode 的 ocr_text/topics 中出现
 *  3. 任务单号跨多日：同一 task_id 在 ≥2 个不同日期的 Episode 中出现
 *
 * 返回 IngestCandidate[]，含 suggestedTitle/suggestedType/confidence/evidence。
 * 纯规则统计实现，不调用外部 AI（本地优先）。
 */
import { randomUUID } from 'node:crypto'
import type { Episode, WikiType } from '@/types'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { extractTaskIds, extractKeywords } from '../capture/EpisodeBuilder'
import { filterHighConfidenceEntities } from '@/utils/entity'

/** Ingest 候选源类型 */
export type IngestSourceType = 'episode_group' | 'topic' | 'task'

/** Ingest 候选源：识别出的高价值信号 */
export interface IngestCandidate {
  id: string
  sourceType: IngestSourceType
  /** 关联的 Episode id 列表 */
  sourceIds: string[]
  suggestedTitle: string
  suggestedType: WikiType
  /** 置信度 0-1 */
  confidence: number
  /** 证据描述列表（人类可读） */
  evidence: string[]
}

/** 编辑动作词正则 */
const EDIT_ACTION_REGEX = /(编写|修改|撰写|更新|编辑|修订|审阅|draft|edit|modify|update|revise)/i

/** 信号阈值 */
const DOC_EPISODE_THRESHOLD = 3
const TOPIC_EPISODE_THRESHOLD = 3
const TASK_DATE_THRESHOLD = 2

/** 主题词候选后缀（用于 suggestedTitle 生成） */
const TOPIC_TITLE_SUFFIXES = ['配置', '方案', '笔记', '梳理']

/**
 * HighValueSignalDetector：高价值信号识别器。
 */
export class HighValueSignalDetector {
  /**
   * 分析 Episodes，识别高价值 Ingest 候选源。
   * 返回去重后的 IngestCandidate[]（按 confidence 降序）。
   */
  detectFromEpisodes(episodes: Episode[]): IngestCandidate[] {
    if (episodes.length === 0) return []

    const candidates: IngestCandidate[] = []

    // 信号 1：文档反复编辑
    candidates.push(...this.detectDocumentEditing(episodes))

    // 信号 2：主题词重复搜索
    candidates.push(...this.detectTopicRepetition(episodes))

    // 信号 3：任务单号跨多日
    candidates.push(...this.detectTaskCrossDate(episodes))

    // 去重：相同 sourceType + suggestedTitle 的候选合并，取最高 confidence
    const deduped = this.dedupeCandidates(candidates)

    // 按 confidence 降序排序
    return deduped.sort((a, b) => b.confidence - a.confidence)
  }

  // ===================== 信号 1：文档反复编辑 =====================

  /**
   * 检测同一 document 实体在 ≥3 个 Episode 中出现，且 OCR 文本含编辑动作词。
   */
  private detectDocumentEditing(episodes: Episode[]): IngestCandidate[] {
    const candidates: IngestCandidate[] = []

    // 按 document 实体名分组 Episode（低置信实体不进入候选检测）
    const docToEpisodes = new Map<string, Episode[]>()
    for (const episode of episodes) {
      const highConfidenceEntities = filterHighConfidenceEntities(episode.entities)
      for (const entity of highConfidenceEntities) {
        if (entity.type !== 'document') continue
        const name = entity.name.trim()
        if (name.length === 0) continue
        const list = docToEpisodes.get(name) ?? []
        list.push(episode)
        docToEpisodes.set(name, list)
      }
    }

    for (const [docName, eps] of docToEpisodes) {
      if (eps.length < DOC_EPISODE_THRESHOLD) continue

      // 检查 OCR 文本是否含编辑动作词
      const ocrText = this.aggregateOcrText(eps)
      if (!EDIT_ACTION_REGEX.test(ocrText)) continue

      const sourceIds = eps.map(e => e.id)
      const dates = new Set(eps.map(e => e.date))
      const confidence = this.computeConfidence(eps.length, dates.size, DOC_EPISODE_THRESHOLD)
      const suggestedTitle = this.generateDocumentTitle(docName)
      const evidence = [
        `文档「${docName}」在 ${eps.length} 个工作片段中被提及`,
        `跨越 ${dates.size} 个日期：${[...dates].sort().join('、')}`,
        `OCR 文本检测到编辑/撰写动作`
      ]

      candidates.push({
        id: randomUUID(),
        sourceType: 'episode_group',
        sourceIds,
        suggestedTitle,
        suggestedType: 'topic',
        confidence,
        evidence
      })
    }

    return candidates
  }

  // ===================== 信号 2：主题词重复搜索 =====================

  /**
   * 检测同一关键词在 ≥3 个 Episode 的 ocr_text/topics 中出现。
   */
  private detectTopicRepetition(episodes: Episode[]): IngestCandidate[] {
    const candidates: IngestCandidate[] = []

    // 收集每个主题词出现在哪些 Episode 中
    const topicToEpisodes = new Map<string, Episode[]>()

    for (const episode of episodes) {
      // 从 topics 字段收集
      const topics = new Set<string>()
      for (const t of episode.topics) {
        const trimmed = t.trim()
        if (trimmed.length >= 2) topics.add(trimmed)
      }

      // 从 OCR 文本提取关键词（补充 topics 未覆盖的）
      const ocrText = this.aggregateOcrText([episode])
      if (ocrText.length > 0) {
        for (const kw of extractKeywords(ocrText)) {
          if (kw.length >= 2) topics.add(kw)
        }
      }

      // 累加到 topicToEpisodes
      for (const topic of topics) {
        const list = topicToEpisodes.get(topic) ?? []
        list.push(episode)
        topicToEpisodes.set(topic, list)
      }
    }

    for (const [topic, eps] of topicToEpisodes) {
      if (eps.length < TOPIC_EPISODE_THRESHOLD) continue

      // 跳过过于通用的词（单字、纯数字）
      if (topic.length < 2) continue
      if (/^\d+$/.test(topic)) continue

      const sourceIds = eps.map(e => e.id)
      const dates = new Set(eps.map(e => e.date))
      const confidence = this.computeConfidence(eps.length, dates.size, TOPIC_EPISODE_THRESHOLD)
      const suggestedTitle = this.generateTopicTitle(topic)
      const evidence = [
        `主题词「${topic}」在 ${eps.length} 个工作片段中反复出现`,
        `跨越 ${dates.size} 个日期：${[...dates].sort().join('、')}`,
        `建议沉淀为知识页以便后续查阅`
      ]

      candidates.push({
        id: randomUUID(),
        sourceType: 'topic',
        sourceIds,
        suggestedTitle,
        suggestedType: 'topic',
        confidence,
        evidence
      })
    }

    return candidates
  }

  // ===================== 信号 3：任务单号跨多日 =====================

  /**
   * 检测同一 task_id 在 ≥2 个不同日期的 Episode 中出现。
   */
  private detectTaskCrossDate(episodes: Episode[]): IngestCandidate[] {
    const candidates: IngestCandidate[] = []

    // 按 task_id 分组（记录 Episode + date）
    const taskToEntries = new Map<string, Array<{ episode: Episode; date: string }>>()

    for (const episode of episodes) {
      const ocrText = this.aggregateOcrText([episode])
      const fullText = `${ocrText}\n${episode.title}\n${episode.oneLineSummary}`
      const taskIds = extractTaskIds(fullText)
      for (const taskId of taskIds) {
        const list = taskToEntries.get(taskId) ?? []
        list.push({ episode, date: episode.date })
        taskToEntries.set(taskId, list)
      }
    }

    for (const [taskId, entries] of taskToEntries) {
      const uniqueDates = new Set(entries.map(e => e.date))
      if (uniqueDates.size < TASK_DATE_THRESHOLD) continue

      // 去重 Episode
      const seenEpisodeIds = new Set<string>()
      const uniqueEpisodes: Episode[] = []
      for (const entry of entries) {
        if (!seenEpisodeIds.has(entry.episode.id)) {
          seenEpisodeIds.add(entry.episode.id)
          uniqueEpisodes.push(entry.episode)
        }
      }

      const sourceIds = uniqueEpisodes.map(e => e.id)
      const confidence = this.computeConfidence(
        uniqueEpisodes.length,
        uniqueDates.size,
        TASK_DATE_THRESHOLD
      )
      const suggestedTitle = this.generateTaskTitle(taskId)
      const evidence = [
        `任务单号「${taskId}」在 ${uniqueDates.size} 个不同日期出现`,
        `涉及 ${uniqueEpisodes.length} 个工作片段`,
        `日期：${[...uniqueDates].sort().join('、')}`
      ]

      candidates.push({
        id: randomUUID(),
        sourceType: 'task',
        sourceIds,
        suggestedTitle,
        suggestedType: 'issue',
        confidence,
        evidence
      })
    }

    return candidates
  }

  // ===================== 工具方法 =====================

  /** 聚合 Episodes 关联 Segments 的 OCR 文本 */
  private aggregateOcrText(episodes: Episode[]): string {
    const segmentIds: string[] = []
    for (const episode of episodes) {
      segmentIds.push(...episode.segmentIds)
    }
    if (segmentIds.length === 0) {
      // 降级：使用 episode title + summary
      return episodes.map(e => `${e.title}\n${e.oneLineSummary}`).join('\n')
    }
    const segments = SegmentRepository.getByIds(segmentIds)
    const ocrTexts = segments.map(s => s.ocrText).filter(t => t.length > 0)
    if (ocrTexts.length === 0) {
      return episodes.map(e => `${e.title}\n${e.oneLineSummary}`).join('\n')
    }
    return ocrTexts.join('\n')
  }

  /**
   * 计算置信度（0-1）。
   * 基础 0.4，每多一次出现 +0.1，跨日 +0.15，跨 3 日以上再 +0.1，上限 0.95。
   */
  private computeConfidence(occurrenceCount: number, dateSpan: number, threshold: number): number {
    let confidence = 0.4
    confidence += Math.min(0.3, (occurrenceCount - threshold) * 0.1)
    if (dateSpan >= 2) confidence += 0.15
    if (dateSpan >= 3) confidence += 0.1
    return Math.min(0.95, Math.round(confidence * 100) / 100)
  }

  /** 生成文档类候选标题 */
  private generateDocumentTitle(docName: string): string {
    // 去除文件扩展名
    const baseName = docName.replace(/\.[^.]+$/, '').trim()
    if (baseName.length === 0) return `${docName} 笔记`
    return `${baseName} 笔记`
  }

  /** 生成主题类候选标题：主题词 + 后缀 */
  private generateTopicTitle(topic: string): string {
    // 根据主题词特征选择后缀
    const suffix =
      TOPIC_TITLE_SUFFIXES[
        Math.abs(this.hashString(topic)) % TOPIC_TITLE_SUFFIXES.length
      ]
    return `${topic} ${suffix}`
  }

  /** 生成任务类候选标题 */
  private generateTaskTitle(taskId: string): string {
    return `${taskId} 跟踪`
  }

  /** 简单字符串哈希（用于确定性选择后缀） */
  private hashString(s: string): number {
    let hash = 0
    for (let i = 0; i < s.length; i++) {
      hash = (hash << 5) - hash + s.charCodeAt(i)
      hash |= 0
    }
    return hash
  }

  /** 候选去重：相同 sourceType + suggestedTitle 合并，取最高 confidence */
  private dedupeCandidates(candidates: IngestCandidate[]): IngestCandidate[] {
    const map = new Map<string, IngestCandidate>()
    for (const c of candidates) {
      const key = `${c.sourceType}::${c.suggestedTitle}`
      const existing = map.get(key)
      if (!existing || c.confidence > existing.confidence) {
        // 合并 sourceIds 和 evidence
        if (existing) {
          const mergedSourceIds = new Set([...existing.sourceIds, ...c.sourceIds])
          const mergedEvidence = [...existing.evidence]
          for (const ev of c.evidence) {
            if (!mergedEvidence.includes(ev)) mergedEvidence.push(ev)
          }
          map.set(key, {
            ...c,
            sourceIds: [...mergedSourceIds],
            evidence: mergedEvidence,
            confidence: Math.max(existing.confidence, c.confidence)
          })
        } else {
          map.set(key, c)
        }
      }
    }
    return [...map.values()]
  }
}
