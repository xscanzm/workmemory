//! SegmentRepository：原始工作片段数据访问层（对应 electron/db/repositories/SegmentRepository.ts）
//!
//! 全部使用参数化查询防注入；数组字段（tags）入库 JSON.stringify，出库 JSON.parse。

use rusqlite::{params, Connection};

use crate::db::json::{parse_json_array, stringify_json_array};
use crate::db::database::get_database;
use crate::models::{
    ActionFlow, ActivityType, BoundsRect, CaptureSource, ContentType, LayoutType, OcrBlock,
    SourceQuality, SourceStatus, WorkSegment,
};

/// 将可选 JSON 字符串解析为指定类型
fn parse_json_object<T: serde::de::DeserializeOwned>(value: Option<&str>) -> Option<T> {
    let v = value?;
    if v.is_empty() {
        return None;
    }
    serde_json::from_str(v).ok()
}

/// 将可选对象序列化为 JSON 字符串（None 返回空字符串）
fn stringify_optional_object<T: serde::Serialize>(value: Option<&T>) -> String {
    match value {
        Some(v) => serde_json::to_string(v).unwrap_or_default(),
        None => String::new(),
    }
}

/// 从数据库行构造 WorkSegment
fn row_to_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkSegment> {
    let tags_str: String = row.get("tags")?;
    let ocr_blocks_str: Option<String> = row.get("ocr_blocks").ok();
    let ocr_blocks_str = ocr_blocks_str.unwrap_or_else(|| "[]".to_string());
    let active_window_bounds_str: Option<String> = row.get("active_window_bounds").ok();
    let display_bounds_str: Option<String> = row.get("display_bounds").ok();
    let content_data_str: Option<String> = row.get("content_data").ok();

    let source_status_str: String = row.get("source_status")?;
    let capture_source_str: Option<String> = row.get("capture_source").ok();
    let source_quality_str: Option<String> = row.get("source_quality").ok();
    let activity_type_str: Option<String> = row.get("activity_type").ok();
    let content_type_str: Option<String> = row.get("content_type").ok();
    let layout_type_str: Option<String> = row.get("layout_type").ok();
    let action_flow_str: Option<String> = row.get("action_flow").ok();

    Ok(WorkSegment {
        id: row.get("id")?,
        date: row.get("date")?,
        start_time: row.get("start_time")?,
        end_time: row.get("end_time")?,
        duration_seconds: row.get("duration_seconds")?,
        app_name: row.get("app_name")?,
        process_name: row.get("process_name")?,
        window_title: row.get("window_title")?,
        ocr_text: row.get("ocr_text")?,
        ocr_summary: row.get("ocr_summary")?,
        image_hash: row.get("image_hash")?,
        screenshot_path: row.get("screenshot_path")?,
        is_selected_for_report: row.get::<_, i64>("is_selected_for_report")? != 0,
        is_private: row.get::<_, i64>("is_private")? != 0,
        is_important: row.get::<_, i64>("is_important")? != 0,
        is_deleted: row.get::<_, i64>("is_deleted")? != 0,
        source_status: SourceStatus::from_str(&source_status_str),
        user_title: row.get("user_title")?,
        user_summary: row.get("user_summary")?,
        user_note: row.get("user_note")?,
        tags: parse_json_array(&tags_str),
        ocr_blocks: parse_json_array(&ocr_blocks_str),
        ocr_confidence: row.get("ocr_confidence").unwrap_or(0.0),
        capture_source: capture_source_str
            .as_deref()
            .map(CaptureSource::from_str)
            .unwrap_or_default(),
        source_quality: source_quality_str
            .as_deref()
            .map(SourceQuality::from_str)
            .unwrap_or_default(),
        active_window_bounds: parse_json_object::<BoundsRect>(active_window_bounds_str.as_deref()),
        display_bounds: parse_json_object::<BoundsRect>(display_bounds_str.as_deref()),
        ocr_raw_text: row.get("ocr_raw_text").ok(),
        noise_score: row.get("noise_score").ok(),
        activity_type: activity_type_str.as_deref().map(ActivityType::from_str),
        content_type: content_type_str.as_deref().map(ContentType::from_str),
        content_data: parse_json_object::<serde_json::Value>(content_data_str.as_deref()),
        browser_url: row.get("browser_url").ok(),
        layout_type: layout_type_str.as_deref().map(LayoutType::from_str),
        action_flow: action_flow_str.as_deref().map(ActionFlow::from_str),
        created_at: row.get("created_at").unwrap_or_default(),
        updated_at: row.get("updated_at").unwrap_or_default(),
    })
}

