/**
 * DistillManager：整点低频 AI 理解批处理。
 */
import { randomUUID } from 'node:crypto'
import type { CleanEpisode, EntityRef, EvidenceRef, WorkSegment } from '@/types'
import { getDatabase } from '../db/database'
import { SettingsStore } from '../db/SettingsStore'
import { CleanEpisodeRepository } from '../db/repositories/CleanEpisodeRepository'
import { MemCellRepository } from '../db/repositories/MemCellRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import type { MemCell } from '../memory/MemCell'
import { MEMCELL_CREATED_EVENT, memCellEventBus } from '../events/bus'
import { OpenAIClient } from './OpenAIClient'
import { maskSensitive } from './SensitiveMasker'
import { HourContextPackBuilder } from './HourContextPackBuilder'
import { DISTILL_VERSION, buildDistillMessages } from './DistillPrompt'
import { parseDistillResponse, type DistillEvent } from './schemas/DistillEventSchema'

interface DistillRunRow {
  id: string
  date: string
  hour_bucket: string
  status: string
  segment_ids: string
  error_message: string
  model_name: string
  input_snapshot: string
  created_at: string
  updated_at: string
}

export interface DistillResult {
  created: number
  skipped: boolean
  message: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function jsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100))
}

function normalizeEntities(value: DistillEvent['entities']): EntityRef[] {
  const result: EntityRef[] = []
  for (const item of value) {
    const name = item.name.trim()
    if (name.length === 0) continue
    result.push({
      type: item.type,
      name,
      value: item.value,
      confidence: clampConfidence(item.confidence)
    })
  }
  return result
}

function normalizeEvidence(
  value: DistillEvent['evidenceRefs'],
  allowedSegmentIds: Set<string>
): EvidenceRef[] {
  const result: EvidenceRef[] = []
  for (const item of value) {
    if (!allowedSegmentIds.has(item.segmentId)) continue
    result.push({
      segmentId: item.segmentId,
      quote: item.quote.slice(0, 300),
      reason: item.reason.slice(0, 160)
    })
  }
  return result
}

function normalizeEvent(
  raw: DistillEvent,
  date: string,
  hourBucket: string,
  allowedSegmentIds: Set<string>,
  modelName: string
): CleanEpisode | null {
  const title = raw.title.trim()
  const summary = raw.summary.trim()
  if (!title || !summary) return null

  const segmentIds = raw.segmentIds.filter((id) => allowedSegmentIds.has(id))
  if (segmentIds.length === 0) return null

  const ts = nowIso()
  return {
    id: randomUUID(),
    date,
    hourBucket,
    startTime: raw.startTime,
    endTime: raw.endTime,
    title,
    summary,
    memoryKind: raw.memoryKind,
    project: raw.project.trim(),
    entities: normalizeEntities(raw.entities),
    topics: raw.topics.slice(0, 12),
    materials: raw.materials.slice(0, 12),
    outputs: raw.outputs.slice(0, 12),
    todos: raw.todos.slice(0, 12),
    blockers: raw.blockers.slice(0, 8),
    segmentIds,
    evidenceRefs: normalizeEvidence(raw.evidenceRefs, allowedSegmentIds),
    sourceQuality: raw.sourceQuality,
    confidence: clampConfidence(raw.confidence),
    reportEligible: raw.reportEligible,
    wikiEligible: raw.wikiEligible,
    wikiStatus: raw.wikiStatus,
    createdAt: ts,
    updatedAt: ts,
    modelName,
    distillVersion: DISTILL_VERSION
  }
}

