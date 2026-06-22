//! WikiLinkEngine：双链与反链维护引擎（对应 electron/wiki/WikiLinkEngine.ts）
//!
//! 功能：
//!  - resolve_links(text)：正则解析 [[link]]，返回标题列表（支持别名 [[alias|display]]）
//!  - update_backlinks(page_id)：增量更新指定页的反向链接
//!
//! 被 WikiRepository 复用（WikiRepository 内部 backlinks 逻辑可调用本引擎）。

use regex::Regex;

use crate::models::WikiPage;
use crate::repositories::wiki_repository::WikiRepository;

/// [[link]] 双链正则，支持 [[alias|display]] 格式
fn wiki_link_regex() -> &'static Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
    &RE
}

/// 解析后的链接信息
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedLink {
    /// 原始匹配文本，如 [[Tauri 配置]]
    pub raw: String,
    /// 链接目标（别名前的部分），如 [[alias|display]] 中的 alias
    pub target: String,
    /// 显示文本（若有 | 分隔），否则等于 target
    pub display: String,
}

/// WikiLinkEngine：双链与反链维护引擎。
pub struct WikiLinkEngine;

impl WikiLinkEngine {
    /// 创建实例
    pub fn new() -> Self {
        WikiLinkEngine
    }

    /// 解析 Markdown 内容中的所有 [[link]]，返回 ParsedLink 列表。
    /// 支持 [[alias|display]] 格式：target=alias, display=display。
    pub fn parse_links(&self, content: &str) -> Vec<ParsedLink> {
        if content.is_empty() {
            return Vec::new();
        }
        let re = wiki_link_regex();
        let mut links: Vec<ParsedLink> = Vec::new();
        for cap in re.captures_iter(content) {
            let inner = cap.get(1).map(|m| m.as_str().trim()).unwrap_or("");
            if inner.is_empty() {
                continue;
            }
            let raw = cap.get(0).map(|m| m.as_str().to_string()).unwrap_or_default();
            if let Some(pipe_idx) = inner.find('|') {
                let target = inner[..pipe_idx].trim().to_string();
                let display = inner[pipe_idx + 1..].trim().to_string();
                let display = if display.is_empty() { target.clone() } else { display };
                links.push(ParsedLink { raw, target, display });
            } else {
                links.push(ParsedLink {
                    raw,
                    target: inner.to_string(),
                    display: inner.to_string(),
                });
            }
        }
        links
    }

    /// 解析内容中的链接目标标题列表（仅 target，去重）。
    pub fn resolve_links(&self, text: &str) -> Vec<String> {
        let links = self.parse_links(text);
        let mut targets: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for link in links {
            if seen.insert(link.target.clone()) {
                targets.push(link.target);
            }
        }
        targets
    }

    /// 按 title 或 aliases 匹配目标 WikiPage。
    /// 大小写不敏感。返回匹配的 WikiPage 或 None。
    pub fn resolve_link(&self, link_text: &str, all_pages: &[WikiPage]) -> Option<WikiPage> {
        let target = link_text.trim().to_lowercase();
        if target.is_empty() {
            return None;
        }
        for page in all_pages {
            if page.title.to_lowercase() == target {
                return Some(page.clone());
            }
            for alias in &page.aliases {
                if alias.trim().to_lowercase() == target {
                    return Some(page.clone());
                }
            }
        }
        None
    }

    /// 增量更新指定页相关的 backlinks。
    /// 当某页 A 的 title/aliases/content 变化时：
    ///  1. 重新计算 A 的 backlinks（谁引用了 A）
    ///  2. 重新计算 A 引用的其他页的 backlinks（A 的 content 中的 [[link]] 目标）
    pub fn update_backlinks(&self, page_id: &str) -> anyhow::Result<()> {
        let target = match WikiRepository::get_by_id(page_id)? {
            Some(t) => t,
            None => return Ok(()),
        };

        // 1. 更新本页 backlinks（谁引用了本页）
        WikiRepository::update_backlinks(page_id)?;

        // 2. 更新本页 content 中引用的其他页的 backlinks
        let all_pages = WikiRepository::get_all()?;
        let links = self.parse_links(&target.content);
        let mut updated_target_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        for link in links {
            if let Some(resolved) = self.resolve_link(&link.target, &all_pages) {
                if resolved.id != page_id && updated_target_ids.insert(resolved.id.clone()) {
                    WikiRepository::update_backlinks(&resolved.id)?;
                }
            }
        }
        Ok(())
    }

