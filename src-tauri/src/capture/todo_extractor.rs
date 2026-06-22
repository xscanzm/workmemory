//! TodoExtractor：从 OCR 文本自动提取 TODO 项（F8.6）
//!
//! 功能：
//!  - 从 OCR 文本逐行扫描，匹配以下模式：
//!    - "TODO: ..."
//!    - "待办: ..."
//!    - "下一步: ..."
//!    - "Action Item: ..."
//!    - "- [ ] ..."（Markdown 未完成项）
//!    - "需要 ..."
//!  - 已完成项 "- [x] ..." 也被识别（completed=true）
//!  - 返回 TodoItem 列表，包含来源行号、置信度
//!
//! 用途：填充 Episode.todos[] 字段（模型中已存在但当前为空）

use regex::Regex;
use serde::{Deserialize, Serialize};

/// 单个 TODO 项
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    /// TODO 文本内容
    pub text: String,
    /// 是否已完成
    pub completed: bool,
    /// 来源（哪一行，格式 "line:N"）
    pub source: String,
    /// 置信度 0-1
    pub confidence: f64,
}

/// TodoExtractor：从 OCR 文本提取 TODO 项
pub struct TodoExtractor {
    patterns: Vec<(Regex, bool)>,
}

impl TodoExtractor {
    /// 创建实例并编译所有匹配模式
    pub fn new() -> Self {
        // (正则, 是否为已完成模式)
        // 使用 (?i) 忽略大小写
        let patterns: Vec<(Regex, bool)> = vec![
            // Markdown 已完成项
            (Regex::new(r"(?i)^\s*[-*]\s*\[x\]\s*(.+)$").unwrap(), true),
            // Markdown 未完成项
            (Regex::new(r"(?i)^\s*[-*]\s*\[\s\]\s*(.+)$").unwrap(), false),
            // TODO: ...
            (Regex::new(r"(?i)^\s*TODO\s*[:：]\s*(.+)$").unwrap(), false),
            // 待办: ...
            (Regex::new(r"^\s*待办\s*[:：]\s*(.+)$").unwrap(), false),
            // 下一步: ...
            (Regex::new(r"^\s*下一步\s*[:：]\s*(.+)$").unwrap(), false),
            // Action Item: ...
            (Regex::new(r"(?i)^\s*Action\s+Item\s*[:：]\s*(.+)$").unwrap(), false),
            // 需要 ...
            (Regex::new(r"^\s*需要\s*(.+)$").unwrap(), false),
        ];
        TodoExtractor { patterns }
    }

    /// 从 OCR 文本提取 TODO 项
    pub fn extract(&self, ocr_text: &str) -> Vec<TodoItem> {
        let mut items: Vec<TodoItem> = Vec::new();
        for (idx, line) in ocr_text.lines().enumerate() {
            let line = line.trim_end();
            if line.trim().is_empty() {
                continue;
            }
            for (re, completed) in &self.patterns {
                if let Some(caps) = re.captures(line) {
                    let text = caps
                        .get(1)
                        .map(|m| m.as_str().trim().to_string())
                        .unwrap_or_default();
                    if text.is_empty() {
                        continue;
                    }
                    let confidence = compute_confidence(&text, *completed);
                    items.push(TodoItem {
                        text,
                        completed: *completed,
                        source: format!("line:{}", idx + 1),
                        confidence,
                    });
                    break; // 同一行只匹配一个模式
                }
            }
        }
        items
    }
}

impl Default for TodoExtractor {
    fn default() -> Self {
        Self::new()
    }
}

/// 计算置信度：基于文本长度与是否已完成
fn compute_confidence(text: &str, completed: bool) -> f64 {
    let mut confidence: f64 = 0.7;
    let len = text.chars().count();
    if len >= 4 && len <= 80 {
        confidence += 0.15;
    } else if len < 2 {
        confidence -= 0.2;
    }
    if completed {
        confidence += 0.05;
    }
    // 限制在 [0,1]
    confidence.max(0.0).min(1.0)
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_todo_english() {
        let text = "TODO: 修复登录页 bug\nAction Item: 跟进客户反馈";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "修复登录页 bug");
        assert!(!items[0].completed);
        assert_eq!(items[0].source, "line:1");
        assert_eq!(items[1].text, "跟进客户反馈");
    }

    #[test]
    fn test_extract_todo_chinese() {
        let text = "待办: 写周报\n下一步: 联系张三\n需要确认需求细节";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].text, "写周报");
        assert_eq!(items[1].text, "联系张三");
        assert_eq!(items[2].text, "确认需求细节");
    }

    #[test]
    fn test_extract_markdown_checkbox() {
        let text = "- [ ] 未完成任务\n- [x] 已完成任务\n* [ ] 另一个未完成";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert_eq!(items.len(), 3);
        assert!(!items[0].completed);
        assert!(items[1].completed);
        assert!(!items[2].completed);
    }

    #[test]
    fn test_extract_skips_empty_lines() {
        let text = "\n\nTODO: 任务 A\n\n\n待办: 任务 B\n";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "任务 A");
        assert_eq!(items[1].text, "任务 B");
    }

    #[test]
    fn test_extract_no_match_returns_empty() {
        let text = "这是一段普通文本\n没有 TODO 标记\n只是描述性内容";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert!(items.is_empty());
    }

    #[test]
    fn test_extract_confidence_in_range() {
        let text = "TODO: 这是一个比较合理的任务描述用于测试置信度计算";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert_eq!(items.len(), 1);
        let conf = items[0].confidence;
        assert!(conf >= 0.0 && conf <= 1.0);
        assert!(conf > 0.7);
    }

    #[test]
    fn test_extract_source_line_number() {
        let text = "第一行\n第二行\nTODO: 第三行的任务";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert_eq!(items[0].source, "line:3");
    }

    #[test]
    fn test_extract_case_insensitive_todo() {
        let text = "todo: 小写\nTODO: 大写\nTodo: 混合";
        let extractor = TodoExtractor::new();
        let items = extractor.extract(text);
        assert_eq!(items.len(), 3);
    }
}
