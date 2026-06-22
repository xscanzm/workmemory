// src-tauri/src/repositories/semantic_search_repository.rs

//! SemanticSearchRepository：MemCell 混合检索数据访问层（Task M5）
//!
//! 混合检索 = FTS5 关键词匹配 + 语义向量余弦相似度。
//!
//! 检索流程：
//!  1. FTS5 关键词匹配：对 fts_memory_cells 虚拟表执行 MATCH 查询，
//!     使用 bm25() 得分（负数，越小越相关）归一化到 0-1。
//!  2. 语义向量检索：EmbeddingService.embed(query) 生成查询向量，
//!     EmbeddingRepository.searchBySimilarity 计算余弦相似度（已为 0-1）。
//!  3. 合并去重：同一 memory_cell_id 合并，按
//!     `score = keywordWeight * ftsScore + semanticWeight * semanticScore` 计算综合得分。
//!  4. matchType 判断：仅关键词 → 'keyword'；仅语义 → 'semantic'；两者 → 'hybrid'。
//!  5. 降级：EmbeddingService 不可用时退化为纯 FTS5，所有结果 matchType = 'keyword'。
//!
//! 得分归一化：
//!  - FTS5 bm25 返回负数（越小越相关），归一化公式：`abs(score) / (1 + abs(score))`
//!    确保 bm25 = 0（无匹配）→ 0.0，bm25 = -10（强匹配）→ 0.91
//!  - 语义得分（余弦相似度）已落在 [0, 1] 区间
//!
//! 注意：由于 EmbeddingService 尚未在 Rust 中实现，semantic_matches 由调用方计算后传入，
//! 这允许在 EmbeddingService 就绪后直接使用本仓库。

use rusqlite::params;

use crate::db::database::get_database;

/// snippet 最大 token 数
const SNIPPET_TOKENS: i64 = 12;

/// 匹配类型
#[derive(Debug, Clone, PartialEq)]
pub enum MatchType {
    /// 关键词匹配
    Keyword,
    /// 语义相似
    Semantic,
    /// 混合匹配（关键词 + 语义）
    Hybrid,
}

impl MatchType {
    pub fn as_str(&self) -> &'static str {
        match self {
            MatchType::Keyword => "keyword",
            MatchType::Semantic => "semantic",
            MatchType::Hybrid => "hybrid",
        }
    }

    #[allow(dead_code)]
    pub fn from_str(s: &str) -> Self {
        match s {
            "semantic" => MatchType::Semantic,
            "hybrid" => MatchType::Hybrid,
            _ => MatchType::Keyword,
        }
    }
}

/// 混合检索选项
#[derive(Debug, Clone)]
pub struct HybridSearchOptions {
    /// 返回结果数量上限
    pub limit: usize,
    /// 关键词得分权重（默认 1.0）
    pub keyword_weight: f64,
    /// 语义得分权重（默认 1.0）
    pub semantic_weight: f64,
}

impl Default for HybridSearchOptions {
    fn default() -> Self {
        Self {
            limit: 20,
            keyword_weight: 1.0,
            semantic_weight: 1.0,
        }
    }
}

/// 混合检索单条结果
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// 关联的 MemCell ID
    pub mem_cell_id: String,
    /// 综合得分（keyword_weight * keyword_score + semantic_weight * semantic_score）
    pub score: f64,
    /// 匹配类型：关键词匹配 / 语义相似 / 混合
    pub match_type: MatchType,
    /// FTS5 归一化得分（0-1），仅关键词匹配或混合时有值
    pub keyword_score: Option<f64>,
    /// 语义相似度得分（0-1），仅语义匹配或混合时有值
    pub semantic_score: Option<f64>,
    /// FTS5 命中片段（关键词匹配时提供）
    pub snippet: Option<String>,
}

/// FTS5 关键词匹配结果（内部中间结构）
struct KeywordMatch {
    mem_cell_id: String,
    keyword_score: f64,
    snippet: String,
}

/// 语义匹配结果（由调用方通过 EmbeddingService 计算后传入）
pub struct SemanticMatch {
    pub mem_cell_id: String,
    pub semantic_score: f64,
}

/// 将查询字符串分词（与 SearchRepository.tokenize 保持一致）：
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

/// 归一化 FTS5 bm25 得分到 0-1 区间。
///
/// bm25 返回负数（越小越相关）：bm25 = 0 表示无匹配，bm25 = -10 表示强匹配。
/// 归一化公式：`abs(score) / (1 + abs(score))`，确保越相关得分越高：
/// - score = 0（无匹配）→ 0.0
/// - score = -1（中等匹配）→ 0.5
/// - score = -10（强匹配）→ 0.91
fn normalize_bm25_score(score: f64) -> f64 {
    let abs_score = score.abs();
    abs_score / (1.0 + abs_score)
}

