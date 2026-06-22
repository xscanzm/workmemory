//! EpisodeRepository：工作事件数据访问层（对应 electron/db/repositories/EpisodeRepository.ts）
//!
//! 含 userEdited 保护逻辑：若 user_edited=1 则 set_one_line_summary 拒绝覆盖并返回 false。

use rusqlite::{params, Connection};

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, stringify_json_array};
use crate::models::{EntityRef, EntityRefType, Episode};

fn row_to_episode(row: &rusqlite::Row<'_>) -> rusqlite::Result<Episode> {
    let segment_ids_str: String = row.get("segment_ids")?;
    let entities_str: String = row.get("entities")?;
    let topics_str: String = row.get("topics")?;

    Ok(Episode {
        id: row.get("id")?,
        date: row.get("date")?,
        start_time: row.get("start_time")?,
        end_time: row.get("end_time")?,
        title: row.get("title")?,
        one_line_summary: row.get("one_line_summary")?,
        segment_ids: parse_json_array(&segment_ids_str),
        entities: parse_json_array(&entities_str),
        topics: parse_json_array(&topics_str),
        user_edited: row.get::<_, i64>("user_edited")? != 0,
        report_eligible: row.get::<_, i64>("report_eligible")? != 0,
        wiki_eligible: row.get::<_, i64>("wiki_eligible")? != 0,
        dominant_activity_type: None,
    })
}

fn insert_episode(conn: &Connection, episode: &Episode) -> anyhow::Result<()> {
    let segment_ids = stringify_json_array(&episode.segment_ids);
    let entities = stringify_json_array(&episode.entities);
    let topics = stringify_json_array(&episode.topics);

    conn.execute(
        "INSERT INTO episodes (
            id, date, start_time, end_time, title, one_line_summary,
            segment_ids, entities, topics, user_edited, report_eligible, wiki_eligible
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
        )",
        params![
            episode.id,
            episode.date,
            episode.start_time,
            episode.end_time,
            episode.title,
            episode.one_line_summary,
            segment_ids,
            entities,
            topics,
            episode.user_edited as i64,
            episode.report_eligible as i64,
            episode.wiki_eligible as i64,
        ],
    )?;
    Ok(())
}

fn update_episode_full(conn: &Connection, episode: &Episode) -> anyhow::Result<()> {
    let segment_ids = stringify_json_array(&episode.segment_ids);
    let entities = stringify_json_array(&episode.entities);
    let topics = stringify_json_array(&episode.topics);

    conn.execute(
        "UPDATE episodes SET
            date = ?2, start_time = ?3, end_time = ?4, title = ?5,
            one_line_summary = ?6, segment_ids = ?7, entities = ?8,
            topics = ?9, user_edited = ?10, report_eligible = ?11,
            wiki_eligible = ?12
        WHERE id = ?1",
        params![
            episode.id,
            episode.date,
            episode.start_time,
            episode.end_time,
            episode.title,
            episode.one_line_summary,
            segment_ids,
            entities,
            topics,
            episode.user_edited as i64,
            episode.report_eligible as i64,
            episode.wiki_eligible as i64,
        ],
    )?;
    Ok(())
}

/// 仅更新 entities 字段
fn update_entities(conn: &Connection, id: &str, entities: &[EntityRef]) -> anyhow::Result<()> {
    let entities_str = stringify_json_array(entities);
    conn.execute(
        "UPDATE episodes SET entities = ?1 WHERE id = ?2",
        params![entities_str, id],
    )?;
    Ok(())
}

pub struct EpisodeRepository;

impl EpisodeRepository {
    pub fn insert(episode: Episode) -> anyhow::Result<Episode> {
        let id = if episode.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            episode.id.clone()
        };
        let mut episode = episode;
        episode.id = id.clone();

