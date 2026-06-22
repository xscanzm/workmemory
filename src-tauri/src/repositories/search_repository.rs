// src-tauri/src/repositories/search_repository.rs

//! SearchRepository：基于 SQLite FTS5 的全文检索数据访问层
//!
//! 索引四张外部内容 FTS5 虚拟表：
//!  - fts_clean_episodes(title, summary, evidence_refs) → clean_episodes 表
//!  - fts_segments(ocr_text, window_title) → segments 表
//!  - fts_episodes(title, one_line_summary) → episodes 表
//!  - fts_wiki(content) → wiki_pages 表
//!
//! 查询流程：
//!  1. tokenize()：中文双字滑窗 + 英文单词 + 数字 token
//!  2. build_match_expr()：构建 FTS5 MATCH 表达式（短语 OR 连接）
//!  3. 分别查询四张 FTS 表，返回 ID + snippet + 命中字段
//!
//! 调用方（Search 页）结合本地时间/实体维度匹配，组合多维匹配原因。

use rusqlite::{params, Connection};

use crate::db::database::get_database;

/// snippet 最大 token 数
const SNIPPET_TOKENS: i64 = 12;

/// FTS 段落匹配结果
#[derive(Debug, Clone)]
pub struct FtsSegmentMatch {
    pub segment_id: String,
    pub snippet: String,
    pub matched_field: String,
}

/// FTS 事件匹配结果
#[derive(Debug, Clone)]
pub struct FtsEpisodeMatch {
    pub episode_id: String,
    pub snippet: String,
    pub matched_field: String,
}

/// FTS CleanEpisode 匹配结果
#[derive(Debug, Clone)]
pub struct FtsCleanEpisodeMatch {
    pub clean_episode_id: String,
    pub snippet: String,
    pub matched_field: String,
}

/// FTS Wiki 匹配结果
#[derive(Debug, Clone)]
pub struct FtsWikiMatch {
    pub wiki_id: String,
    pub title: String,
    pub snippet: String,
}

/// FTS 综合搜索结果
#[derive(Debug, Clone, Default)]
pub struct FtsSearchResult {
    pub clean_episodes: Vec<FtsCleanEpisodeMatch>,
    pub segments: Vec<FtsSegmentMatch>,
    pub episodes: Vec<FtsEpisodeMatch>,
    pub wikis: Vec<FtsWikiMatch>,
}

/// CleanEpisode FTS 行（内部中间结构）
struct CleanEpisodeFtsRow {
    id: String,
    snippet: String,
    matched_title: i64,
    matched_summary: i64,
    matched_evidence: i64,
}

/// Segment FTS 行（内部中间结构）
struct SegmentFtsRow {
    id: String,
    snippet: String,
    matched_ocr: i64,
    matched_title: i64,
}

/// Episode FTS 行（内部中间结构）
struct EpisodeFtsRow {
    id: String,
    snippet: String,
    matched_title: i64,
    matched_summary: i64,
}

/// Wiki FTS 行（内部中间结构）
struct WikiFtsRow {
    id: String,
    title: String,
    snippet: String,
}

/// 将查询字符串分词（与 Search 页 tokenize 保持一致）：
/// - 中文：双字滑窗（bigram）
/// - 英文：按空格/标点切分单词（≥2 字符）
/// - 数字：独立 token
fn tokenize(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();

    // 中文双字滑窗
    let chinese_re = regex::Regex::new(r"[\u{4e00}-\u{9fa5}]").unwrap();
    let chinese_chars: Vec<char> = chinese_re
        .find_iter(query)
        .filter_map(|m| m.as_str().chars().next())
        .collect();
    if !chinese_chars.is_empty() {
        if chinese_chars.len() == 1 {
            terms.push(chinese_chars.iter().collect());
        } else {
            for i in 0..chinese_chars.len() - 1 {
                terms.push(format!("{}{}", chinese_chars[i], chinese_chars[i + 1]));
            }
        }
    }

    // 英文单词（≥2 字符，小写）
    let english_re = regex::Regex::new(r"[a-zA-Z]+").unwrap();
    for m in english_re.find_iter(query) {
        let word = m.as_str();
        if word.len() >= 2 {
            terms.push(word.to_lowercase());
        }
    }

    // 数字 token
    let number_re = regex::Regex::new(r"\d+").unwrap();
    for m in number_re.find_iter(query) {
        terms.push(m.as_str().to_string());
    }

    // 去重
    let mut seen = std::collections::HashSet::new();
    terms.retain(|t| seen.insert(t.clone()));
    terms
}

