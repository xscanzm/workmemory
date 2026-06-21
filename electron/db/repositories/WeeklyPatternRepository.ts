/**
 * WeeklyPatternRepository：周级模式发现数据访问层（Task H2）。
 *
 * weekly_patterns 表存储 WeeklyPatternDetector 产出的周级模式：
 *  - week_start：周一日期（YYYY-MM-DD）
 *  - patterns：周级模式数组（JSON，WeeklyPattern[]）
 *  - trend：趋势数据（JSON，WeeklyPatternTrend）
 *
 * 按 week_start 唯一约束，upsert 时主键冲突更新全部字段。
 * id 与 created_at 由仓库内部生成/管理，不暴露给调用方。
 */
import { randomUUID } from 'node:crypto'
import type { WeeklyPatternResult, WeeklyPatternTrend } from '../../ai/WeeklyPatternDetector'
import { getDatabase } from '../database'
import { parseJsonArray, parseJsonField, stringifyJsonArray } from '../json'

interface WeeklyPatternRow {
  id: string
  week_start: string
  patterns: string
  trend: string
  created_at: string
}

/** 空趋势默认值，用于反序列化兜底 */
const DEFAULT_TREND: WeeklyPatternTrend = {
  deepWorkHoursTrend: [],
  switchCountTrend: [],
  dominantActivityTrend: []
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToResult(row: WeeklyPatternRow): WeeklyPatternResult {
  return {
    weekStart: row.week_start,
    patterns: parseJsonArray<WeeklyPatternResult['patterns'][number]>(row.patterns),
    trend: parseJsonField(row.trend, DEFAULT_TREND) as WeeklyPatternTrend,
    createdAt: row.created_at
  }
}

export const WeeklyPatternRepository = {
  /**
   * 插入或更新周级模式结果（按 week_start 唯一约束，主键冲突时更新全部字段）。
   * id 由仓库内部生成；createdAt 为空时由仓库内部生成；更新已有记录时刷新 created_at。
   * @param result 周级模式结果
   */
  upsert(result: WeeklyPatternResult): void {
    const db = getDatabase()
    const id = randomUUID()
    const createdAt = result.createdAt || nowIso()
    db.prepare(
      `INSERT INTO weekly_patterns (id, week_start, patterns, trend, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET
         id = excluded.id,
         patterns = excluded.patterns,
         trend = excluded.trend,
         created_at = excluded.created_at`
    ).run(
      id,
      result.weekStart,
      stringifyJsonArray(result.patterns),
      JSON.stringify(result.trend),
      createdAt
    )
  },

  /**
   * 按 week_start 查询周级模式结果。
   * @param weekStart 周一日期字符串（YYYY-MM-DD）
   * @returns 周级模式结果；不存在返回 null
   */
  getByWeekStart(weekStart: string): WeeklyPatternResult | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM weekly_patterns WHERE week_start = ?')
      .get(weekStart) as WeeklyPatternRow | undefined
    return row ? rowToResult(row) : null
  }
}
