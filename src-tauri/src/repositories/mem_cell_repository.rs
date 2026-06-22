// src-tauri/src/repositories/mem_cell_repository.rs

//! MemCellRepository：结构化记忆单元数据访问层（对应 electron/db/repositories/MemCellRepository.ts）
//!
//! memory_cells 表存储 MemCell（episode/facts/foresight/metadata），
//! 通过 clean_episode_id 外键关联 clean_episodes 表。
//! 数组/对象字段（facts/foresight/metadata）入库 JSON 序列化，出库 JSON 反序列化。

use rusqlite::params;

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, parse_json_field, stringify_json_array};
use crate::models::{Foresight, MemCell, MemCellMetadata};

/// 从数据库行构造 MemCell。
///
/// facts/foresight 解析为 JSON 数组；metadata 使用 parse_json_field 解析，
/// 解析失败时回退到 MemCellMetadata::default()。
fn row_to_mem_cell(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemCell> {
    let facts_str: String = row.get("facts")?;
    let foresight_str: String = row.get("foresight")?;
    let metadata_str: String = row.get("metadata")?;

    Ok(MemCell {
        id: row.get("id")?,
        clean_episode_id: row.get("clean_episode_id")?,
        episode: row.get("episode")?,
        facts: parse_json_array::<String>(&facts_str),
        foresight: parse_json_array::<Foresight>(&foresight_str),
        metadata: parse_json_field::<MemCellMetadata>(&metadata_str, MemCellMetadata::default()),
        created_at: row.get("created_at")?,
    })
}

/// MemCellRepository：结构化记忆单元数据访问层
pub struct MemCellRepository;

impl MemCellRepository {
    /// 插入 MemCell，JSON 序列化 facts/foresight/metadata。
    ///
    /// id/created_at 为空时自动生成。
    pub fn insert(mut mem_cell: MemCell) -> anyhow::Result<()> {
        if mem_cell.id.is_empty() {
            mem_cell.id = uuid::Uuid::new_v4().to_string();
        }
        if mem_cell.created_at.is_empty() {
            mem_cell.created_at = chrono::Utc::now().to_rfc3339();
        }

        let facts = stringify_json_array(&mem_cell.facts);
        let foresight = stringify_json_array(&mem_cell.foresight);
        let metadata = serde_json::to_string(&mem_cell.metadata).unwrap_or_else(|_| "{}".to_string());

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO memory_cells (
                id, clean_episode_id, episode, facts, foresight, metadata, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7
            )",
            params![
                mem_cell.id,
                mem_cell.clean_episode_id,
                mem_cell.episode,
                facts,
                foresight,
                metadata,
                mem_cell.created_at,
            ],
        )?;
        Ok(())
    }

    /// 按 ID 查询 MemCell，JSON 反序列化 facts/foresight/metadata。
    pub fn get_by_id(id: &str) -> anyhow::Result<Option<MemCell>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM memory_cells WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_mem_cell(row)?)),
            None => Ok(None),
        }
    }

    /// 按关联 CleanEpisode 查询，按 created_at 升序排列。
    pub fn get_by_clean_episode_id(clean_episode_id: &str) -> anyhow::Result<Vec<MemCell>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM memory_cells WHERE clean_episode_id = ?1 ORDER BY created_at ASC",
        )?;
        let cells = stmt
            .query_map(params![clean_episode_id], row_to_mem_cell)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(cells)
    }

    /// 按创建时间范围查询（基于 created_at，含两端），按 created_at 升序排列。
    pub fn get_by_date_range(start_date: &str, end_date: &str) -> anyhow::Result<Vec<MemCell>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM memory_cells
             WHERE created_at >= ?1 AND created_at <= ?2
             ORDER BY created_at ASC",
        )?;
        let cells = stmt
            .query_map(params![start_date, end_date], row_to_mem_cell)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(cells)
    }

    /// 删除指定日期指定小时创建的 MemCell（用于重新蒸馏时清理旧数据）。
    ///
    /// # 参数
    /// - `date`：格式 YYYY-MM-DD
    /// - `hour`：0-23，基于 created_at ISO 时间戳前缀匹配（hour 零填充至 2 位）
    ///
    /// # 返回
    /// 实际删除的行数
    pub fn delete_by_hour(date: &str, hour: i32) -> anyhow::Result<usize> {
        let hour_str = format!("{:02}", hour);
        let conn = get_database()?;
        let changes = conn.execute(
            "DELETE FROM memory_cells
             WHERE substr(created_at, 1, 10) = ?1
               AND substr(created_at, 12, 2) = ?2",
            params![date, hour_str],
        )?;
        Ok(changes)
    }
}
