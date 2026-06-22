//! WikiGraph：Wiki 知识图谱可视化器（F8.12）
//!
//! 功能：
//!  - build_graph()：扫描全部 WikiPage，构建节点与边
//!  - 节点 size = 该页被其他页引用的次数（backlinks 数量）
//!  - 节点 color 按 wiki_type 分配固定色值
//!  - 边：[[wikilink]] 解析结果，source→target，附带来源 Episode ID（若可追溯）
//!
//! 用于前端图谱可视化（力导向布局）。

use serde::{Deserialize, Serialize};

use crate::models::{WikiPage, WikiType};
use crate::repositories::wiki_repository::WikiRepository;

/// Wiki 图谱节点
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphNode {
    /// 节点唯一 ID（= WikiPage.id）
    pub id: String,
    /// 节点显示标题
    pub title: String,
    /// Wiki 类型
    pub wiki_type: WikiType,
    /// 节点大小 = 被引用次数（backlinks 数量）
    pub size: u32,
    /// 节点颜色（按类型分配的十六进制色值）
    pub color: String,
}

/// Wiki 图谱边
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphEdge {
    /// 来源页 ID
    pub source: String,
    /// 目标页 ID
    pub target: String,
    /// 来源 Episode ID（若可追溯，否则 None）
    pub source_episode_id: Option<String>,
}

/// Wiki 图谱数据
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WikiGraphData {
    /// 节点列表
    pub nodes: Vec<WikiGraphNode>,
    /// 边列表
    pub edges: Vec<WikiGraphEdge>,
}

/// 按 wiki_type 返回固定色值
fn color_for_type(wiki_type: &WikiType) -> &'static str {
    match wiki_type {
        WikiType::Person => "#4CAF50",   // 人物：绿色
        WikiType::Project => "#2196F3",  // 项目：蓝色
        WikiType::Decision => "#FF9800", // 决策：橙色
        WikiType::Issue => "#F44336",    // 问题：红色（对应 spec 中的 problem）
        WikiType::Topic => "#9C27B0",    // 主题：紫色（对应 spec 中的 concept）
        WikiType::Customer => "#00BCD4", // 客户：青色
        WikiType::Meeting => "#795548",  // 会议：棕色
    }
}

/// WikiGraph：Wiki 知识图谱可视化器
pub struct WikiGraph;

impl WikiGraph {
    /// 创建实例
    pub fn new() -> Self {
        WikiGraph
    }

    /// 构建全库 Wiki 图谱。
    ///
    /// 流程：
    ///  1. 读取全部 WikiPage
    ///  2. 构建 title/alias → pageId 索引（小写匹配）
    ///  3. 解析每页 content 中的 [[wikilink]]，生成边并累计被引用次数
    ///  4. 生成节点（size = 被引用次数，color = 按 type）
    pub fn build_graph(&self) -> anyhow::Result<WikiGraphData> {
        let all_pages = WikiRepository::get_all()?;
        if all_pages.is_empty() {
            return Ok(WikiGraphData::default());
        }

        // 1. 构建 title/alias → pageId 索引（小写）
        let mut target_index: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for page in &all_pages {
            target_index.insert(page.title.to_lowercase(), page.id.clone());
            for alias in &page.aliases {
                let trimmed = alias.trim().to_lowercase();
                if !trimmed.is_empty() {
                    target_index.insert(trimmed, page.id.clone());
                }
            }
        }

        // 2. 统计每页被引用次数 + 生成边
        let mut backlink_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        let mut edges: Vec<WikiGraphEdge> = Vec::new();
        let mut seen_edges: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();

        for page in &all_pages {
            let links = extract_wiki_links(&page.content);
            for link_target in links {
                let lower = link_target.to_lowercase();
                if let Some(target_id) = target_index.get(&lower) {
                    // 跳过自环
                    if target_id == &page.id {
                        continue;
                    }
                    // 累计被引用次数
                    *backlink_counts.entry(target_id.clone()).or_insert(0) += 1;
                    // 去重添加边
                    let key = (page.id.clone(), target_id.clone());
                    if seen_edges.insert(key) {
                        edges.push(WikiGraphEdge {
                            source: page.id.clone(),
                            target: target_id.clone(),
                            source_episode_id: page.sources.first().cloned(),
                        });
                    }
                }
            }
        }

        // 3. 生成节点
        let nodes: Vec<WikiGraphNode> = all_pages
            .iter()
            .map(|page| WikiGraphNode {
                id: page.id.clone(),
                title: page.title.clone(),
                wiki_type: page.wiki_type.clone(),
                size: *backlink_counts.get(&page.id).unwrap_or(&0),
                color: color_for_type(&page.wiki_type).to_string(),
            })
            .collect();

        Ok(WikiGraphData { nodes, edges })
    }

