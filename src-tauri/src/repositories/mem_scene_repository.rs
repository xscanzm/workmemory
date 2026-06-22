// src-tauri/src/repositories/mem_scene_repository.rs

//! MemSceneRepository：MemScene 主题场景数据访问层（对应 electron/db/repositories/MemSceneRepository.ts）
//!
//! memory_scenes 表存储 MemScene（主题场景），由 MemSceneClusterer 自组织聚类产生。
//!  - centroid_embedding：质心向量（Vec<f32> 序列化为 BLOB，小端序）
//!  - member_cell_ids：成员 MemCell ID 列表（JSON 数组）
//!
//! 向量序列化与 EmbeddingRepository 一致：Vec<f32> ↔ Vec<u8>（小端序，每 4 字节一个 float）。

use rusqlite::params;

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, stringify_json_array};
use crate::models::MemScene;

/// Vec<f32> → Vec<u8>（小端序，每 4 字节一个 float）
pub fn float32_vec_to_bytes(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for &f in vec {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    bytes
}

/// Vec<u8> → Vec<f32>（小端序，每 4 字节一个 float）
pub fn bytes_to_float32_vec(bytes: &[u8]) -> Vec<f32> {
    let count = bytes.len() / 4;
    (0..count)
        .map(|i| {
            let start = i * 4;
            let mut arr = [0u8; 4];
            arr.copy_from_slice(&bytes[start..start + 4]);
            f32::from_le_bytes(arr)
        })
        .collect()
}

/// 从数据库行构造 MemScene。
///
/// centroid_embedding 从 BLOB 解析为 Vec<f32>；member_cell_ids 解析为 JSON 数组；
/// summary 为 NULL 时回退为空字符串。
fn row_to_mem_scene(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemScene> {
    let centroid_blob: Vec<u8> = row.get("centroid_embedding")?;
    let member_cell_ids_str: String = row.get("member_cell_ids")?;
    let summary: Option<String> = row.get("summary").ok();

    Ok(MemScene {
        id: row.get("id")?,
        title: row.get("title")?,
        centroid_embedding: bytes_to_float32_vec(&centroid_blob),
        member_cell_ids: parse_json_array::<String>(&member_cell_ids_str),
        summary: summary.unwrap_or_default(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// MemSceneRepository：MemScene 主题场景数据访问层
pub struct MemSceneRepository;

impl MemSceneRepository {
    /// 插入 MemScene。
    ///
    /// id/created_at/updated_at 为空时自动生成（updated_at 缺省时回退到 created_at）。
    pub fn insert(mut scene: MemScene) -> anyhow::Result<()> {
        if scene.id.is_empty() {
            scene.id = uuid::Uuid::new_v4().to_string();
        }
        if scene.created_at.is_empty() {
            scene.created_at = chrono::Utc::now().to_rfc3339();
        }
        if scene.updated_at.is_empty() {
            scene.updated_at = scene.created_at.clone();
        }

        let centroid_blob = float32_vec_to_bytes(&scene.centroid_embedding);
        let member_cell_ids = stringify_json_array(&scene.member_cell_ids);
        let summary: Option<&str> = if scene.summary.is_empty() {
            None
        } else {
            Some(&scene.summary)
        };

        let conn = get_database()?;
        conn.execute(
            "INSERT INTO memory_scenes (
                id, title, centroid_embedding, member_cell_ids, summary, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7
            )",
            params![
                scene.id,
                scene.title,
                centroid_blob,
                member_cell_ids,
                summary,
                scene.created_at,
                scene.updated_at,
            ],
        )?;
        Ok(())
    }

    /// 更新 MemScene 的全部可变字段（title/centroid/member_cell_ids/summary/updated_at）。
    ///
    /// id 必须已存在。updated_at 自动刷新为当前时间。
    pub fn update(scene: MemScene) -> anyhow::Result<()> {
        let updated_at = chrono::Utc::now().to_rfc3339();
        let centroid_blob = float32_vec_to_bytes(&scene.centroid_embedding);
        let member_cell_ids = stringify_json_array(&scene.member_cell_ids);
        let summary: Option<&str> = if scene.summary.is_empty() {
            None
        } else {
            Some(&scene.summary)
        };

        let conn = get_database()?;
        conn.execute(
            "UPDATE memory_scenes
             SET title = ?1, centroid_embedding = ?2, member_cell_ids = ?3,
                 summary = ?4, updated_at = ?5
             WHERE id = ?6",
            params![
                scene.title,
                centroid_blob,
                member_cell_ids,
                summary,
                updated_at,
                scene.id,
            ],
        )?;
        Ok(())
    }

    /// 按 ID 查询 MemScene，不存在返回 None。
    pub fn get_by_id(id: &str) -> anyhow::Result<Option<MemScene>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM memory_scenes WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_mem_scene(row)?)),
            None => Ok(None),
        }
    }

    /// 查询全部 MemScene（按 created_at 升序）。
    pub fn get_all() -> anyhow::Result<Vec<MemScene>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM memory_scenes ORDER BY created_at ASC")?;
        let scenes = stmt
            .query_map([], row_to_mem_scene)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(scenes)
    }

    /// 向 MemScene 添加成员 MemCell（追加到 member_cell_ids JSON 数组）。
    ///
    /// 已存在的 mem_cell_id 不会重复添加。同时更新 updated_at。
    /// 场景不存在时静默返回。
    pub fn add_member(scene_id: &str, mem_cell_id: &str) -> anyhow::Result<()> {
        let conn = get_database()?;

        // 读取现有 member_cell_ids
        let existing: Option<String> = conn
            .query_row(
                "SELECT member_cell_ids FROM memory_scenes WHERE id = ?1",
                params![scene_id],
                |row| row.get(0),
            )
            .ok();
        let member_cell_ids_str = match existing {
            Some(s) => s,
            None => return Ok(()),
        };

        let mut members: Vec<String> = parse_json_array(&member_cell_ids_str);
        if !members.iter().any(|m| m == mem_cell_id) {
            members.push(mem_cell_id.to_string());
        }
        let new_members = stringify_json_array(&members);
        let updated_at = chrono::Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE memory_scenes SET member_cell_ids = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_members, updated_at, scene_id],
        )?;
        Ok(())
    }

    /// 更新 MemScene 的质心向量，同时更新 updated_at。
    pub fn update_centroid(scene_id: &str, centroid: &[f32]) -> anyhow::Result<()> {
        let centroid_blob = float32_vec_to_bytes(centroid);
        let updated_at = chrono::Utc::now().to_rfc3339();
        let conn = get_database()?;
        conn.execute(
            "UPDATE memory_scenes SET centroid_embedding = ?1, updated_at = ?2 WHERE id = ?3",
            params![centroid_blob, updated_at, scene_id],
        )?;
        Ok(())
    }
}
