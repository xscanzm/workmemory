//! ActionFlowInferrer：操作流推断器（对应 electron/capture/ActionFlowInferrer.ts）
//!
//! 通过相邻 segment 的对比推断用户操作流（复制粘贴/上下文切换/深度滚动/
//! 连续编辑/线性浏览），用于感知增强。
//!
//! 推断规则（按优先级从高到低）：
//!  - copy-paste: prev 的某段文本（≥10 字）在 curr 中出现，且时间间隔 <2min
//!  - switch-context: appName 变化，或非浏览器应用的 windowTitle 变化
//!  - browse-linear: 同浏览器应用，windowTitle 或 browserUrl 变化，时间间隔 <2min
//!  - scroll-deep: 同窗口，OCR 文本行级重叠率 >50% 且有新增内容，时间间隔 <1min
//!  - edit-continuous: 同应用同窗口，OCR 文本渐进变化（行级差异 20-50%）
//!  - unknown: 以上都不匹配
//!
//! 时间解析：支持 ISO 时间戳（如 "2026-06-21T10:30:00.000Z"）和 HH:MM:SS 格式。

use std::collections::HashSet;

use chrono::{DateTime, NaiveTime, Timelike, Utc};

use crate::models::ActionFlow;

/// 浏览器应用关键词（用于 browse-linear 判定）
const BROWSER_APP_KEYWORDS: &[&str] = &[
    "chrome", "edge", "firefox", "safari", "brave", "opera", "vivaldi", "arc", "chromium",
];

/// copy-paste 时间间隔阈值（秒）
const COPY_PASTE_MAX_INTERVAL: i64 = 2 * 60;
/// browse-linear 时间间隔阈值（秒）
const BROWSE_LINEAR_MAX_INTERVAL: i64 = 2 * 60;
/// scroll-deep 时间间隔阈值（秒）
const SCROLL_DEEP_MAX_INTERVAL: i64 = 1 * 60;
/// copy-paste 最小文本长度（字符）
const COPY_PASTE_MIN_LENGTH: usize = 10;
/// scroll-deep 重叠率阈值
const SCROLL_DEEP_MIN_OVERLAP: f64 = 0.5;
/// edit-continuous 行级差异范围
const EDIT_CONTINUOUS_MIN_DIFF: f64 = 0.2;
const EDIT_CONTINUOUS_MAX_DIFF: f64 = 0.5;
/// 一天的秒数（用于 HH:MM:SS 跨天修正）
const SECONDS_PER_DAY: i64 = 86400;
/// 证据中展示的文本块最大长度
const EVIDENCE_PREVIEW_MAX: usize = 40;

/// 轻量 Segment 输入接口（不直接依赖完整 WorkSegment，降低耦合）
#[derive(Debug, Clone, Default)]
pub struct SegmentLike {
    /// Segment id
    pub id: String,
    /// 应用名
    pub app_name: String,
    /// 窗口标题
    pub window_title: String,
    /// OCR 文本
    pub ocr_text: String,
    /// 开始时间（ISO 时间戳或 HH:MM:SS）
    pub start_time: String,
    /// 结束时间（ISO 时间戳或 HH:MM:SS）
    pub end_time: String,
    /// 浏览器 URL
    pub browser_url: Option<String>,
}

/// 推断结果
#[derive(Debug, Clone)]
pub struct ActionFlowInference {
    /// 操作流类型
    pub action_flow: ActionFlow,
    /// 证据说明
    pub evidence: String,
}

/// 解析时间字符串为秒数。
/// 支持 ISO 时间戳（如 "2026-06-21T10:30:00.000Z"）和 HH:MM:SS 格式。
/// 解析失败返回 None。
fn parse_time_to_seconds(time: &str) -> Option<i64> {
    let trimmed = time.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 尝试 ISO 时间戳
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp());
    }
    if let Ok(dt) = trimmed.parse::<DateTime<Utc>>() {
        return Some(dt.timestamp());
    }

    // HH:MM:SS 格式（可选小数秒）
    if let Ok(t) = NaiveTime::parse_from_str(trimmed, "%H:%M:%S") {
        return Some(t.num_seconds_from_midnight() as i64);
    }
    if let Ok(t) = NaiveTime::parse_from_str(trimmed, "%H:%M:%S%.f") {
        return Some(t.num_seconds_from_midnight() as i64);
    }

    None
}

