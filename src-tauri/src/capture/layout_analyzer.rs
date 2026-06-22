//! LayoutAnalyzer：UI 布局分析器（对应 electron/capture/LayoutAnalyzer.ts）
//!
//! 基于 OCR 文本块的坐标分布识别屏幕布局类型
//! （form/list/article/editor/chat/dashboard/other），
//! 增强对屏幕内容的结构化理解。
//!
//! 识别策略（基于 OCR 块坐标分布）：
//!  - form: "标签 + 输入框"交替排列 + 按钮文字
//!  - list: 多行等间距短文本块
//!  - article: 长段落连续排列，无交互元素
//!  - editor: 代码缩进/行号特征 + 等宽字体区域
//!  - chat: 左右分栏对话气泡 + 头像区域 + 昵称模式
//!  - dashboard: 网格布局 + 数据卡片
//!
//! 置信度计算：每个候选类型有 3 条规则，
//!   confidence = 匹配规则数 / 3；取所有候选中最高分；
//!   若最高分 ≥ 0.5 则赋该类型，否则返回 'other'。

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::models::{LayoutType, OcrBlock};

/// 置信度阈值：≥ 此值才赋具体布局类型，否则 other
pub const CONFIDENCE_THRESHOLD: f64 = 0.5;

/// 每个候选类型的规则总数
pub const RULES_PER_TYPE: usize = 3;

/// 布局区域类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutRegion {
    /// 区域类型（button/input/label/paragraph/bubble/avatar/card 等）
    #[serde(rename = "type")]
    pub region_type: String,
    /// 区域边界
    pub bounds: BoundsRect,
    /// 文本内容
    pub text: String,
    /// 置信度
    pub confidence: f64,
}

/// 区域边界
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundsRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 分析结果
#[derive(Debug, Clone)]
pub struct LayoutAnalysis {
    /// 布局类型
    pub layout_type: LayoutType,
    /// 布局区域
    pub regions: Vec<LayoutRegion>,
    /// 置信度 0-1
    pub confidence: f64,
}

/// 保留两位小数
fn round2(n: f64) -> f64 {
    let clamped = n.max(0.0).min(1.0);
    (clamped * 100.0).round() / 100.0
}

// ===================== 通用正则 =====================

fn button_keywords_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(提交|取消|确定|保存|重置|登录|注册|搜索|应用|关闭|确认)|(?:\b(?:submit|cancel|save|reset|login|sign in|sign up|search|apply|confirm|close|ok)\b)").unwrap()
    })
}

fn label_colon_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[:：]\s*$").unwrap())
}

fn line_number_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\d{1,4}\s+").unwrap())
}

fn code_indent_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(\s{2,}|\t+)").unwrap())
}

fn code_keyword_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\b(function|class|import|export|const|let|var|def|return|public|private|protected|void|interface|extends|implements|async|await|namespace|struct|enum|package|require|module|func|fn|if|else|for|while|switch|case|try|catch|finally|elif|endif)\b").unwrap()
    })
}

fn nickname_colon_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[\u4e00-\u9fff\w]{1,12}\s*[:：]").unwrap())
}

fn numeric_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b\d+(\.\d+)?\s*(%|k|m|万|亿)?\b").unwrap())
}

// ===================== 工具函数 =====================

/// 从 OcrBlock 构造 LayoutRegion
fn make_region(region_type: &str, block: &OcrBlock) -> LayoutRegion {
    LayoutRegion {
        region_type: region_type.to_string(),
        bounds: BoundsRect {
            x: block.box_rect.x,
            y: block.box_rect.y,
            w: block.box_rect.w,
            h: block.box_rect.h,
        },
        text: block.text.clone(),
        confidence: block.confidence,
    }
}

/// 计算变异系数 CV（标准差 / 均值）
fn coefficient_of_variation(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    if mean == 0.0 {
        return 0.0;
    }
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    variance.sqrt() / mean
}

