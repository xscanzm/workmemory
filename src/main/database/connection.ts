import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from "sql.js";
import path from "path";
import fs from "fs";
import { app } from "electron";

let SQL: SqlJsStatic | null = null;
let db: SqlJsDatabase | null = null;

export function getDbPath(): string {
  const userDataPath = app.getPath("userData");
  return path.join(userDataPath, "workmemory.db");
}

async function initSql(): Promise<SqlJsStatic> {
  if (!SQL) {
    // sql.js needs the WASM file path
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    SQL = await initSqlJs({ locateFile: () => wasmPath });
  }
  return SQL;
}

export async function getDatabase(): Promise<SqlJsDatabase> {
  if (!db) {
    const sql = await initSql();
    const dbPath = getDbPath();

    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new sql.Database(buffer);
    } else {
      db = new sql.Database();
    }

    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA foreign_keys=ON");
    runMigrations(db);
  }
  return db;
}

export function saveDatabase(): void {
  if (!db) return;
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

export function closeDatabase(): void {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
  }
}

function runMigrations(database: SqlJsDatabase): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      app_name TEXT NOT NULL,
      process_name TEXT NOT NULL,
      window_title TEXT NOT NULL,
      window_title_sanitized TEXT,
      monitor_id TEXT,
      ocr_text TEXT,
      ocr_summary TEXT,
      ocr_confidence REAL,
      image_hash TEXT,
      text_hash TEXT,
      screenshot_path TEXT,
      screenshot_saved INTEGER NOT NULL DEFAULT 0,
      is_selected_for_report INTEGER NOT NULL DEFAULT 1,
      is_private INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER NOT NULL DEFAULT 0,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      source_status TEXT NOT NULL DEFAULT 'pending',
      user_title TEXT,
      user_summary TEXT,
      user_note TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`CREATE INDEX IF NOT EXISTS idx_segments_date ON segments(date)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_segments_date_not_deleted ON segments(date, is_deleted)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_segments_source_status ON segments(source_status)`);

  database.run(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS privacy_rules (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      pattern TEXT NOT NULL,
      match_mode TEXT NOT NULL DEFAULT 'contains',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS ai_provider_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
      base_url TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      model TEXT NOT NULL,
      temperature REAL NOT NULL DEFAULT 0.3,
      max_tokens INTEGER,
      timeout_seconds INTEGER NOT NULL DEFAULT 60,
      stream INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS report_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'daily',
      prompt TEXT NOT NULL,
      output_format TEXT NOT NULL DEFAULT 'rich_text',
      is_built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      template_id TEXT NOT NULL,
      template_name TEXT NOT NULL,
      segment_ids TEXT NOT NULL DEFAULT '[]',
      user_notes TEXT,
      prompt_snapshot TEXT NOT NULL,
      ai_input_snapshot TEXT NOT NULL,
      markdown_content TEXT NOT NULL DEFAULT '',
      rich_text_content TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      module TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS daily_summaries (
      date TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      total_duration_seconds INTEGER NOT NULL DEFAULT 0,
      segment_count INTEGER NOT NULL DEFAULT 0,
      top_apps TEXT NOT NULL DEFAULT '[]',
      generated_by TEXT NOT NULL DEFAULT 'rule',
      generated_at TEXT NOT NULL
    )
  `);
  database.run(`CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date)`);

  // === Module 2: 片段扩展字段（人/事维度）===
  // 使用 ALTER TABLE ADD COLUMN（IF NOT EXISTS 通过 try-catch 实现，sql.js 不支持 IF NOT EXISTS for ADD COLUMN）
  tryAddColumn(database, "segments", "people", "TEXT DEFAULT '[]'");
  tryAddColumn(database, "segments", "event", "TEXT");

  // === Module 3: Wiki 知识库 ===
  database.run(`
    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      summary TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      source_segment_ids TEXT NOT NULL DEFAULT '[]',
      linked_node_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  database.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_title ON knowledge_nodes(title)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_source ON knowledge_nodes(source)`);

  database.run(`
    CREATE TABLE IF NOT EXISTS knowledge_links (
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      context TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_id, target_id)
    )
  `);
  database.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_links_source ON knowledge_links(source_id)`);
  database.run(`CREATE INDEX IF NOT EXISTS idx_knowledge_links_target ON knowledge_links(target_id)`);

  // === Module 4: 主动智能 ===
  database.run(`
    CREATE TABLE IF NOT EXISTS insight_cards (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      action_label TEXT,
      action_route TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS smart_reminders (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    )
  `);

  database.run(`
    CREATE TABLE IF NOT EXISTS anomaly_detections (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'low',
      dismissed INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    )
  `);
}

/**
 * 安全添加列（如果列已存在则跳过）
 * sql.js 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS
 */
function tryAddColumn(db: SqlJsDatabase, table: string, column: string, definition: string): void {
  try {
    // 检查列是否已存在
    const result = db.exec(`PRAGMA table_info(${table})`);
    if (result.length > 0) {
      const columns = result[0].values.map((row) => row[1]);
      if (columns.includes(column)) return;
    }
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // 列已存在或添加失败，忽略
  }
}

export { db };