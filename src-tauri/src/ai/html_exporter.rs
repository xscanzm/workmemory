//! HtmlExporter：Markdown → 富文本 HTML 转换器（对应 electron/ai/HtmlExporter.ts）
//!
//! 用于剪贴板富文本复制（粘贴到 Word / 飞书 / 钉钉文档等保留格式）。
//! 所有样式均为 inline style，因为富文本粘贴目标仅识别 inline style，不识别 CSS class。
//!
//! 支持 Markdown 元素：
//!  - 标题 # / ## / ### → <h1>/<h2>/<h3>
//!  - 无序列表 - / * → <ul><li>
//!  - 有序列表 1. 2. → <ol><li>
//!  - 粗体 **text** → <strong>
//!  - 斜体 *text* → <em>
//!  - 代码块 ``` → <pre><code>
//!  - 行内代码 `code` → <code>
//!  - 段落 → <p>
//!  - 水平分割线 --- → <hr>
//!  - 引用 > → <blockquote>
//!  - 链接 [text](url) → <a>
//!
//! 边界处理：空输入返回空字符串；嵌套格式按优先级匹配；HTML 特殊字符转义。

use std::sync::OnceLock;

use regex::Regex;

/// 转义 HTML 特殊字符，避免破坏 HTML 结构
fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// 行内格式节点
#[derive(Debug, Clone)]
enum InlineNode {
    Text(String),
    Bold(String),
    Italic(String),
    Code(String),
    Link { content: String, href: String },
}

/// 行内格式解析：按优先级匹配 code > bold > italic > link
fn parse_inline(text: &str) -> Vec<InlineNode> {
    static RE_CODE: OnceLock<Regex> = OnceLock::new();
    static RE_BOLD: OnceLock<Regex> = OnceLock::new();
    static RE_ITALIC: OnceLock<Regex> = OnceLock::new();
    static RE_LINK: OnceLock<Regex> = OnceLock::new();

    let re_code = RE_CODE.get_or_init(|| Regex::new(r"`([^`]+)`").unwrap());
    let re_bold = RE_BOLD.get_or_init(|| Regex::new(r"\*\*([^*]+)\*\*").unwrap());
    let re_italic = RE_ITALIC.get_or_init(|| Regex::new(r"\*([^*]+)\*").unwrap());
    let re_link = RE_LINK.get_or_init(|| Regex::new(r"\[([^\]]+)\]\(([^)]+)\)").unwrap());

    let mut nodes: Vec<InlineNode> = Vec::new();
    let mut remaining = text;

    while !remaining.is_empty() {
        // 找出最早匹配的 token
        let mut earliest: Option<(usize, usize, &Regex, &str)> = None;

        for (re, kind) in [
            (re_code, "code"),
            (re_bold, "bold"),
            (re_italic, "italic"),
            (re_link, "link"),
        ] {
            if let Some(m) = re.find(remaining) {
                let pos = m.start();
                if earliest.is_none() || pos < earliest.unwrap().0 {
                    earliest = Some((pos, m.end(), re, kind));
                }
            }
        }

        match earliest {
            None => {
                nodes.push(InlineNode::Text(remaining.to_string()));
                break;
            }
            Some((start, end, re, kind)) => {
                if start > 0 {
                    nodes.push(InlineNode::Text(remaining[..start].to_string()));
                }
                let caps = re.captures(&remaining[start..end]).unwrap();
                match kind {
                    "code" => {
                        nodes.push(InlineNode::Code(caps.get(1).unwrap().as_str().to_string()));
                    }
                    "bold" => {
                        nodes.push(InlineNode::Bold(caps.get(1).unwrap().as_str().to_string()));
                    }
                    "italic" => {
                        nodes.push(InlineNode::Italic(caps.get(1).unwrap().as_str().to_string()));
                    }
                    "link" => {
                        nodes.push(InlineNode::Link {
                            content: caps.get(1).unwrap().as_str().to_string(),
                            href: caps.get(2).unwrap().as_str().to_string(),
                        });
                    }
                    _ => {}
                }
                remaining = &remaining[end..];
            }
        }
    }
    nodes
}

/// 行内样式常量（inline style，便于粘贴到 Word/飞书保留格式）
const INLINE_STYLE_CODE: &str = "font-family: Consolas, Monaco, \"Courier New\", monospace; font-size: 12px; background: #eef2f7; color: #c7254e; padding: 1px 4px; border-radius: 3px;";
const INLINE_STYLE_LINK: &str = "color: #2b7fff; text-decoration: underline;";

