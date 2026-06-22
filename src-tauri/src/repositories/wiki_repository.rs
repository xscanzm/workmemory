//! WikiRepository：知识双链沉淀数据访问层（对应 electron/db/repositories/WikiRepository.ts）
//!
//! 含 Review Queue 审核队列、[[wikilink]] 双链反链维护、断链检测。

use rusqlite::{params, Connection};
use regex::Regex;

use crate::db::database::get_database;
use crate::db::json::{parse_json_array, stringify_json_array};
use crate::models::{WikiPage, WikiReviewStatus, WikiType};

/// 从 Markdown 内容中提取 [[wikilink]] 目标标题
pub fn extract_wiki_links(content: &str) -> Vec<String> {
    lazy_static_regex(r"\[\[([^\]]+)\]\]", content)
}

fn lazy_static_regex(pattern: &str, content: &str) -> Vec<String> {
    let re = match regex::Regex::new(pattern) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    re.captures_iter(content)
        .filter_map(|c| c.get(1).map(|m| m.as_str().trim().to_string()))
        .collect()
}

fn row_to_wiki(row: &rusqlite::Row<'_>) -> rusqlite::Result<WikiPage> {
    let aliases_str: String = row.get("aliases")?;
    let sources_str: String = row.get("sources")?;
    let backlinks_str: String = row.get("backlinks")?;
    let wiki_type_str: String = row.get("type")?;
    let review_status_str: String = row.get("review_status")?;

    Ok(WikiPage {
        id: row.get("id")?,
        wiki_type: WikiType::from_str(&wiki_type_str),
        title: row.get("title")?,
        aliases: parse_json_array(&aliases_str),
        content: row.get("content")?,
        sources: parse_json_array(&sources_str),
        backlinks: parse_json_array(&backlinks_str),
        confidence: row.get("confidence")?,
        review_status: WikiReviewStatus::from_str(&review_status_str),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn insert_wiki(conn: &Connection, page: &WikiPage) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO wiki_pages (
            id, type, title, aliases, content, sources, backlinks,
            confidence, review_status, created_at, updated_at
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11
        )",
        params![
            page.id,
            page.wiki_type.as_str(),
            page.title,
            stringify_json_array(&page.aliases),
            page.content,
            stringify_json_array(&page.sources),
            stringify_json_array(&page.backlinks),
            page.confidence,
            page.review_status.as_str(),
            page.created_at,
            page.updated_at,
        ],
    )?;
    Ok(())
}

fn update_wiki_full(conn: &Connection, page: &WikiPage) -> anyhow::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE wiki_pages SET
            type = ?2, title = ?3, aliases = ?4, content = ?5,
            sources = ?6, backlinks = ?7, confidence = ?8,
            review_status = ?9, updated_at = ?10
        WHERE id = ?1",
        params![
            page.id,
            page.wiki_type.as_str(),
            page.title,
            stringify_json_array(&page.aliases),
            page.content,
            stringify_json_array(&page.sources),
            stringify_json_array(&page.backlinks),
            page.confidence,
            page.review_status.as_str(),
            now,
        ],
    )?;
    Ok(())
}

/// 仅更新 backlinks 字段
fn update_backlinks_field(
    conn: &Connection,
    id: &str,
    backlinks: &[String],
) -> anyhow::Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let backlinks_str = stringify_json_array(backlinks);
    conn.execute(
        "UPDATE wiki_pages SET backlinks = ?1, updated_at = ?2 WHERE id = ?3",
        params![backlinks_str, now, id],
    )?;
    Ok(())
}

pub struct WikiRepository;

