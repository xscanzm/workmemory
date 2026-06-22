//! ReportRepository：日报/周报数据访问层（对应 electron/db/repositories/ReportRepository.ts）

use rusqlite::{params, Connection};

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, stringify_json_array};
use crate::models::{Report, ReportStatus, ReportTemplate, ReportType};

fn row_to_report(row: &rusqlite::Row<'_>) -> rusqlite::Result<Report> {
    let segment_ids_str: String = row.get("segment_ids")?;
    let template_id_str: String = row.get("template_id")?;
    let status_str: String = row.get("status")?;
    let report_type_str: Option<String> = row.get("report_type").ok();
    let ai_input_snapshot: Option<String> = row.get("ai_input_snapshot").ok();
    let prompt_snapshot: Option<String> = row.get("prompt_snapshot").ok();

    Ok(Report {
        id: row.get("id")?,
        date: row.get("date")?,
        template_id: ReportTemplate::from_str(&template_id_str),
        template_name: row.get("template_name")?,
        segment_ids: parse_json_array(&segment_ids_str),
        ai_input_snapshot: ai_input_snapshot
            .or(prompt_snapshot)
            .unwrap_or_default(),
        markdown_content: row.get("markdown_content")?,
        status: ReportStatus::from_str(&status_str),
        report_type: report_type_str
            .as_deref()
            .map(ReportType::from_str)
            .unwrap_or_default(),
    })
}

pub struct ReportRepository;

impl ReportRepository {
    pub fn insert(report: Report) -> anyhow::Result<Report> {
        let id = if report.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            report.id.clone()
        };
        let mut report = report;
        report.id = id.clone();

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO reports (
                id, date, template_id, template_name, segment_ids,
                ai_input_snapshot, prompt_snapshot, markdown_content, status, report_type
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
            )",
            params![
                report.id,
                report.date,
                report.template_id.as_str(),
                report.template_name,
                stringify_json_array(&report.segment_ids),
                report.ai_input_snapshot,
                report.ai_input_snapshot,
                report.markdown_content,
                report.status.as_str(),
                report.report_type.as_str(),
            ],
        )?;
        drop(conn);
        Self::get_by_id(&id)?
            .ok_or_else(|| anyhow::anyhow!("Report insert failed for id={}", id))
    }

    pub fn update(id: &str, patch: Report) -> anyhow::Result<Option<Report>> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let merged = merge_report(existing, patch, id);
        let conn = get_database()?;
        conn.execute(
            "UPDATE reports SET
                date = ?2, template_id = ?3, template_name = ?4, segment_ids = ?5,
                ai_input_snapshot = ?6, prompt_snapshot = ?7, markdown_content = ?8,
                status = ?9, report_type = ?10
            WHERE id = ?1",
            params![
                merged.id,
                merged.date,
                merged.template_id.as_str(),
                merged.template_name,
                stringify_json_array(&merged.segment_ids),
                merged.ai_input_snapshot,
                merged.ai_input_snapshot,
                merged.markdown_content,
                merged.status.as_str(),
                merged.report_type.as_str(),
            ],
        )?;
        drop(conn);
        Self::get_by_id(id)
    }

    pub fn get_by_id(id: &str) -> anyhow::Result<Option<Report>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM reports WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_report(row)?)),
            None => Ok(None),
        }
    }

    pub fn get_by_date(date: &str) -> anyhow::Result<Vec<Report>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM reports WHERE date = ?1 ORDER BY rowid DESC")?;
        let reports = stmt
            .query_map(params![date], row_to_report)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(reports)
    }

    pub fn get_all_history() -> anyhow::Result<Vec<Report>> {
        let conn = get_database()?;
        let mut stmt =
            conn.prepare("SELECT * FROM reports ORDER BY date DESC, rowid DESC")?;
        let reports = stmt
            .query_map([], row_to_report)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(reports)
    }

    pub fn set_status(id: &str, status: ReportStatus) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute(
            "UPDATE reports SET status = ?1 WHERE id = ?2",
            params![status.as_str(), id],
        )?;
        Ok(changes > 0)
    }
}

fn merge_report(mut existing: Report, patch: Report, id: &str) -> Report {
    if !patch.date.is_empty() {
        existing.date = patch.date;
    }
    existing.template_id = patch.template_id;
    if !patch.template_name.is_empty() {
        existing.template_name = patch.template_name;
    }
    if !patch.segment_ids.is_empty() {
        existing.segment_ids = patch.segment_ids;
    }
    if !patch.ai_input_snapshot.is_empty() {
        existing.ai_input_snapshot = patch.ai_input_snapshot;
    }
    if !patch.markdown_content.is_empty() {
        existing.markdown_content = patch.markdown_content;
    }
    existing.status = patch.status;
    existing.report_type = patch.report_type;
    existing.id = id.to_string();
    existing
}
