import { getDatabase, saveDatabase } from "../connection";
import { WorkSegment, SegmentSourceStatus, SegmentSearchResult, WorkStats, MemoryGraphData } from "../../../shared/types";
import { v4 as uuidv4 } from "uuid";

function queryAll(db: any, sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(db: any, sql: string, params?: any[]): any | null {
  const rows = queryAll(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(db: any, sql: string, params?: any[]): void {
  db.run(sql, params);
}

export class SegmentRepository {
  async getTodaySegments(date: string): Promise<WorkSegment[]> {
    const db = await getDatabase();
    const rows = queryAll(
      db,
      `SELECT * FROM segments WHERE date = ? AND is_deleted = 0 ORDER BY start_time ASC`,
      [date]
    );
    return rows.map(this.mapRowToSegment);
  }

  async getSegmentById(id: string): Promise<WorkSegment | null> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT * FROM segments WHERE id = ?", [id]);
    return row ? this.mapRowToSegment(row) : null;
  }

  async createSegment(segment: Omit<WorkSegment, "id" | "createdAt" | "updatedAt">): Promise<WorkSegment> {
    const db = await getDatabase();
    const id = uuidv4();
    const now = new Date().toISOString();

    run(
      db,
      `INSERT INTO segments (
        id, date, start_time, end_time, duration_seconds,
        app_name, process_name, window_title, window_title_sanitized,
        monitor_id, ocr_text, ocr_summary, ocr_confidence,
        image_hash, text_hash, screenshot_path, screenshot_saved,
        is_selected_for_report, is_private, is_important, is_deleted,
        source_status, user_title, user_summary, user_note, tags,
        people, event,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, segment.date, segment.startTime, segment.endTime, segment.durationSeconds,
        segment.appName, segment.processName, segment.windowTitle,
        segment.windowTitleSanitized || null,
        segment.monitorId || null, segment.ocrText || null,
        segment.ocrSummary || null, segment.ocrConfidence || null,
        segment.imageHash || null, segment.textHash || null,
        segment.screenshotPath || null, segment.screenshotSaved ? 1 : 0,
        segment.isSelectedForReport ? 1 : 0, segment.isPrivate ? 1 : 0,
        segment.isImportant ? 1 : 0, segment.isDeleted ? 1 : 0,
        segment.sourceStatus, segment.userTitle || null,
        segment.userSummary || null, segment.userNote || null,
        JSON.stringify(segment.tags),
        JSON.stringify(segment.people || []),
        segment.event || null,
        now, now,
      ]
    );

    saveDatabase();
    return { ...segment, id, createdAt: now, updatedAt: now };
  }

  async updateSegment(id: string, updates: Partial<WorkSegment>): Promise<void> {
    const db = await getDatabase();
    const now = new Date().toISOString();

    const fields: string[] = [];
    const values: any[] = [];

    const fieldMap: Record<string, string> = {
      startTime: "start_time", endTime: "end_time", durationSeconds: "duration_seconds",
      appName: "app_name", processName: "process_name", windowTitle: "window_title",
      windowTitleSanitized: "window_title_sanitized", monitorId: "monitor_id",
      ocrText: "ocr_text", ocrSummary: "ocr_summary", ocrConfidence: "ocr_confidence",
      imageHash: "image_hash", textHash: "text_hash", screenshotPath: "screenshot_path",
      screenshotSaved: "screenshot_saved", isSelectedForReport: "is_selected_for_report",
      isPrivate: "is_private", isImportant: "is_important", isDeleted: "is_deleted",
      sourceStatus: "source_status", userTitle: "user_title",
      userSummary: "user_summary", userNote: "user_note",
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        fields.push(`${col} = ?`);
        const val = (updates as any)[key];
        values.push(typeof val === "boolean" ? (val ? 1 : 0) : (val ?? null));
      }
    }

    if ("tags" in updates && updates.tags) {
      fields.push("tags = ?");
      values.push(JSON.stringify(updates.tags));
    }

    if ("people" in updates && updates.people) {
      fields.push("people = ?");
      values.push(JSON.stringify(updates.people));
    }

    if ("event" in updates) {
      fields.push("event = ?");
      values.push((updates as any).event ?? null);
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);

    run(db, `UPDATE segments SET ${fields.join(", ")} WHERE id = ?`, values);
    saveDatabase();
  }

  async softDeleteSegment(id: string): Promise<void> {
    const db = await getDatabase();
    run(db, "UPDATE segments SET is_deleted = 1, updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    saveDatabase();
  }

  async clearToday(date: string): Promise<void> {
    const db = await getDatabase();
    run(db, "UPDATE segments SET is_deleted = 1 WHERE date = ?", [date]);
    saveDatabase();
  }

  async clearAll(): Promise<void> {
    const db = await getDatabase();
    run(db, "DELETE FROM segments");
    saveDatabase();
  }

  async getTodayCount(date: string): Promise<number> {
    const db = await getDatabase();
    const row = queryOne(db, "SELECT COUNT(*) as count FROM segments WHERE date = ? AND is_deleted = 0", [date]);
    return row?.count || 0;
  }

  async getLastSegment(date: string): Promise<WorkSegment | null> {
    const db = await getDatabase();
    const row = queryOne(
      db,
      "SELECT * FROM segments WHERE date = ? AND is_deleted = 0 ORDER BY end_time DESC LIMIT 1",
      [date]
    );
    return row ? this.mapRowToSegment(row) : null;
  }

  async extendSegmentEndTime(id: string, newEndTime: string): Promise<void> {
    const db = await getDatabase();
    const segment = await this.getSegmentById(id);
    if (!segment) return;

    const startTime = new Date(segment.startTime).getTime();
    const endTime = new Date(newEndTime).getTime();
    const durationSeconds = Math.round((endTime - startTime) / 1000);

    run(db, "UPDATE segments SET end_time = ?, duration_seconds = ?, updated_at = ? WHERE id = ?", [
      newEndTime, durationSeconds, new Date().toISOString(), id,
    ]);
    saveDatabase();
  }

  /**
   * 全文搜索片段（跨天）
   * 搜索字段：window_title, user_title, user_summary, ocr_summary, ocr_text, user_note, tags
   */
  async search(query: string, limit: number = 100): Promise<SegmentSearchResult[]> {
    const db = await getDatabase();
    const keyword = `%${query}%`;
    const rows = queryAll(
      db,
      `SELECT * FROM segments
       WHERE is_deleted = 0 AND (
         window_title LIKE ? OR user_title LIKE ? OR user_summary LIKE ?
         OR ocr_summary LIKE ? OR ocr_text LIKE ? OR user_note LIKE ? OR tags LIKE ?
       )
       ORDER BY date DESC, start_time DESC
       LIMIT ?`,
      [keyword, keyword, keyword, keyword, keyword, keyword, keyword, limit]
    );

    return rows.map((row) => {
      const segment = this.mapRowToSegment(row);
      const matchedFields: string[] = [];
      const q = query.toLowerCase();

      if ((segment.windowTitle || "").toLowerCase().includes(q)) matchedFields.push("窗口标题");
      if ((segment.userTitle || "").toLowerCase().includes(q)) matchedFields.push("标题");
      if ((segment.userSummary || "").toLowerCase().includes(q)) matchedFields.push("摘要");
      if ((segment.ocrSummary || "").toLowerCase().includes(q)) matchedFields.push("OCR摘要");
      if ((segment.ocrText || "").toLowerCase().includes(q)) matchedFields.push("OCR文本");
      if ((segment.userNote || "").toLowerCase().includes(q)) matchedFields.push("备注");
      if (segment.tags.some((t) => t.toLowerCase().includes(q))) matchedFields.push("标签");

      // 生成摘要片段
      let snippet = "";
      const fields = [segment.userSummary, segment.ocrSummary, segment.ocrText, segment.userNote, segment.userTitle, segment.windowTitle];
      for (const f of fields) {
        if (f && f.toLowerCase().includes(q)) {
          const idx = f.toLowerCase().indexOf(q);
          const start = Math.max(0, idx - 20);
          const end = Math.min(f.length, idx + query.length + 40);
          snippet = (start > 0 ? "..." : "") + f.substring(start, end) + (end < f.length ? "..." : "");
          break;
        }
      }

      return { segment, matchedFields, snippet };
    });
  }

  /**
   * 获取指定日期范围的片段
   */
  async getByDateRange(startDate: string, endDate: string): Promise<WorkSegment[]> {
    const db = await getDatabase();
    const rows = queryAll(
      db,
      `SELECT * FROM segments WHERE date >= ? AND date <= ? AND is_deleted = 0 ORDER BY date ASC, start_time ASC`,
      [startDate, endDate]
    );
    return rows.map(this.mapRowToSegment);
  }

  /**
   * 获取工作统计数据
   */
  async getWorkStats(startDate: string, endDate: string): Promise<WorkStats> {
    const db = await getDatabase();
    const segments = await this.getByDateRange(startDate, endDate);

    const totalDurationSeconds = segments.reduce((sum, s) => sum + s.durationSeconds, 0);

    // 应用分布
    const appMap = new Map<string, number>();
    for (const s of segments) {
      appMap.set(s.appName, (appMap.get(s.appName) || 0) + s.durationSeconds);
    }
    const appDistribution = Array.from(appMap.entries())
      .map(([app, durationSeconds]) => ({
        app,
        durationSeconds,
        percentage: totalDurationSeconds > 0 ? (durationSeconds / totalDurationSeconds) * 100 : 0,
      }))
      .sort((a, b) => b.durationSeconds - a.durationSeconds);

    // 时段分布（24小时）
    const hourlyDistribution = new Array(24).fill(0);
    for (const s of segments) {
      const hour = parseInt(s.startTime.split("T")[1]?.substring(0, 2) || "0");
      hourlyDistribution[hour] += s.durationSeconds;
    }

    // 每日趋势
    const dailyMap = new Map<string, number>();
    for (const s of segments) {
      dailyMap.set(s.date, (dailyMap.get(s.date) || 0) + s.durationSeconds);
    }
    const dailyTrend = Array.from(dailyMap.entries())
      .map(([date, durationSeconds]) => ({ date, durationSeconds }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Top 应用（按时长+次数）
    const appCountMap = new Map<string, number>();
    for (const s of segments) {
      appCountMap.set(s.appName, (appCountMap.get(s.appName) || 0) + 1);
    }
    const topApps = appDistribution.slice(0, 10).map((a) => ({
      app: a.app,
      durationSeconds: a.durationSeconds,
      count: appCountMap.get(a.app) || 0,
    }));

    return {
      totalDurationSeconds,
      totalSegments: segments.length,
      appDistribution,
      hourlyDistribution,
      dailyTrend,
      topApps,
    };
  }

  private mapRowToSegment(row: any): WorkSegment {
    return {
      id: row.id, date: row.date, startTime: row.start_time, endTime: row.end_time,
      durationSeconds: row.duration_seconds, appName: row.app_name,
      processName: row.process_name, windowTitle: row.window_title,
      windowTitleSanitized: row.window_title_sanitized || undefined,
      monitorId: row.monitor_id || undefined,
      ocrText: row.ocr_text || undefined,
      ocrSummary: row.ocr_summary || undefined,
      ocrConfidence: row.ocr_confidence || undefined,
      imageHash: row.image_hash || undefined,
      textHash: row.text_hash || undefined,
      screenshotPath: row.screenshot_path || undefined,
      screenshotSaved: row.screenshot_saved === 1,
      isSelectedForReport: row.is_selected_for_report === 1,
      isPrivate: row.is_private === 1,
      isImportant: row.is_important === 1,
      isDeleted: row.is_deleted === 1,
      sourceStatus: row.source_status as SegmentSourceStatus,
      userTitle: row.user_title || undefined,
      userSummary: row.user_summary || undefined,
      userNote: row.user_note || undefined,
      tags: JSON.parse(row.tags || "[]"),
      people: row.people ? JSON.parse(row.people) : [],
      event: row.event || undefined,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // ============================================================
  // Module 2: 人/事/时间串联 - 记忆图谱查询
  // ============================================================

  /**
   * 获取记忆图谱数据（人/事/时间三维度聚合）
   */
  async getMemoryGraph(startDate?: string, endDate?: string): Promise<MemoryGraphData> {
    const db = await getDatabase();
    let sql = "SELECT * FROM segments WHERE is_deleted = 0";
    const params: any[] = [];
    if (startDate && endDate) {
      sql += " AND date >= ? AND date <= ?";
      params.push(startDate, endDate);
    }
    sql += " ORDER BY start_time ASC";
    const rows = queryAll(db, sql, params);
    const segments = rows.map(this.mapRowToSegment);

    // 聚合人物
    const peopleMap = new Map<string, { segmentCount: number; totalDurationSeconds: number; lastSeen: string }>();
    for (const s of segments) {
      const people = s.people || [];
      for (const person of people) {
        const existing = peopleMap.get(person) || { segmentCount: 0, totalDurationSeconds: 0, lastSeen: "" };
        existing.segmentCount++;
        existing.totalDurationSeconds += s.durationSeconds;
        if (s.startTime > existing.lastSeen) existing.lastSeen = s.startTime;
        peopleMap.set(person, existing);
      }
    }
    const people = Array.from(peopleMap.entries())
      .map(([name, info]) => ({ name, ...info }))
      .sort((a, b) => b.segmentCount - a.segmentCount);

    // 聚合事件
    const eventMap = new Map<string, { segmentCount: number; totalDurationSeconds: number; lastSeen: string; date: string }>();
    for (const s of segments) {
      if (!s.event) continue;
      const existing = eventMap.get(s.event) || { segmentCount: 0, totalDurationSeconds: 0, lastSeen: "", date: s.date };
      existing.segmentCount++;
      existing.totalDurationSeconds += s.durationSeconds;
      if (s.startTime > existing.lastSeen) existing.lastSeen = s.startTime;
      eventMap.set(s.event, existing);
    }
    const events = Array.from(eventMap.entries())
      .map(([name, info]) => ({ name, ...info }))
      .sort((a, b) => b.segmentCount - a.segmentCount);

    // 聚合时间线（按天）
    const timelineMap = new Map<string, { segmentCount: number; totalDurationSeconds: number }>();
    for (const s of segments) {
      const existing = timelineMap.get(s.date) || { segmentCount: 0, totalDurationSeconds: 0 };
      existing.segmentCount++;
      existing.totalDurationSeconds += s.durationSeconds;
      timelineMap.set(s.date, existing);
    }
    const timeline = Array.from(timelineMap.entries())
      .map(([date, info]) => ({ date, ...info }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { people, events, timeline };
  }

  /**
   * 按人物查询关联片段
   */
  async getSegmentsByPerson(person: string): Promise<WorkSegment[]> {
    const db = await getDatabase();
    const keyword = `%"${person}"%`;
    const rows = queryAll(
      db,
      "SELECT * FROM segments WHERE is_deleted = 0 AND people LIKE ? ORDER BY date DESC, start_time DESC",
      [keyword]
    );
    return rows.map(this.mapRowToSegment);
  }

  /**
   * 按事件查询关联片段
   */
  async getSegmentsByEvent(event: string): Promise<WorkSegment[]> {
    const db = await getDatabase();
    const rows = queryAll(
      db,
      "SELECT * FROM segments WHERE is_deleted = 0 AND event = ? ORDER BY date DESC, start_time DESC",
      [event]
    );
    return rows.map(this.mapRowToSegment);
  }
}

export const segmentRepo = new SegmentRepository();