/// 将 WorkSegment 序列化为 SQL 参数并执行 INSERT
fn insert_segment(conn: &Connection, segment: &WorkSegment) -> anyhow::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let tags = stringify_json_array(&segment.tags);
    let ocr_blocks = stringify_json_array(&segment.ocr_blocks);
    let active_window_bounds = stringify_optional_object(segment.active_window_bounds.as_ref());
    let display_bounds = stringify_optional_object(segment.display_bounds.as_ref());
    let content_data = segment
        .content_data
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default());
    let source_quality = if !segment.source_quality.as_str().is_empty() {
        segment.source_quality.as_str().to_string()
    } else if segment.is_private {
        "private".to_string()
    } else if segment.source_status == SourceStatus::OcrDone {
        "medium".to_string()
    } else {
        "low".to_string()
    };

    conn.execute(
        "INSERT INTO segments (
            id, date, start_time, end_time, duration_seconds, app_name, process_name,
            window_title, ocr_text, ocr_summary, image_hash, screenshot_path,
            is_selected_for_report, is_private, is_important, is_deleted, source_status,
            user_title, user_summary, user_note, tags, ocr_blocks, ocr_confidence,
            capture_source, source_quality, active_window_bounds, display_bounds,
            ocr_raw_text, noise_score, activity_type, content_type, content_data,
            browser_url, layout_type, action_flow, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
            ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37
        )",
        params![
            segment.id,
            segment.date,
            segment.start_time,
            segment.end_time,
            segment.duration_seconds,
            segment.app_name,
            segment.process_name,
            segment.window_title,
            segment.ocr_text,
            segment.ocr_summary,
            segment.image_hash,
            segment.screenshot_path,
            segment.is_selected_for_report as i64,
            segment.is_private as i64,
            segment.is_important as i64,
            segment.is_deleted as i64,
            segment.source_status.as_str(),
            segment.user_title,
            segment.user_summary,
            segment.user_note,
            tags,
            ocr_blocks,
            segment.ocr_confidence,
            segment.capture_source.as_str(),
            source_quality,
            active_window_bounds,
            display_bounds,
            segment.ocr_raw_text,
            segment.noise_score,
            segment.activity_type.as_ref().map(|a| a.as_str()),
            segment.content_type.as_ref().map(|c| c.as_str()),
            content_data,
            segment.browser_url,
            segment.layout_type.as_ref().map(|l| l.as_str()),
            segment.action_flow.as_ref().map(|a| a.as_str()),
            now,
            now,
        ],
    )?;
    Ok(())
}

/// 将 WorkSegment 序列化为 SQL 参数并执行 UPDATE
fn update_segment(conn: &Connection, segment: &WorkSegment) -> anyhow::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let tags = stringify_json_array(&segment.tags);
    let ocr_blocks = stringify_json_array(&segment.ocr_blocks);
    let active_window_bounds = stringify_optional_object(segment.active_window_bounds.as_ref());
    let display_bounds = stringify_optional_object(segment.display_bounds.as_ref());
    let content_data = segment
        .content_data
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default());

    conn.execute(
        "UPDATE segments SET
            date = ?2, start_time = ?3, end_time = ?4, duration_seconds = ?5,
            app_name = ?6, process_name = ?7, window_title = ?8,
            ocr_text = ?9, ocr_summary = ?10, image_hash = ?11, screenshot_path = ?12,
            is_selected_for_report = ?13, is_private = ?14, is_important = ?15,
            is_deleted = ?16, source_status = ?17, user_title = ?18, user_summary = ?19,
            user_note = ?20, tags = ?21, ocr_blocks = ?22, ocr_confidence = ?23,
            capture_source = ?24, source_quality = ?25, active_window_bounds = ?26,
            display_bounds = ?27, ocr_raw_text = ?28, noise_score = ?29,
            activity_type = ?30, content_type = ?31, content_data = ?32,
            browser_url = ?33, layout_type = ?34, action_flow = ?35, updated_at = ?36
        WHERE id = ?1",
        params![
            segment.id,
            segment.date,
            segment.start_time,
            segment.end_time,
            segment.duration_seconds,
            segment.app_name,
            segment.process_name,
            segment.window_title,
            segment.ocr_text,
            segment.ocr_summary,
            segment.image_hash,
            segment.screenshot_path,
            segment.is_selected_for_report as i64,
            segment.is_private as i64,
            segment.is_important as i64,
            segment.is_deleted as i64,
            segment.source_status.as_str(),
            segment.user_title,
            segment.user_summary,
            segment.user_note,
            tags,
            ocr_blocks,
            segment.ocr_confidence,
            segment.capture_source.as_str(),
            segment.source_quality.as_str(),
            active_window_bounds,
            display_bounds,
            segment.ocr_raw_text,
            segment.noise_score,
            segment.activity_type.as_ref().map(|a| a.as_str()),
            segment.content_type.as_ref().map(|c| c.as_str()),
            content_data,
            segment.browser_url,
            segment.layout_type.as_ref().map(|l| l.as_str()),
            segment.action_flow.as_ref().map(|a| a.as_str()),
            now,
        ],
    )?;
    Ok(())
}