/// 计算时间间隔（curr.startTime - prev.endTime），单位秒。
/// 支持 HH:MM:SS 跨天（若结果为负且在 24h 内，加 24h 修正）。
/// 解析失败返回 None（时间相关规则不匹配）。
fn get_time_diff_seconds(prev_end: &str, curr_start: &str) -> Option<i64> {
    let prev = parse_time_to_seconds(prev_end)?;
    let curr = parse_time_to_seconds(curr_start)?;
    let mut diff = curr - prev;
    if diff < 0 && diff > -SECONDS_PER_DAY {
        diff += SECONDS_PER_DAY;
    }
    Some(diff)
}

/// 判断是否为浏览器应用
fn is_browser_app(app_name: &str) -> bool {
    let lower = app_name.to_lowercase();
    BROWSER_APP_KEYWORDS.iter().any(|k| lower.contains(k))
}

/// 按行分割 OCR 文本，去除空行并 trim
fn split_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| l.len() > 0)
        .collect()
}

/// 从 OCR 文本中提取候选文本块（按行/句分割）
fn extract_chunks(text: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let lines = split_lines(text);
    for line in &lines {
        chunks.push(line.clone());
        // 长行额外按句末标点分割
        if line.len() > 30 {
            let sentence_re = regex::Regex::new(r"[。！？.!?]").unwrap();
            let parts: Vec<&str> = sentence_re.split(line).collect();
            for part in parts {
                let trimmed = part.trim();
                if trimmed.len() >= COPY_PASTE_MIN_LENGTH {
                    chunks.push(trimmed.to_string());
                }
            }
        }
    }
    chunks
}

/// 计算行级 Jaccard 相似度及 curr 中的新增行
fn line_jaccard(prev_text: &str, curr_text: &str) -> (f64, Vec<String>) {
    let prev_lines: HashSet<String> = split_lines(prev_text).into_iter().collect();
    let curr_lines = split_lines(curr_text);
    let curr_set: HashSet<String> = curr_lines.iter().cloned().collect();

    let intersection = prev_lines.intersection(&curr_set).count();
    let union = prev_lines.len() + curr_set.len() - intersection;
    let similarity = if union > 0 {
        intersection as f64 / union as f64
    } else {
        0.0
    };

    let new_lines: Vec<String> = curr_lines.iter().filter(|l| !prev_lines.contains(*l)).cloned().collect();

    (similarity, new_lines)
}

/// 检测 copy-paste：在 prev.ocrText 中查找 ≥10 字的块，检查是否在 curr.ocrText 中出现
fn detect_copy_paste(prev: &SegmentLike, curr: &SegmentLike) -> Option<String> {
    let chunks = extract_chunks(&prev.ocr_text);
    let mut candidates: Vec<String> = chunks
        .into_iter()
        .filter(|c| c.len() >= COPY_PASTE_MIN_LENGTH)
        .collect();
    // 按长度降序
    candidates.sort_by(|a, b| b.len().cmp(&a.len()));
    for chunk in candidates {
        if curr.ocr_text.contains(&chunk) {
            return Some(chunk);
        }
    }
    None
}

/// 截断文本块用于证据展示
fn preview_chunk(chunk: &str) -> String {
    if chunk.chars().count() > EVIDENCE_PREVIEW_MAX {
        let truncated: String = chunk.chars().take(EVIDENCE_PREVIEW_MAX).collect();
        format!("{}...", truncated)
    } else {
        chunk.to_string()
    }
}

