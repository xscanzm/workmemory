import { getDatabase, saveDatabase } from "../connection";
import { DailySummary, CalendarDayInfo } from "../../../shared/types";

function queryAll(db: any, sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(db: any, sql: string, params?: any[]): any | null {
  const rows = queryAll(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export class DailySummaryRepository {
  /**
   * 获取某天的总结
   */
  async getByDate(date: string): Promise<DailySummary | null> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT * FROM daily_summaries WHERE date = ?", [date]);
    return row ? this.mapRow(row) : null;
  }

  /**
   * 保存（upsert）每日总结
   */
  async save(summary: DailySummary): Promise<void> {
    const db = await getDatabase();
    db.run(
      `INSERT INTO daily_summaries (date, summary, total_duration_seconds, segment_count, top_apps, generated_by, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         summary = excluded.summary,
         total_duration_seconds = excluded.total_duration_seconds,
         segment_count = excluded.segment_count,
         top_apps = excluded.top_apps,
         generated_by = excluded.generated_by,
         generated_at = excluded.generated_at`,
      [
        summary.date,
        summary.summary,
        summary.totalDurationSeconds,
        summary.segmentCount,
        JSON.stringify(summary.topApps),
        summary.generatedBy,
        summary.generatedAt,
      ]
    );
    saveDatabase();
  }

  /**
   * 获取某月的日历信息（每天的工作时长 + 总结）
   * 返回该月所有有数据的天
   */
  async getCalendarMonth(year: number, month: number): Promise<CalendarDayInfo[]> {
    const db = await getDatabase();
    const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

    // 查询该月每天的聚合数据
    const rows = queryAll(
      db,
      `SELECT
         date,
         SUM(duration_seconds) as total_duration,
         COUNT(*) as segment_count
       FROM segments
       WHERE date >= ? AND date < ? AND is_deleted = 0
       GROUP BY date
       ORDER BY date ASC`,
      [startDate, endDate]
    );

    // 查询该月所有总结
    const summaryRows = queryAll(
      db,
      "SELECT * FROM daily_summaries WHERE date >= ? AND date < ?",
      [startDate, endDate]
    );
    const summaryMap = new Map<string, string>();
    for (const s of summaryRows) {
      summaryMap.set(s.date, s.summary);
    }

    // 查询每天 top app
    const topAppRows = queryAll(
      db,
      `SELECT date, app_name, SUM(duration_seconds) as dur
       FROM segments
       WHERE date >= ? AND date < ? AND is_deleted = 0
       GROUP BY date, app_name
       ORDER BY date ASC, dur DESC`,
      [startDate, endDate]
    );
    const topAppMap = new Map<string, string>();
    for (const r of topAppRows) {
      if (!topAppMap.has(r.date)) topAppMap.set(r.date, r.app_name);
    }

    return rows.map((r) => ({
      date: r.date,
      hasData: true,
      totalDurationSeconds: r.total_duration || 0,
      segmentCount: r.segment_count || 0,
      topApp: topAppMap.get(r.date),
      summary: summaryMap.get(r.date),
    }));
  }

  private mapRow(row: any): DailySummary {
    return {
      date: row.date,
      summary: row.summary,
      totalDurationSeconds: row.total_duration_seconds,
      segmentCount: row.segment_count,
      topApps: JSON.parse(row.top_apps || "[]"),
      generatedBy: row.generated_by as "ai" | "rule",
      generatedAt: row.generated_at,
    };
  }
}

export const dailySummaryRepo = new DailySummaryRepository();
