/**
 * SegmentRepository：原始工作片段数据访问层
 * 全部使用参数化查询防注入；数组字段（tags）入库 JSON.stringify，出库 JSON.parse。
 */
import { randomUUID } from 'node:crypto'
import type { BoundsRect, CaptureSource, OcrBlock, SourceQuality, WorkSegment, SourceStatus } from '@/types'
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

interface SegmentRow {
  id: string
  date: string
  start_time: string
  end_time: string
  duration_seconds: number
  app_name: string
  process_name: string
  window_title: string
  ocr_text: string
  ocr_summary: string
  image_hash: string
  screenshot_path: string
  is_selected_for_report: number
  is_private: number
  is_important: number
  is_deleted: number
  source_status: string
  user_title: string
  user_summary: string
  user_note: string
  tags: string
  ocr_blocks?: string
  ocr_confidence?: number
  capture_source?: string
  source_quality?: string
  active_window_bounds?: string
  display_bounds?: string
}

function parseJsonObject<T>(value: string | undefined): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function rowToSegment(row: SegmentRow): WorkSegment {
  return {
    id: row.id,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    appName: row.app_name,
    processName: row.process_name,
    windowTitle: row.window_title,
    ocrText: row.ocr_text,
    ocrSummary: row.ocr_summary,
    imageHash: row.image_hash,
    screenshotPath: row.screenshot_path,
    isSelectedForReport: row.is_selected_for_report === 1,
    isPrivate: row.is_private === 1,
    isImportant: row.is_important === 1,
    isDeleted: row.is_deleted === 1,
    sourceStatus: row.source_status as SourceStatus,
    userTitle: row.user_title,
    userSummary: row.user_summary,
    userNote: row.user_note,
    tags: parseJsonArray<string>(row.tags),
    ocrBlocks: parseJsonArray<OcrBlock>(row.ocr_blocks ?? '[]'),
    ocrConfidence: row.ocr_confidence ?? 0,
    captureSource: (row.capture_source ?? 'unknown') as CaptureSource,
    sourceQuality: (row.source_quality ?? 'low') as SourceQuality,
    activeWindowBounds: parseJsonObject<BoundsRect>(row.active_window_bounds),
    displayBounds: parseJsonObject<BoundsRect>(row.display_bounds)
  }
}

interface SegmentInsertParams {
  id: string
  date: string
  start_time: string
  end_time: string
  duration_seconds: number
  app_name: string
  process_name: string
  window_title: string
  ocr_text: string
  ocr_summary: string
  image_hash: string
  screenshot_path: string
  is_selected_for_report: number
  is_private: number
  is_important: number
  is_deleted: number
  source_status: string
  user_title: string
  user_summary: string
  user_note: string
  tags: string
  ocr_blocks: string
  ocr_confidence: number
  capture_source: string
  source_quality: string
  active_window_bounds: string
  display_bounds: string
  created_at: string
  updated_at: string
}

function stringifyOptionalObject(value: unknown): string {
  if (!value) return ''
  return JSON.stringify(value)
}

function segmentToParams(segment: WorkSegment): SegmentInsertParams {
  const now = new Date().toISOString()
  return {
    id: segment.id,
    date: segment.date,
    start_time: segment.startTime,
    end_time: segment.endTime,
    duration_seconds: segment.durationSeconds,
    app_name: segment.appName,
    process_name: segment.processName,
    window_title: segment.windowTitle,
    ocr_text: segment.ocrText,
    ocr_summary: segment.ocrSummary,
    image_hash: segment.imageHash,
    screenshot_path: segment.screenshotPath,
    is_selected_for_report: segment.isSelectedForReport ? 1 : 0,
    is_private: segment.isPrivate ? 1 : 0,
    is_important: segment.isImportant ? 1 : 0,
    is_deleted: segment.isDeleted ? 1 : 0,
    source_status: segment.sourceStatus,
    user_title: segment.userTitle,
    user_summary: segment.userSummary,
    user_note: segment.userNote,
    tags: stringifyJsonArray(segment.tags),
    ocr_blocks: stringifyJsonArray(segment.ocrBlocks ?? []),
    ocr_confidence: segment.ocrConfidence ?? 0,
    capture_source: segment.captureSource ?? 'unknown',
    source_quality: segment.sourceQuality ?? (
      segment.isPrivate ? 'private' : segment.sourceStatus === 'ocr_done' ? 'medium' : 'low'
    ),
    active_window_bounds: stringifyOptionalObject(segment.activeWindowBounds),
    display_bounds: stringifyOptionalObject(segment.displayBounds),
    created_at: now,
    updated_at: now
  }
}