        {
            let conn = get_database()?;
            insert_episode(&conn, &episode)?;
        }
        Self::get_by_id(&id)?
            .ok_or_else(|| anyhow::anyhow!("Episode insert failed for id={}", id))
    }

    pub fn update(id: &str, patch: Episode) -> anyhow::Result<Option<Episode>> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let merged = merge_episode(existing, patch, id);
        {
            let conn = get_database()?;
            update_episode_full(&conn, &merged)?;
        }
        Self::get_by_id(id)
    }

    pub fn get_by_id(id: &str) -> anyhow::Result<Option<Episode>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM episodes WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_episode(row)?)),
            None => Ok(None),
        }
    }

    pub fn get_by_date(date: &str) -> anyhow::Result<Vec<Episode>> {
        let conn = get_database()?;
        let mut stmt =
            conn.prepare("SELECT * FROM episodes WHERE date = ?1 ORDER BY start_time ASC")?;
        let episodes = stmt
            .query_map(params![date], row_to_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    /// 按日期范围 [startDate, endDate] 查询 Episodes（含两端）
    pub fn get_by_date_range(start_date: &str, end_date: &str) -> anyhow::Result<Vec<Episode>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM episodes WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC, start_time ASC",
        )?;
        let episodes = stmt
            .query_map(params![start_date, end_date], row_to_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    /// 获取最近 N 天的 Episodes（含今日）
    pub fn get_recent(days: i64) -> anyhow::Result<Vec<Episode>> {
        let end = chrono::Utc::now();
        let start = end - chrono::Duration::days(days);
        let fmt = |d: chrono::DateTime<chrono::Utc>| d.format("%Y-%m-%d").to_string();
        Self::get_by_date_range(&fmt(start), &fmt(end))
    }

    /// 获取全库所有 Episodes（按日期升序）
    pub fn get_all() -> anyhow::Result<Vec<Episode>> {
        let conn = get_database()?;
        let mut stmt =
            conn.prepare("SELECT * FROM episodes ORDER BY date ASC, start_time ASC")?;
        let episodes = stmt
            .query_map([], row_to_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    /// 设置一句话总结。若 user_edited=1 则拒绝覆盖并返回 false。
    pub fn set_one_line_summary(id: &str, summary: &str) -> anyhow::Result<bool> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(false),
        };
        if existing.user_edited {
            return Ok(false);
        }
        let conn = get_database()?;
        let changes = conn.execute(
            "UPDATE episodes SET one_line_summary = ?1 WHERE id = ?2 AND user_edited = 0",
            params![summary, id],
        )?;
        Ok(changes > 0)
    }

    pub fn set_report_eligible(id: &str, eligible: bool) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute(
            "UPDATE episodes SET report_eligible = ?1 WHERE id = ?2",
            params![eligible as i64, id],
        )?;
        Ok(changes > 0)
    }

    pub fn set_wiki_eligible(id: &str, eligible: bool) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute(
            "UPDATE episodes SET wiki_eligible = ?1 WHERE id = ?2",
            params![eligible as i64, id],
        )?;
        Ok(changes > 0)
    }

    /// 确认实体：标记 user_confirmed=true
    pub fn confirm_entity(
        id: &str,
        entity_type: EntityRefType,
        entity_name: &str,
    ) -> anyhow::Result<Option<Episode>> {
        let mut existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let mut found = false;
        for e in existing.entities.iter_mut() {
            if e.ref_type == entity_type && e.name == entity_name {
                e.user_confirmed = true;
                found = true;
            }
        }
        if !found {
            return Ok(None);
        }
        {
            let conn = get_database()?;
            update_entities(&conn, id, &existing.entities)?;
        }
        Self::get_by_id(id)
    }

    /// 修正实体名：更新 name 并标记 user_confirmed=true
    pub fn correct_entity(
        id: &str,
        entity_type: EntityRefType,
        entity_name: &str,
        new_name: &str,
    ) -> anyhow::Result<Option<Episode>> {
        let mut existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let mut found = false;
        for e in existing.entities.iter_mut() {
            if e.ref_type == entity_type && e.name == entity_name {
                e.name = new_name.to_string();
                e.user_confirmed = true;
                found = true;
            }
        }
        if !found {
            return Ok(None);
        }
        {
            let conn = get_database()?;
            update_entities(&conn, id, &existing.entities)?;
        }
        Self::get_by_id(id)
    }

    /// 忽略实体：从 episode.entities 中移除匹配的实体
    pub fn ignore_entity(
        id: &str,
        entity_type: EntityRefType,
        entity_name: &str,
    ) -> anyhow::Result<Option<Episode>> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let before_len = existing.entities.len();
        let entities: Vec<EntityRef> = existing
            .entities
            .iter()
            .filter(|e| !(e.ref_type == entity_type && e.name == entity_name))
            .cloned()
            .collect();
        if entities.len() == before_len {
            return Ok(None);
        }
        {
            let conn = get_database()?;
            update_entities(&conn, id, &entities)?;
        }
        Self::get_by_id(id)
    }

    pub fn hard_delete(id: &str) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute("DELETE FROM episodes WHERE id = ?1", params![id])?;
        Ok(changes > 0)
    }
}

/// 合并现有 episode 与 patch（patch 的非空字段覆盖 existing）
fn merge_episode(mut existing: Episode, patch: Episode, id: &str) -> Episode {
    if !patch.date.is_empty() {
        existing.date = patch.date;
    }
    if !patch.start_time.is_empty() {
        existing.start_time = patch.start_time;
    }
    if !patch.end_time.is_empty() {
        existing.end_time = patch.end_time;
    }
    if !patch.title.is_empty() {
        existing.title = patch.title;
    }
    if !patch.one_line_summary.is_empty() {
        existing.one_line_summary = patch.one_line_summary;
    }
    if !patch.segment_ids.is_empty() {
        existing.segment_ids = patch.segment_ids;
    }
    if !patch.entities.is_empty() {
        existing.entities = patch.entities;
    }
    if !patch.topics.is_empty() {
        existing.topics = patch.topics;
    }
    // 布尔字段总是采用 patch 值
    existing.user_edited = patch.user_edited;
    existing.report_eligible = patch.report_eligible;
    existing.wiki_eligible = patch.wiki_eligible;
    if patch.dominant_activity_type.is_some() {
        existing.dominant_activity_type = patch.dominant_activity_type;
    }
    existing.id = id.to_string();
    existing
}
