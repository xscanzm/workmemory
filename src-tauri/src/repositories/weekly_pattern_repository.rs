// src-tauri/src/repositories/weekly_pattern_repository.rs

//! WeeklyPatternRepository：周级模式发现数据访问层（对应 electron/db/repositories/WeeklyPatternRepository.ts）
//!
//! weekly_patterns 表存储 WeeklyPatternDetector 产出的周级模式：
//!  - week_start：周一日期（YYYY-MM-DD）
//!  - patterns：周级模式数组（JSON，WeeklyPattern[]）
//!  - trend：趋势数据（JSON，WeeklyPatternTrend）
//!
//! 按 week_start 唯一约束，upsert 时主键冲突更新全部字段。
//! id 与 created_at 由仓库内部生成/管理，不暴露给调用方。

use rusqlite::params;

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, parse_json_field, stringify_json_array};
use crate::models::{WeeklyPattern, WeeklyPatternResult, WeeklyPatternTrend};

/// 从数据库行构造 WeeklyPatternResult。
///
/// patterns 解析为 JSON 数组；trend 使用 parse_json_field 解析，
/// 解析失败时回退到 WeeklyPatternTrend::default()。
fn row_to_result(row: &rusqlite::Row<'_>) -> rusqlite::Result<WeeklyPatternResult> {
    let patterns_str: String = row.get("patterns")?;
    let trend_str: String = row.get("trend")?;

    Ok(WeeklyPatternResult {
        week_start: row.get("week_start")?,
        patterns: parse_json_array::<WeeklyPattern>(&patterns_str),
        trend: parse_json_field::<WeeklyPatternTrend>(&trend_str, WeeklyPatternTrend::default()),
        created_at: row.get("created_at")?,
    })
}

/// WeeklyPatternRepository：周级模式发现数据访问层
pub struct WeeklyPatternRepository;

impl WeeklyPatternRepository {
    /// 插入或更新周级模式结果（按 week_start 唯一约束，主键冲突时更新全部字段）。
    /// id 由仓库内部生成；created_at 为空时由仓库内部生成；更新已有记录时刷新 created_at。
    pub fn upsert(result: WeeklyPatternResult) -> anyhow::Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = if result.created_at.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            result.created_at.clone()
        };
        let patterns = stringify_json_array(&result.patterns);
        let trend = serde_json::to_string(&result.trend).unwrap_or_else(|_| "{}".to_string());

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO weekly_patterns (id, week_start, patterns, trend, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(week_start) DO UPDATE SET
                 id = excluded.id,
                 patterns = excluded.patterns,
                 trend = excluded.trend,
                 created_at = excluded.created_at",
            params![
                id,
                result.week_start,
                patterns,
                trend,
                created_at,
            ],
        )?;
        Ok(())
    }

    /// 按 week_start 查询周级模式结果，不存在返回 None。
    pub fn get_by_week_start(week_start: &str) -> anyhow::Result<Option<WeeklyPatternResult>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM weekly_patterns WHERE week_start = ?1")?;
        let mut rows = stmt.query(params![week_start])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_result(row)?)),
            None => Ok(None),
        }
    }
}