/// 将相近的值（差值 < threshold）归为一类
fn cluster_values(values: &[f64], threshold: f64) -> Vec<Vec<f64>> {
    if values.is_empty() {
        return vec![];
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut clusters: Vec<Vec<f64>> = vec![vec![sorted[0]]];
    for i in 1..sorted.len() {
        if sorted[i] - sorted[i - 1] < threshold {
            clusters.last_mut().unwrap().push(sorted[i]);
        } else {
            clusters.push(vec![sorted[i]]);
        }
    }
    clusters
}

// ===================== 布局检测器 =====================

/// form 检测结果
struct DetectResult {
    matched: usize,
    regions: Vec<LayoutRegion>,
}

/// form 检测：表单布局
fn detect_form(blocks: &[OcrBlock]) -> DetectResult {
    if blocks.is_empty() {
        return DetectResult { matched: 0, regions: vec![] };
    }
    let mut regions: Vec<LayoutRegion> = Vec::new();
    let mut matched = 0;

    let mut sorted: Vec<&OcrBlock> = blocks.iter().collect();
    sorted.sort_by(|a, b| a.box_rect.y.partial_cmp(&b.box_rect.y).unwrap_or(std::cmp::Ordering::Equal));

    let labels: Vec<&&OcrBlock> = sorted
        .iter()
        .filter(|b| {
            let t = b.text.trim();
            t.len() <= 10 && label_colon_regex().is_match(t)
        })
        .collect();

    // 规则1：标签 + 输入框交替排列（≥ 2 对）
    let mut pairs = 0;
    for label in &labels {
        let input_block = sorted.iter().find(|b| {
            !std::ptr::eq(**b, **label)
                && (b.box_rect.y - label.box_rect.y).abs() < label.box_rect.h * 0.8
                && b.box_rect.x > label.box_rect.x + label.box_rect.w
                && b.box_rect.w > label.box_rect.w * 1.5
        });
        if let Some(input_block) = input_block {
            pairs += 1;
            regions.push(make_region("label", **label));
            regions.push(make_region("input", *input_block));
        }
    }
    if pairs >= 2 {
        matched += 1;
    }

    // 规则2：按钮文字
    let buttons: Vec<&&OcrBlock> = sorted
        .iter()
        .filter(|b| button_keywords_regex().is_match(b.text.trim()))
        .collect();
    if !buttons.is_empty() {
        matched += 1;
        for btn in &buttons {
            regions.push(make_region("button", **btn));
        }
    }

    // 规则3：垂直排列的表单字段（≥ 3 个不同 y 坐标的标签）
    let distinct_y: HashSet<i64> = labels.iter().map(|l| (l.box_rect.y / 10.0) as i64).collect();
    if labels.len() >= 3 && distinct_y.len() >= 3 {
        matched += 1;
    }

    DetectResult { matched, regions }
}

use std::collections::HashSet;

/// list 检测：列表布局
fn detect_list(blocks: &[OcrBlock]) -> DetectResult {
    if blocks.len() < 2 {
        return DetectResult { matched: 0, regions: vec![] };
    }
    let mut regions: Vec<LayoutRegion> = Vec::new();
    let mut matched = 0;

    let mut sorted: Vec<&OcrBlock> = blocks.iter().collect();
    sorted.sort_by(|a, b| a.box_rect.y.partial_cmp(&b.box_rect.y).unwrap_or(std::cmp::Ordering::Equal));

    // 规则1：行间距均匀
    let gaps: Vec<f64> = (1..sorted.len())
        .map(|i| sorted[i].box_rect.y - (sorted[i - 1].box_rect.y + sorted[i - 1].box_rect.h))
        .collect();
    let gap_cv = coefficient_of_variation(&gaps);
    if gaps.len() >= 2 && gap_cv < 0.3 && gaps.iter().all(|g| *g >= 0.0) {
        matched += 1;
    }

    // 规则2：文本长度相近且较短
    let lengths: Vec<f64> = sorted.iter().map(|b| b.text.trim().len() as f64).collect();
    let avg_len = lengths.iter().sum::<f64>() / lengths.len() as f64;
    let len_cv = coefficient_of_variation(&lengths);
    if avg_len > 0.0 && avg_len < 30.0 && len_cv < 0.5 {
        matched += 1;
    }

    // 规则3：行数 ≥ 5
    if sorted.len() >= 5 {
        matched += 1;
        for b in &sorted {
            regions.push(make_region("list-item", b));
        }
    }

    DetectResult { matched, regions }
}

/// article 检测：文章布局
fn detect_article(blocks: &[OcrBlock]) -> DetectResult {
    if blocks.is_empty() {
        return DetectResult { matched: 0, regions: vec![] };
    }
    let mut regions: Vec<LayoutRegion> = Vec::new();
    let mut matched = 0;

    // 规则1：长段落占比 ≥ 50%
    let long_blocks: Vec<&OcrBlock> = blocks.iter().filter(|b| b.text.trim().len() >= 40).collect();
    if !blocks.is_empty() && long_blocks.len() as f64 / blocks.len() as f64 >= 0.5 {
        matched += 1;
        for b in &long_blocks {
            regions.push(make_region("paragraph", b));
        }
    }

    // 规则2：无交互元素
    let has_button = blocks.iter().any(|b| button_keywords_regex().is_match(b.text.trim()));
    let has_label = blocks.iter().any(|b| label_colon_regex().is_match(b.text.trim()));
    if !has_button && !has_label {
        matched += 1;
    }

    // 规则3：段落间有空行
    let mut sorted: Vec<&OcrBlock> = blocks.iter().collect();
    sorted.sort_by(|a, b| a.box_rect.y.partial_cmp(&b.box_rect.y).unwrap_or(std::cmp::Ordering::Equal));
    let avg_h = sorted.iter().map(|b| b.box_rect.h).sum::<f64>() / sorted.len() as f64;
    let mut big_gaps = 0;
    for i in 1..sorted.len() {
        let gap = sorted[i].box_rect.y - (sorted[i - 1].box_rect.y + sorted[i - 1].box_rect.h);
        if gap > avg_h * 0.5 {
            big_gaps += 1;
        }
    }
    if sorted.len() >= 2 && big_gaps >= 1 {
        matched += 1;
    }

    DetectResult { matched, regions }
}

/// editor 检测：代码编辑器布局
fn detect_editor(blocks: &[OcrBlock]) -> DetectResult {
    if blocks.is_empty() {
        return DetectResult { matched: 0, regions: vec![] };
    }
    let mut regions: Vec<LayoutRegion> = Vec::new();
    let mut matched = 0;

    // 规则1：代码缩进或关键词特征
    let code_blocks: Vec<&OcrBlock> = blocks
        .iter()
        .filter(|b| code_indent_regex().is_match(&b.text) || code_keyword_regex().is_match(&b.text))
        .collect();
    if code_blocks.len() >= 3 {
        matched += 1;
    }

    // 规则2：行号特征
    let line_number_blocks: Vec<&OcrBlock> = blocks
        .iter()
        .filter(|b| line_number_regex().is_match(b.text.trim()))
        .collect();
    if line_number_blocks.len() >= 3 {
        let nums: Vec<i64> = line_number_blocks
            .iter()
            .filter_map(|b| {
                let trimmed = b.text.trim();
                let re = Regex::new(r"^\d+").unwrap();
                re.captures(trimmed)
                    .and_then(|c| c.get(0))
                    .and_then(|m| m.as_str().parse::<i64>().ok())
            })
            .collect();
        let mut consecutive = 0;
        for i in 1..nums.len() {
            if nums[i] == nums[i - 1] + 1 {
                consecutive += 1;
            }
        }
        if consecutive >= 2 {
            matched += 1;
            for b in &line_number_blocks {
                regions.push(make_region("code-line", b));
            }
        }
    }

    // 规则3：等宽字体区域
    let char_widths: Vec<f64> = blocks
        .iter()
        .filter(|b| b.text.trim().len() >= 3)
        .map(|b| b.box_rect.w / b.text.trim().len() as f64)
        .collect();
    if char_widths.len() >= 3 {
        let cv = coefficient_of_variation(&char_widths);
        if cv < 0.3 {
            matched += 1;
        }
    }

    DetectResult { matched, regions }
}

/// chat 检测：聊天布局
fn detect_chat(blocks: &[OcrBlock]) -> DetectResult {
    if blocks.len() < 4 {
        return DetectResult { matched: 0, regions: vec![] };
    }
    let mut regions: Vec<LayoutRegion> = Vec::new();
    let mut matched = 0;

    let right_edges: Vec<f64> = blocks.iter().map(|b| b.box_rect.x + b.box_rect.w).collect();
    let xs: Vec<f64> = blocks.iter().map(|b| b.box_rect.x).collect();
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = right_edges.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mid_x = (min_x + max_x) / 2.0;

    // 规则1：左右分栏对话气泡
    let left_blocks: Vec<&OcrBlock> = blocks.iter().filter(|b| b.box_rect.x + b.box_rect.w / 2.0 < mid_x).collect();
    let right_blocks: Vec<&OcrBlock> = blocks.iter().filter(|b| b.box_rect.x + b.box_rect.w / 2.0 >= mid_x).collect();
    if left_blocks.len() >= 2 && right_blocks.len() >= 2 {
        let tolerance = (mid_x - min_x) * 0.3;
        let right_aligned: Vec<&&OcrBlock> = right_blocks
            .iter()
            .filter(|b| max_x - (b.box_rect.x + b.box_rect.w) < tolerance)
            .collect();
        if right_aligned.len() >= 1 {
            matched += 1;
            for b in &left_blocks {
                regions.push(make_region("bubble", b));
            }
            for b in &right_blocks {
                regions.push(make_region("bubble", b));
            }
        }
    }

    // 规则2：头像区域
    let avg_w = blocks.iter().map(|b| b.box_rect.w).sum::<f64>() / blocks.len() as f64;
    let avatars: Vec<&OcrBlock> = blocks
        .iter()
        .filter(|b| b.box_rect.w < avg_w * 0.5 && b.text.trim().len() <= 2 && b.text.trim().len() > 0)
        .collect();
    if avatars.len() >= 2 {
        matched += 1;
        for b in &avatars {
            regions.push(make_region("avatar", b));
        }
    }

    // 规则3：昵称模式
    let nicknames: Vec<&OcrBlock> = blocks.iter().filter(|b| nickname_colon_regex().is_match(b.text.trim())).collect();
    if nicknames.len() >= 2 {
        matched += 1;
        for b in &nicknames {
            regions.push(make_region("nickname", b));
        }
    }

    DetectResult { matched, regions }
}

/// dashboard 检测：仪表盘布局
fn detect_dashboard(blocks: &[OcrBlock]) -> DetectResult {
    if blocks.len() < 4 {
        return DetectResult { matched: 0, regions: vec![] };
    }
    let mut regions: Vec<LayoutRegion> = Vec::new();
    let mut matched = 0;

    // 规则1：网格布局
    let xs: Vec<f64> = blocks.iter().map(|b| b.box_rect.x).collect();
    let ys: Vec<f64> = blocks.iter().map(|b| b.box_rect.y).collect();
    let x_clusters = cluster_values(&xs, 20.0);
    let y_clusters = cluster_values(&ys, 20.0);
    if x_clusters.len() >= 2 && y_clusters.len() >= 2 {
        matched += 1;
    }

    // 规则2：数据卡片
    let numeric_blocks: Vec<&OcrBlock> = blocks.iter().filter(|b| numeric_regex().is_match(b.text.trim())).collect();
    let mut card_count = 0;
    for num in &numeric_blocks {
        let nearby_label = blocks.iter().find(|b| {
            !std::ptr::eq(*b, *num)
                && (b.box_rect.y - num.box_rect.y).abs() < num.box_rect.h * 2.0
                && b.text.trim().len() <= 10
                && !numeric_regex().is_match(b.text.trim())
        });
        if let Some(label) = nearby_label {
            card_count += 1;
            regions.push(make_region("card", num));
            regions.push(make_region("card-label", label));
        }
    }
    if card_count >= 2 {
        matched += 1;
    }

    // 规则3：多个数字文本块
    if numeric_blocks.len() >= 3 {
        matched += 1;
    }

    DetectResult { matched, regions }
}

// ===================== 主分析器 =====================

/// 候选布局检测器列表（顺序即并列时的优先级，专用类型前置，list 作为兜底靠后）
fn detectors() -> &'static [(&'static str, fn(&[OcrBlock]) -> DetectResult)] {
    static D: OnceLock<Vec<(&'static str, fn(&[OcrBlock]) -> DetectResult)>> = OnceLock::new();
    D.get_or_init(|| vec![
        ("editor", detect_editor as fn(&[OcrBlock]) -> DetectResult),
        ("chat", detect_chat as fn(&[OcrBlock]) -> DetectResult),
        ("dashboard", detect_dashboard as fn(&[OcrBlock]) -> DetectResult),
        ("form", detect_form as fn(&[OcrBlock]) -> DetectResult),
        ("article", detect_article as fn(&[OcrBlock]) -> DetectResult),
        ("list", detect_list as fn(&[OcrBlock]) -> DetectResult),
    ])
}

/// 将字符串映射为 LayoutType
fn str_to_layout_type(s: &str) -> LayoutType {
    match s {
        "form" => LayoutType::Form,
        "list" => LayoutType::List,
        "article" => LayoutType::Article,
        "editor" => LayoutType::Editor,
        "chat" => LayoutType::Chat,
        "dashboard" => LayoutType::Dashboard,
        _ => LayoutType::Other,
    }
}

/// 分析 OCR 文本块的布局类型。
///
/// 基于 OCR 块的坐标分布识别屏幕布局，并提取布局区域。
pub fn analyze_layout(ocr_blocks: &[OcrBlock]) -> LayoutAnalysis {
    if ocr_blocks.is_empty() {
        return LayoutAnalysis {
            layout_type: LayoutType::Other,
            regions: vec![],
            confidence: 0.0,
        };
    }

    let mut best_type = LayoutType::Other;
    let mut best_score: f64 = 0.0;
    let mut best_regions: Vec<LayoutRegion> = Vec::new();

    for (type_str, detect_fn) in detectors() {
        let result = detect_fn(ocr_blocks);
        let score = result.matched as f64 / RULES_PER_TYPE as f64;
        if score > best_score {
            best_type = str_to_layout_type(type_str);
            best_score = score;
            best_regions = result.regions;
        }
    }

    let confidence = round2(best_score);
    if confidence >= CONFIDENCE_THRESHOLD {
        return LayoutAnalysis {
            layout_type: best_type,
            regions: best_regions,
            confidence,
        };
    }
    LayoutAnalysis {
        layout_type: LayoutType::Other,
        regions: vec![],
        confidence,
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::OcrBox;

    fn make_block(text: &str, x: f64, y: f64, w: f64, h: f64) -> OcrBlock {
        OcrBlock {
            text: text.to_string(),
            box_rect: OcrBox { x, y, w, h },
            confidence: 0.9,
        }
    }

    #[test]
    fn test_empty_blocks_returns_other() {
        let result = analyze_layout(&[]);
        assert_eq!(result.layout_type, LayoutType::Other);
        assert_eq!(result.confidence, 0.0);
        assert!(result.regions.is_empty());
    }

    #[test]
    fn test_detect_list_layout() {
        // 5 行等间距短文本
        let blocks: Vec<OcrBlock> = (0..5)
            .map(|i| make_block(&format!("项目 {}", i + 1), 10.0, i as f64 * 30.0, 100.0, 20.0))
            .collect();
        let result = analyze_layout(&blocks);
        assert_eq!(result.layout_type, LayoutType::List);
        assert!(result.confidence >= CONFIDENCE_THRESHOLD);
        assert!(!result.regions.is_empty());
    }

    #[test]
    fn test_detect_editor_layout() {
        // 代码缩进 + 行号 + 关键词，直接测试 editor detector
        let blocks = vec![
            make_block("1 fn main() {", 10.0, 0.0, 150.0, 20.0),
            make_block("2   let x = 1;", 10.0, 25.0, 150.0, 20.0),
            make_block("3   let y = 2;", 10.0, 50.0, 150.0, 20.0),
            make_block("4   println!(x)", 10.0, 75.0, 150.0, 20.0),
            make_block("5 }", 10.0, 100.0, 150.0, 20.0),
        ];
        let result = detect_editor(&blocks);
        // editor detector 应至少匹配 2 条规则
        assert!(result.matched >= 2);
    }

    #[test]
    fn test_detect_article_layout() {
        // 长段落
        let long_text = "这是一段非常长的文本内容用于测试文章布局识别功能是否能够正确识别出长段落特征。".to_string();
        let blocks = vec![
            make_block(&long_text, 10.0, 0.0, 400.0, 30.0),
            make_block(&long_text, 10.0, 50.0, 400.0, 30.0),
        ];
        let result = analyze_layout(&blocks);
        assert_eq!(result.layout_type, LayoutType::Article);
        assert!(result.confidence >= CONFIDENCE_THRESHOLD);
    }

    #[test]
    fn test_detect_form_layout() {
        // 标签 + 输入框 + 按钮
        let blocks = vec![
            make_block("姓名：", 10.0, 0.0, 50.0, 20.0),
            make_block("输入框内容", 80.0, 0.0, 200.0, 20.0),
            make_block("邮箱：", 10.0, 30.0, 50.0, 20.0),
            make_block("输入框内容", 80.0, 30.0, 200.0, 20.0),
            make_block("电话：", 10.0, 60.0, 50.0, 20.0),
            make_block("输入框内容", 80.0, 60.0, 200.0, 20.0),
            make_block("提交", 10.0, 90.0, 80.0, 30.0),
        ];
        let result = analyze_layout(&blocks);
        assert_eq!(result.layout_type, LayoutType::Form);
        assert!(result.confidence >= CONFIDENCE_THRESHOLD);
    }

    #[test]
    fn test_low_confidence_returns_other() {
        // 单个短文本块，无法匹配任何布局
        let blocks = vec![make_block("hello", 10.0, 10.0, 50.0, 20.0)];
        let result = analyze_layout(&blocks);
        assert_eq!(result.layout_type, LayoutType::Other);
    }
}
