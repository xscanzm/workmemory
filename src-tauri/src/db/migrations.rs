/** 数据库迁移系统（对应 electron/db/migrations.ts）
 *
 * 18 个迁移版本，使用 PRAGMA user_version 追踪。
 * 每个迁移在独立事务中执行，失败回滚且不更新 user_version。
 * 所有 DDL 使用 IF NOT EXISTS；ALTER TABLE ADD COLUMN 前检查列是否已存在。
 */

use rusqlite::Connection;

use super::schema::{CLEAN_EPISODES_FTS_SQL, FTS5_SCHEMA_SQL, SCHEMA_SQL};

/// 当前最新迁移版本
pub const CURRENT_VERSION: i64 = 18;

/// 执行数据库迁移。
///
/// 流程：
/// 1. 注册 FTS 自定义函数（已在 init_database 中完成）
/// 2. 读取当前 user_version
/// 3. 若 current >= CURRENT_VERSION，跳过迁移，但仍调用 ensure_version4_artifacts
/// 4. 否则筛选 version > current 的迁移，按版本号升序执行
/// 5. 每个迁移在独立事务中执行
/// 6. 最后调用 ensure_version4_artifacts 兜底
pub fn run_migrations(conn: &Connection) -> anyhow::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;

    if current < CURRENT_VERSION {
        for version in (current + 1)..=CURRENT_VERSION {
            let tx = conn.unchecked_transaction()?;
            apply_migration(&tx, version)?;
            tx.pragma_update(None, "user_version", version)?;
            tx.commit()?;
        }
    }

    // v4 FTS 兜底：每次启动都执行一次，确保 FTS 表健康
    ensure_version4_artifacts(conn)?;

    Ok(())
}

/// 应用指定版本的迁移
fn apply_migration(conn: &Connection, version: i64) -> anyhow::Result<()> {
    match version {
        1 => migration_v1(conn),
        2 => migration_v2(conn),
        3 => migration_v3(conn),
        4 => migration_v4(conn),
        5 => migration_v5(conn),
        6 => migration_v6(conn),
        7 => migration_v7(conn),
        8 => migration_v8(conn),
        9 => migration_v9(conn),
        10 => migration_v10(conn),
        11 => migration_v11(conn),
        12 => migration_v12(conn),
        13 => migration_v13(conn),
        14 => migration_v14(conn),
        15 => migration_v15(conn),
        16 => migration_v16(conn),
        17 => migration_v17(conn),
        18 => migration_v18(conn),
        _ => Ok(()),
    }
}

/// v1：初始迁移 — 创建全部表、索引、FTS5 虚拟表、触发器
fn migration_v1(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(())
}

/// v2：reports 表新增 report_type 字段
fn migration_v2(conn: &Connection) -> anyhow::Result<()> {
    if !column_exists(conn, "reports", "report_type")? {
        conn.execute(
            "ALTER TABLE reports ADD COLUMN report_type TEXT NOT NULL DEFAULT 'daily'",
            [],
        )?;
    }
    Ok(())
}

/// v3：FTS5 全文索引 — 创建 fts_segments / fts_episodes / fts_wiki + 回填
fn migration_v3(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(FTS5_SCHEMA_SQL)?;

    // 回填 fts_segments（若空）
    let fts_segments_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM fts_segments", [], |row| row.get(0))?;
    if fts_segments_count == 0 {
        conn.execute(
            "INSERT INTO fts_segments(rowid, ocr_text, window_title) SELECT rowid, ocr_text, window_title FROM segments",
            [],
        )?;
    }

    // 回填 fts_episodes（若空）
    let fts_episodes_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM fts_episodes", [], |row| row.get(0))?;
    if fts_episodes_count == 0 {
        conn.execute(
            "INSERT INTO fts_episodes(rowid, title, one_line_summary) SELECT rowid, title, one_line_summary FROM episodes",
            [],
        )?;
    }

    // 回填 fts_wiki（若空）
    let fts_wiki_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM fts_wiki", [], |row| row.get(0))?;
    if fts_wiki_count == 0 {
        conn.execute(
            "INSERT INTO fts_wiki(rowid, content) SELECT rowid, content FROM wiki_pages",
            [],
        )?;
    }

    Ok(())
}

/// v4：小时级理解层 — segments 元数据 + clean_episodes + distill_runs + clean FTS
fn migration_v4(conn: &Connection) -> anyhow::Result<()> {
    // segments 新增 6 列
    let v4_columns = [
        ("ocr_blocks", "TEXT NOT NULL DEFAULT '[]'"),
        ("ocr_confidence", "REAL NOT NULL DEFAULT 0.0"),
        ("capture_source", "TEXT NOT NULL DEFAULT 'unknown'"),
        ("source_quality", "TEXT NOT NULL DEFAULT 'low'"),
        ("active_window_bounds", "TEXT NOT NULL DEFAULT ''"),
        ("display_bounds", "TEXT NOT NULL DEFAULT ''"),
    ];
    for (col, def) in &v4_columns {
        if !column_exists(conn, "segments", col)? {
            conn.execute(&format!("ALTER TABLE segments ADD COLUMN {} {}", col, def), [])?;
        }
    }

    // clean_episodes / distill_runs 表 + clean FTS（schema.sql 已含 IF NOT EXISTS）
    conn.execute_batch(CLEAN_EPISODES_FTS_SQL)?;

    // 重建 fts_clean_episodes 索引
    let _ = conn.execute(
        "INSERT INTO fts_clean_episodes(fts_clean_episodes) VALUES ('rebuild')",
        [],
    );

    Ok(())
}

