/**
 * DailyDistillRepository：日级理解数据访问层。
 *
 * daily_distills 表存储 DailyDistillManager 产出的日级理解结果：
 *  - summary：日级摘要（2-3 句）
 *  - themes：跨小时主题（JSON 数组，DayTheme[]）
 *  - patterns：当日模式（JSON 对象，DayPattern）
 *  - memcell_ids：涉及的 MemCell ID 列表（JSON 数组）
 *
 * 按 date 唯一约束，upsert 时主键冲突更新全部字段。
 * id 与 created_at 由仓库内部生成/管理，不暴露给调用方。
 */
import { randomUUID } from 'node:crypto'
import type { DayDistillResult } from '../../ai/DailyDistillManager'
import { getDatabase } from '../database'
import { parseJsonArray, parseJsonField, stringifyJsonArray } from '../json'

interface DailyDistillRow {
  id: string
  date: string
  summary: string
  themes: string
  patterns: string
  memcell_ids: string
  created_at: string
}

/** 空模式默认值，用于反序列化兜底 */
const DEFAULT_PATTERNS = {
  deepWorkHours: 0,
  fragmentedPeriods: [] as { start: string; end: string }[],
  switchCount: 0,
  activeHours: 0,
  dominantActivity: ''
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToResult(row: DailyDistillRow): DayDistillResult {
  return {
    date: row.date,
    summary: row.summary,
    themes: parseJsonArray<DayDistillResult['themes'][number]>(row.themes),
    patterns: parseJsonField(row.patterns, DEFAULT_PATTERNS) as DayDistillResult['patterns'],
    memcellIds: parseJsonArray<string>(row.memcell_ids)
  }
}

export const DailyDistillRepository = {
  /**
   * 插入或更新日级理解结果（按 date 唯一约束，主键冲突时更新全部字段）。
   * id 与 created_at 由仓库内部生成；更新已有记录时刷新 created_at。
   * @param result 日级理解结果
   */
  upsert(result: DayDistillResult): void {
    const db = getDatabase()
    const id = randomUUID()
    const createdAt = nowIso()
    db.prepare(
      `INSERT INTO daily_distills (id, date, summary, themes, patterns, memcell_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         id = excluded.id,
         summary = excluded.summary,
         themes = excluded.themes,
         patterns = excluded.patterns,
         memcell_ids = excluded.memcell_ids,
         created_at = excluded.created_at`
    ).run(
      id,
      result.date,
      result.summary,
      stringifyJsonArray(result.themes),
      JSON.stringify(result.patterns),
      stringifyJsonArray(result.memcellIds),
      createdAt
    )
  },

  /**
   * 按日期查询日级理解结果。
   * @param date 日期字符串（YYYY-MM-DD）
   * @returns 日级理解结果；不存在返回 null
   */
  getByDate(date: string): DayDistillResult | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM daily_distills WHERE date = ?')
      .get(date) as DailyDistillRow | undefined
    return row ? rowToResult(row) : null
  },

  /**
   * 按日期范围查询日级理解结果（含两端，按 date 升序）。
   * @param startDate 起始日期（YYYY-MM-DD，含）
   * @param endDate 结束日期（YYYY-MM-DD，含）
   * @returns 日级理解结果数组（按 date 升序）
   */
  getByDateRange(startDate: string, endDate: string): DayDistillResult[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM daily_distills WHERE date >= ? AND date <= ? ORDER BY date ASC`
      )
      .all(startDate, endDate) as DailyDistillRow[]
    return rows.map(rowToResult)
  }
}