/// 将行内节点渲染为 HTML 字符串（含 inline style）
fn render_inline_nodes(nodes: &[InlineNode]) -> String {
    nodes
        .iter()
        .map(|node| match node {
            InlineNode::Bold(content) => format!("<strong>{}</strong>", escape_html(content)),
            InlineNode::Italic(content) => format!("<em>{}</em>", escape_html(content)),
            InlineNode::Code(content) => format!(
                "<code style=\"{}\">{}</code>",
                INLINE_STYLE_CODE,
                escape_html(content)
            ),
            InlineNode::Link { content, href } => format!(
                "<a href=\"{}\" style=\"{}\">{}</a>",
                escape_html(href),
                INLINE_STYLE_LINK,
                escape_html(content)
            ),
            InlineNode::Text(content) => escape_html(content),
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Markdown 块级结构
#[derive(Debug, Clone)]
enum MarkdownBlock {
    H1(String),
    H2(String),
    H3(String),
    Ul(Vec<String>),
    Ol(Vec<String>),
    P(String),
    Quote(String),
    Hr,
    Code(String),
}

/// 判断是否为水平分割线
fn is_hr(s: &str) -> bool {
    if s.len() < 3 {
        return false;
    }
    let chars: Vec<char> = s.chars().collect();
    if !chars.iter().all(|c| *c == '-' || *c == '*' || *c == '_') {
        return false;
    }
    chars.len() >= 3
}

/// 将 Markdown 解析为块级结构
fn parse_blocks(content: &str) -> Vec<MarkdownBlock> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut blocks: Vec<MarkdownBlock> = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // 代码块 ```lang ... ```
        if trimmed.starts_with("```") {
            let mut code_lines: Vec<String> = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim().starts_with("```") {
                code_lines.push(lines[i].to_string());
                i += 1;
            }
            if i < lines.len() {
                i += 1; // 跳过结束 ```
            }
            blocks.push(MarkdownBlock::Code(code_lines.join("\n")));
            continue;
        }

        // 水平分割线
        if is_hr(trimmed) {
            blocks.push(MarkdownBlock::Hr);
            i += 1;
            continue;
        }

        // 标题
        if let Some(rest) = trimmed.strip_prefix("# ") {
            blocks.push(MarkdownBlock::H1(rest.to_string()));
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("## ") {
            blocks.push(MarkdownBlock::H2(rest.to_string()));
            i += 1;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("### ") {
            blocks.push(MarkdownBlock::H3(rest.to_string()));
            i += 1;
            continue;
        }

        // 引用
        if let Some(rest) = trimmed.strip_prefix("> ") {
            let mut quote_lines: Vec<String> = vec![rest.to_string()];
            i += 1;
            while i < lines.len() {
                let t = lines[i].trim();
                if let Some(r) = t.strip_prefix("> ") {
                    quote_lines.push(r.to_string());
                    i += 1;
                } else {
                    break;
                }
            }
            blocks.push(MarkdownBlock::Quote(quote_lines.join("\n")));
            continue;
        }

        // 无序列表
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let mut items: Vec<String> = Vec::new();
            while i < lines.len() {
                let t = lines[i].trim();
                if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
                    items.push(rest.to_string());
                    i += 1;
                } else {
                    break;
                }
            }
            blocks.push(MarkdownBlock::Ul(items));
            continue;
        }

        // 有序列表
        if let Some(dot_pos) = trimmed.find(". ") {
            let prefix = &trimmed[..dot_pos];
            if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) {
                let mut items: Vec<String> = Vec::new();
                while i < lines.len() {
                    let t = lines[i].trim();
                    if let Some(dp) = t.find(". ") {
                        let p = &t[..dp];
                        if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
                            items.push(t[dp + 2..].to_string());
                            i += 1;
                            continue;
                        }
                    }
                    break;
                }
                blocks.push(MarkdownBlock::Ol(items));
                continue;
            }
        }

        // 段落：连续非空行
        let mut para_lines: Vec<String> = vec![line.to_string()];
        i += 1;
        while i < lines.len() {
            let t = lines[i].trim();
            if t.is_empty()
                || t.starts_with("# ")
                || t.starts_with("## ")
                || t.starts_with("### ")
                || t.starts_with("- ")
                || t.starts_with("* ")
                || t.starts_with("> ")
                || t.starts_with("```")
                || is_hr(t)
            {
                break;
            }
            // 检查是否为有序列表起始
            if let Some(dot_pos) = t.find(". ") {
                let prefix = &t[..dot_pos];
                if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) {
                    break;
                }
            }
            para_lines.push(lines[i].to_string());
            i += 1;
        }
        blocks.push(MarkdownBlock::P(para_lines.join("\n")));
    }

    blocks
}

