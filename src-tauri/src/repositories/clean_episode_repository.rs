//! CleanEpisodeRepository：工作记忆事件数据访问层（对应 electron/db/repositories/CleanEpisodeRepository.ts）

use rusqlite::{params, Connection};

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, stringify_json_array};
use crate::models::{
    CleanEpisode, EntityRef, EvidenceRef, MemoryKind, SourceQuality, WikiStatus,
};

fn row_to_clean_episode(row: &rusqlite::Row<'_>) -> rusqlite::Result<CleanEpisode> {
    let entities_str: String = row.get("entities")?;
    let topics_str: String = row.get("topics")?;
    let materials_str: String = row.get("materials")?;
    let outputs_str: String = row.get("outputs")?;
    let todos_str: String = row.get("todos")?;
    let blockers_str: String = row.get("blockers")?;
    let segment_ids_str: String = row.get("segment_ids")?;
    let evidence_refs_str: String = row.get("evidence_refs")?;
    let memory_kind_str: String = row.get("memory_kind")?;
    let source_quality_str: String = row.get("source_quality")?;
    let wiki_status_str: String = row.get("wiki_status")?;

    Ok(CleanEpisode {
        id: row.get("id")?,
        date: row.get("date")?,
        hour_bucket: row.get("hour_bucket")?,
        start_time: row.get("start_time")?,
        end_time: row.get("end_time")?,
        title: row.get("title")?,
        summary: row.get("summary")?,
        memory_kind: MemoryKind::from_str(&memory_kind_str),
        project: row.get("project")?,
        entities: parse_json_array(&entities_str),
        topics: parse_json_array(&topics_str),
        materials: parse_json_array(&materials_str),
        outputs: parse_json_array(&outputs_str),
        todos: parse_json_array(&todos_str),
        blockers: parse_json_array(&blockers_str),
        segment_ids: parse_json_array(&segment_ids_str),
        evidence_refs: parse_json_array(&evidence_refs_str),
        source_quality: SourceQuality::from_str(&source_quality_str),
        confidence: row.get("confidence")?,
        report_eligible: row.get::<_, i64>("report_eligible")? != 0,
        wiki_eligible: row.get::<_, i64>("wiki_eligible")? != 0,
        wiki_status: WikiStatus::from_str(&wiki_status_str),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        model_name: row.get("model_name")?,
        distill_version: row.get("distill_version")?,
    })
}

fn insert_clean_episode(conn: &Connection, episode: &CleanEpisode) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO clean_episodes (
            id, date, hour_bucket, start_time, end_time, title, summary,
            memory_kind, project, entities, topics, materials, outputs, todos,
            blockers, segment_ids, evidence_refs, source_quality, confidence,
            report_eligible, wiki_eligible, wiki_status, created_at, updated_at,
            model_name, distill_version
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26
        )",
        params![
            episode.id,
            episode.date,
            episode.hour_bucket,
            episode.start_time,
            episode.end_time,
            episode.title,
            episode.summary,
            episode.memory_kind.as_str(),
            episode.project,
            stringify_json_array(&episode.entities),
            stringify_json_array(&episode.topics),
            stringify_json_array(&episode.materials),
            stringify_json_array(&episode.outputs),
            stringify_json_array(&episode.todos),
            stringify_json_array(&episode.blockers),
            stringify_json_array(&episode.segment_ids),
            stringify_json_array(&episode.evidence_refs),
            episode.source_quality.as_str(),
            episode.confidence,
            episode.report_eligible as i64,
            episode.wiki_eligible as i64,
            episode.wiki_status.as_str(),
            episode.created_at,
            episode.updated_at,
            episode.model_name,
            episode.distill_version,
        ],
    )?;
    Ok(())
}

fn update_clean_episode_full(conn: &Connection, episode: &CleanEpisode) -> anyhow::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE clean_episodes SET
            date = ?2, hour_bucket = ?3, start_time = ?4, end_time = ?5,
            title = ?6, summary = ?7, memory_kind = ?8, project = ?9,
            entities = ?10, topics = ?11, materials = ?12, outputs = ?13,
            todos = ?14, blockers = ?15, segment_ids = ?16, evidence_refs = ?17,
            source_quality = ?18, confidence = ?19, report_eligible = ?20,
            wiki_eligible = ?21, wiki_status = ?22, updated_at = ?23,
            model_name = ?24, distill_version = ?25
        WHERE id = ?1",
        params![
            episode.id,
            episode.date,
            episode.hour_bucket,
            episode.start_time,
            episode.end_time,
            episode.title,
            episode.summary,
            episode.memory_kind.as_str(),
            episode.project,
            stringify_json_array(&episode.entities),
            stringify_json_array(&episode.topics),
            stringify_json_array(&episode.materials),
            stringify_json_array(&episode.outputs),
            stringify_json_array(&episode.todos),
            stringify_json_array(&episode.blockers),
            stringify_json_array(&episode.segment_ids),
            stringify_json_array(&episode.evidence_refs),
            episode.source_quality.as_str(),
            episode.confidence,
            episode.report_eligible as i64,
            episode.wiki_eligible as i64,
            episode.wiki_status.as_str(),
            now,
            episode.model_name,
            episode.distill_version,
        ],
    )?;
    Ok(())
}

pub struct CleanEpisodeRepository;