    /// 重建全库 backlinks。
    /// 扫描所有 wiki_pages，对每页 A 的 content 中的 [[link]]，
    /// 若 link 命中页 B 的 title/aliases，则将 A.title 加入 B.backlinks。
    ///
    /// 返回更新的页数。
    pub fn rebuild_all_backlinks(&self) -> anyhow::Result<usize> {
        let all_pages = WikiRepository::get_all()?;
        if all_pages.is_empty() {
            return Ok(0);
        }

        // 构建 title/alias → pageId 索引（小写）
        let mut target_index: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for page in &all_pages {
            target_index.insert(page.title.to_lowercase(), page.id.clone());
            for alias in &page.aliases {
                let trimmed = alias.trim().to_lowercase();
                if !trimmed.is_empty() {
                    target_index.insert(trimmed, page.id.clone());
                }
            }
        }

        // 计算每个目标页的 backlinks（来源页 title 列表）
        let mut backlinks_map: std::collections::HashMap<String, std::collections::BTreeSet<String>> =
            std::collections::HashMap::new();
        for page in &all_pages {
            let links = self.parse_links(&page.content);
            for link in links {
                if let Some(target_id) = target_index.get(&link.target.to_lowercase()) {
                    if target_id == &page.id {
                        continue;
                    }
                    backlinks_map
                        .entry(target_id.clone())
                        .or_default()
                        .insert(page.title.clone());
                }
            }
        }

        // 持久化更新每页的 backlinks
        let mut updated_count = 0usize;
        for page in &all_pages {
            let new_backlinks: Vec<String> = backlinks_map
                .get(&page.id)
                .map(|set| set.iter().cloned().collect())
                .unwrap_or_default();
            let mut current_backlinks = page.backlinks.clone();
            current_backlinks.sort();
            if new_backlinks != current_backlinks {
                let mut patch = page.clone();
                patch.backlinks = new_backlinks;
                WikiRepository::update(&page.id, patch)?;
                updated_count += 1;
            }
        }
        Ok(updated_count)
    }

    /// 查找所有断链：[[link]] 指向的 title/alias 在 wiki_pages 中不存在。
    pub fn find_broken_links(&self) -> anyhow::Result<Vec<(String, String)>> {
        let all_pages = WikiRepository::get_all()?;
        if all_pages.is_empty() {
            return Ok(Vec::new());
        }

        // 构建有效目标集合（小写）
        let mut valid_targets: std::collections::HashSet<String> = std::collections::HashSet::new();
        for page in &all_pages {
            valid_targets.insert(page.title.to_lowercase());
            for alias in &page.aliases {
                let trimmed = alias.trim().to_lowercase();
                if !trimmed.is_empty() {
                    valid_targets.insert(trimmed);
                }
            }
        }

        let mut broken: Vec<(String, String)> = Vec::new();
        for page in &all_pages {
            let links = self.parse_links(&page.content);
            for link in links {
                if !valid_targets.contains(&link.target.to_lowercase()) {
                    broken.push((page.title.clone(), link.target));
                }
            }
        }
        Ok(broken)
    }
}

impl Default for WikiLinkEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_links_simple() {
        let engine = WikiLinkEngine::new();
        let links = engine.parse_links("这是一个 [[Tauri 配置]] 链接，还有 [[Rust]]。");
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].target, "Tauri 配置");
        assert_eq!(links[0].display, "Tauri 配置");
        assert_eq!(links[1].target, "Rust");
    }

    #[test]
    fn test_parse_links_with_alias() {
        let engine = WikiLinkEngine::new();
        let links = engine.parse_links("使用 [[alias|显示文本]] 格式。");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "alias");
        assert_eq!(links[0].display, "显示文本");
    }

    #[test]
    fn test_parse_links_empty_alias_display_falls_back_to_target() {
        let engine = WikiLinkEngine::new();
        // [[alias|]] 中 display 为空，应回退为 target
        let links = engine.parse_links("[[target|]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "target");
        assert_eq!(links[0].display, "target");
    }

    #[test]
    fn test_resolve_links_deduplicates() {
        let engine = WikiLinkEngine::new();
        let targets = engine.resolve_links("[[A]] 和 [[A]] 和 [[B]]");
        assert_eq!(targets.len(), 2);
        assert!(targets.contains(&"A".to_string()));
        assert!(targets.contains(&"B".to_string()));
    }

    #[test]
    fn test_parse_links_empty_content() {
        let engine = WikiLinkEngine::new();
        assert!(engine.parse_links("").is_empty());
        assert!(engine.parse_links("无链接文本").is_empty());
    }

    #[test]
    fn test_resolve_link_case_insensitive() {
        let engine = WikiLinkEngine::new();
        let pages = vec![WikiPage {
            id: "p1".to_string(),
            wiki_type: crate::models::WikiType::Topic,
            title: "Tauri".to_string(),
            aliases: vec!["塔乌里".to_string()],
            content: String::new(),
            sources: vec![],
            backlinks: vec![],
            confidence: 0.8,
            review_status: crate::models::WikiReviewStatus::Reviewed,
            created_at: String::new(),
            updated_at: String::new(),
        }];
        // 大小写不敏感匹配 title
        assert!(engine.resolve_link("tauri", &pages).is_some());
        assert!(engine.resolve_link("TAURI", &pages).is_some());
        // 匹配 alias
        assert!(engine.resolve_link("塔乌里", &pages).is_some());
        // 不存在
        assert!(engine.resolve_link("unknown", &pages).is_none());
        // 空字符串
        assert!(engine.resolve_link("", &pages).is_none());
    }
}