/// SegmentRepository：原始工作片段数据访问层
pub struct SegmentRepository;

impl SegmentRepository {
    /// 插入 Segment，返回插入后的完整对象
    pub fn insert(segment: WorkSegment) -> anyhow::Result<WorkSegment> {
        let id = if segment.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            segment.id.clone()
        };
        let mut segment = segment;
        segment.id = id.clone();

        {
            let conn = get_database()?;
            insert_segment(&conn, &segment)?;
        }
        Self::get_by_id(&id)?
            .ok_or_else(|| anyhow::anyhow!("Segment insert failed for id={}", id))
    }

    /// 更新 Segment（合并 patch），返回更新后的对象；不存在返回 None
    pub fn update(id: &str, patch: WorkSegment) -> anyhow::Result<Option<WorkSegment>> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let merged = merge_segment(existing, patch, id);
        {
            let conn = get_database()?;
            update_segment(&conn, &merged)?;
        }
        Self::get_by_id(id)
    }

    /// 按 ID 查询 Segment
    pub fn get_by_id(id: &str) -> anyhow::Result<Option<WorkSegment>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM segments WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_segment(row)?)),
            None => Ok(None),
        }
    }

    /// 按日期查询 Segments
    pub fn get_by_date(date: &str) -> anyhow::Result<Vec<WorkSegment>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM segments WHERE date = ?1 ORDER BY start_time ASC")?;
        let segments = stmt
            .query_map(params![date], row_to_segment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(segments)
    }

    /// 按日期范围 [startDate, endDate] 查询 Segments（含两端，仅未删除）
    pub fn get_by_date_range(start_date: &str, end_date: &str) -> anyhow::Result<Vec<WorkSegment>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM segments WHERE date >= ?1 AND date <= ?2 AND is_deleted = 0 ORDER BY date ASC, start_time ASC",
        )?;
        let segments = stmt
            .query_map(params![start_date, end_date], row_to_segment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(segments)
    }

    /// 批量按 id 查询 Segments（仅未删除）
    pub fn get_by_ids(ids: &[String]) -> anyhow::Result<Vec<WorkSegment>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = get_database()?;
        let placeholders: Vec<String> = (0..ids.len()).map(|i| format!("?{}", i + 1)).collect();
        let sql = format!(
            "SELECT * FROM segments WHERE id IN ({}) AND is_deleted = 0 ORDER BY start_time ASC",
            placeholders.join(",")
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::ToSql> = ids
            .iter()
            .map(|id| id as &dyn rusqlite::ToSql)
            .collect();
        let segments = stmt
            .query_map(params.as_slice(), row_to_segment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(segments)
    }

    /// 按日期查询未删除的 Segments
    pub fn get_active_by_date(date: &str) -> anyhow::Result<Vec<WorkSegment>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM segments WHERE date = ?1 AND is_deleted = 0 ORDER BY start_time ASC",
        )?;
        let segments = stmt
            .query_map(params![date], row_to_segment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(segments)
    }

    /// 设置是否选中进入报告
    pub fn set_selected_for_report(id: &str, selected: bool) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute(
            "UPDATE segments SET is_selected_for_report = ?1 WHERE id = ?2",
            params![selected as i64, id],
        )?;
        Ok(changes > 0)
    }

    /// 设置重要标记
    pub fn set_important(id: &str, important: bool) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute(
            "UPDATE segments SET is_important = ?1 WHERE id = ?2",
            params![important as i64, id],
        )?;
        Ok(changes > 0)
    }

    /// 软删除（标记 is_deleted = 1）
    pub fn soft_delete(id: &str) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute(
            "UPDATE segments SET is_deleted = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(changes > 0)
    }

    /// 物理删除
    pub fn hard_delete(id: &str) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute("DELETE FROM segments WHERE id = ?1", params![id])?;
        Ok(changes > 0)
    }

    /// 按日期查询私有 Segments
    pub fn get_private_by_date(date: &str) -> anyhow::Result<Vec<WorkSegment>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM segments WHERE date = ?1 AND is_private = 1 AND is_deleted = 0 ORDER BY start_time ASC",
        )?;
        let segments = stmt
            .query_map(params![date], row_to_segment)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(segments)
    }
}

