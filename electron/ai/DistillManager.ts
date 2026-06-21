/**
 * DistillManager：整点低频 AI 理解批处理。
 */
import { randomUUID } from 'node:crypto'
import type { CleanEpisode, EntityRef, EvidenceRef, MemoryKind, SourceQuality, WikiStatus } from '@/types'
import { getDatabase } from '../db/database'
import { SettingsStore } from '../db/SettingsStore'
import { CleanEpisodeRepository } from '../db/repositories/CleanEpisodeRepository'
import { OpenAIClient } from './OpenAIClient'
import { maskSensitive } from './SensitiveMasker'
import { HourContextPackBuilder } from './HourContextPackBuilder'
import { DISTILL_VERSION, buildDistillMessages } from './DistillPrompt'

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

interface RawDistillEvent {
  title?: unknown
  summary?: unknown
  startTime?: unknown
  endTime?: unknown
  memoryKind?: unknown
  project?: unknown
  entities?: unknown
  topics?: unknown
  materials?: unknown
  outputs?: unknown
  todos?: unknown
  blockers?: unknown
  segmentIds?: unknown
  evidenceRefs?: unknown
  sourceQuality?: unknown
  confidence?: unknown
  reportEligible?: unknown
  wikiEligible?: unknown
  wikiStatus?: unknown
}

interface RawDistillResponse {
  events?: unknown
}

export interface DistillResult {
  created: number
  skipped: boolean
  message: string
}

const VALID_MEMORY_KINDS = new Set<MemoryKind>([
  'work',
  'research',
  'communication',
  'coding',
  'planning',
  'review',
  'admin',
  'idle_uncertain'
])
const VALID_SOURCE_QUALITY = new Set<SourceQuality>(['high', 'medium', 'low', 'failed', 'private'])
const VALID_WIKI_STATUS = new Set<WikiStatus>(['none', 'candidate', 'auto_upserted', 'needs_review', 'rejected'])

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

function parseJsonFromModel(content: string): RawDistillResponse {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced ? fenced[1].trim() : trimmed
  return JSON.parse(jsonText) as RawDistillResponse
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : 0.5
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100))
}

function normalizeEntities(value: unknown): EntityRef[] {
  if (!Array.isArray(value)) return []
  const result: EntityRef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const type = obj.type
    const name = obj.name
    if (
      (type === 'person' || type === 'project' || type === 'document' || type === 'url') &&
      typeof name === 'string' &&
      name.trim().length > 0
    ) {
      result.push({
        type,
        name: name.trim(),
        value: typeof obj.value === 'string' ? obj.value : undefined,
        confidence: clampConfidence(obj.confidence)
      })
    }
  }
  return result
}

function normalizeEvidence(value: unknown, allowedSegmentIds: Set<string>): EvidenceRef[] {
  if (!Array.isArray(value)) return []
  const result: EvidenceRef[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    if (typeof obj.segmentId !== 'string' || !allowedSegmentIds.has(obj.segmentId)) continue
    result.push({
      segmentId: obj.segmentId,
      quote: typeof obj.quote === 'string' ? obj.quote.slice(0, 300) : '',
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 160) : ''
    })
  }
  return result
}

function normalizeEvent(
  raw: RawDistillEvent,
  date: string,
  hourBucket: string,
  allowedSegmentIds: Set<string>,
  modelName: string
): CleanEpisode | null {
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (!title || !summary) return null

  const segmentIds = stringArray(raw.segmentIds).filter((id) => allowedSegmentIds.has(id))
  if (segmentIds.length === 0) return null

  const memoryKind = VALID_MEMORY_KINDS.has(raw.memoryKind as MemoryKind)
    ? raw.memoryKind as MemoryKind
    : 'work'
  const sourceQuality = VALID_SOURCE_QUALITY.has(raw.sourceQuality as SourceQuality)
    ? raw.sourceQuality as SourceQuality
    : 'medium'
  const wikiStatus = VALID_WIKI_STATUS.has(raw.wikiStatus as WikiStatus)
    ? raw.wikiStatus as WikiStatus
    : raw.wikiEligible === true
      ? 'candidate'
      : 'none'

  const ts = nowIso()
  return {
    id: randomUUID(),
    date,
    hourBucket,
    startTime: typeof raw.startTime === 'string' ? raw.startTime : `${hourBucket.slice(0, 2)}:00:00`,
    endTime: typeof raw.endTime === 'string' ? raw.endTime : `${hourBucket.slice(0, 2)}:59:59`,
    title,
    summary,
    memoryKind,
    project: typeof raw.project === 'string' ? raw.project.trim() : '',
    entities: normalizeEntities(raw.entities),
    topics: stringArray(raw.topics).slice(0, 12),
    materials: stringArray(raw.materials).slice(0, 12),
    outputs: stringArray(raw.outputs).slice(0, 12),
    todos: stringArray(raw.todos).slice(0, 12),
    blockers: stringArray(raw.blockers).slice(0, 8),
    segmentIds,
    evidenceRefs: normalizeEvidence(raw.evidenceRefs, allowedSegmentIds),
    sourceQuality,
    confidence: clampConfidence(raw.confidence),
    reportEligible: raw.reportEligible !== false,
    wikiEligible: raw.wikiEligible === true,
    wikiStatus,
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
      const result = await OpenAIClient.chatCompletion({
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: masked.text }
        ],
        temperature: 0.2,
        maxTokens: 4096
      })

      const parsed = parseJsonFromModel(result.content)
      if (!Array.isArray(parsed.events)) {
        throw new Error('AI JSON 缺少 events 数组')
      }
      const allowedSegmentIds = new Set(pack.segmentIds)
      const cleanEpisodes = parsed.events
        .map((event) => normalizeEvent(event as RawDistillEvent, date, hourBucket, allowedSegmentIds, apiConfig.model))
        .filter((event): event is CleanEpisode => event !== null)
      if (cleanEpisodes.length === 0) {
        throw new Error('AI JSON 未产生可写入的工作记忆事件')
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
