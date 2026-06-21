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
  ai_input_snapshot?: string
  prompt_snapshot?: string
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
    aiInputSnapshot: row.ai_input_snapshot ?? row.prompt_snapshot ?? '',
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
  prompt_snapshot: string
  markdown_content: string
  status: string
  report_type: string
}

type ReportColumn =
  | 'id'
  | 'date'
  | 'template_id'
  | 'template_name'
  | 'segment_ids'
  | 'ai_input_snapshot'
  | 'prompt_snapshot'
  | 'markdown_content'
  | 'status'
  | 'report_type'

const BASE_REPORT_COLUMNS: ReportColumn[] = [
  'id',
  'date',
  'template_id',
  'template_name',
  'segment_ids',
  'markdown_content',
  'status',
  'report_type'
]

function getReportColumns(): Set<string> {
  const db = getDatabase()
  const rows = db.prepare('PRAGMA table_info(reports)').all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function getSnapshotColumns(columns: Set<string>): ReportColumn[] {
  const result: ReportColumn[] = []
  if (columns.has('ai_input_snapshot')) result.push('ai_input_snapshot')
  if (columns.has('prompt_snapshot')) result.push('prompt_snapshot')
  return result
}

function reportToParams(report: Report): ReportParams {
  return {
    id: report.id,
    date: report.date,
    template_id: report.templateId,
    template_name: report.templateName,
    segment_ids: stringifyJsonArray(report.segmentIds),
    ai_input_snapshot: report.aiInputSnapshot,
    prompt_snapshot: report.aiInputSnapshot,
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
    const existingColumns = getReportColumns()
    const snapshotColumns = getSnapshotColumns(existingColumns)
    const insertColumns = [
      ...BASE_REPORT_COLUMNS.slice(0, 5),
      ...snapshotColumns,
      ...BASE_REPORT_COLUMNS.slice(5)
    ].filter((column) => existingColumns.has(column))

    if (snapshotColumns.length === 0) {
      throw new Error('reports 表缺少 ai_input_snapshot/prompt_snapshot 字段，无法保存日报输入快照')
    }

    db.prepare(
      `INSERT INTO reports (${insertColumns.join(', ')})
       VALUES (${insertColumns.map((column) => `@${column}`).join(', ')})`
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
    const existingColumns = getReportColumns()
    const snapshotColumns = getSnapshotColumns(existingColumns)
    const updateColumns = [
      'date',
      'template_id',
      'template_name',
      'segment_ids',
      ...snapshotColumns,
      'markdown_content',
      'status',
      'report_type'
    ].filter((column) => existingColumns.has(column))

    if (snapshotColumns.length === 0) {
      throw new Error('reports 表缺少 ai_input_snapshot/prompt_snapshot 字段，无法更新日报输入快照')
    }

    db.prepare(
      `UPDATE reports SET ${updateColumns.map((column) => `${column} = @${column}`).join(', ')}
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
