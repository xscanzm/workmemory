// src-tauri/src/repositories/feedback_event_repository.rs

//! FeedbackEventRepository：用户反馈事件数据访问层（对应 electron/db/repositories/FeedbackEventRepository.ts）
//!
//! feedback_events 表存储 FeedbackLoop 记录的用户反馈事件：
//!  - type：反馈类型（'episode_renamed' | 'wiki_rejected' | 'report_edited'）
//!  - target_id：被反馈对象的 ID（Episode ID / Wiki ID / Report ID）
//!  - before / after：修改前后的内容（如原标题 / 新标题）
//!  - timestamp：ISO 时间戳
//!  - applied：0=未应用, 1=已应用（applyFeedback 处理后置 1）

use rusqlite::params;

use crate::db::database::get_database;
use crate::models::{FeedbackEvent, FeedbackEventType};

/// 从数据库行构造 FeedbackEvent。
///
/// type 字段通过 FeedbackEventType::from_str 解析。
fn row_to_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<FeedbackEvent> {
    let type_str: String = row.get("type")?;
    Ok(FeedbackEvent {
        id: row.get("id")?,
        event_type: FeedbackEventType::from_str(&type_str),
        target_id: row.get("target_id")?,
        before: row.get("before")?,
        after: row.get("after")?,
        timestamp: row.get("timestamp")?,
    })
}

/// FeedbackEventRepository：用户反馈事件数据访问层
pub struct FeedbackEventRepository;

impl FeedbackEventRepository {
    /// 插入反馈事件。id 由仓库内部生成，applied 默认为 0。
    pub fn insert(
        event_type: FeedbackEventType,
        target_id: &str,
        before: &str,
        after: &str,
        timestamp: &str,
    ) -> anyhow::Result<()> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = get_database()?;
        conn.execute(
            "INSERT INTO feedback_events (id, type, target_id, before, after, timestamp, applied)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![
                id,
                event_type.as_str(),
                target_id,
                before,
                after,
                timestamp,
            ],
        )?;
        Ok(())
    }

    /// 查询所有未应用的反馈事件（applied = 0），按 timestamp 升序。
    pub fn get_unapplied() -> anyhow::Result<Vec<FeedbackEvent>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM feedback_events WHERE applied = 0 ORDER BY timestamp ASC",
        )?;
        let events = stmt
            .query_map([], row_to_event)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(events)
    }

    /// 批量标记反馈事件为已应用（applied = 1）。
    /// 空数组时直接返回 Ok(())，否则逐条 UPDATE。
    pub fn mark_applied(ids: &[String]) -> anyhow::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let conn = get_database()?;
        for id in ids {
            conn.execute(
                "UPDATE feedback_events SET applied = 1 WHERE id = ?1",
                params![id],
            )?;
        }
        Ok(())
    }

    /// 按 type 查询反馈事件（含已应用与未应用），按 timestamp 升序。
    pub fn get_by_type(event_type: FeedbackEventType) -> anyhow::Result<Vec<FeedbackEvent>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM feedback_events WHERE type = ?1 ORDER BY timestamp ASC",
        )?;
        let events = stmt
            .query_map(params![event_type.as_str()], row_to_event)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(events)
    }
}
