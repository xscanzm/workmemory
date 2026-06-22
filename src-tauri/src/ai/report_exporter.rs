//! ReportExporter：报告导出器（对应 electron/ai/ReportExporter.ts）
//!
//! 支持 3 种导出格式：
//!  - Markdown（.md）：纯 Markdown 文本
//!  - HTML（.html）：使用 HtmlExporter 生成带 inline style 的 HTML
//!  - PlainText（.txt）：去除 Markdown 标记的纯文本
//!  - JSON（.json）：含完整元数据，用于存档审计
//!
//! 与 TypeScript 版本的差异：
//!  - 不生成 .docx（Rust 侧无 docx 库依赖，由前端或外部工具处理）
//!  - 新增 export_html / export_plain_text 方法

use crate::ai::html_exporter::markdown_to_rich_html;
use crate::models::{Report, ReportStatus};

/// 报告状态中文标签
fn status_label(status: &ReportStatus) -> &'static str {
    match status {
        ReportStatus::Draft => "草稿",
        ReportStatus::Exported => "已导出",
    }
}

/// ReportExporter：报告导出器
pub struct ReportExporter;

impl ReportExporter {
    pub fn new() -> Self {
        ReportExporter
    }

    /// 导出为 Markdown 文件内容。
    /// 返回纯 Markdown 文本，文件扩展名 .md。
    pub fn export_markdown(&self, report: &Report) -> String {
        format!(
            "<!-- WorkMemory 日报 | 日期: {} | 模板: {} | 状态: {} -->\n\n{}",
            report.date,
            report.template_name,
            status_label(&report.status),
            report.markdown_content
        )
    }

    /// 导出为 HTML 文件内容（带 inline style）。
    /// 使用 HtmlExporter 将 Markdown 转换为富文本 HTML。
    pub fn export_html(&self, report: &Report) -> String {
        let body = markdown_to_rich_html(&report.markdown_content);
        format!(
            "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n<title>工作日报 {}</title>\n</head>\n<body>\n{}\n</body>\n</html>",
            report.date, body
        )
    }

    /// 导出为纯文本（去除 Markdown 标记）。
    pub fn export_plain_text(&self, report: &Report) -> String {
        markdown_to_plain_text(&report.markdown_content)
    }

    /// 导出为 JSON 文件内容。
    /// 含完整元数据：date/template/segmentIds/aiInputSnapshot/markdownContent/status/createdAt。
    pub fn export_json(&self, report: &Report) -> String {
        let export_data = serde_json::json!({
            "exportedAt": now_iso(),
            "id": report.id,
            "date": report.date,
            "templateId": report.template_id.as_str(),
            "templateName": report.template_name,
            "status": report.status.as_str(),
            "reportType": report.report_type.as_str(),
            "segmentIds": report.segment_ids,
            "aiInputSnapshot": report.ai_input_snapshot,
            "markdownContent": report.markdown_content,
        });
        serde_json::to_string_pretty(&export_data).unwrap_or_default()
    }
}

impl Default for ReportExporter {
    fn default() -> Self {
        Self::new()
    }
}

