/**
 * CleanEpisodeRepository：工作记忆事件数据访问层。
 *
 * clean_episodes 是稳定理解层，不随启发式 episodes 重建而删除。
 */
import { randomUUID } from 'node:crypto'
import type {
  CleanEpisode,
  EntityRef,
  EvidenceRef,
  MemoryKind,
  SourceQuality,
  WikiStatus
} from '@/types'
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

interface CleanEpisodeRow {
  id: string
  date: string
  hour_bucket: string
  start_time: string
  end_time: string
  title: string
  summary: string
  memory_kind: string
  project: string
  entities: string
  topics: string
  materials: string
  outputs: string
  todos: string
  blockers: string
  segment_ids: string
  evidence_refs: string
  source_quality: string
  confidence: number
  report_eligible: number
  wiki_eligible: number
  wiki_status: string
  created_at: string
  updated_at: string
  model_name: string
  distill_version: string
}

interface CleanEpisodeParams {
  id: string
  date: string
  hour_bucket: string
  start_time: string
  end_time: string
  title: string
  summary: string
  memory_kind: string
  project: string
  entities: string
  topics: string
  materials: string
  outputs: string
  todos: string
  blockers: string
  segment_ids: string
  evidence_refs: string
  source_quality: string
  confidence: number
  report_eligible: number
  wiki_eligible: number
  wiki_status: string
  created_at: string
  updated_at: string
  model_name: string
  distill_version: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToCleanEpisode(row: CleanEpisodeRow): CleanEpisode {
  return {
    id: row.id,
    date: row.date,
    hourBucket: row.hour_bucket,
    startTime: row.start_time,
    endTime: row.end_time,
    title: row.title,
    summary: row.summary,
    memoryKind: row.memory_kind as MemoryKind,
    project: row.project,
    entities: parseJsonArray<EntityRef>(row.entities),
    topics: parseJsonArray<string>(row.topics),
    materials: parseJsonArray<string>(row.materials),
    outputs: parseJsonArray<string>(row.outputs),
    todos: parseJsonArray<string>(row.todos),
    blockers: parseJsonArray<string>(row.blockers),
    segmentIds: parseJsonArray<string>(row.segment_ids),
    evidenceRefs: parseJsonArray<EvidenceRef>(row.evidence_refs),
    sourceQuality: row.source_quality as SourceQuality,
    confidence: row.confidence,
    reportEligible: row.report_eligible === 1,
    wikiEligible: row.wiki_eligible === 1,
    wikiStatus: row.wiki_status as WikiStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modelName: row.model_name,
    distillVersion: row.distill_version
  }
}

function cleanEpisodeToParams(episode: CleanEpisode): CleanEpisodeParams {
  return {
    id: episode.id,
    date: episode.date,
    hour_bucket: episode.hourBucket,
    start_time: episode.startTime,
    end_time: episode.endTime,
    title: episode.title,
    summary: episode.summary,
    memory_kind: episode.memoryKind,
    project: episode.project,
    entities: stringifyJsonArray(episode.entities),
    topics: stringifyJsonArray(episode.topics),
    materials: stringifyJsonArray(episode.materials),
    outputs: stringifyJsonArray(episode.outputs),
    todos: stringifyJsonArray(episode.todos),
    blockers: stringifyJsonArray(episode.blockers),
    segment_ids: stringifyJsonArray(episode.segmentIds),
    evidence_refs: stringifyJsonArray(episode.evidenceRefs),
    source_quality: episode.sourceQuality,
    confidence: episode.confidence,
    report_eligible: episode.reportEligible ? 1 : 0,
    wiki_eligible: episode.wikiEligible ? 1 : 0,
    wiki_status: episode.wikiStatus,
    created_at: episode.createdAt,
    updated_at: episode.updatedAt,
    model_name: episode.modelName,
    distill_version: episode.distillVersion
  }
}

export const CleanEpisodeRepository = {
  insert(episode: CleanEpisode): CleanEpisode {
    const db = getDatabase()
    const id = episode.id || randomUUID()
    const ts = episode.createdAt || nowIso()
    const params = cleanEpisodeToParams({
      ...episode,
      id,
      createdAt: ts,
      updatedAt: episode.updatedAt || ts
    })
    db.prepare(
      `INSERT INTO clean_episodes (
        id, date, hour_bucket, start_time, end_time, title, summary,
        memory_kind, project, entities, topics, materials, outputs, todos,
        blockers, segment_ids, evidence_refs, source_quality, confidence,
        report_eligible, wiki_eligible, wiki_status, created_at, updated_at,
        model_name, distill_version
      ) VALUES (
        @id, @date, @hour_bucket, @start_time, @end_time, @title, @summary,
        @memory_kind, @project, @entities, @topics, @materials, @outputs, @todos,
        @blockers, @segment_ids, @evidence_refs, @source_quality, @confidence,
        @report_eligible, @wiki_eligible, @wiki_status, @created_at, @updated_at,
        @model_name, @distill_version
      )`
    ).run(params)
    const created = this.getById(id)
    if (!created) throw new Error(`CleanEpisode insert failed for id=${id}`)
    return created
  },

  update(id: string, patch: Partial<CleanEpisode>): CleanEpisode | null {
    const existing = this.getById(id)
    if (!existing) return null
    const merged: CleanEpisode = { ...existing, ...patch, id, updatedAt: nowIso() }
    const params = cleanEpisodeToParams(merged)
    const db = getDatabase()
    db.prepare(
      `UPDATE clean_episodes SET
        date = @date, hour_bucket = @hour_bucket, start_time = @start_time,
        end_time = @end_time, title = @title, summary = @summary,
        memory_kind = @memory_kind, project = @project, entities = @entities,
        topics = @topics, materials = @materials, outputs = @outputs,
        todos = @todos, blockers = @blockers, segment_ids = @segment_ids,
        evidence_refs = @evidence_refs, source_quality = @source_quality,
        confidence = @confidence, report_eligible = @report_eligible,
        wiki_eligible = @wiki_eligible, wiki_status = @wiki_status,
        updated_at = @updated_at, model_name = @model_name,
        distill_version = @distill_version
      WHERE id = @id`
    ).run(params)
    return this.getById(id)
  },

  getById(id: string): CleanEpisode | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM clean_episodes WHERE id = ?').get(id) as CleanEpisodeRow | undefined
    return row ? rowToCleanEpisode(row) : null
  },