/// v5：segments 新增 ocr_raw_text / noise_score（均可空）
fn migration_v5(conn: &Connection) -> anyhow::Result<()> {
    if !column_exists(conn, "segments", "ocr_raw_text")? {
        conn.execute("ALTER TABLE segments ADD COLUMN ocr_raw_text TEXT", [])?;
    }
    if !column_exists(conn, "segments", "noise_score")? {
        conn.execute("ALTER TABLE segments ADD COLUMN noise_score REAL", [])?;
    }
    Ok(())
}

/// v6：segments 新增感知增强字段（均可空）
fn migration_v6(conn: &Connection) -> anyhow::Result<()> {
    let v6_columns = [
        "activity_type",
        "content_type",
        "content_data",
        "browser_url",
        "layout_type",
        "action_flow",
    ];
    for col in &v6_columns {
        if !column_exists(conn, "segments", col)? {
            conn.execute(&format!("ALTER TABLE segments ADD COLUMN {} TEXT", col), [])?;
        }
    }
    Ok(())
}

/// v7：memory_cells 表
fn migration_v7(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_cells (
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
        CREATE INDEX IF NOT EXISTS idx_memory_cells_created_at ON memory_cells(created_at);",
    )?;
    Ok(())
}

/// v8：embeddings 表
fn migration_v8(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS embeddings (
          id              TEXT PRIMARY KEY NOT NULL,
          memory_cell_id  TEXT NOT NULL,
          embedding       BLOB NOT NULL,
          model_version   TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (memory_cell_id) REFERENCES memory_cells(id)
        );
        CREATE INDEX IF NOT EXISTS idx_embeddings_memory_cell ON embeddings(memory_cell_id);",
    )?;
    Ok(())
}

/// v9：fts_memory_cells FTS5 虚拟表（初始版本，未使用 wm_preprocess_fts）
fn migration_v9(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts_memory_cells USING fts5(
          episode,
          facts,
          content='memory_cells',
          content_rowid='rowid'
        );",
    )?;
    // v9 的触发器不使用 wm_preprocess_fts（v10 会修复）
    // schema.sql 终态中已使用 wm_preprocess_fts，此处 IF NOT EXISTS 不会覆盖
    Ok(())
}

/// v10：修复 fts_memory_cells 中文分词 — 重建触发器 + 重建索引
fn migration_v10(conn: &Connection) -> anyhow::Result<()> {
    // DROP 旧触发器（v9 创建的，不使用 wm_preprocess_fts）
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS memory_cells_ai;
         DROP TRIGGER IF EXISTS memory_cells_ad;
         DROP TRIGGER IF EXISTS memory_cells_au;",
    )?;

    // 重建触发器（使用 wm_preprocess_fts，与 schema.sql 终态一致）
    conn.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS memory_cells_ai AFTER INSERT ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(rowid, episode, facts) VALUES (new.rowid, wm_preprocess_fts(new.episode), wm_preprocess_fts(new.facts));
        END;
        CREATE TRIGGER IF NOT EXISTS memory_cells_ad AFTER DELETE ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(fts_memory_cells, rowid, episode, facts) VALUES ('delete', old.rowid, wm_preprocess_fts(old.episode), wm_preprocess_fts(old.facts));
        END;
        CREATE TRIGGER IF NOT EXISTS memory_cells_au AFTER UPDATE ON memory_cells BEGIN
          INSERT INTO fts_memory_cells(fts_memory_cells, rowid, episode, facts) VALUES ('delete', old.rowid, wm_preprocess_fts(old.episode), wm_preprocess_fts(old.facts));
          INSERT INTO fts_memory_cells(rowid, episode, facts) VALUES (new.rowid, wm_preprocess_fts(new.episode), wm_preprocess_fts(new.facts));
        END;",
    )?;

    // 重建索引
    conn.execute("DELETE FROM fts_memory_cells", [])?;
    conn.execute(
        "INSERT INTO fts_memory_cells(rowid, episode, facts)
         SELECT rowid, wm_preprocess_fts(episode), wm_preprocess_fts(facts) FROM memory_cells",
        [],
    )?;

    Ok(())
}

/// v11：memory_scenes 表
fn migration_v11(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_scenes (
          id                  TEXT PRIMARY KEY NOT NULL,
          title               TEXT NOT NULL,
          centroid_embedding  BLOB NOT NULL,
          member_cell_ids     TEXT NOT NULL,
          summary             TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_scenes_created_at ON memory_scenes(created_at);",
    )?;
    Ok(())
}