/// 构建 FTS5 MATCH 表达式。
/// 每个 term 用双引号包裹（短语查询），转义内部双引号，term 间用 OR 连接。
/// 返回 None 表示无有效 term。
fn build_match_expr(terms: &[String]) -> Option<String> {
    if terms.is_empty() {
        return None;
    }
    let quoted: Vec<String> = terms
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    Some(quoted.join(" OR "))
}

/// 查询 fts_clean_episodes，返回匹配行。查询失败时记录日志并返回空数组。
fn query_clean_episodes(conn: &Connection, match_expr: &str) -> Vec<CleanEpisodeFtsRow> {
    let sql = "SELECT c.id,
             snippet(fts_clean_episodes, 0, '«', '»', '…', ?1) AS snippet,
             (fts_clean_episodes MATCH ?2 AND title != '') AS matched_title,
             (fts_clean_episodes MATCH ?3 AND summary != '') AS matched_summary,
             (fts_clean_episodes MATCH ?4 AND evidence_refs != '') AS matched_evidence
           FROM fts_clean_episodes
           JOIN clean_episodes c ON c.rowid = fts_clean_episodes.rowid
           WHERE fts_clean_episodes MATCH ?5";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[SearchRepository] fts_clean_episodes prepare 失败: {}", e);
            return Vec::new();
        }
    };
    let rows = match stmt.query_map(
        params![SNIPPET_TOKENS, match_expr, match_expr, match_expr, match_expr],
        |row| {
            Ok(CleanEpisodeFtsRow {
                id: row.get(0)?,
                snippet: row.get(1)?,
                matched_title: row.get(2)?,
                matched_summary: row.get(3)?,
                matched_evidence: row.get(4)?,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => {
            log::error!("[SearchRepository] fts_clean_episodes query 失败: {}", e);
            return Vec::new();
        }
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// 查询 fts_segments，返回匹配行。查询失败时记录日志并返回空数组。
fn query_segments(conn: &Connection, match_expr: &str) -> Vec<SegmentFtsRow> {
    let sql = "SELECT s.id,
             snippet(fts_segments, 0, '«', '»', '…', ?1) AS snippet,
             (fts_segments MATCH ?2 AND ocr_text != '') AS matched_ocr,
             (fts_segments MATCH ?3 AND window_title != '') AS matched_title
           FROM fts_segments
           JOIN segments s ON s.rowid = fts_segments.rowid
           WHERE fts_segments MATCH ?4";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[SearchRepository] fts_segments prepare 失败: {}", e);
            return Vec::new();
        }
    };
    let rows = match stmt.query_map(
        params![SNIPPET_TOKENS, match_expr, match_expr, match_expr],
        |row| {
            Ok(SegmentFtsRow {
                id: row.get(0)?,
                snippet: row.get(1)?,
                matched_ocr: row.get(2)?,
                matched_title: row.get(3)?,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => {
            log::error!("[SearchRepository] fts_segments query 失败: {}", e);
            return Vec::new();
        }
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// 查询 fts_episodes，返回匹配行。查询失败时记录日志并返回空数组。
fn query_episodes(conn: &Connection, match_expr: &str) -> Vec<EpisodeFtsRow> {
    let sql = "SELECT e.id,
             snippet(fts_episodes, 0, '«', '»', '…', ?1) AS snippet,
             (fts_episodes MATCH ?2 AND title != '') AS matched_title,
             (fts_episodes MATCH ?3 AND one_line_summary != '') AS matched_summary
           FROM fts_episodes
           JOIN episodes e ON e.rowid = fts_episodes.rowid
           WHERE fts_episodes MATCH ?4";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[SearchRepository] fts_episodes prepare 失败: {}", e);
            return Vec::new();
        }
    };
    let rows = match stmt.query_map(
        params![SNIPPET_TOKENS, match_expr, match_expr, match_expr],
        |row| {
            Ok(EpisodeFtsRow {
                id: row.get(0)?,
                snippet: row.get(1)?,
                matched_title: row.get(2)?,
                matched_summary: row.get(3)?,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => {
            log::error!("[SearchRepository] fts_episodes query 失败: {}", e);
            return Vec::new();
        }
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// 查询 fts_wiki，返回匹配行。查询失败时记录日志并返回空数组。
fn query_wiki(conn: &Connection, match_expr: &str) -> Vec<WikiFtsRow> {
    let sql = "SELECT w.id, w.title,
             snippet(fts_wiki, 0, '«', '»', '…', ?1) AS snippet
           FROM fts_wiki
           JOIN wiki_pages w ON w.rowid = fts_wiki.rowid
           WHERE fts_wiki MATCH ?2";
    let mut stmt = match conn.prepare(sql) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[SearchRepository] fts_wiki prepare 失败: {}", e);
            return Vec::new();
        }
    };
    let rows = match stmt.query_map(
        params![SNIPPET_TOKENS, match_expr],
        |row| {
            Ok(WikiFtsRow {
                id: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
            })
        },
    ) {
        Ok(r) => r,
        Err(e) => {
            log::error!("[SearchRepository] fts_wiki query 失败: {}", e);
            return Vec::new();
        }
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// SearchRepository：基于 SQLite FTS5 的全文检索数据访问层
pub struct SearchRepository;

impl SearchRepository {
    /// 执行 FTS5 全文搜索，返回四张表的匹配结果。
    /// 若 query 无有效 token，返回空结果。单表查询失败时跳过该表，不影响其他表。
    pub fn search(query: &str) -> anyhow::Result<FtsSearchResult> {
        let terms = tokenize(query);
        let match_expr = match build_match_expr(&terms) {
            Some(expr) => expr,
            None => return Ok(FtsSearchResult::default()),
        };

        let conn = get_database()?;
        let mut result = FtsSearchResult::default();

        // 查询 fts_clean_episodes：检查 title / summary / evidence_refs 命中
        for row in query_clean_episodes(&conn, &match_expr) {
            let matched_field = if row.matched_title != 0 {
                "title"
            } else if row.matched_summary != 0 {
                "summary"
            } else {
                "evidence_refs"
            };
            result.clean_episodes.push(FtsCleanEpisodeMatch {
                clean_episode_id: row.id,
                snippet: row.snippet,
                matched_field: matched_field.to_string(),
            });
        }

        // 查询 fts_segments：优先返回 ocr_text 命中，否则返回 window_title 命中
        for row in query_segments(&conn, &match_expr) {
            if row.matched_ocr != 0 {
                result.segments.push(FtsSegmentMatch {
                    segment_id: row.id,
                    snippet: row.snippet,
                    matched_field: "ocr_text".to_string(),
                });
            } else if row.matched_title != 0 {
                // window_title 命中时重新取 window_title 列（列索引 1）的 snippet
                let title_snippet: Option<String> = conn
                    .query_row(
                        "SELECT snippet(fts_segments, 1, '«', '»', '…', ?1) AS s
                         FROM fts_segments
                         JOIN segments s ON s.rowid = fts_segments.rowid
                         WHERE s.id = ?2 AND fts_segments MATCH ?3",
                        params![SNIPPET_TOKENS, row.id, match_expr],
                        |r| r.get::<_, String>(0),
                    )
                    .ok();
                result.segments.push(FtsSegmentMatch {
                    segment_id: row.id,
                    snippet: title_snippet.unwrap_or(row.snippet),
                    matched_field: "window_title".to_string(),
                });
            }
        }

        // 查询 fts_episodes：优先返回 title 命中，否则返回 one_line_summary 命中
        for row in query_episodes(&conn, &match_expr) {
            if row.matched_title != 0 {
                result.episodes.push(FtsEpisodeMatch {
                    episode_id: row.id,
                    snippet: row.snippet,
                    matched_field: "title".to_string(),
                });
            } else if row.matched_summary != 0 {
                // one_line_summary 命中时重新取 one_line_summary 列（列索引 1）的 snippet
                let sum_snippet: Option<String> = conn
                    .query_row(
                        "SELECT snippet(fts_episodes, 1, '«', '»', '…', ?1) AS s
                         FROM fts_episodes
                         JOIN episodes e ON e.rowid = fts_episodes.rowid
                         WHERE e.id = ?2 AND fts_episodes MATCH ?3",
                        params![SNIPPET_TOKENS, row.id, match_expr],
                        |r| r.get::<_, String>(0),
                    )
                    .ok();
                result.episodes.push(FtsEpisodeMatch {
                    episode_id: row.id,
                    snippet: sum_snippet.unwrap_or(row.snippet),
                    matched_field: "one_line_summary".to_string(),
                });
            }
        }

        // 查询 fts_wiki：join wiki_pages 取 id + title
        for row in query_wiki(&conn, &match_expr) {
            result.wikis.push(FtsWikiMatch {
                wiki_id: row.id,
                title: row.title,
                snippet: row.snippet,
            });
        }

        Ok(result)
    }
}
