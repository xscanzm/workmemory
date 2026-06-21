/**
 * DistillManager：整点低频 AI 理解批处理。
 */
import { randomUUID } from 'node:crypto'
import type { CleanEpisode, EntityRef, EvidenceRef } from '@/types'
import { getDatabase } from '../db/database'
import { SettingsStore } from '../db/SettingsStore'
import { CleanEpisodeRepository } from '../db/repositories/CleanEpisodeRepository'
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
      const cleanEpisodes = events
        .map((event) => normalizeEvent(event, date, hourBucket, allowedSegmentIds, apiConfig.model))
        .filter((event): event is CleanEpisode => event !== null)
      if (cleanEpisodes.length === 0) {
        const errorMessage = `AI JSON 解析失败，跳过 ${skipped} 条`
        upsertRun(date, hourBucket, {
          status: 'failed',
          segmentIds: pack.segmentIds,
          modelName: apiConfig.model,
          errorMessage
        })
        return { created: 0, skipped: false, message: errorMessage }
      }

      CleanEpisodeRepository.deleteByHour(date, hourBucket)
      for (const event of cleanEpisodes) {
        CleanEpisodeRepository.insert(event)
      }
      SettingsStore.set({ aiDistillLastRunAt: nowIso() })
      upsertRun(date, hourBucket, {
        status: 'success',
        segmentIds: pack.segmentIds,
        modelName: apiConfig.model,
        errorMessage: ''
      })
      return { created: cleanEpisodes.length, skipped: false, message: `已生成 ${cleanEpisodes.length} 条工作记忆事件` }
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
