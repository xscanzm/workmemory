/**
 * ReportRepository：日报/周报数据访问层
 */
import { randomUUID } from 'node:crypto'
import type { Report, ReportStatus, ReportTemplate, ReportType } from '@/types'
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

interface ReportRow {
  id: string
  date: string
  template_id: string
  template_name: string
  segment_ids: string
  ai_input_snapshot: string
  markdown_content: string
  status: string
  report_type: string
}

function rowToReport(row: ReportRow): Report {
  return {
    id: row.id,
    date: row.date,
    templateId: row.template_id as ReportTemplate,
    templateName: row.template_name,
    segmentIds: parseJsonArray<string>(row.segment_ids),
    aiInputSnapshot: row.ai_input_snapshot,
    markdownContent: row.markdown_content,
    status: row.status as ReportStatus,
    reportType: (row.report_type ?? 'daily') as ReportType
  }
}

interface ReportParams {
  id: string
  date: string
  template_id: string
  template_name: string
  segment_ids: string
  ai_input_snapshot: string
  markdown_content: string
  status: string
  report_type: string
}

function reportToParams(report: Report): ReportParams {
  return {
    id: report.id,
    date: report.date,
    template_id: report.templateId,
    template_name: report.templateName,
    segment_ids: stringifyJsonArray(report.segmentIds),
    ai_input_snapshot: report.aiInputSnapshot,
    markdown_content: report.markdownContent,
    status: report.status,
    report_type: report.reportType ?? 'daily'
  }
}

export const ReportRepository = {
  insert(report: Report): Report {
    const db = getDatabase()
    const id = report.id || randomUUID()
    const params = reportToParams({ ...report, id })
    db.prepare(
      `INSERT INTO reports (
        id, date, template_id, template_name, segment_ids,
        ai_input_snapshot, markdown_content, status, report_type
      ) VALUES (
        @id, @date, @template_id, @template_name, @segment_ids,
        @ai_input_snapshot, @markdown_content, @status, @report_type
      )`
    ).run(params)
    const created = this.getById(id)
    if (!created) throw new Error(`Report insert failed for id=${id}`)
    return created
  },

  update(id: string, patch: Partial<Report>): Report | null {
    const existing = this.getById(id)
    if (!existing) return null
    const merged: Report = { ...existing, ...patch, id }
    const params = reportToParams(merged)
    const db = getDatabase()
    db.prepare(
      `UPDATE reports SET
        date = @date, template_id = @template_id, template_name = @template_name,
        segment_ids = @segment_ids, ai_input_snapshot = @ai_input_snapshot,
        markdown_content = @markdown_content, status = @status, report_type = @report_type
      WHERE id = @id`
    ).run(params)
    return this.getById(id)
  },

  getById(id: string): Report | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow | undefined
    return row ? rowToReport(row) : null
  },

  getByDate(date: string): Report[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM reports WHERE date = ? ORDER BY rowid DESC')
      .all(date) as ReportRow[]
    return rows.map(rowToReport)
  },

  getAllHistory(): Report[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM reports ORDER BY date DESC, rowid DESC')
      .all() as ReportRow[]
    return rows.map(rowToReport)
  },

  setStatus(id: string, status: ReportStatus): boolean {
    const db = getDatabase()
    const result = db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, id)
    return result.changes > 0
  }
}