/// 推断相邻两个 segment 之间的操作流。
///
/// 无法识别时 actionFlow=unknown。
pub fn infer_action_flow(prev: &SegmentLike, curr: &SegmentLike) -> ActionFlowInference {
    let time_diff = get_time_diff_seconds(&prev.end_time, &curr.start_time);
    let same_app = prev.app_name.to_lowercase() == curr.app_name.to_lowercase();
    let same_title = prev.window_title == curr.window_title;
    let prev_is_browser = is_browser_app(&prev.app_name);
    let curr_is_browser = is_browser_app(&curr.app_name);

    // 1. copy-paste（最高优先级）
    if let Some(diff) = time_diff {
        if diff < COPY_PASTE_MAX_INTERVAL {
            if let Some(pasted_chunk) = detect_copy_paste(prev, curr) {
                return ActionFlowInference {
                    action_flow: ActionFlow::CopyPaste,
                    evidence: format!(
                        "prev 中的 '{}' 出现在 curr 中",
                        preview_chunk(&pasted_chunk)
                    ),
                };
            }
        }
    }

    // 2. switch-context：appName 变化
    if !same_app {
        return ActionFlowInference {
            action_flow: ActionFlow::SwitchContext,
            evidence: format!(
                "应用从 '{}' 切换到 '{}'",
                if prev.app_name.is_empty() { "(空)" } else { &prev.app_name },
                if curr.app_name.is_empty() { "(空)" } else { &curr.app_name }
            ),
        };
    }
    // 非浏览器应用的 windowTitle 变化也归入 switch-context
    if !same_title && !(prev_is_browser && curr_is_browser) {
        return ActionFlowInference {
            action_flow: ActionFlow::SwitchContext,
            evidence: format!(
                "窗口从 '{}' 切换到 '{}'",
                if prev.window_title.is_empty() { "(空)" } else { &prev.window_title },
                if curr.window_title.is_empty() { "(空)" } else { &curr.window_title }
            ),
        };
    }

    // 3. browse-linear：同浏览器应用，windowTitle 或 browserUrl 变化
    if let Some(diff) = time_diff {
        if prev_is_browser && curr_is_browser && diff < BROWSE_LINEAR_MAX_INTERVAL {
            let url_changed = prev.browser_url.is_some()
                && curr.browser_url.is_some()
                && prev.browser_url != curr.browser_url;
            let title_changed = !same_title;
            if title_changed || url_changed {
                let change = if title_changed {
                    format!(
                        "标题从 '{}' 变为 '{}'",
                        if prev.window_title.is_empty() { "(空)" } else { &prev.window_title },
                        if curr.window_title.is_empty() { "(空)" } else { &curr.window_title }
                    )
                } else {
                    format!(
                        "URL 从 '{}' 变为 '{}'",
                        prev.browser_url.as_deref().unwrap_or(""),
                        curr.browser_url.as_deref().unwrap_or("")
                    )
                };
                return ActionFlowInference {
                    action_flow: ActionFlow::BrowseLinear,
                    evidence: format!("浏览器线性浏览，{}", change),
                };
            }
        }
    }

    // 4. scroll-deep：同窗口，OCR 文本重叠率 >50% 且有新增内容
    if let Some(diff) = time_diff {
        if same_app && same_title && diff < SCROLL_DEEP_MAX_INTERVAL {
            let (similarity, new_lines) = line_jaccard(&prev.ocr_text, &curr.ocr_text);
            if similarity > SCROLL_DEEP_MIN_OVERLAP && !new_lines.is_empty() {
                return ActionFlowInference {
                    action_flow: ActionFlow::ScrollDeep,
                    evidence: format!(
                        "同窗口深度滚动，OCR 文本重叠率 {}%，新增 {} 行",
                        (similarity * 100.0).round() as i64,
                        new_lines.len()
                    ),
                };
            }
        }
    }

    // 5. edit-continuous：同应用同窗口，OCR 文本渐进变化
    if same_app && same_title {
        let (similarity, _) = line_jaccard(&prev.ocr_text, &curr.ocr_text);
        let diff = 1.0 - similarity;
        if diff >= EDIT_CONTINUOUS_MIN_DIFF && diff <= EDIT_CONTINUOUS_MAX_DIFF {
            return ActionFlowInference {
                action_flow: ActionFlow::EditContinuous,
                evidence: format!(
                    "同应用同窗口，OCR 文本渐进变化（差异 {}%）",
                    (diff * 100.0).round() as i64
                ),
            };
        }
    }

    // 6. unknown
    ActionFlowInference {
        action_flow: ActionFlow::Unknown,
        evidence: "无法识别操作流".to_string(),
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_segment(id: &str, app: &str, title: &str, ocr: &str, start: &str, end: &str) -> SegmentLike {
        SegmentLike {
            id: id.to_string(),
            app_name: app.to_string(),
            window_title: title.to_string(),
            ocr_text: ocr.to_string(),
            start_time: start.to_string(),
            end_time: end.to_string(),
            browser_url: None,
        }
    }

    #[test]
    fn test_copy_paste_detection() {
        let prev = make_segment("s1", "Code", "main.rs", "这是一段需要复制的长文本内容用于测试", "10:00:00", "10:01:00");
        let curr = make_segment("s2", "Word", "doc.docx", "这是一段需要复制的长文本内容用于测试 加点新内容", "10:01:30", "10:02:00");
        let result = infer_action_flow(&prev, &curr);
        assert_eq!(result.action_flow, ActionFlow::CopyPaste);
        assert!(result.evidence.contains("出现在 curr 中"));
    }

    #[test]
    fn test_switch_context_app_change() {
        let prev = make_segment("s1", "Code", "main.rs", "code", "10:00:00", "10:01:00");
        let curr = make_segment("s2", "Chrome", "Google", "search", "10:05:00", "10:06:00");
        let result = infer_action_flow(&prev, &curr);
        assert_eq!(result.action_flow, ActionFlow::SwitchContext);
        assert!(result.evidence.contains("应用从"));
    }

    #[test]
    fn test_browse_linear() {
        let prev = make_segment("s1", "Chrome", "Google", "search", "10:00:00", "10:01:00");
        let mut curr = make_segment("s2", "Chrome", "GitHub", "code", "10:01:30", "10:02:00");
        curr.browser_url = Some("https://github.com".to_string());
        let result = infer_action_flow(&prev, &curr);
        assert_eq!(result.action_flow, ActionFlow::BrowseLinear);
        assert!(result.evidence.contains("浏览器线性浏览"));
    }

    #[test]
    fn test_scroll_deep() {
        let prev = make_segment("s1", "Chrome", "GitHub", "line1\nline2\nline3\nline4", "10:00:00", "10:00:30");
        let curr = make_segment("s2", "Chrome", "GitHub", "line1\nline2\nline3\nline4\nline5", "10:00:45", "10:01:00");
        let result = infer_action_flow(&prev, &curr);
        assert_eq!(result.action_flow, ActionFlow::ScrollDeep);
        assert!(result.evidence.contains("深度滚动"));
    }

    #[test]
    fn test_unknown_when_no_match() {
        let prev = make_segment("s1", "Code", "main.rs", "completely different text", "10:00:00", "10:01:00");
        let curr = make_segment("s2", "Code", "main.rs", "totally unrelated content here", "10:05:00", "10:06:00");
        let result = infer_action_flow(&prev, &curr);
        assert_eq!(result.action_flow, ActionFlow::Unknown);
    }

    #[test]
    fn test_parse_time_iso() {
        let t = parse_time_to_seconds("2026-06-21T10:30:00Z");
        assert!(t.is_some());
    }

    #[test]
    fn test_parse_time_hms() {
        let t = parse_time_to_seconds("10:30:45");
        assert_eq!(t, Some(10 * 3600 + 30 * 60 + 45));
    }

    #[test]
    fn test_parse_time_invalid() {
        assert!(parse_time_to_seconds("invalid").is_none());
        assert!(parse_time_to_seconds("").is_none());
    }
}