    /// 从已有 WikiPage 列表构建图谱（仅供测试使用，不访问数据库）
    pub fn build_graph_from_pages(&self, pages: &[WikiPage]) -> WikiGraphData {
        if pages.is_empty() {
            return WikiGraphData::default();
        }

        // 构建 title/alias → pageId 索引
        let mut target_index: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for page in pages {
            target_index.insert(page.title.to_lowercase(), page.id.clone());
            for alias in &page.aliases {
                let trimmed = alias.trim().to_lowercase();
                if !trimmed.is_empty() {
                    target_index.insert(trimmed, page.id.clone());
                }
            }
        }

        let mut backlink_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        let mut edges: Vec<WikiGraphEdge> = Vec::new();
        let mut seen_edges: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();

        for page in pages {
            let links = extract_wiki_links(&page.content);
            for link_target in links {
                let lower = link_target.to_lowercase();
                if let Some(target_id) = target_index.get(&lower) {
                    if target_id == &page.id {
                        continue;
                    }
                    *backlink_counts.entry(target_id.clone()).or_insert(0) += 1;
                    let key = (page.id.clone(), target_id.clone());
                    if seen_edges.insert(key) {
                        edges.push(WikiGraphEdge {
                            source: page.id.clone(),
                            target: target_id.clone(),
                            source_episode_id: page.sources.first().cloned(),
                        });
                    }
                }
            }
        }

        let nodes: Vec<WikiGraphNode> = pages
            .iter()
            .map(|page| WikiGraphNode {
                id: page.id.clone(),
                title: page.title.clone(),
                wiki_type: page.wiki_type.clone(),
                size: *backlink_counts.get(&page.id).unwrap_or(&0),
                color: color_for_type(&page.wiki_type).to_string(),
            })
            .collect();

        WikiGraphData { nodes, edges }
    }
}

impl Default for WikiGraph {
    fn default() -> Self {
        Self::new()
    }
}

