// src-tauri/src/repositories/reflection_report_repository.rs

//! ReflectionReportRepository：周级反思报告数据访问层（对应 electron/db/repositories/ReflectionReportRepository.ts）
//!
//! reflection_reports 表存储 ReflectionEngine 产出的周级反思报告：
//!  - week_start：周一日期（YYYY-MM-DD）
//!  - report：反思报告（JSON 对象，ReflectionReport）
//!
//! 按 week_start 唯一约束，upsert 时主键冲突更新全部字段。
//! id 与 created_at 由仓库内部生成/管理，不暴露给调用方。

use rusqlite::params;

use crate::db::database::get_database;
use crate::db::json::parse_json_field;
use crate::models::ReflectionReport;

/// 从数据库行构造 ReflectionReport。
///
/// 反序列化时以空报告兜底，避免脏数据导致解析失败；
/// 确保关键字段存在（旧数据兼容）：week_start/created_at 为空时回退到行值，
/// patterns/suggestions/trends 默认为空数组。
fn row_to_report(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReflectionReport> {
    let report_str: String = row.get("report")?;
    let week_start: String = row.get("week_start")?;
    let created_at: String = row.get("created_at")?;

    let fallback = ReflectionReport {
        week_start: week_start.clone(),
        patterns: Vec::new(),
        suggestions: Vec::new(),
        trends: Vec::new(),
        created_at: created_at.clone(),
    };

    let parsed = parse_json_field::<ReflectionReport>(&report_str, fallback);

    // 确保关键字段存在（旧数据兼容）
    let mut report = parsed;
    if report.week_start.is_empty() {
        report.week_start = week_start;
    }
    if report.created_at.is_empty() {
        report.created_at = created_at;
    }
    // patterns/suggestions/trends 通过 #[serde(default)] 默认为空数组

    Ok(report)
}

/// ReflectionReportRepository：周级反思报告数据访问层
pub struct ReflectionReportRepository;

impl ReflectionReportRepository {
    /// 插入或更新周级反思报告（按 week_start 唯一约束，主键冲突时更新全部字段）。
    /// id 由仓库内部生成；created_at 为空时由仓库内部生成；更新已有记录时刷新 created_at。
    pub fn upsert(report: ReflectionReport) -> anyhow::Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = if report.created_at.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            report.created_at.clone()
        };
        let report_json = serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string());

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO reflection_reports (id, week_start, report, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(week_start) DO UPDATE SET
                 id = excluded.id,
                 report = excluded.report,
                 created_at = excluded.created_at",
            params![
                id,
                report.week_start,
                report_json,
                created_at,
            ],
        )?;
        Ok(())
    }

    /// 按 week_start 查询周级反思报告，不存在返回 None。
    pub fn get_by_week_start(week_start: &str) -> anyhow::Result<Option<ReflectionReport>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM reflection_reports WHERE week_start = ?1")?;
        let mut rows = stmt.query(params![week_start])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_report(row)?)),
            None => Ok(None),
        }
    }
}