  getByDate(date: string): CleanEpisode[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM clean_episodes WHERE date = ? ORDER BY start_time ASC')
      .all(date) as CleanEpisodeRow[]
    return rows.map(rowToCleanEpisode)
  },

  getByHour(date: string, hourBucket: string): CleanEpisode[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM clean_episodes WHERE date = ? AND hour_bucket = ? ORDER BY start_time ASC'
      )
      .all(date, hourBucket) as CleanEpisodeRow[]
    return rows.map(rowToCleanEpisode)
  },

  getByDateRange(startDate: string, endDate: string): CleanEpisode[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM clean_episodes
         WHERE date >= ? AND date <= ?
         ORDER BY date ASC, start_time ASC`
      )
      .all(startDate, endDate) as CleanEpisodeRow[]
    return rows.map(rowToCleanEpisode)
  },

  getByWikiStatus(status: WikiStatus): CleanEpisode[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM clean_episodes
         WHERE wiki_status = ?
         ORDER BY date DESC, start_time DESC`
      )
      .all(status) as CleanEpisodeRow[]
    return rows.map(rowToCleanEpisode)
  },

  getWikiCandidates(days: number): CleanEpisode[] {
    const end = new Date()
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
    const fmt = (d: Date): string => {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM clean_episodes
         WHERE date >= ? AND date <= ?
           AND wiki_eligible = 1
           AND wiki_status IN ('candidate', 'none')
         ORDER BY confidence DESC, date DESC, start_time DESC`
      )
      .all(fmt(start), fmt(end)) as CleanEpisodeRow[]
    return rows.map(rowToCleanEpisode)
  },

  deleteByHour(date: string, hourBucket: string): number {
    const db = getDatabase()
    const result = db
      .prepare('DELETE FROM clean_episodes WHERE date = ? AND hour_bucket = ?')
      .run(date, hourBucket)
    return result.changes
  }
}
