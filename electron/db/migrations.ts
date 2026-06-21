/**
 * SQLite 迁移版本管理
 * 使用 PRAGMA user_version 跟踪已应用的迁移版本，逐版本升级。
 */
import type Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema'

const CURRENT_VERSION = 5

interface Migration {
  version: number
  description: string
  up: (db: Database.Database) => void
}

/** FTS5 虚拟表 + 触发器创建 SQL（幂等，与 schema.ts 保持一致） */
const FTS5_SCHEMA_SQL = `
-- fts_segments：索引 segments.ocr_text + segments.window_title
CREATE VIRTUAL TABLE IF NOT EXISTS fts_segments USING fts5(
  ocr_text,
  window_title,
  content='segments',
  content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
  title,
  one_line_summary,
  content='episodes',
  content_rowid='rowid'
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_wiki USING fts5(
  content,
  content='wiki_pages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO fts_segments(rowid, ocr_text, window_title) VALUES (new.rowid, new.ocr_text, new.window_title);
END;
CREATE TRIGGER IF NOT EXISTS segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO fts_segments(fts_segments, rowid, ocr_text, window_title) VALUES ('delete', old.rowid, old.ocr_text, old.window_title);
END;
CREATE TRIGGER IF NOT EXISTS segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO fts_segments(fts_segments, rowid, ocr_text, window_title) VALUES ('delete', old.rowid, old.ocr_text, old.window_title);
  INSERT INTO fts_segments(rowid, ocr_text, window_title) VALUES (new.rowid, new.ocr_text, new.window_title);
END;

CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO fts_episodes(rowid, title, one_line_summary) VALUES (new.rowid, new.title, new.one_line_summary);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, title, one_line_summary) VALUES ('delete', old.rowid, old.title, old.one_line_summary);
END;
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, title, one_line_summary) VALUES ('delete', old.rowid, old.title, old.one_line_summary);
  INSERT INTO fts_episodes(rowid, title, one_line_summary) VALUES (new.rowid, new.title, new.one_line_summary);
END;

CREATE TRIGGER IF NOT EXISTS wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO fts_wiki(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO fts_wiki(fts_wiki, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO fts_wiki(fts_wiki, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO fts_wiki(rowid, content) VALUES (new.rowid, new.content);
END;
`