/// 获取当前 ISO 时间戳
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 将 Markdown 转换为纯文本（去除标记符号）
fn markdown_to_plain_text(markdown: &str) -> String {
    let mut result = String::new();
    let mut in_code_block = false;

    for line in markdown.lines() {
        let trimmed = line.trim();

        // 代码块开始/结束
        if trimmed.starts_with("```") {
            in_code_block = !in_code_block;
            continue;
        }

        if in_code_block {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        // 水平分割线
        if is_hr(trimmed) {
            result.push_str("———————————————\n");
            continue;
        }

        // 标题：去除 # 前缀
        if let Some(stripped) = strip_heading(trimmed) {
            result.push_str(stripped);
            result.push('\n');
            continue;
        }

        // 引用：去除 > 前缀
        if let Some(stripped) = trimmed.strip_prefix("> ") {
            result.push_str(stripped);
            result.push('\n');
            continue;
        }

        // 列表项：去除 - / * / 1. 前缀
        let list_stripped = strip_list_marker(trimmed);
        if let Some(s) = list_stripped {
            result.push_str("• ");
            result.push_str(s);
            result.push('\n');
            continue;
        }

        // 普通行：去除行内格式标记
        let cleaned = strip_inline_format(line);
        result.push_str(&cleaned);
        result.push('\n');
    }

    result
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

/// 去除标题前缀（# / ## / ###），返回标题内容
fn strip_heading(s: &str) -> Option<&str> {
    let hashes = s.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    s.get(hashes..)
        .map(|rest| rest.trim_start())
}

/// 去除列表标记前缀（- / * / 1.），返回列表项内容
fn strip_list_marker(s: &str) -> Option<&str> {
    if let Some(rest) = s.strip_prefix("- ").or_else(|| s.strip_prefix("* ")) {
        return Some(rest);
    }
    // 有序列表：1. 2. 等
    let dot_pos = s.find(". ")?;
    let prefix = &s[..dot_pos];
    if !prefix.is_empty() && prefix.chars().all(|c| c.is_ascii_digit()) {
        return Some(&s[dot_pos + 2..]);
    }
    None
}

/// 去除行内格式标记（粗体、斜体、代码、链接）
fn strip_inline_format(s: &str) -> String {
    let mut result = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // 粗体 **text**
        if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
            if let Some(end) = find_double_char(&chars, i + 2, '*') {
                let inner: String = chars[i + 2..end].iter().collect();
                result.push_str(&inner);
                i = end + 2;
                continue;
            }
        }
        // 行内代码 `code`
        if chars[i] == '`' {
            if let Some(end) = find_single_char(&chars, i + 1, '`') {
                let inner: String = chars[i + 1..end].iter().collect();
                result.push_str(&inner);
                i = end + 1;
                continue;
            }
        }
        // 链接 [text](url)
        if chars[i] == '[' {
            if let Some(close_bracket) = find_single_char(&chars, i + 1, ']') {
                if close_bracket + 1 < chars.len() && chars[close_bracket + 1] == '(' {
                    if let Some(close_paren) = find_single_char(&chars, close_bracket + 2, ')') {
                        let inner: String = chars[i + 1..close_bracket].iter().collect();
                        result.push_str(&inner);
                        i = close_paren + 1;
                        continue;
                    }
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

/// 查找连续两个相同字符的位置
fn find_double_char(chars: &[char], start: usize, target: char) -> Option<usize> {
    let mut i = start;
    while i + 1 < chars.len() {
        if chars[i] == target && chars[i + 1] == target {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// 查找单个字符的位置
fn find_single_char(chars: &[char], start: usize, target: char) -> Option<usize> {
    chars.iter().skip(start).position(|c| *c == target).map(|p| p + start)
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Report, ReportStatus, ReportTemplate, ReportType};

    /// 构造测试用 Report
    fn make_report() -> Report {
        Report {
            id: "r1".to_string(),
            date: "2026-06-22".to_string(),
            template_id: ReportTemplate::Enhanced,
            template_name: "汇报优化版".to_string(),
            segment_ids: vec!["s1".to_string()],
            ai_input_snapshot: "{}".to_string(),
            markdown_content: "# 工作日报\n\n- 完成任务 A\n- 完成任务 B".to_string(),
            status: ReportStatus::Draft,
            report_type: ReportType::Daily,
        }
    }

    /// 测试 export_markdown
    #[test]
    fn test_export_markdown() {
        let exporter = ReportExporter::new();
        let report = make_report();
        let md = exporter.export_markdown(&report);
        assert!(md.contains("<!-- WorkMemory 日报"));
        assert!(md.contains("日期: 2026-06-22"));
        assert!(md.contains("模板: 汇报优化版"));
        assert!(md.contains("状态: 草稿"));
        assert!(md.contains("# 工作日报"));
    }

    /// 测试 export_html
    #[test]
    fn test_export_html() {
        let exporter = ReportExporter::new();
        let report = make_report();
        let html = exporter.export_html(&report);
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains("<html"));
        assert!(html.contains("工作日报"));
    }

    /// 测试 export_plain_text
    #[test]
    fn test_export_plain_text() {
        let exporter = ReportExporter::new();
        let report = make_report();
        let text = exporter.export_plain_text(&report);
        // 应去除 # 标记
        assert!(!text.contains("# 工作日报"));
        assert!(text.contains("工作日报"));
        // 应将 - 列表转为 •
        assert!(text.contains("• 完成任务 A"));
    }

    /// 测试 export_json
    #[test]
    fn test_export_json() {
        let exporter = ReportExporter::new();
        let report = make_report();
        let json = exporter.export_json(&report);
        assert!(json.contains("\"date\": \"2026-06-22\""));
        assert!(json.contains("\"templateName\": \"汇报优化版\""));
        assert!(json.contains("\"status\": \"draft\""));
    }

    /// 测试 markdown_to_plain_text 标题处理
    #[test]
    fn test_markdown_to_plain_text_heading() {
        let text = markdown_to_plain_text("# 标题一\n## 标题二\n### 标题三");
        assert!(text.contains("标题一"));
        assert!(text.contains("标题二"));
        assert!(text.contains("标题三"));
        assert!(!text.contains("#"));
    }

    /// 测试 markdown_to_plain_text 行内格式
    #[test]
    fn test_markdown_to_plain_text_inline() {
        let text = markdown_to_plain_text("这是 **粗体** 和 `代码` 和 [链接](http://x.com)");
        assert!(text.contains("粗体"));
        assert!(text.contains("代码"));
        assert!(text.contains("链接"));
        assert!(!text.contains("**"));
        assert!(!text.contains("`"));
        assert!(!text.contains("["));
        assert!(!text.contains("http://x.com"));
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

    /// 测试 strip_heading
    #[test]
    fn test_strip_heading() {
        assert_eq!(strip_heading("# 标题"), Some("标题"));
        assert_eq!(strip_heading("## 二级标题"), Some("二级标题"));
        assert_eq!(strip_heading("普通文本"), None);
    }

    /// 测试 strip_list_marker
    #[test]
    fn test_strip_list_marker() {
        assert_eq!(strip_list_marker("- 列表项"), Some("列表项"));
        assert_eq!(strip_list_marker("* 列表项"), Some("列表项"));
        assert_eq!(strip_list_marker("1. 有序项"), Some("有序项"));
        assert_eq!(strip_list_marker("普通文本"), None);
    }
}