/// 合并现有 segment 与 patch（patch 的非空字段覆盖 existing）
fn merge_segment(mut existing: WorkSegment, patch: WorkSegment, id: &str) -> WorkSegment {
    // 简单合并策略：patch 中非默认值覆盖 existing
    // 对于 String 类型，空字符串表示未提供
    if !patch.date.is_empty() {
        existing.date = patch.date;
    }
    if !patch.start_time.is_empty() {
        existing.start_time = patch.start_time;
    }
    if !patch.end_time.is_empty() {
        existing.end_time = patch.end_time;
    }
    if patch.duration_seconds != 0 {
        existing.duration_seconds = patch.duration_seconds;
    }
    if !patch.app_name.is_empty() {
        existing.app_name = patch.app_name;
    }
    if !patch.process_name.is_empty() {
        existing.process_name = patch.process_name;
    }
    if !patch.window_title.is_empty() {
        existing.window_title = patch.window_title;
    }
    if !patch.ocr_text.is_empty() {
        existing.ocr_text = patch.ocr_text;
    }
    if !patch.ocr_summary.is_empty() {
        existing.ocr_summary = patch.ocr_summary;
    }
    if !patch.image_hash.is_empty() {
        existing.image_hash = patch.image_hash;
    }
    if !patch.screenshot_path.is_empty() {
        existing.screenshot_path = patch.screenshot_path;
    }
    // 布尔字段：总是采用 patch 值（调用方需提供完整 patch）
    existing.is_selected_for_report = patch.is_selected_for_report;
    existing.is_private = patch.is_private;
    existing.is_important = patch.is_important;
    existing.is_deleted = patch.is_deleted;
    existing.source_status = patch.source_status;
    if !patch.user_title.is_empty() {
        existing.user_title = patch.user_title;
    }
    if !patch.user_summary.is_empty() {
        existing.user_summary = patch.user_summary;
    }
    if !patch.user_note.is_empty() {
        existing.user_note = patch.user_note;
    }
    if !patch.tags.is_empty() {
        existing.tags = patch.tags;
    }
    if !patch.ocr_blocks.is_empty() {
        existing.ocr_blocks = patch.ocr_blocks;
    }
    if patch.ocr_confidence != 0.0 {
        existing.ocr_confidence = patch.ocr_confidence;
    }
    existing.capture_source = patch.capture_source;
    existing.source_quality = patch.source_quality;
    if patch.active_window_bounds.is_some() {
        existing.active_window_bounds = patch.active_window_bounds;
    }
    if patch.display_bounds.is_some() {
        existing.display_bounds = patch.display_bounds;
    }
    if patch.ocr_raw_text.is_some() {
        existing.ocr_raw_text = patch.ocr_raw_text;
    }
    if patch.noise_score.is_some() {
        existing.noise_score = patch.noise_score;
    }
    if patch.activity_type.is_some() {
        existing.activity_type = patch.activity_type;
    }
    if patch.content_type.is_some() {
        existing.content_type = patch.content_type;
    }
    if patch.content_data.is_some() {
        existing.content_data = patch.content_data;
    }
    if patch.browser_url.is_some() {
        existing.browser_url = patch.browser_url;
    }
    if patch.layout_type.is_some() {
        existing.layout_type = patch.layout_type;
    }
    if patch.action_flow.is_some() {
        existing.action_flow = patch.action_flow;
    }
    existing.id = id.to_string();
    existing
}
