/**
 * SQLite 迁移版本管理
 * 使用 PRAGMA user_version 跟踪已应用的迁移版本，逐版本升级。
 */
import type Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema'
import { registerFtsFunctions } from './ftsTokenizer'

const CURRENT_VERSION = 18

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
  },
  {
    version: 6,
    description: 'segments 表新增感知增强字段：activity_type / content_type / content_data / browser_url / layout_type / action_flow（均可空）',
    up: (db: Database.Database) => {
      const segmentCols = db.prepare("PRAGMA table_info(segments)").all() as Array<{ name: string }>
      const addSegmentColumn = (name: string, ddl: string): void => {
        if (!segmentCols.some((c) => c.name === name)) {
          db.exec(`ALTER TABLE segments ADD COLUMN ${ddl}`)
        }
      }
      addSegmentColumn('activity_type', 'activity_type TEXT')
      addSegmentColumn('content_type', 'content_type TEXT')
      addSegmentColumn('content_data', 'content_data TEXT')
      addSegmentColumn('browser_url', 'browser_url TEXT')
      addSegmentColumn('layout_type', 'layout_type TEXT')
      addSegmentColumn('action_flow', 'action_flow TEXT')
    }
  },
  {
    version: 7,
    description: '新增 memory_cells 表：结构化记忆单元（MemCell），含 episode/facts/foresight/metadata',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_cells (
          id                TEXT PRIMARY KEY NOT NULL,
          clean_episode_id  TEXT NOT NULL,
          episode           TEXT NOT NULL,
          facts             TEXT NOT NULL DEFAULT '[]',
          foresight         TEXT NOT NULL DEFAULT '[]',
          metadata          TEXT NOT NULL DEFAULT '{}',
          created_at        TEXT NOT NULL,
          FOREIGN KEY (clean_episode_id) REFERENCES clean_episodes(id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_cells_clean_episode ON memory_cells(clean_episode_id);
        CREATE INDEX IF NOT EXISTS idx_memory_cells_created_at ON memory_cells(created_at);
      `)
    }
  },
  {
    version: 8,
    description: '新增 embeddings 表：MemCell 语义向量存储（embedding BLOB, model_version）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          id              TEXT PRIMARY KEY NOT NULL,
          memory_cell_id  TEXT NOT NULL,
          embedding       BLOB NOT NULL,
          model_version   TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (memory_cell_id) REFERENCES memory_cells(id)
        );
        CREATE INDEX IF NOT EXISTS idx_embeddings_memory_cell ON embeddings(memory_cell_id);
      `)
    }
  },
  {
    version: 9,
    description: '新增 fts_memory_cells FTS5 虚拟表：索引 memory_cells.episode + facts，供 SemanticSearchRepository 关键词匹配',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_memory_cells USING fts5(
          episode,
          facts,
          content='memory_cells',
          content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS memory_cells_ai AFTER INSERT ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(rowid, episode, facts) VALUES (new.rowid, wm_preprocess_fts(new.episode), wm_preprocess_fts(new.facts));
        END;
        CREATE TRIGGER IF NOT EXISTS memory_cells_ad AFTER DELETE ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(fts_memory_cells, rowid, episode, facts) VALUES ('delete', old.rowid, wm_preprocess_fts(old.episode), wm_preprocess_fts(old.facts));
        END;
        CREATE TRIGGER IF NOT EXISTS memory_cells_au AFTER UPDATE ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(fts_memory_cells, rowid, episode, facts) VALUES ('delete', old.rowid, wm_preprocess_fts(old.episode), wm_preprocess_fts(old.facts));
          INSERT INTO fts_memory_cells(rowid, episode, facts) VALUES (new.rowid, wm_preprocess_fts(new.episode), wm_preprocess_fts(new.facts));
        END;
      `)
      // 回填存量 memory_cells 数据（使用 wm_preprocess_fts 预处理中文 bigram）
      const mcCount = db.prepare('SELECT COUNT(*) as c FROM fts_memory_cells').get() as { c: number }
      if (mcCount.c === 0) {
        db.exec(
          `INSERT INTO fts_memory_cells(rowid, episode, facts)
           SELECT rowid, wm_preprocess_fts(episode), wm_preprocess_fts(facts) FROM memory_cells`
        )
      }
    }
  },
  {
    version: 10,
    description: '修复 fts_memory_cells 中文分词：触发器改用 wm_preprocess_fts() 预处理 bigram，重建索引',
    up: (db: Database.Database) => {
      // 1. 丢弃旧触发器（v9 之前版本可能使用原始文本，未做 bigram 预处理）
      db.exec(`
        DROP TRIGGER IF EXISTS memory_cells_ai;
        DROP TRIGGER IF EXISTS memory_cells_ad;
        DROP TRIGGER IF EXISTS memory_cells_au;
      `)

      // 2. 重建触发器，使用 wm_preprocess_fts() 预处理中文文本
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memory_cells_ai AFTER INSERT ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(rowid, episode, facts) VALUES (new.rowid, wm_preprocess_fts(new.episode), wm_preprocess_fts(new.facts));
        END;
        CREATE TRIGGER IF NOT EXISTS memory_cells_ad AFTER DELETE ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(fts_memory_cells, rowid, episode, facts) VALUES ('delete', old.rowid, wm_preprocess_fts(old.episode), wm_preprocess_fts(old.facts));
        END;
        CREATE TRIGGER IF NOT EXISTS memory_cells_au AFTER UPDATE ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(fts_memory_cells, rowid, episode, facts) VALUES ('delete', old.rowid, wm_preprocess_fts(old.episode), wm_preprocess_fts(old.facts));
          INSERT INTO fts_memory_cells(rowid, episode, facts) VALUES (new.rowid, wm_preprocess_fts(new.episode), wm_preprocess_fts(new.facts));
        END;
      `)

      // 3. 重建 FTS5 索引：清空并使用预处理文本重新填充
      //    （外部内容表的 'rebuild' 命令会读取原始列，无法应用预处理函数，故手动重建）
      db.exec(`
        DELETE FROM fts_memory_cells;
        INSERT INTO fts_memory_cells(rowid, episode, facts)
        SELECT rowid, wm_preprocess_fts(episode), wm_preprocess_fts(facts) FROM memory_cells;
      `)
    }
  },
  {
    version: 11,
    description: '新增 memory_scenes 表：MemScene 主题场景聚类（centroid_embedding BLOB, member_cell_ids JSON）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_scenes (
          id                  TEXT PRIMARY KEY NOT NULL,
          title               TEXT NOT NULL,
          centroid_embedding  BLOB NOT NULL,
          member_cell_ids     TEXT NOT NULL,
          summary             TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_scenes_created_at ON memory_scenes(created_at);
      `)
    }
  },
  {
    version: 12,
    description: '新增 user_profile 表：用户画像演进（稳定特质 vs 瞬态状态，key/value/type/confidence/valid_to/sources）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_profile (
          key          TEXT PRIMARY KEY NOT NULL,
          value        TEXT NOT NULL,
          type         TEXT NOT NULL,
          confidence   REAL NOT NULL,
          valid_to     TEXT,
          sources      TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_profile_type ON user_profile(type);
      `)
    }
  },
  {
    version: 13,
    description: '新增 daily_distills 表：日级理解（跨小时主题 + 当日模式，date/summary/themes/patterns/memcell_ids）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_distills (
          id            TEXT PRIMARY KEY NOT NULL,
          date          TEXT NOT NULL UNIQUE,
          summary       TEXT NOT NULL,
          themes        TEXT NOT NULL,
          patterns      TEXT NOT NULL,
          memcell_ids   TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_distills_date ON daily_distills(date);
      `)
    }
  },
  {
    version: 14,
    description: '新增 causal_chains 表：跨 Episode 因果链（cause_cell_id/effect_cell_id/relation/confidence/evidence）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS causal_chains (
          id              TEXT PRIMARY KEY NOT NULL,
          cause_cell_id   TEXT NOT NULL,
          effect_cell_id  TEXT NOT NULL,
          relation        TEXT NOT NULL,
          confidence      REAL NOT NULL,
          evidence        TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (cause_cell_id) REFERENCES memory_cells(id),
          FOREIGN KEY (effect_cell_id) REFERENCES memory_cells(id)
        );
        CREATE INDEX IF NOT EXISTS idx_causal_chains_cause_cell ON causal_chains(cause_cell_id);
        CREATE INDEX IF NOT EXISTS idx_causal_chains_effect_cell ON causal_chains(effect_cell_id);
      `)
    }
  },
  {
    version: 15,
    description: '新增 weekly_patterns 表：周级模式发现（week_start/patterns JSON/trend JSON）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS weekly_patterns (
          id            TEXT PRIMARY KEY NOT NULL,
          week_start    TEXT NOT NULL UNIQUE,
          patterns      TEXT NOT NULL,
          trend         TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_weekly_patterns_week_start ON weekly_patterns(week_start);
      `)
    }
  },
  {
    version: 16,
    description: '新增 reflection_reports 表：周级反思报告（week_start/report JSON）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS reflection_reports (
          id            TEXT PRIMARY KEY NOT NULL,
          week_start    TEXT NOT NULL UNIQUE,
          report        TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reflection_reports_week_start ON reflection_reports(week_start);
      `)
    }
  },
  {
    version: 17,
    description: '新增 skills 表：技能卡（SkillEvolver 从重复 MemScene 主题提炼的 SOP/陷阱/洞察）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          id              TEXT PRIMARY KEY NOT NULL,
          title           TEXT NOT NULL,
          steps           TEXT NOT NULL,
          traps           TEXT NOT NULL,
          insights        TEXT NOT NULL,
          source_cell_ids TEXT NOT NULL,
          confidence      REAL NOT NULL,
          evolved_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_skills_title ON skills(title);
        CREATE INDEX IF NOT EXISTS idx_skills_evolved_at ON skills(evolved_at);
      `)
    }
  },
  {
    version: 18,
    description: '新增 feedback_events 表：用户反馈事件（FeedbackLoop 反馈回流，记录重命名/拒绝/编辑）',
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_events (
          id          TEXT PRIMARY KEY NOT NULL,
          type        TEXT NOT NULL,
          target_id   TEXT NOT NULL,
          before      TEXT NOT NULL,
          after       TEXT NOT NULL,
          timestamp   TEXT NOT NULL,
          applied     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_events_type ON feedback_events(type);
        CREATE INDEX IF NOT EXISTS idx_feedback_events_applied ON feedback_events(applied);
      `)
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
  // 注册 FTS5 预处理自定义函数（wm_preprocess_fts），供 fts_memory_cells 触发器使用。
  // 必须在任何 memory_cells INSERT/UPDATE/DELETE 之前注册，否则触发器调用会失败。
  // 覆盖生产环境（initDatabase）与测试环境（createInMemoryDb）。
  registerFtsFunctions(db)

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
