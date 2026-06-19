import { getDatabase, saveDatabase } from "../connection";
import { InsightCard, SmartReminder, AnomalyDetection, InsightType, InsightSeverity, ReminderType } from "../../../shared/types";
import { v4 as uuidv4 } from "uuid";

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

/**
 * InsightsRepository - 主动智能数据仓库
 * 存储：洞察卡片、智能提醒、异常检测
 */
export class InsightsRepository {
  // === 洞察卡片 ===
  async getInsights(includeDismissed: boolean = false): Promise<InsightCard[]> {
    const db = await getDatabase();
    const sql = includeDismissed
      ? "SELECT * FROM insight_cards ORDER BY created_at DESC"
      : "SELECT * FROM insight_cards WHERE dismissed = 0 ORDER BY created_at DESC";
    const rows = queryAll(db, sql);
    return rows.map(this.mapInsightRow);
  }

  async saveInsight(insight: Omit<InsightCard, "id" | "createdAt" | "dismissed"> & { id?: string }): Promise<InsightCard> {
    const db = await getDatabase();
    const now = new Date().toISOString();
    const id = insight.id || uuidv4();

    db.run(
      `INSERT OR REPLACE INTO insight_cards (id, type, severity, title, content, action_label, action_route, metadata, created_at, dismissed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, insight.type, insight.severity, insight.title, insight.content,
        insight.actionLabel || null, insight.actionRoute || null,
        insight.metadata ? JSON.stringify(insight.metadata) : null,
        now, 0,
      ]
    );
    saveDatabase();
    return { ...insight, id, createdAt: now, dismissed: false };
  }

  async dismissInsight(id: string): Promise<void> {
    const db = await getDatabase();
    db.run("UPDATE insight_cards SET dismissed = 1 WHERE id = ?", [id]);
    saveDatabase();
  }

  // === 智能提醒 ===
  async getReminders(includeDismissed: boolean = false): Promise<SmartReminder[]> {
    const db = await getDatabase();
    const sql = includeDismissed
      ? "SELECT * FROM smart_reminders ORDER BY scheduled_at DESC"
      : "SELECT * FROM smart_reminders WHERE dismissed = 0 ORDER BY scheduled_at DESC";
    const rows = queryAll(db, sql);
    return rows.map(this.mapReminderRow);
  }

  async saveReminder(reminder: Omit<SmartReminder, "id" | "dismissed"> & { id?: string }): Promise<SmartReminder> {
    const db = await getDatabase();
    const id = reminder.id || uuidv4();
    db.run(
      `INSERT OR REPLACE INTO smart_reminders (id, type, title, message, scheduled_at, dismissed, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id, reminder.type, reminder.title, reminder.message,
        reminder.scheduledAt, 0,
        reminder.metadata ? JSON.stringify(reminder.metadata) : null,
      ]
    );
    saveDatabase();
    return { ...reminder, id, dismissed: false };
  }

  async dismissReminder(id: string): Promise<void> {
    const db = await getDatabase();
    db.run("UPDATE smart_reminders SET dismissed = 1 WHERE id = ?", [id]);
    saveDatabase();
  }

  // === 异常检测 ===
  async getAnomalies(includeDismissed: boolean = false): Promise<AnomalyDetection[]> {
    const db = await getDatabase();
    const sql = includeDismissed
      ? "SELECT * FROM anomaly_detections ORDER BY detected_at DESC"
      : "SELECT * FROM anomaly_detections WHERE dismissed = 0 ORDER BY detected_at DESC";
    const rows = queryAll(db, sql);
    return rows.map(this.mapAnomalyRow);
  }

  async saveAnomaly(anomaly: Omit<AnomalyDetection, "id" | "dismissed"> & { id?: string }): Promise<AnomalyDetection> {
    const db = await getDatabase();
    const id = anomaly.id || uuidv4();
    db.run(
      `INSERT OR REPLACE INTO anomaly_detections (id, type, title, description, detected_at, severity, dismissed, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, anomaly.type, anomaly.title, anomaly.description,
        anomaly.detectedAt, anomaly.severity, 0,
        anomaly.metadata ? JSON.stringify(anomaly.metadata) : null,
      ]
    );
    saveDatabase();
    return { ...anomaly, id, dismissed: false };
  }

  async dismissAnomaly(id: string): Promise<void> {
    const db = await getDatabase();
    db.run("UPDATE anomaly_detections SET dismissed = 1 WHERE id = ?", [id]);
    saveDatabase();
  }

  // === 清理旧数据 ===
  async cleanupOldEntries(daysToKeep: number = 30): Promise<void> {
    const db = await getDatabase();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString();
    db.run("DELETE FROM insight_cards WHERE created_at < ? AND dismissed = 1", [cutoffStr]);
    db.run("DELETE FROM smart_reminders WHERE scheduled_at < ? AND dismissed = 1", [cutoffStr]);
    db.run("DELETE FROM anomaly_detections WHERE detected_at < ? AND dismissed = 1", [cutoffStr]);
    saveDatabase();
  }

  private mapInsightRow(row: any): InsightCard {
    return {
      id: row.id,
      type: row.type as InsightType,
      severity: row.severity as InsightSeverity,
      title: row.title,
      content: row.content,
      actionLabel: row.action_label || undefined,
      actionRoute: row.action_route || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      dismissed: row.dismissed === 1,
    };
  }

  private mapReminderRow(row: any): SmartReminder {
    return {
      id: row.id,
      type: row.type as ReminderType,
      title: row.title,
      message: row.message,
      scheduledAt: row.scheduled_at,
      dismissed: row.dismissed === 1,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private mapAnomalyRow(row: any): AnomalyDetection {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      description: row.description,
      detectedAt: row.detected_at,
      severity: row.severity,
      dismissed: row.dismissed === 1,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }
}

export const insightsRepo = new InsightsRepository();