impl WikiRepository {
    pub fn insert(page: WikiPage) -> anyhow::Result<WikiPage> {
        let id = if page.id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            page.id.clone()
        };
        let ts = if page.created_at.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            page.created_at.clone()
        };
        let updated_at = if page.updated_at.is_empty() {
            ts.clone()
        } else {
            page.updated_at.clone()
        };
        let mut page = page;
        page.id = id.clone();
        page.created_at = ts;
        page.updated_at = updated_at;

        {
            let conn = get_database()?;
            insert_wiki(&conn, &page)?;
        }
        Self::get_by_id(&id)?
            .ok_or_else(|| anyhow::anyhow!("WikiPage insert failed for id={}", id))
    }

    pub fn update(id: &str, patch: WikiPage) -> anyhow::Result<Option<WikiPage>> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let merged = merge_wiki(existing, patch, id);
        {
            let conn = get_database()?;
            update_wiki_full(&conn, &merged)?;
        }
        Self::get_by_id(id)
    }

    pub fn get_by_id(id: &str) -> anyhow::Result<Option<WikiPage>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM wiki_pages WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_wiki(row)?)),
            None => Ok(None),
        }
    }

    pub fn get_by_type(wiki_type: WikiType) -> anyhow::Result<Vec<WikiPage>> {
        let conn = get_database()?;
        let mut stmt =
            conn.prepare("SELECT * FROM wiki_pages WHERE type = ?1 ORDER BY updated_at DESC")?;
        let pages = stmt
            .query_map(params![wiki_type.as_str()], row_to_wiki)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(pages)
    }

    pub fn get_by_title(title: &str) -> anyhow::Result<Option<WikiPage>> {
        let conn = get_database()?;
        let mut stmt =
            conn.prepare("SELECT * FROM wiki_pages WHERE title = ?1 COLLATE NOCASE LIMIT 1")?;
        let mut rows = stmt.query(params![title])?;
        match rows.next()? {
            Some(row) => Ok(Some(row_to_wiki(row)?)),
            None => Ok(None),
        }
    }

    /// 物理删除指定 Wiki 页
    pub fn delete(id: &str) -> anyhow::Result<bool> {
        let conn = get_database()?;
        let changes = conn.execute("DELETE FROM wiki_pages WHERE id = ?1", params![id])?;
        Ok(changes > 0)
    }

    pub fn get_all() -> anyhow::Result<Vec<WikiPage>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT * FROM wiki_pages ORDER BY updated_at DESC")?;
        let pages = stmt
            .query_map([], row_to_wiki)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(pages)
    }

    pub fn search_by_title(keyword: &str) -> anyhow::Result<Vec<WikiPage>> {
        let like = format!("%{}%", keyword);
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM wiki_pages WHERE title LIKE ?1 OR aliases LIKE ?2 ORDER BY updated_at DESC",
        )?;
        let pages = stmt
            .query_map(params![like, like], row_to_wiki)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(pages)
    }

    /// 加入审核队列（review_status = needs_review）
    pub fn add_to_review_queue(
        wiki_type: crate::models::WikiType,
        title: String,
        aliases: Vec<String>,
        content: String,
        sources: Vec<String>,
        confidence: f64,
    ) -> anyhow::Result<WikiPage> {
        let ts = chrono::Utc::now().to_rfc3339();
        let page = WikiPage {
            id: uuid::Uuid::new_v4().to_string(),
            wiki_type,
            title,
            aliases,
            content,
            sources,
            backlinks: Vec::new(),
            confidence,
            review_status: WikiReviewStatus::NeedsReview,
            created_at: ts.clone(),
            updated_at: ts,
        };
        Self::insert(page)
    }

    pub fn get_review_queue() -> anyhow::Result<Vec<WikiPage>> {
        let conn = get_database()?;
        let mut stmt = conn.prepare(
            "SELECT * FROM wiki_pages WHERE review_status = 'needs_review' ORDER BY created_at ASC",
        )?;
        let pages = stmt
            .query_map([], row_to_wiki)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(pages)
    }

    /// 确认审核：将 needs_review 转为 reviewed
    pub fn confirm_review(id: &str) -> anyhow::Result<Option<WikiPage>> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let mut patch = existing.clone();
        patch.review_status = WikiReviewStatus::Reviewed;
        Self::update(id, patch)
    }

    /// 忽略审核：从 Review Queue 中移除（物理删除 needs_review 的候选页）
    pub fn reject_review(id: &str) -> anyhow::Result<bool> {
        let existing = match Self::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(false),
        };
        if existing.review_status != WikiReviewStatus::NeedsReview {
            return Ok(false);
        }
        Self::delete(id)
    }

    /// 重新计算指定页的反向链接
    pub fn update_backlinks(id: &str) -> anyhow::Result<Vec<String>> {
        let target = match Self::get_by_id(id)? {
            Some(t) => t,
            None => return Ok(Vec::new()),
        };
        let mut candidates: Vec<String> = target.aliases.clone();
        candidates.push(target.title.clone());
        candidates.retain(|s| !s.is_empty());
        if candidates.is_empty() {
            {
                let conn = get_database()?;
                update_backlinks_field(&conn, id, &[])?;
            }
            return Ok(Vec::new());
        }

        let conn = get_database()?;
        let mut stmt = conn.prepare("SELECT id, title, content FROM wiki_pages WHERE id != ?1")?;
        let rows = stmt.query_map(params![id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut backlink_titles: Vec<String> = Vec::new();
        for row in rows {
            let (_id, title, content) = row?;
            let links = extract_wiki_links(&content);
            let hit = links.iter().any(|link| {
                candidates
                    .iter()
                    .any(|c| c.to_lowercase() == link.to_lowercase())
            });
            if hit {
                backlink_titles.push(title);
            }
        }
        // 去重
        let mut seen = std::collections::HashSet::new();
        backlink_titles.retain(|t| seen.insert(t.clone()));
        {
            update_backlinks_field(&conn, id, &backlink_titles)?;
        }
        Ok(backlink_titles)
    }

    /// 查找所有 content 中引用了指定 title 的页（反向链接查询）
    pub fn get_backlinks(title: &str) -> anyhow::Result<Vec<WikiPage>> {
        let all_pages = Self::get_all()?;
        let result: Vec<WikiPage> = all_pages
            .into_iter()
            .filter(|p| {
                let links = extract_wiki_links(&p.content);
                links
                    .iter()
                    .any(|link| link.to_lowercase() == title.to_lowercase())
            })
            .collect();
        Ok(result)
    }

    /// 检测所有断链
    pub fn find_broken_links() -> anyhow::Result<Vec<(String, String)>> {
        let conn = get_database()?;
        let mut stmt =
            conn.prepare("SELECT title, aliases, content FROM wiki_pages")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;

        let mut valid_targets = std::collections::HashSet::new();
        let mut all_rows: Vec<(String, String, String)> = Vec::new();
        for row in rows {
            let (title, aliases, content) = row?;
            valid_targets.insert(title.to_lowercase());
            let aliases_arr: Vec<String> = parse_json_array(&aliases);
            for a in aliases_arr {
                valid_targets.insert(a.to_lowercase());
            }
            all_rows.push((title, aliases, content));
        }

        let mut broken: Vec<(String, String)> = Vec::new();
        for (title, _aliases, content) in all_rows {
            let links = extract_wiki_links(&content);
            for link in links {
                if !valid_targets.contains(&link.to_lowercase()) {
                    broken.push((title.clone(), link));
                }
            }
        }
        Ok(broken)
    }
}

fn merge_wiki(mut existing: WikiPage, patch: WikiPage, id: &str) -> WikiPage {
    // type 字段总是采用 patch 值
    existing.wiki_type = patch.wiki_type;
    if !patch.title.is_empty() {
        existing.title = patch.title;
    }
    if !patch.aliases.is_empty() {
        existing.aliases = patch.aliases;
    }
    if !patch.content.is_empty() {
        existing.content = patch.content;
    }
    if !patch.sources.is_empty() {
        existing.sources = patch.sources;
    }
    if !patch.backlinks.is_empty() {
        existing.backlinks = patch.backlinks;
    }
    existing.confidence = patch.confidence;
    existing.review_status = patch.review_status;
    existing.id = id.to_string();
    existing
}