export const SegmentRepository = {
  insert(segment: WorkSegment): WorkSegment {
    const db = getDatabase()
    const id = segment.id || randomUUID()
    const params = segmentToParams({ ...segment, id })
    db.prepare(
      `INSERT INTO segments (
        id, date, start_time, end_time, duration_seconds, app_name, process_name,
        window_title, ocr_text, ocr_summary, image_hash, screenshot_path,
        is_selected_for_report, is_private, is_important, is_deleted, source_status,
        user_title, user_summary, user_note, tags, ocr_blocks, ocr_confidence,
        capture_source, source_quality, active_window_bounds, display_bounds,
        created_at, updated_at
      ) VALUES (
        @id, @date, @start_time, @end_time, @duration_seconds, @app_name, @process_name,
        @window_title, @ocr_text, @ocr_summary, @image_hash, @screenshot_path,
        @is_selected_for_report, @is_private, @is_important, @is_deleted, @source_status,
        @user_title, @user_summary, @user_note, @tags, @ocr_blocks, @ocr_confidence,
        @capture_source, @source_quality, @active_window_bounds, @display_bounds,
        @created_at, @updated_at
      )`
    ).run(params)
    const created = this.getById(id)
    if (!created) throw new Error(`Segment insert failed for id=${id}`)
    return created
  },

  update(id: string, patch: Partial<WorkSegment>): WorkSegment | null {
    const existing = this.getById(id)
    if (!existing) return null
    const merged: WorkSegment = { ...existing, ...patch, id }
    const params = segmentToParams(merged)
    db_update(params)
    return this.getById(id)
  },

  getById(id: string): WorkSegment | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM segments WHERE id = ?').get(id) as SegmentRow | undefined
    return row ? rowToSegment(row) : null
  },

  getByDate(date: string): WorkSegment[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM segments WHERE date = ? ORDER BY start_time ASC')
      .all(date) as SegmentRow[]
    return rows.map(rowToSegment)
  },

  /** 按日期范围 [startDate, endDate] 查询 Segments（含两端，仅未删除） */
  getByDateRange(startDate: string, endDate: string): WorkSegment[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM segments WHERE date >= ? AND date <= ? AND is_deleted = 0 ORDER BY date ASC, start_time ASC`
      )
      .all(startDate, endDate) as SegmentRow[]
    return rows.map(rowToSegment)
  },

  /** 批量按 id 查询 Segments（仅未删除） */
  getByIds(ids: string[]): WorkSegment[] {
    if (ids.length === 0) return []
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT * FROM segments WHERE id IN (${placeholders}) AND is_deleted = 0 ORDER BY start_time ASC`
      )
      .all(...ids) as SegmentRow[]
    return rows.map(rowToSegment)
  },

  getActiveByDate(date: string): WorkSegment[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM segments WHERE date = ? AND is_deleted = 0 ORDER BY start_time ASC')
      .all(date) as SegmentRow[]
    return rows.map(rowToSegment)
  },

  setSelectedForReport(id: string, selected: boolean): boolean {
    const db = getDatabase()
    const result = db
      .prepare('UPDATE segments SET is_selected_for_report = ? WHERE id = ?')
      .run(selected ? 1 : 0, id)
    return result.changes > 0
  },

  setImportant(id: string, important: boolean): boolean {
    const db = getDatabase()
    const result = db
      .prepare('UPDATE segments SET is_important = ? WHERE id = ?')
      .run(important ? 1 : 0, id)
    return result.changes > 0
  },

  softDelete(id: string): boolean {
    const db = getDatabase()
    const result = db.prepare('UPDATE segments SET is_deleted = 1 WHERE id = ?').run(id)
    return result.changes > 0
  },

  hardDelete(id: string): boolean {
    const db = getDatabase()
    const result = db.prepare('DELETE FROM segments WHERE id = ?').run(id)
    return result.changes > 0
  },

  getPrivateByDate(date: string): WorkSegment[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM segments WHERE date = ? AND is_private = 1 AND is_deleted = 0 ORDER BY start_time ASC'
      )
      .all(date) as SegmentRow[]
    return rows.map(rowToSegment)
  }
}

function db_update(params: SegmentInsertParams): void {
  const db = getDatabase()
  db.prepare(
    `UPDATE segments SET
      date = @date, start_time = @start_time, end_time = @end_time,
      duration_seconds = @duration_seconds, app_name = @app_name,
      process_name = @process_name, window_title = @window_title,
      ocr_text = @ocr_text, ocr_summary = @ocr_summary, image_hash = @image_hash,
      screenshot_path = @screenshot_path, is_selected_for_report = @is_selected_for_report,
      is_private = @is_private, is_important = @is_important, is_deleted = @is_deleted,
      source_status = @source_status, user_title = @user_title, user_summary = @user_summary,
      user_note = @user_note, tags = @tags, ocr_blocks = @ocr_blocks,
      ocr_confidence = @ocr_confidence, capture_source = @capture_source,
      source_quality = @source_quality, active_window_bounds = @active_window_bounds,
      display_bounds = @display_bounds, updated_at = @updated_at
    WHERE id = @id`
  ).run(params)
}