/// v12：user_profile 表
fn migration_v12(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_profile (
          key          TEXT PRIMARY KEY NOT NULL,
          value        TEXT NOT NULL,
          type         TEXT NOT NULL,
          confidence   REAL NOT NULL,
          valid_to     TEXT,
          sources      TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_profile_type ON user_profile(type);",
    )?;
    Ok(())
}

/// v13：daily_distills 表
fn migration_v13(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS daily_distills (
          id            TEXT PRIMARY KEY NOT NULL,
          date          TEXT NOT NULL UNIQUE,
          summary       TEXT NOT NULL,
          themes        TEXT NOT NULL,
          patterns      TEXT NOT NULL,
          memcell_ids   TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_daily_distills_date ON daily_distills(date);",
    )?;
    Ok(())
}

/// v14：causal_chains 表
fn migration_v14(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS causal_chains (
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
        CREATE INDEX IF NOT EXISTS idx_causal_chains_effect_cell ON causal_chains(effect_cell_id);",
    )?;
    Ok(())
}

/// v15：weekly_patterns 表
fn migration_v15(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS weekly_patterns (
          id            TEXT PRIMARY KEY NOT NULL,
          week_start    TEXT NOT NULL UNIQUE,
          patterns      TEXT NOT NULL,
          trend         TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_weekly_patterns_week_start ON weekly_patterns(week_start);",
    )?;
    Ok(())
}

/// v16：reflection_reports 表
fn migration_v16(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS reflection_reports (
          id            TEXT PRIMARY KEY NOT NULL,
          week_start    TEXT NOT NULL UNIQUE,
          report        TEXT NOT NULL,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reflection_reports_week_start ON reflection_reports(week_start);",
    )?;
    Ok(())
}

/// v17：skills 表
fn migration_v17(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS skills (
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
        CREATE INDEX IF NOT EXISTS idx_skills_evolved_at ON skills(evolved_at);",
    )?;
    Ok(())
}

/// v18：feedback_events 表
fn migration_v18(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS feedback_events (
          id          TEXT PRIMARY KEY NOT NULL,
          type        TEXT NOT NULL,
          target_id   TEXT NOT NULL,
          before      TEXT NOT NULL,
          after       TEXT NOT NULL,
          timestamp   TEXT NOT NULL,
          applied     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_events_type ON feedback_events(type);
        CREATE INDEX IF NOT EXISTS idx_feedback_events_applied ON feedback_events(applied);",
    )?;
    Ok(())
}

/// v4 FTS 兜底：每次启动都执行，确保 fts_clean_episodes 表健康。
///
/// 1. 重新执行 CLEAN_EPISODES_FTS_SQL（幂等）
/// 2. 尝试 rebuild fts_clean_episodes（失败吞掉异常）
fn ensure_version4_artifacts(conn: &Connection) -> anyhow::Result<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))?;
    if current < 4 {
        return Ok(());
    }

    conn.execute_batch(CLEAN_EPISODES_FTS_SQL)?;

    // 尝试 rebuild，失败吞掉（防止 FTS 损坏阻断启动）
    let _ = conn.execute(
        "INSERT INTO fts_clean_episodes(fts_clean_episodes) VALUES ('rebuild')",
        [],
    );

    Ok(())
}

/// 检查指定表的列是否已存在（SQLite 不支持 ADD COLUMN IF NOT EXISTS）
fn column_exists(conn: &Connection, table: &str, column: &str) -> anyhow::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let rows = stmt.query_map([], |row| {
        let name: String = row.get(1)?;
        Ok(name)
    })?;
    for row in rows {
        let name = row?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::fts_tokenizer::register_fts_functions;

    #[test]
    fn test_migrations_on_fresh_db() {
        let conn = Connection::open_in_memory().unwrap();
        register_fts_functions(&conn).unwrap();
        run_migrations(&conn).unwrap();

        let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!(version, CURRENT_VERSION);

        // 验证关键表存在
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(tables.contains(&"segments".to_string()));
        assert!(tables.contains(&"episodes".to_string()));
        assert!(tables.contains(&"clean_episodes".to_string()));
        assert!(tables.contains(&"memory_cells".to_string()));
        assert!(tables.contains(&"wiki_pages".to_string()));
        assert!(tables.contains(&"feedback_events".to_string()));
    }

    #[test]
    fn test_column_exists() {
        let conn = Connection::open_in_memory().unwrap();
        register_fts_functions(&conn).unwrap();
        run_migrations(&conn).unwrap();

        assert!(column_exists(&conn, "segments", "ocr_text").unwrap());
        assert!(column_exists(&conn, "segments", "activity_type").unwrap());
        assert!(column_exists(&conn, "reports", "report_type").unwrap());
        assert!(!column_exists(&conn, "segments", "nonexistent_column").unwrap());
    }
}