/// 解析 Markdown 内容中的 [[wikilink]] 目标标题（去重）
fn extract_wiki_links(content: &str) -> Vec<String> {
    use once_cell::sync::Lazy;
    static RE: Lazy<regex::Regex> =
        Lazy::new(|| regex::Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
    let mut result: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for cap in RE.captures_iter(content) {
        if let Some(m) = cap.get(1) {
            let inner = m.as_str().trim();
            // 支持 [[alias|display]] 语法
            let target = if let Some(pipe_idx) = inner.find('|') {
                inner[..pipe_idx].trim().to_string()
            } else {
                inner.to_string()
            };
            if !target.is_empty() && seen.insert(target.to_lowercase()) {
                result.push(target);
            }
        }
    }
    result
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{WikiReviewStatus, WikiType};

    fn make_page(
        id: &str,
        title: &str,
        wiki_type: WikiType,
        content: &str,
        sources: Vec<String>,
    ) -> WikiPage {
        let ts = chrono::Utc::now().to_rfc3339();
        WikiPage {
            id: id.to_string(),
            wiki_type,
            title: title.to_string(),
            aliases: vec![],
            content: content.to_string(),
            sources,
            backlinks: vec![],
            confidence: 0.8,
            review_status: WikiReviewStatus::Reviewed,
            created_at: ts.clone(),
            updated_at: ts,
        }
    }

    #[test]
    fn test_color_for_type_mapping() {
        assert_eq!(color_for_type(&WikiType::Person), "#4CAF50");
        assert_eq!(color_for_type(&WikiType::Project), "#2196F3");
        assert_eq!(color_for_type(&WikiType::Decision), "#FF9800");
        assert_eq!(color_for_type(&WikiType::Issue), "#F44336");
        assert_eq!(color_for_type(&WikiType::Topic), "#9C27B0");
    }

    #[test]
    fn test_build_graph_from_pages_empty() {
        let graph = WikiGraph::new();
        let data = graph.build_graph_from_pages(&[]);
        assert!(data.nodes.is_empty());
        assert!(data.edges.is_empty());
    }

    #[test]
    fn test_build_graph_from_pages_with_links() {
        let graph = WikiGraph::new();
        // p1 引用 p2，p2 引用 p3
        let pages = vec![
            make_page(
                "p1",
                "Tauri",
                WikiType::Project,
                "使用 [[Rust]] 开发",
                vec!["ep-1".to_string()],
            ),
            make_page(
                "p2",
                "Rust",
                WikiType::Topic,
                "Rust 是 [[系统编程语言]]，参考 [[Tauri]]",
                vec![],
            ),
            make_page(
                "p3",
                "系统编程语言",
                WikiType::Topic,
                "无外链",
                vec![],
            ),
        ];
        let data = graph.build_graph_from_pages(&pages);
        // 3 个节点
        assert_eq!(data.nodes.len(), 3);
        // 边：p1→p2（[[Rust]]），p2→p3（[[系统编程语言]]），p2→p1（[[Tauri]]）
        // 注意 [[系统编程语言]] 在 p2 content 中，target=p3
        assert!(data.edges.len() >= 2);

        // 验证节点 size：p1 被引用 1 次（来自 p2），p2 被引用 1 次（来自 p1），p3 被引用 1 次（来自 p2）
        let p1 = data.nodes.iter().find(|n| n.id == "p1").unwrap();
        let p2 = data.nodes.iter().find(|n| n.id == "p2").unwrap();
        let p3 = data.nodes.iter().find(|n| n.id == "p3").unwrap();
        assert_eq!(p1.size, 1);
        assert_eq!(p2.size, 1);
        assert_eq!(p3.size, 1);

        // 验证颜色
        assert_eq!(p1.color, "#2196F3"); // Project
        assert_eq!(p2.color, "#9C27B0"); // Topic
        assert_eq!(p3.color, "#9C27B0"); // Topic

        // 验证 source_episode_id 透传
        let edge_p1_p2 = data
            .edges
            .iter()
            .find(|e| e.source == "p1" && e.target == "p2")
            .expect("应存在 p1→p2 边");
        assert_eq!(edge_p1_p2.source_episode_id, Some("ep-1".to_string()));
    }

    #[test]
    fn test_build_graph_skips_self_loops() {
        let graph = WikiGraph::new();
        let pages = vec![make_page(
            "p1",
            "SelfRef",
            WikiType::Topic,
            "自引用 [[SelfRef]]",
            vec![],
        )];
        let data = graph.build_graph_from_pages(&pages);
        assert_eq!(data.nodes.len(), 1);
        // 自环应被跳过
        assert!(data.edges.is_empty());
        // 自引用不计入 size
        assert_eq!(data.nodes[0].size, 0);
    }

    #[test]
    fn test_build_graph_deduplicates_edges() {
        let graph = WikiGraph::new();
        let pages = vec![
            make_page(
                "p1",
                "A",
                WikiType::Topic,
                "[[B]] 和 [[B]] 和 [[B]]",
                vec![],
            ),
            make_page("p2", "B", WikiType::Topic, "", vec![]),
        ];
        let data = graph.build_graph_from_pages(&pages);
        // 多次 [[B]] 应只生成一条边
        let p1_to_p2_edges: Vec<_> = data
            .edges
            .iter()
            .filter(|e| e.source == "p1" && e.target == "p2")
            .collect();
        assert_eq!(p1_to_p2_edges.len(), 1);
    }

    #[test]
    fn test_extract_wiki_links_with_alias() {
        let links = extract_wiki_links("使用 [[Rust|铁锈]] 开发 [[Tauri]]");
        assert_eq!(links.len(), 2);
        assert!(links.contains(&"Rust".to_string()));
        assert!(links.contains(&"Tauri".to_string()));
    }
}