impl CleanEpisodeRepository {
    pub fn insert(episode: CleanEpisode) -> anyhow::Result<CleanEpisode> {
        let id = if episode.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            episode.id.clone()
        };
        let ts = if episode.created_at.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            episode.created_at.clone()
        };
        let updated_at = if episode.updated_at.is_empty() {
            ts.clone()
        } else {
            episode.updated_at.clone()
        };
        let mut episode = episode;
        episode.id = id.clone();
        episode.created_at = ts;
        episode.updated_at = updated_at;

        {
            let conn = get_database()?;
            insert_clean_episode(&conn, &episode)?;
        }
        Self::get_by_id(&id)?
            .ok_or_else(|| anyhow::anyhow!("CleanEpisode insert failed for id={}", id))
    }

    pub fn update(id: &str, patch: CleanEpisode) -> anyhow::Result<Option<CleanEpisode>> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let merged = merge_clean_episode(existing, patch, id);
        {
            let conn = get_database()?;
            update_clean_episode_full(&conn, &merged)?;
        }
        Self::get_by_id(id)
    }

    pub fn get_by_id(id: &str) -> anyhow::Result<Option<CleanEpisode>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM clean_episodes WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_clean_episode(row)?)),
            None => Ok(None),
        }
    }

    pub fn get_by_date(date: &str) -> anyhow::Result<Vec<CleanEpisode>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM clean_episodes WHERE date = ?1 ORDER BY start_time ASC",
        )?;
        let episodes = stmt
            .query_map(params![date], row_to_clean_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    pub fn get_by_hour(date: &str, hour_bucket: &str) -> anyhow::Result<Vec<CleanEpisode>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM clean_episodes WHERE date = ?1 AND hour_bucket = ?2 ORDER BY start_time ASC",
        )?;
        let episodes = stmt
            .query_map(params![date, hour_bucket], row_to_clean_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    pub fn get_by_date_range(
        start_date: &str,
        end_date: &str,
    ) -> anyhow::Result<Vec<CleanEpisode>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM clean_episodes WHERE date >= ?1 AND date <= ?2 ORDER BY date ASC, start_time ASC",
        )?;
        let episodes = stmt
            .query_map(params![start_date, end_date], row_to_clean_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    pub fn get_by_wiki_status(status: WikiStatus) -> anyhow::Result<Vec<CleanEpisode>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM clean_episodes WHERE wiki_status = ?1 ORDER BY date DESC, start_time DESC",
        )?;
        let episodes = stmt
            .query_map(params![status.as_str()], row_to_clean_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    pub fn get_wiki_candidates(days: i64) -> anyhow::Result<Vec<CleanEpisode>> {
        let end = chrono::Utc::now();
        let start = end - chrono::Duration::days(days);
        let fmt = |d: chrono::DateTime<chrono::Utc>| d.format("%Y-%m-%d").to_string();
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM clean_episodes
             WHERE date >= ?1 AND date <= ?2
               AND wiki_eligible = 1
               AND wiki_status IN ('candidate', 'none')
             ORDER BY confidence DESC, date DESC, start_time DESC",
        )?;
        let episodes = stmt
            .query_map(params![fmt(start), fmt(end)], row_to_clean_episode)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(episodes)
    }

    pub fn delete_by_hour(date: &str, hour_bucket: &str) -> anyhow::Result<usize> {
        let conn = get_database()?;
        let changes = conn.execute(
            "DELETE FROM clean_episodes WHERE date = ?1 AND hour_bucket = ?2",
            params![date, hour_bucket],
        )?;
        Ok(changes)
    }
}

fn merge_clean_episode(
    mut existing: CleanEpisode,
    patch: CleanEpisode,
    id: &str,
) -> CleanEpisode {
    if !patch.date.is_empty() {
        existing.date = patch.date;
    }
    if !patch.hour_bucket.is_empty() {
        existing.hour_bucket = patch.hour_bucket;
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
    if !patch.summary.is_empty() {
        existing.summary = patch.summary;
    }
    // memory_kind 总是采用 patch 值
    existing.memory_kind = patch.memory_kind;
    if !patch.project.is_empty() {
        existing.project = patch.project;
    }
    if !patch.entities.is_empty() {
        existing.entities = patch.entities;
    }
    if !patch.topics.is_empty() {
        existing.topics = patch.topics;
    }
    if !patch.materials.is_empty() {
        existing.materials = patch.materials;
    }
    if !patch.outputs.is_empty() {
        existing.outputs = patch.outputs;
    }
    if !patch.todos.is_empty() {
        existing.todos = patch.todos;
    }
    if !patch.blockers.is_empty() {
        existing.blockers = patch.blockers;
    }
    if !patch.segment_ids.is_empty() {
        existing.segment_ids = patch.segment_ids;
    }
    if !patch.evidence_refs.is_empty() {
        existing.evidence_refs = patch.evidence_refs;
    }
    existing.source_quality = patch.source_quality;
    existing.confidence = patch.confidence;
    existing.report_eligible = patch.report_eligible;
    existing.wiki_eligible = patch.wiki_eligible;
    existing.wiki_status = patch.wiki_status;
    if !patch.model_name.is_empty() {
        existing.model_name = patch.model_name;
    }
    if !patch.distill_version.is_empty() {
        existing.distill_version = patch.distill_version;
    }
    existing.id = id.to_string();
    existing
}
