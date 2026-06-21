/**
 * WorkMemory SQLite Schema
 * 5 张表：segments / episodes / wiki_pages / reports / privacy_rules
 * 3 张 FTS5 虚拟表：fts_segments / fts_episodes / fts_wiki（外部内容表，触发器同步）
 * 全部使用 IF NOT EXISTS，支持幂等迁移。
 */

export const SCHEMA_SQL = `
-- ========== segments 表：原始窗口片段 + OCR ==========
CREATE TABLE IF NOT EXISTS segments (
  id                      TEXT PRIMARY KEY NOT NULL,
  date                    TEXT NOT NULL,
  start_time              TEXT NOT NULL,
  end_time                TEXT NOT NULL,
  duration_seconds        INTEGER NOT NULL DEFAULT 0,
  app_name                TEXT NOT NULL DEFAULT '',
  process_name            TEXT NOT NULL DEFAULT '',
  window_title            TEXT NOT NULL DEFAULT '',
  ocr_text                TEXT NOT NULL DEFAULT '',
  ocr_summary             TEXT NOT NULL DEFAULT '',
  image_hash              TEXT NOT NULL DEFAULT '',
  screenshot_path         TEXT NOT NULL DEFAULT '',
  is_selected_for_report  INTEGER NOT NULL DEFAULT 0,
  is_private              INTEGER NOT NULL DEFAULT 0,
  is_important            INTEGER NOT NULL DEFAULT 0,
  is_deleted              INTEGER NOT NULL DEFAULT 0,
  source_status           TEXT NOT NULL DEFAULT 'pending',
  user_title              TEXT NOT NULL DEFAULT '',
  user_summary            TEXT NOT NULL DEFAULT '',
  user_note               TEXT NOT NULL DEFAULT '',
  tags                    TEXT NOT NULL DEFAULT '[]',
  ocr_blocks              TEXT NOT NULL DEFAULT '[]',
  ocr_confidence          REAL NOT NULL DEFAULT 0.0,
  capture_source          TEXT NOT NULL DEFAULT 'unknown',
  source_quality          TEXT NOT NULL DEFAULT 'low',
  active_window_bounds    TEXT NOT NULL DEFAULT '',
  display_bounds          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_segments_date ON segments(date);
CREATE INDEX IF NOT EXISTS idx_segments_image_hash ON segments(image_hash);
CREATE INDEX IF NOT EXISTS idx_segments_is_deleted ON segments(is_deleted);
CREATE INDEX IF NOT EXISTS idx_segments_date_active ON segments(date, is_deleted);

-- ========== episodes 表：语义合并后的工作事件 ==========
CREATE TABLE IF NOT EXISTS episodes (
  id                TEXT PRIMARY KEY NOT NULL,
  date              TEXT NOT NULL,
  start_time        TEXT NOT NULL,
  end_time          TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  one_line_summary  TEXT NOT NULL DEFAULT '',
  segment_ids       TEXT NOT NULL DEFAULT '[]',
  entities          TEXT NOT NULL DEFAULT '[]',
  topics            TEXT NOT NULL DEFAULT '[]',
  user_edited       INTEGER NOT NULL DEFAULT 0,
  report_eligible   INTEGER NOT NULL DEFAULT 1,
  wiki_eligible     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_episodes_date ON episodes(date);
CREATE INDEX IF NOT EXISTS idx_episodes_user_edited ON episodes(user_edited);

-- ========== clean_episodes 表：小时级理解后的工作记忆事件 ==========
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

-- ========== distill_runs 表：小时级理解批处理运行记录 ==========
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

-- ========== wiki_pages 表：知识双链沉淀 ==========
CREATE TABLE IF NOT EXISTS wiki_pages (
  id            TEXT PRIMARY KEY NOT NULL,
  type          TEXT NOT NULL DEFAULT 'topic',
  title         TEXT NOT NULL DEFAULT '',
  aliases       TEXT NOT NULL DEFAULT '[]',
  content       TEXT NOT NULL DEFAULT '',
  sources       TEXT NOT NULL DEFAULT '[]',
  backlinks     TEXT NOT NULL DEFAULT '[]',
  confidence    REAL NOT NULL DEFAULT 0.0,
  review_status TEXT NOT NULL DEFAULT 'needs_review',
  created_at    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_wiki_type ON wiki_pages(type);
CREATE INDEX IF NOT EXISTS idx_wiki_review_status ON wiki_pages(review_status);
CREATE INDEX IF NOT EXISTS idx_wiki_title ON wiki_pages(title);

-- ========== reports 表：日报/周报 ==========
CREATE TABLE IF NOT EXISTS reports (
  id                  TEXT PRIMARY KEY NOT NULL,
  date                TEXT NOT NULL,
  template_id         TEXT NOT NULL DEFAULT 'enhanced',
  template_name       TEXT NOT NULL DEFAULT '',
  segment_ids         TEXT NOT NULL DEFAULT '[]',
  ai_input_snapshot   TEXT NOT NULL DEFAULT '',
  markdown_content    TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'draft',
  report_type         TEXT NOT NULL DEFAULT 'daily'
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(date);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);

-- ========== privacy_rules 表：隐私规则 ==========
CREATE TABLE IF NOT EXISTS privacy_rules (
  id          TEXT PRIMARY KEY NOT NULL,
  type        TEXT NOT NULL DEFAULT 'window_title',
  pattern     TEXT NOT NULL DEFAULT '',
  match_mode  TEXT NOT NULL DEFAULT 'contains',
  enabled     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_privacy_type ON privacy_rules(type);
CREATE INDEX IF NOT EXISTS idx_privacy_enabled ON privacy_rules(enabled);

-- ========== FTS5 全文索引虚拟表（外部内容表，content_rowid 引用源表 rowid） ==========
-- fts_segments：索引 segments.ocr_text + segments.window_title
CREATE VIRTUAL TABLE IF NOT EXISTS fts_segments USING fts5(
  ocr_text,
  window_title,
  content='segments',
  content_rowid='rowid'
);

-- fts_episodes：索引 episodes.title + episodes.one_line_summary
CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
  title,
  one_line_summary,
  content='episodes',
  content_rowid='rowid'
);

-- fts_clean_episodes：索引 clean_episodes.title + summary + evidence_refs
CREATE VIRTUAL TABLE IF NOT EXISTS fts_clean_episodes USING fts5(
  title,
  summary,
  evidence_refs,
  content='clean_episodes',
  content_rowid='rowid'
);

-- fts_wiki：索引 wiki_pages.content
CREATE VIRTUAL TABLE IF NOT EXISTS fts_wiki USING fts5(
  content,
  content='wiki_pages',
  content_rowid='rowid'
);

-- ========== FTS5 同步触发器：segments ==========
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

-- ========== FTS5 同步触发器：episodes ==========
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

-- ========== FTS5 同步触发器：clean_episodes ==========
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

-- ========== FTS5 同步触发器：wiki_pages ==========
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
