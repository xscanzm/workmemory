//! DataManager：数据管理操作（对应 electron/db/DataManager.ts）
//!
//! - 一键瘦身：清理已删除 segments + 过期截图 + 孤立数据
//! - 一键清空当天数据
//! - 一键清空全部数据

use std::fs;
use std::path::PathBuf;

use rusqlite::params;

use crate::db::database::get_database;
use crate::repositories::settings_store::{SettingsStore, APP_DATA_DIR};

#[derive(Debug, Clone, serde::Serialize)]
pub struct CleanupStats {
    pub deleted_segments: usize,
    pub deleted_episodes: usize,
    pub deleted_screenshots: usize,
    pub orphan_wiki_sources: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClearResult {
    pub segments: usize,
    pub episodes: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ClearAllResult {
    pub segments: usize,
    pub episodes: usize,
    pub wiki_pages: usize,
    pub reports: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DataStats {
    pub segment_count: i64,
    pub episode_count: i64,
    pub wiki_count: i64,
    pub report_count: i64,
    pub screenshot_count: usize,
    pub db_size_bytes: u64,
}

/// 截图存储目录（userData/screenshots）
fn get_screenshots_dir() -> PathBuf {
    let dir = APP_DATA_DIR.lock().unwrap();
    match dir.as_ref() {
        Some(p) => p.join("screenshots"),
        None => PathBuf::from("screenshots"),
    }
}

/// 列出截图目录下所有文件
fn list_screenshot_files() -> Vec<PathBuf> {
    let dir = get_screenshots_dir();
    match fs::read_dir(&dir) {
        Ok(entries) => entries.filter_map(|e| e.ok().map(|e| e.path())).collect(),
        Err(_) => Vec::new(),
    }
}

/// 删除指定截图文件
fn delete_screenshot_file(file_path: &PathBuf) -> bool {
    if file_path.exists() {
        match fs::remove_file(file_path) {
            Ok(_) => return true,
            Err(_) => return false,
        }
    }
    false
}

pub struct DataManager;

impl DataManager {
    /// 一键瘦身
    pub fn cleanup() -> anyhow::Result<CleanupStats> {
        let conn = get_database()?;
        let mut stats = CleanupStats {
            deleted_segments: 0,
            deleted_episodes: 0,
            deleted_screenshots: 0,
            orphan_wiki_sources: 0,
        };

        // 1. 物理删除已软删除的 segments 及其截图
        {
            let mut stmt = conn.prepare(
                "SELECT screenshot_path FROM segments WHERE is_deleted = 1 AND screenshot_path != ''",
            )?;
            let rows: Vec<String> = stmt
                .query_map([], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            for path in &rows {
                let p = PathBuf::from(path);
                if delete_screenshot_file(&p) {
                    stats.deleted_screenshots += 1;
                }
            }
        }
        let deleted = conn.execute("DELETE FROM segments WHERE is_deleted = 1", [])?;
        stats.deleted_segments = deleted;

        // 2. 删除过期截图
        let settings = SettingsStore::get();
        if settings.save_screenshots && settings.screenshot_retention_days > 0 {
            let retention_ms: u128 = (settings.screenshot_retention_days as u64 * 24 * 60 * 60 * 1000) as u128;
            let now: u128 = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let files = list_screenshot_files();
            for f in &files {
                if let Ok(metadata) = fs::metadata(f) {
                    if let Ok(modified) = metadata.modified() {
                        if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                            if now - duration.as_millis() > retention_ms {
                                if delete_screenshot_file(f) {
                                    stats.deleted_screenshots += 1;
                                }
                            }
                        }
                    }
                }
            }
        } else if !settings.save_screenshots {
            // 不保存截图模式：清空整个截图目录
            let files = list_screenshot_files();
            for f in &files {
                if delete_screenshot_file(f) {
                    stats.deleted_screenshots += 1;
                }
            }
        }

        // 3. 删除孤立 episodes（segmentIds 全部不存在）
        {
            let mut stmt = conn.prepare("SELECT id, segment_ids FROM episodes")?;
            let rows: Vec<(String, String)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            for (ep_id, segment_ids_str) in &rows {
                let seg_ids: Vec<String> = serde_json::from_str(segment_ids_str).unwrap_or_default();
                if seg_ids.is_empty() {
                    continue;
                }
                // 检查是否所有 segmentId 都不存在
                let placeholders: Vec<String> =
                    (0..seg_ids.len()).map(|i| format!("?{}", i + 1)).collect();
                let sql = format!(
                    "SELECT COUNT(*) as cnt FROM segments WHERE id IN ({})",
                    placeholders.join(",")
                );
                let params: Vec<&dyn rusqlite::ToSql> = seg_ids
                    .iter()
                    .map(|id| id as &dyn rusqlite::ToSql)
                    .collect();
                let count: i64 = conn
                    .query_row(&sql, params.as_slice(), |row| row.get(0))
                    .unwrap_or(0);
                if count == 0 {
                    let _ = conn.execute("DELETE FROM episodes WHERE id = ?1", params![ep_id]);
                    stats.deleted_episodes += 1;
                }
            }
        }

        // 4. 清理 Wiki 中失效的 sources 引用
        {
            let mut stmt = conn.prepare("SELECT id, sources FROM wiki_pages")?;
            let rows: Vec<(String, String)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            for (wiki_id, sources_str) in &rows {
                let src_ids: Vec<String> = serde_json::from_str(sources_str).unwrap_or_default();
                if src_ids.is_empty() {
                    continue;
                }
                let placeholders: Vec<String> =
                    (0..src_ids.len()).map(|i| format!("?{}", i + 1)).collect();
                let ep_sql = format!(
                    "SELECT COUNT(*) as cnt FROM episodes WHERE id IN ({})",
                    placeholders.join(",")
                );
                let seg_sql = format!(
                    "SELECT COUNT(*) as cnt FROM segments WHERE id IN ({})",
                    placeholders.join(",")
                );
                let params: Vec<&dyn rusqlite::ToSql> = src_ids
                    .iter()
                    .map(|id| id as &dyn rusqlite::ToSql)
                    .collect();
                let ep_count: i64 = conn
                    .query_row(&ep_sql, params.as_slice(), |row| row.get(0))
                    .unwrap_or(0);
                let seg_count: i64 = conn
                    .query_row(&seg_sql, params.as_slice(), |row| row.get(0))
                    .unwrap_or(0);
                let valid_count = ep_count + seg_count;
                if (valid_count as usize) < src_ids.len() {
                    // 保留仍存在的引用
                    let mut valid_ids: Vec<String> = Vec::new();
                    for sid in &src_ids {
                        let ep_exists: i64 = conn
                            .query_row(
                                "SELECT 1 FROM episodes WHERE id = ?1",
                                params![sid],
                                |row| row.get(0),
                            )
                            .unwrap_or(0);
                        let seg_exists: i64 = conn
                            .query_row(
                                "SELECT 1 FROM segments WHERE id = ?1",
                                params![sid],
                                |row| row.get(0),
                            )
                            .unwrap_or(0);
                        if ep_exists > 0 || seg_exists > 0 {
                            valid_ids.push(sid.clone());
                        }
                    }
                    let valid_str = serde_json::to_string(&valid_ids).unwrap_or_else(|_| "[]".to_string());
                    let _ = conn.execute(
                        "UPDATE wiki_pages SET sources = ?1 WHERE id = ?2",
                        params![valid_str, wiki_id],
                    );
                    stats.orphan_wiki_sources += src_ids.len() - valid_ids.len();
                }
            }
        }

        Ok(stats)
    }

    /// 一键清空指定日期的数据
    pub fn clear_day(date: &str) -> anyhow::Result<ClearResult> {
        let conn = get_database()?;
        // 先收集要删除的截图路径
        {
            let mut stmt = conn.prepare(
                "SELECT screenshot_path FROM segments WHERE date = ?1 AND screenshot_path != ''",
            )?;
            let rows: Vec<String> = stmt
                .query_map(params![date], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            for path in &rows {
                let p = PathBuf::from(path);
                delete_screenshot_file(&p);
            }
        }
        let seg_count = conn.execute("DELETE FROM segments WHERE date = ?1", params![date])?;
        let ep_count = conn.execute("DELETE FROM episodes WHERE date = ?1", params![date])?;
        Ok(ClearResult {
            segments: seg_count,
            episodes: ep_count,
        })
    }

    /// 一键清空全部数据
    pub fn clear_all() -> anyhow::Result<ClearAllResult> {
        let conn = get_database()?;
        // 删除所有截图
        let files = list_screenshot_files();
        for f in &files {
            delete_screenshot_file(f);
        }
        let seg_count = conn.execute("DELETE FROM segments", [])?;
        let ep_count = conn.execute("DELETE FROM episodes", [])?;
        let wiki_count = conn.execute("DELETE FROM wiki_pages", [])?;
        let report_count = conn.execute("DELETE FROM reports", [])?;
        Ok(ClearAllResult {
            segments: seg_count,
            episodes: ep_count,
            wiki_pages: wiki_count,
            reports: report_count,
        })
    }

    /// 获取数据统计
    pub fn get_stats() -> anyhow::Result<DataStats> {
        let conn = get_database()?;
        let seg_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM segments", [], |row| row.get(0))?;
        let ep_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM episodes", [], |row| row.get(0))?;
        let wiki_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM wiki_pages", [], |row| row.get(0))?;
        let report_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM reports", [], |row| row.get(0))?;
        let screenshot_files = list_screenshot_files();

        let mut db_size_bytes = 0u64;
        let dir = APP_DATA_DIR.lock().unwrap();
        if let Some(p) = dir.as_ref() {
            let db_path: PathBuf = p.join("workmemory.db");
            if db_path.exists() {
                if let Ok(metadata) = fs::metadata(&db_path) {
                    db_size_bytes = metadata.len();
                }
            }
        }

        Ok(DataStats {
            segment_count: seg_count,
            episode_count: ep_count,
            wiki_count,
            report_count,
            screenshot_count: screenshot_files.len(),
            db_size_bytes,
        })
    }
}
