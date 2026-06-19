import { getDatabase, saveDatabase } from "../connection";

function queryAll(db: any, sql: string, params?: any[]): any[] {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export type LogLevel = "info" | "warn" | "error";

export interface EventLog {
  id: number;
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  details?: string;
}

export class EventLogRepository {
  async log(level: LogLevel, module: string, message: string, details?: string): Promise<void> {
    try {
      const db = await getDatabase();
      const timestamp = new Date().toISOString();
      db.run(
        `INSERT INTO event_logs (timestamp, level, module, message, details) VALUES (?, ?, ?, ?, ?)`,
        [timestamp, level, module, message, details || null]
      );
      saveDatabase();
    } catch (error) {
      console.error("EventLogRepository: Failed to log event:", error);
    }
  }

  async info(module: string, message: string, details?: string): Promise<void> {
    return this.log("info", module, message, details);
  }

  async warn(module: string, message: string, details?: string): Promise<void> {
    return this.log("warn", module, message, details);
  }

  async error(module: string, message: string, details?: string): Promise<void> {
    return this.log("error", module, message, details);
  }

  async getAll(limit: number = 200): Promise<EventLog[]> {
    const db = await getDatabase();
    const rows = queryAll(
      db,
      "SELECT * FROM event_logs ORDER BY id DESC LIMIT ?",
      [limit]
    );
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      level: r.level as LogLevel,
      module: r.module,
      message: r.message,
      details: r.details || undefined,
    }));
  }

  async clear(): Promise<void> {
    const db = await getDatabase();
    db.run("DELETE FROM event_logs");
    saveDatabase();
  }
}

export const eventLogRepo = new EventLogRepository();