const CLEAN_EPISODES_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_clean_episodes USING fts5(
  title,
  summary,
  evidence_refs,
  content='clean_episodes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS clean_episodes_ai AFTER INSERT ON clean_episodes BEGIN
  INSERT INTO fts_clean_episodes(rowid, title, summary, evidence_refs) VALUES (new.rowid, new.title, new.summary, new.evidence_refs);
END;
CREATE TRIGGER IF NOT EXISTS clean_episodes_ad AFTER DELETE ON clean_episodes BEGIN
  INSERT INTO fts_clean_episodes(fts_clean_episodes, rowid, title, summary, evidence_refs) VALUES ('delete', old.rowid, old.title, old.summary, old.evidence_refs);
END;
CREATE TRIGGER IF NOT EXISTS clean_episodes_au AFTER UPDATE ON clean_episodes BEGIN
  INSERT INTO fts_clean_episodes(fts_clean_episodes, rowid, title, summary, evidence_refs) VALUES ('delete', old.rowid, old.title, old.summary, old.evidence_refs);
  INSERT INTO fts_clean_episodes(rowid, title, summary, evidence_refs) VALUES (new.rowid, new.title, new.summary, new.evidence_refs);
END;
`

const migrations: Migration[] = [
  {
    version: 1,
    description: '初始迁移：创建 segments / episodes / wiki_pages / reports / privacy_rules 五张表及索引',
    up: (db: Database.Database) => {
      db.exec(SCHEMA_SQL)
    }
  },
  {
    version: 2,
    description: 'reports 表新增 report_type 字段（daily/weekly/review），默认 daily',
    up: (db: Database.Database) => {
      // 兼容已存在该列的情况（schema.ts 已含此列时新建库会直接带上）
      const cols = db.prepare("PRAGMA table_info(reports)").all() as Array<{ name: string }>
      if (!cols.some((c) => c.name === 'report_type')) {
        db.exec(
          "ALTER TABLE reports ADD COLUMN report_type TEXT NOT NULL DEFAULT 'daily'"
        )
      }
    }
  },
  {
    version: 3,
    description: 'FTS5 全文索引：创建 fts_segments / fts_episodes / fts_wiki 虚拟表 + 同步触发器 + 回填存量数据',
    up: (db: Database.Database) => {
      // 1. 创建 FTS5 虚拟表与触发器（幂等）
      db.exec(FTS5_SCHEMA_SQL)
      db.exec(CLEAN_EPISODES_FTS_SQL)

      // 2. 回填存量数据（仅当 FTS 表为空时，避免重复插入）
      const segCount = db.prepare('SELECT COUNT(*) as c FROM fts_segments').get() as { c: number }
      if (segCount.c === 0) {
        db.exec(
          `INSERT INTO fts_segments(rowid, ocr_text, window_title)
           SELECT rowid, ocr_text, window_title FROM segments WHERE ocr_text != '' OR window_title != ''`
        )
      }
      const epCount = db.prepare('SELECT COUNT(*) as c FROM fts_episodes').get() as { c: number }
      if (epCount.c === 0) {
        db.exec(
          `INSERT INTO fts_episodes(rowid, title, one_line_summary)
           SELECT rowid, title, one_line_summary FROM episodes WHERE title != '' OR one_line_summary != ''`
        )
      }
      const wikiCount = db.prepare('SELECT COUNT(*) as c FROM fts_wiki').get() as { c: number }
      if (wikiCount.c === 0) {
        db.exec(
          `INSERT INTO fts_wiki(rowid, content)
           SELECT rowid, content FROM wiki_pages WHERE content != ''`
        )
      }
    }
  }
  ,
  {
    version: 4,
    description: '小时级理解层：segments 元数据、clean_episodes、distill_runs、clean FTS',
    up: (db: Database.Database) => {
      const segmentCols = db.prepare("PRAGMA table_info(segments)").all() as Array<{ name: string }>
      const addSegmentColumn = (name: string, ddl: string): void => {
        if (!segmentCols.some((c) => c.name === name)) {
          db.exec(`ALTER TABLE segments ADD COLUMN ${ddl}`)
        }
      }
      addSegmentColumn('ocr_blocks', "ocr_blocks TEXT NOT NULL DEFAULT '[]'")
      addSegmentColumn('ocr_confidence', 'ocr_confidence REAL NOT NULL DEFAULT 0.0')
      addSegmentColumn('capture_source', "capture_source TEXT NOT NULL DEFAULT 'unknown'")
      addSegmentColumn('source_quality', "source_quality TEXT NOT NULL DEFAULT 'low'")
      addSegmentColumn('active_window_bounds', "active_window_bounds TEXT NOT NULL DEFAULT ''")
      addSegmentColumn('display_bounds', "display_bounds TEXT NOT NULL DEFAULT ''")

      db.exec(`
        CREATE TABLE IF NOT EXISTS clean_episodes (
          id                TEXT PRIMARY KEY NOT NULL,
          date              TEXT NOT NULL,
          hour_bucket       TEXT NOT NULL DEFAULT '',
          start_time        TEXT NOT NULL,
          end_time          TEXT NOT NULL,
          title             TEXT NOT NULL DEFAULT '',
          summary           TEXT NOT NULL DEFAULT '',
          memory_kind       TEXT NOT NULL DEFAULT 'work',
          project           TEXT NOT NULL DEFAULT '',
          entities          TEXT NOT NULL DEFAULT '[]',
          topics            TEXT NOT NULL DEFAULT '[]',
          materials         TEXT NOT NULL DEFAULT '[]',
          outputs           TEXT NOT NULL DEFAULT '[]',
          todos             TEXT NOT NULL DEFAULT '[]',
          blockers          TEXT NOT NULL DEFAULT '[]',
          segment_ids       TEXT NOT NULL DEFAULT '[]',
          evidence_refs     TEXT NOT NULL DEFAULT '[]',
          source_quality    TEXT NOT NULL DEFAULT 'medium',
          confidence        REAL NOT NULL DEFAULT 0.0,
          report_eligible   INTEGER NOT NULL DEFAULT 1,
          wiki_eligible     INTEGER NOT NULL DEFAULT 0,
          wiki_status       TEXT NOT NULL DEFAULT 'none',
          created_at        TEXT NOT NULL DEFAULT '',
          updated_at        TEXT NOT NULL DEFAULT '',
          model_name        TEXT NOT NULL DEFAULT '',
          distill_version   TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_clean_episodes_date ON clean_episodes(date);
        CREATE INDEX IF NOT EXISTS idx_clean_episodes_hour ON clean_episodes(date, hour_bucket);
        CREATE INDEX IF NOT EXISTS idx_clean_episodes_wiki ON clean_episodes(wiki_eligible, wiki_status);

        CREATE TABLE IF NOT EXISTS distill_runs (
          id              TEXT PRIMARY KEY NOT NULL,
          date            TEXT NOT NULL,
          hour_bucket     TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL DEFAULT 'pending',
          segment_ids     TEXT NOT NULL DEFAULT '[]',
          error_message   TEXT NOT NULL DEFAULT '',
          model_name      TEXT NOT NULL DEFAULT '',
          input_snapshot  TEXT NOT NULL DEFAULT '',
          created_at      TEXT NOT NULL DEFAULT '',
          updated_at      TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_distill_runs_hour ON distill_runs(date, hour_bucket);
        CREATE INDEX IF NOT EXISTS idx_distill_runs_status ON distill_runs(status);
      `)

      db.exec(FTS5_SCHEMA_SQL)
      db.exec(CLEAN_EPISODES_FTS_SQL)
      db.exec(`INSERT INTO fts_clean_episodes(fts_clean_episodes) VALUES ('rebuild')`)
    }
  },
  {
    version: 5,
    description: 'segments 表新增 ocr_raw_text / noise_score 字段（OCR 原始文本与噪声评分，均可空）',
    up: (db: Database.Database) => {
      const segmentCols = db.prepare("PRAGMA table_info(segments)").all() as Array<{ name: string }>
      const addSegmentColumn = (name: string, ddl: string): void => {
        if (!segmentCols.some((c) => c.name === name)) {
          db.exec(`ALTER TABLE segments ADD COLUMN ${ddl}`)
        }
      }
      addSegmentColumn('ocr_raw_text', 'ocr_raw_text TEXT')
      addSegmentColumn('noise_score', 'noise_score REAL')
    }
  }
]

function ensureVersion4Artifacts(db: Database.Database): void {
  const version = getUserVersion(db)
  if (version < 4) return
  db.exec(CLEAN_EPISODES_FTS_SQL)
  try {
    db.exec(`INSERT INTO fts_clean_episodes(fts_clean_episodes) VALUES ('rebuild')`)
  } catch {
    // FTS rebuild can fail on a corrupt partial virtual table; startup should continue.
  }
}

function getUserVersion(db: Database.Database): number {
  const result = db.pragma('user_version', { simple: true })
  return typeof result === 'number' ? result : 0
}

function setUserVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`)
}

/**
 * 执行所有未应用的迁移。在 app ready 后由 initDatabase() 调用。
 * 每个迁移在独立事务中执行，失败则回滚并抛出。
 */
export function runMigrations(db: Database.Database): void {
  const current = getUserVersion(db)
  if (current >= CURRENT_VERSION) {
    ensureVersion4Artifacts(db)
    return
  }

  const pending = migrations
    .filter(m => m.version > current)
    .sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    const tx = db.transaction(() => {
      migration.up(db)
      setUserVersion(db, migration.version)
    })
    tx()
  }
  ensureVersion4Artifacts(db)
}

export function getDbVersion(db: Database.Database): number {
  return getUserVersion(db)
}

export const LATEST_DB_VERSION = CURRENT_VERSION