/// 执行 FTS5 关键词匹配，返回归一化得分与 snippet。
/// 无有效 token 或查询失败时返回空数组。
fn search_by_keyword(query: &str, limit: usize) -> anyhow::Result<Vec<KeywordMatch>> {
    let terms = tokenize(query);
    let match_expr = match build_match_expr(&terms) {
        Some(expr) => expr,
        None => return Ok(Vec::new()),
    };

    let conn = get_database()?;
    let result: Vec<KeywordMatch> = (|| {
        let mut stmt = conn.prepare(
            "SELECT m.id,
               bm25(fts_memory_cells) AS bm25_score,
               snippet(fts_memory_cells, 0, '«', '»', '…', ?1) AS snippet
             FROM fts_memory_cells
             JOIN memory_cells m ON m.rowid = fts_memory_cells.rowid
             WHERE fts_memory_cells MATCH ?2
             ORDER BY bm25_score
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![SNIPPET_TOKENS, match_expr, limit as i64],
            |row| {
                let id: String = row.get(0)?;
                let bm25_score: f64 = row.get(1)?;
                let snippet: String = row.get(2)?;
                Ok(KeywordMatch {
                    mem_cell_id: id,
                    keyword_score: normalize_bm25_score(bm25_score),
                    snippet,
                })
            },
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })()
    .unwrap_or_else(|e| {
        log::error!("[SemanticSearchRepository] FTS5 关键词匹配失败: {}", e);
        Vec::new()
    });

    Ok(result)
}

/// SemanticSearchRepository：MemCell 混合检索数据访问层
pub struct SemanticSearchRepository;

impl SemanticSearchRepository {
    /// 混合检索：FTS5 关键词匹配 + 语义向量余弦相似度。
    ///
    /// 由于 EmbeddingService 尚未在 Rust 中实现，semantic_matches 由调用方计算后传入。
    /// 这允许在 EmbeddingService 就绪后直接使用本仓库。
    ///
    /// # 参数
    /// - `query`: 查询字符串
    /// - `options`: 检索选项（limit / keyword_weight / semantic_weight）
    /// - `semantic_matches`: 语义匹配结果（由调用方通过 EmbeddingService 计算）
    ///
    /// # 返回
    /// 按综合得分降序排列的 SearchResult 数组
    pub fn hybrid_search(
        query: &str,
        options: HybridSearchOptions,
        semantic_matches: Vec<SemanticMatch>,
    ) -> anyhow::Result<Vec<SearchResult>> {
        let limit = options.limit;
        let keyword_weight = options.keyword_weight;
        let semantic_weight = options.semantic_weight;

        // 1. FTS5 关键词匹配
        let keyword_matches = search_by_keyword(query, limit)?;

        // 2. 合并去重：同一 mem_cell_id 合并，计算综合得分
        let mut merged: std::collections::HashMap<String, SearchResult> =
            std::collections::HashMap::new();

        for kw in keyword_matches {
            merged.insert(
                kw.mem_cell_id.clone(),
                SearchResult {
                    mem_cell_id: kw.mem_cell_id,
                    score: keyword_weight * kw.keyword_score,
                    match_type: MatchType::Keyword,
                    keyword_score: Some(kw.keyword_score),
                    semantic_score: None,
                    snippet: Some(kw.snippet),
                },
            );
        }

        for sm in semantic_matches {
            if let Some(existing) = merged.get_mut(&sm.mem_cell_id) {
                // 两者都有 → hybrid
                existing.match_type = MatchType::Hybrid;
                existing.semantic_score = Some(sm.semantic_score);
                existing.score = keyword_weight * existing.keyword_score.unwrap_or(0.0)
                    + semantic_weight * sm.semantic_score;
            } else {
                // 仅语义 → semantic
                merged.insert(
                    sm.mem_cell_id.clone(),
                    SearchResult {
                        mem_cell_id: sm.mem_cell_id,
                        score: semantic_weight * sm.semantic_score,
                        match_type: MatchType::Semantic,
                        keyword_score: None,
                        semantic_score: Some(sm.semantic_score),
                        snippet: None,
                    },
                );
            }
        }

        // 3. 按 score 降序排序，取 top limit
        let mut results: Vec<SearchResult> = merged.into_values().collect();
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(limit);

        Ok(results)
    }
}
