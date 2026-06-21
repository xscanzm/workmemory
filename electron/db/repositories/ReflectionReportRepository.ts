/**
 * ReflectionReportRepository：周级反思报告数据访问层（Task R1）。
 *
 * reflection_reports 表存储 ReflectionEngine 产出的周级反思报告：
 *  - week_start：周一日期（YYYY-MM-DD）
 *  - report：反思报告（JSON 对象，ReflectionReport）
 *
 * 按 week_start 唯一约束，upsert 时主键冲突更新全部字段。
 * id 与 created_at 由仓库内部生成/管理，不暴露给调用方。
 *
 * ReflectionReport 类型由 ReflectionEngine 定义并导出，避免循环依赖。
 */
import { randomUUID } from 'node:crypto'
import type { ReflectionReport } from '../../ai/ReflectionEngine'
import { getDatabase } from '../database'
import { parseJsonField } from '../json'

interface ReflectionReportRow {
  id: string
  week_start: string
  report: string
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToReport(row: ReflectionReportRow): ReflectionReport {
  // 反序列化时以空报告兜底，避免脏数据导致解析失败
  const fallback: ReflectionReport = {
    weekStart: row.week_start,
    patterns: [],
    suggestions: [],
    trends: [],
    createdAt: row.created_at
  }
  const parsed = parseJsonField<ReflectionReport>(row.report, fallback)
  // 确保关键字段存在（旧数据兼容）
  return {
    weekStart: parsed.weekStart || row.week_start,
    patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    trends: Array.isArray(parsed.trends) ? parsed.trends : [],
    createdAt: parsed.createdAt || row.created_at
  }
}

export const ReflectionReportRepository = {
  /**
   * 插入或更新周级反思报告（按 week_start 唯一约束，主键冲突时更新全部字段）。
   * id 由仓库内部生成；createdAt 为空时由仓库内部生成；更新已有记录时刷新 created_at。
   * @param report 周级反思报告
   */
  upsert(report: ReflectionReport): void {
    const db = getDatabase()
    const id = randomUUID()
    const createdAt = report.createdAt || nowIso()
    db.prepare(
      `INSERT INTO reflection_reports (id, week_start, report, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         id = excluded.id,
         report = excluded.report,
         created_at = excluded.created_at`
    ).run(
      id,
      report.weekStart,
      JSON.stringify(report),
      createdAt
    )
  },

  /**
   * 按 week_start 查询周级反思报告。
   * @param weekStart 周一日期字符串（YYYY-MM-DD）
   * @returns 周级反思报告；不存在返回 null
   */
  getByWeekStart(weekStart: string): ReflectionReport | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM reflection_reports WHERE week_start = ?')
      .get(weekStart) as ReflectionReportRow | undefined
    return row ? rowToReport(row) : null
  }
}