/// 块级 inline style 常量
const STYLE_H1: &str = "font-size: 22px; font-weight: 700; color: #1a2332; margin: 18px 0 10px; line-height: 1.3; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
const STYLE_H2: &str = "font-size: 17px; font-weight: 600; color: #1a2332; margin: 14px 0 8px; line-height: 1.3; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
const STYLE_H3: &str = "font-size: 14px; font-weight: 600; color: #5a6a7e; margin: 12px 0 6px; line-height: 1.4; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
const STYLE_P: &str = "font-size: 13px; color: #1a2332; margin: 6px 0; line-height: 1.7; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif; white-space: pre-wrap; word-break: break-word;";
const STYLE_UL: &str = "font-size: 13px; color: #1a2332; margin: 6px 0; padding-left: 24px; line-height: 1.7; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
const STYLE_OL: &str = "font-size: 13px; color: #1a2332; margin: 6px 0; padding-left: 24px; line-height: 1.7; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif;";
const STYLE_LI: &str = "margin: 3px 0;";
const STYLE_HR: &str = "border: none; border-top: 1px solid #e1e7ef; margin: 12px 0;";
const STYLE_QUOTE: &str = "margin: 8px 0; padding: 8px 14px; border-left: 3px solid #2b7fff; background: #f0f6ff; color: #5a6a7e; font-size: 13px; line-height: 1.7; font-family: \"Microsoft YaHei\", \"PingFang SC\", sans-serif; white-space: pre-wrap; word-break: break-word;";
const STYLE_PRE: &str = "margin: 10px 0; padding: 12px 14px; background: #f5f7fa; border: 1px solid #e1e7ef; border-radius: 6px; overflow-x: auto; line-height: 1.5;";
const STYLE_CODE_BLOCK: &str = "font-family: Consolas, Monaco, \"Courier New\", monospace; font-size: 12px; color: #1a2332; white-space: pre-wrap; word-break: break-word;";

