// src-tauri/src/repositories/daily_distill_repository.rs

//! DailyDistillRepository：日级理解数据访问层（对应 electron/db/repositories/DailyDistillRepository.ts）
//!
//! daily_distills 表存储 DailyDistillManager 产出的日级理解结果：
//!  - summary：日级摘要（2-3 句）
//!  - themes：跨小时主题（JSON 数组，DayTheme[]）
//!  - patterns：当日模式（JSON 对象，DayPattern）
//!  - memcell_ids：涉及的 MemCell ID 列表（JSON 数组）
//!
//! 按 date 唯一约束，upsert 时主键冲突更新全部字段。
//! id 与 created_at 由仓库内部生成/管理，不暴露给调用方。

use rusqlite::params;

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, parse_json_field, stringify_json_array};
use crate::models::{DayDistillResult, DayPattern, DayTheme, TimeRange};

/// 从数据库行构造 DayDistillResult。
///
/// themes 解析为 JSON 数组；patterns 使用 parse_json_field 解析，
/// 解析失败时回退到空模式默认值；memcell_ids 解析为 JSON 数组。
fn row_to_result(row: &rusqlite::Row<'_>) -> rusqlite::Result<DayDistillResult> {
    let themes_str: String = row.get("themes")?;
    let patterns_str: String = row.get("patterns")?;
    let memcell_ids_str: String = row.get("memcell_ids")?;

    let default_patterns = DayPattern {
        deep_work_hours: 0.0,
        fragmented_periods: Vec::<TimeRange>::new(),
        switch_count: 0,
        active_hours: 0.0,
        dominant_activity: String::new(),
    };

    Ok(DayDistillResult {
        date: row.get("date")?,
        summary: row.get("summary")?,
        themes: parse_json_array::<DayTheme>(&themes_str),
        patterns: parse_json_field::<DayPattern>(&patterns_str, default_patterns),
        memcell_ids: parse_json_array::<String>(&memcell_ids_str),
    })
}

/// DailyDistillRepository：日级理解数据访问层
pub struct DailyDistillRepository;

impl DailyDistillRepository {
    /// 插入或更新日级理解结果（按 date 唯一约束，主键冲突时更新全部字段）。
    /// id 与 created_at 由仓库内部生成；更新已有记录时刷新 created_at。
    pub fn upsert(result: DayDistillResult) -> anyhow::Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339();

        let themes = stringify_json_array(&result.themes);
        let patterns = serde_json::to_string(&result.patterns).unwrap_or_else(|_| "{}".to_string());
        let memcell_ids = stringify_json_array(&result.memcell_ids);

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO daily_distills (id, date, summary, themes, patterns, memcell_ids, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(date) DO UPDATE SET
                 id = excluded.id,
                 summary = excluded.summary,
                 themes = excluded.themes,
                 patterns = excluded.patterns,
                 memcell_ids = excluded.memcell_ids,
                 created_at = excluded.created_at",
            params![
                id,
                result.date,
                result.summary,
                themes,
                patterns,
                memcell_ids,
                created_at,
            ],
        )?;
        Ok(())
    }

    /// 按日期查询日级理解结果，不存在返回 None。
    pub fn get_by_date(date: &str) -> anyhow::Result<Option<DayDistillResult>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM daily_distills WHERE date = ?1")?;
        let mut rows = stmt.query(params![date])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_result(row)?)),
            None => Ok(None),
        }
    }

    /// 按日期范围查询日级理解结果（含两端，按 date 升序）。
    pub fn get_by_date_range(
        start_date: &str,
        end_date: &str,
    ) -> anyhow::Result<Vec<DayDistillResult>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM daily_distills WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC",
        )?;
        let results = stmt
            .query_map(params![start_date, end_date], row_to_result)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(results)
    }
}
