// src-tauri/src/repositories/user_profile_repository.rs

//! UserProfileRepository：用户画像数据访问层（对应 electron/db/repositories/UserProfileRepository.ts）
//!
//! user_profile 表存储用户画像条目（UserProfileEntry），由 UserProfileEvolver 从
//! MemScene 摘要与 MemCell 活动中提取。画像分两类：
//!  - stable（稳定特质）：primary_activity / preferred_apps / work_pattern，置信度随一致性累积
//!  - transient（瞬态状态）：current_focus，每次更新覆盖，带 valid_to 失效日期
//!
//! sources 字段为 JSON 数组，存储来源 MemScene ID 或 MemCell ID 列表。

use rusqlite::params;

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, stringify_json_array};
use crate::models::{ProfileType, UserProfileEntry};

/// 从数据库行构造 UserProfileEntry。
///
/// type 字段通过 ProfileType::from_str 解析；valid_to 为可空字段（NULL → None）；
/// sources 解析为 JSON 数组。
fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserProfileEntry> {
    let type_str: String = row.get("type")?;
    let valid_to: Option<String> = row.get("valid_to")?;
    let sources_str: String = row.get("sources")?;

    Ok(UserProfileEntry {
        key: row.get("key")?,
        value: row.get("value")?,
        profile_type: ProfileType::from_str(&type_str),
        confidence: row.get("confidence")?,
        valid_to,
        sources: parse_json_array::<String>(&sources_str),
        updated_at: row.get("updated_at")?,
    })
}

/// UserProfileRepository：用户画像数据访问层
pub struct UserProfileRepository;

impl UserProfileRepository {
    /// 插入或更新画像条目（按 key 主键冲突时更新全部字段）。
    /// updated_at 为空时由仓库内部生成。
    pub fn upsert(entry: UserProfileEntry) -> anyhow::Result<()> {
        let updated_at = if entry.updated_at.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            entry.updated_at.clone()
        };
        let sources = stringify_json_array(&entry.sources);
        let valid_to: Option<&str> = entry.valid_to.as_deref();

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO user_profile (key, value, type, confidence, valid_to, sources, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value,
                 type = excluded.type,
                 confidence = excluded.confidence,
                 valid_to = excluded.valid_to,
                 sources = excluded.sources,
                 updated_at = excluded.updated_at",
            params![
                entry.key,
                entry.value,
                entry.profile_type.as_str(),
                entry.confidence,
                valid_to,
                sources,
                updated_at,
            ],
        )?;
        Ok(())
    }

    /// 按 key 查询画像条目，不存在返回 None。
    pub fn get(key: &str) -> anyhow::Result<Option<UserProfileEntry>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM user_profile WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_entry(row)?)),
            None => Ok(None),
        }
    }

    /// 获取所有 stable 类型画像条目（按 updated_at 降序）。
    pub fn get_stable() -> anyhow::Result<Vec<UserProfileEntry>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM user_profile WHERE type = 'stable' ORDER BY updated_at DESC",
        )?;
        let entries = stmt
            .query_map([], row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(entries)
    }

    /// 获取所有 transient 类型画像条目（按 updated_at 降序）。
    pub fn get_transient() -> anyhow::Result<Vec<UserProfileEntry>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM user_profile WHERE type = 'transient' ORDER BY updated_at DESC",
        )?;
        let entries = stmt
            .query_map([], row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(entries)
    }

    /// 获取全部画像条目（按 updated_at 降序）。
    pub fn get_all() -> anyhow::Result<Vec<UserProfileEntry>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM user_profile ORDER BY updated_at DESC")?;
        let entries = stmt
            .query_map([], row_to_entry)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(entries)
    }
}