/// 将 Markdown 转换为带 inline style 的 HTML 字符串，适合剪贴板富文本复制。
///
/// # 参数
/// - `markdown`：Markdown 源文本
///
/// # 返回
/// HTML 字符串（仅 body 片段，无 <html>/<head> 包裹）
pub fn markdown_to_rich_html(markdown: &str) -> String {
    if markdown.trim().is_empty() {
        return String::new();
    }
    let blocks = parse_blocks(markdown);
    let parts: Vec<String> = blocks
        .iter()
        .map(|block| match block {
            MarkdownBlock::H1(text) => format!(
                "<h1 style=\"{}\">{}</h1>",
                STYLE_H1,
                render_inline_nodes(&parse_inline(text))
            ),
            MarkdownBlock::H2(text) => format!(
                "<h2 style=\"{}\">{}</h2>",
                STYLE_H2,
                render_inline_nodes(&parse_inline(text))
            ),
            MarkdownBlock::H3(text) => format!(
                "<h3 style=\"{}\">{}</h3>",
                STYLE_H3,
                render_inline_nodes(&parse_inline(text))
            ),
            MarkdownBlock::Ul(items) => {
                let lis: String = items
                    .iter()
                    .map(|item| {
                        format!(
                            "<li style=\"{}\">{}</li>",
                            STYLE_LI,
                            render_inline_nodes(&parse_inline(item))
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("");
                format!("<ul style=\"{}\">{}</ul>", STYLE_UL, lis)
            }
            MarkdownBlock::Ol(items) => {
                let lis: String = items
                    .iter()
                    .map(|item| {
                        format!(
                            "<li style=\"{}\">{}</li>",
                            STYLE_LI,
                            render_inline_nodes(&parse_inline(item))
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("");
                format!("<ol style=\"{}\">{}</ol>", STYLE_OL, lis)
            }
            MarkdownBlock::Quote(text) => format!(
                "<blockquote style=\"{}\">{}</blockquote>",
                STYLE_QUOTE,
                render_inline_nodes(&parse_inline(text))
            ),
            MarkdownBlock::Hr => format!("<hr style=\"{}\"/>", STYLE_HR),
            MarkdownBlock::Code(text) => format!(
                "<pre style=\"{}\"><code style=\"{}\">{}</code></pre>",
                STYLE_PRE,
                STYLE_CODE_BLOCK,
                escape_html(text)
            ),
            MarkdownBlock::P(text) => format!(
                "<p style=\"{}\">{}</p>",
                STYLE_P,
                render_inline_nodes(&parse_inline(text))
            ),
        })
        .collect();
    parts.join("\n")
}

/// HtmlExporter：Markdown → 富文本 HTML 转换器
pub struct HtmlExporter;

impl HtmlExporter {
    pub fn new() -> Self {
        HtmlExporter
    }

    /// 将 Report 的 markdown_content 转换为 HTML 字符串。
    pub fn export_to_html(&self, markdown: &str) -> String {
        markdown_to_rich_html(markdown)
    }
}

impl Default for HtmlExporter {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试空输入
    #[test]
    fn test_empty_input() {
        assert_eq!(markdown_to_rich_html(""), "");
        assert_eq!(markdown_to_rich_html("   "), "");
    }

    /// 测试标题转换
    #[test]
    fn test_headings() {
        let html = markdown_to_rich_html("# 一级标题\n## 二级标题\n### 三级标题");
        assert!(html.contains("<h1"));
        assert!(html.contains("一级标题"));
        assert!(html.contains("<h2"));
        assert!(html.contains("二级标题"));
        assert!(html.contains("<h3"));
        assert!(html.contains("三级标题"));
    }

    /// 测试无序列表
    #[test]
    fn test_unordered_list() {
        let html = markdown_to_rich_html("- 项目 A\n- 项目 B");
        assert!(html.contains("<ul"));
        assert!(html.contains("<li"));
        assert!(html.contains("项目 A"));
        assert!(html.contains("项目 B"));
    }

    /// 测试有序列表
    #[test]
    fn test_ordered_list() {
        let html = markdown_to_rich_html("1. 第一步\n2. 第二步");
        assert!(html.contains("<ol"));
        assert!(html.contains("<li"));
        assert!(html.contains("第一步"));
        assert!(html.contains("第二步"));
    }

    /// 测试粗体
    #[test]
    fn test_bold() {
        let html = markdown_to_rich_html("这是 **粗体** 文本");
        assert!(html.contains("<strong>粗体</strong>"));
    }

    /// 测试行内代码
    #[test]
    fn test_inline_code() {
        let html = markdown_to_rich_html("使用 `code` 标记");
        assert!(html.contains("<code"));
        assert!(html.contains("code"));
    }

    /// 测试链接
    #[test]
    fn test_link() {
        let html = markdown_to_rich_html("[点击](http://example.com)");
        assert!(html.contains("<a"));
        assert!(html.contains("href=\"http://example.com\""));
        assert!(html.contains("点击"));
    }

    /// 测试代码块
    #[test]
    fn test_code_block() {
        let html = markdown_to_rich_html("```\nfn main() {}\n```");
        assert!(html.contains("<pre"));
        assert!(html.contains("<code"));
        assert!(html.contains("fn main() {}"));
    }

    /// 测试水平分割线
    #[test]
    fn test_horizontal_rule() {
        let html = markdown_to_rich_html("---");
        assert!(html.contains("<hr"));
    }

    /// 测试引用
    #[test]
    fn test_blockquote() {
        let html = markdown_to_rich_html("> 这是引用");
        assert!(html.contains("<blockquote"));
        assert!(html.contains("这是引用"));
    }

    /// 测试 HTML 转义
    #[test]
    fn test_escape_html() {
        let html = markdown_to_rich_html("<script>alert(1)</script>");
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>"));
    }

    /// 测试 HtmlExporter 创建与导出
    #[test]
    fn test_html_exporter() {
        let exporter = HtmlExporter::new();
        let html = exporter.export_to_html("# 标题");
        assert!(html.contains("<h1"));
        assert!(html.contains("标题"));
    }

    /// 测试 is_hr
    #[test]
    fn test_is_hr() {
        assert!(is_hr("---"));
        assert!(is_hr("****"));
        assert!(is_hr("___"));
        assert!(!is_hr("--"));
        assert!(!is_hr("abc"));
    }
}