/** 多数投票计算主导 activityType（忽略 undefined/idle） */
function dominantActivityType(segments: WorkSegment[]): string | undefined {
  const counts = new Map<string, number>()
  for (const s of segments) {
    if (s.activityType && s.activityType !== 'idle') {
      counts.set(s.activityType, (counts.get(s.activityType) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return undefined
  let best: string | undefined
  let bestCount = 0
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type
      bestCount = count
    }
  }
  return best
}

/** 多数投票计算主导 contentType（忽略 undefined/other） */
function dominantContentType(segments: WorkSegment[]): string | undefined {
  const counts = new Map<string, number>()
  for (const s of segments) {
    if (s.contentType && s.contentType !== 'other') {
      counts.set(s.contentType, (counts.get(s.contentType) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return undefined
  let best: string | undefined
  let bestCount = 0
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type
      bestCount = count
    }
  }
  return best
}

/** 从 AI 输出事件 + CleanEpisode 构造 MemCell */
function buildMemCell(event: DistillEvent, cleanEpisode: CleanEpisode): MemCell {
  const segments = SegmentRepository.getByIds(cleanEpisode.segmentIds)
  const activityType = dominantActivityType(segments)
  const contentType = dominantContentType(segments)

  const episode = (event.episode ?? '').trim() || cleanEpisode.summary
  const facts = (event.facts ?? [])
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
  const foresight = (event.foresight ?? [])
    .map((f) => ({
      statement: f.statement.trim(),
      validFrom: f.validFrom,
      validTo: f.validTo,
      confidence: clampConfidence(f.confidence)
    }))
    .filter((f) => f.statement.length > 0)

  const ts = nowIso()
  return {
    id: randomUUID(),
    cleanEpisodeId: cleanEpisode.id,
    episode,
    facts,
    foresight,
    metadata: {
      segmentIds: cleanEpisode.segmentIds,
      timestamp: ts,
      confidence: cleanEpisode.confidence,
      activityType,
      contentType
    },
    createdAt: ts
  }
}

function getApiConfig(): { baseUrl: string; apiKey: string; model: string } {
  const settings = SettingsStore.get()
  return {
    baseUrl: settings.apiBaseUrl || 'https://api.openai.com/v1',
    apiKey: SettingsStore.getApiKey(),
    model: settings.modelName || 'gpt-4o-mini'
  }
}

function getRun(date: string, hourBucket: string): DistillRunRow | null {
  const db = getDatabase()
  const row = db
    .prepare('SELECT * FROM distill_runs WHERE date = ? AND hour_bucket = ?')
    .get(date, hourBucket) as DistillRunRow | undefined
  return row ?? null
}

function upsertRun(
  date: string,
  hourBucket: string,
  patch: {
    status: string
    segmentIds?: string[]
    errorMessage?: string
    modelName?: string
    inputSnapshot?: string
  }
): void {
  const db = getDatabase()
  const existing = getRun(date, hourBucket)
  const ts = nowIso()
  if (!existing) {
    db.prepare(
      `INSERT INTO distill_runs (
        id, date, hour_bucket, status, segment_ids, error_message,
        model_name, input_snapshot, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      date,
      hourBucket,
      patch.status,
      JSON.stringify(patch.segmentIds ?? []),
      patch.errorMessage ?? '',
      patch.modelName ?? '',
      patch.inputSnapshot ?? '',
      ts,
      ts
    )
    return
  }
  db.prepare(
    `UPDATE distill_runs SET
      status = ?, segment_ids = ?, error_message = ?, model_name = ?,
      input_snapshot = ?, updated_at = ?
     WHERE date = ? AND hour_bucket = ?`
  ).run(
    patch.status,
    JSON.stringify(patch.segmentIds ?? jsonArray(existing.segment_ids)),
    patch.errorMessage ?? existing.error_message,
    patch.modelName ?? existing.model_name,
    patch.inputSnapshot ?? existing.input_snapshot,
    ts,
    date,
    hourBucket
  )
}

function previousHour(now = new Date()): { date: string; hourBucket: string } {
  const d = new Date(now.getTime() - 60 * 60 * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  return { date: `${y}-${m}-${day}`, hourBucket: `${h}:00` }
}

export class DistillManager {
  private builder = new HourContextPackBuilder()
  private timer: NodeJS.Timeout | null = null
  private initialized = false

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.timer = setInterval(() => {
      this.runDueDistill().catch((e) => {
        console.error('[DistillManager] 定时理解失败:', e instanceof Error ? e.message : String(e))
      })
    }, 10 * 60 * 1000)
    void this.runDueDistill()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.initialized = false
  }

  async runDueDistill(): Promise<DistillResult> {
    const settings = SettingsStore.get()
    if (!settings.aiAutoDistillEnabled || !settings.aiAutoDistillFirstConsentAt) {
      return { created: 0, skipped: true, message: '小时级理解未授权启用' }
    }
    const { date, hourBucket } = previousHour()
    return this.distillHour(date, hourBucket)
  }

  async distillHour(date: string, hourBucket: string): Promise<DistillResult> {
    const existing = getRun(date, hourBucket)
    if (existing?.status === 'success') {
      return { created: 0, skipped: true, message: '该小时已完成理解' }
    }

    const pack = this.builder.build(date, hourBucket)
    if (pack.segmentIds.length === 0) {
      upsertRun(date, hourBucket, {
        status: 'skipped',
        segmentIds: [],
        errorMessage: '无非隐私片段'
      })
      return { created: 0, skipped: true, message: '无非隐私片段可理解' }
    }

    const apiConfig = getApiConfig()
    if (!apiConfig.apiKey) {
      upsertRun(date, hourBucket, {
        status: 'failed',
        segmentIds: pack.segmentIds,
        errorMessage: '未配置 AI API Key',
        modelName: apiConfig.model
      })
      return { created: 0, skipped: true, message: '未配置 AI API Key' }
    }

    const { systemPrompt, userPrompt } = buildDistillMessages(pack)
    const masked = maskSensitive(userPrompt)
    upsertRun(date, hourBucket, {
      status: 'running',
      segmentIds: pack.segmentIds,
      modelName: apiConfig.model,
      inputSnapshot: JSON.stringify({ pack, maskedCount: masked.maskedCount }, null, 2),
      errorMessage: ''
    })

    try {
      const baseParams = {
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
        temperature: 0.2,
        maxTokens: 4096,
        responseFormat: { type: 'json_object' as const }
      }

      const result = await OpenAIClient.chatCompletion({
        ...baseParams,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: masked.text }
        ]
      })

      let { events, skipped } = parseDistillResponse(result.content)

      if (events.length === 0 && skipped > 0) {
        const retryText =
          masked.text +
          '\n\n上次返回无法解析（' +
          skipped +
          ' 条被跳过），请严格输出 JSON 对象，第一个字符必须是 {'
        const retryResult = await OpenAIClient.chatCompletion({
          ...baseParams,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: retryText }
          ]
        })
        const retryParsed = parseDistillResponse(retryResult.content)
        events = retryParsed.events
        skipped = retryParsed.skipped
      }

      const allowedSegmentIds = new Set(pack.segmentIds)
      const pairs = events
        .map((event) => ({
          event,
          cleanEpisode: normalizeEvent(event, date, hourBucket, allowedSegmentIds, apiConfig.model)
        }))
        .filter(
          (pair): pair is { event: DistillEvent; cleanEpisode: CleanEpisode } =>
            pair.cleanEpisode !== null
        )
      if (pairs.length === 0) {
        const errorMessage = `AI JSON 解析失败，跳过 ${skipped} 条`
        upsertRun(date, hourBucket, {
          status: 'failed',
          segmentIds: pack.segmentIds,
          modelName: apiConfig.model,
          errorMessage
        })
        return { created: 0, skipped: false, message: errorMessage }
      }

      // 清理旧 MemCell（避免外键约束阻止 CleanEpisode 删除）
      try {
        const db = getDatabase()
        db.prepare(
          `DELETE FROM memory_cells WHERE clean_episode_id IN (
            SELECT id FROM clean_episodes WHERE date = ? AND hour_bucket = ?
          )`
        ).run(date, hourBucket)
      } catch (e) {
        console.warn(
          '[DistillManager] 清理旧 MemCell 失败:',
          e instanceof Error ? e.message : String(e)
        )
      }

      CleanEpisodeRepository.deleteByHour(date, hourBucket)
      for (const { cleanEpisode } of pairs) {
        CleanEpisodeRepository.insert(cleanEpisode)
      }

      // 写入 MemCell（错误隔离：失败不阻塞 CleanEpisode 写入）
      for (const { event, cleanEpisode } of pairs) {
        try {
          const memCell = buildMemCell(event, cleanEpisode)
          MemCellRepository.insert(memCell)
          // 通知 MemCellIndexer 异步生成 embedding（事件发射同步、监听器内部异步处理，
          // 任何异常都被监听器自身捕获，不会影响主流程）
          memCellEventBus.emit(MEMCELL_CREATED_EVENT, memCell)
        } catch (e) {
          console.error(
            '[DistillManager] MemCell 写入失败:',
            e instanceof Error ? e.message : String(e)
          )
        }
      }

      SettingsStore.set({ aiDistillLastRunAt: nowIso() })
      upsertRun(date, hourBucket, {
        status: 'success',
        segmentIds: pack.segmentIds,
        modelName: apiConfig.model,
        errorMessage: ''
      })
      return { created: pairs.length, skipped: false, message: `已生成 ${pairs.length} 条工作记忆事件` }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      upsertRun(date, hourBucket, {
        status: 'failed',
        segmentIds: pack.segmentIds,
        modelName: apiConfig.model,
        errorMessage: message
      })
      return { created: 0, skipped: false, message }
    }
  }
}

let managerInstance: DistillManager | null = null

export function getDistillManager(): DistillManager {
  if (!managerInstance) {
    managerInstance = new DistillManager()
  }
  return managerInstance
}

export function resetDistillManager(): void {
  if (managerInstance) {
    managerInstance.stop()
    managerInstance = null
  }
}
