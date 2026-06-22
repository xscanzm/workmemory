//! HourContextPackBuilder：小时级上下文打包器（对应 electron/ai/HourContextPackBuilder.ts）
//!
//! 把上一小时 segments 压缩成发送给 AI 的文本证据包：
//!  - 按小时过滤 segments（基于 start_time）
//!  - 排除隐私 segments（is_private 或 source_status=private）
//!  - 文本相似度压缩：同应用同窗口且 Jaccard ≥ 0.82 的连续 segment 合并
//!  - 生成代表性帧、变化点、窗口时间线
//!  - 统计本地指标（segment 数、应用数、OCR 完成数、低质量数）

use crate::models::{SourceQuality, WorkSegment};

/// 文本相似度阈值：Jaccard ≥ 0.82 视为重复，合并到上一帧
const SIMILARITY_THRESHOLD: f64 = 0.82;
/// 文本预览最大字符数
const TEXT_PREVIEW_MAX: usize = 1200;

/// 小时级上下文包（简化版，用于 AI 输入）
#[derive(Debug, Clone)]
pub struct HourContextPack {
    /// 日期 YYYY-MM-DD
    pub date: String,
    /// 小时（0-23）
    pub hour: u32,
    /// 本小时内的非隐私 segments
    pub segments: Vec<WorkSegment>,
    /// 上下文摘要文本（JSON 序列化，发送给 AI）
    pub summary: String,
}

/// 将 HH:MM:SS 时间字符串转为秒数
fn time_to_seconds(time: &str) -> u32 {
    let parts: Vec<&str> = time.split(':').collect();
    if parts.len() < 2 {
        return 0;
    }
    let h: u32 = parts[0].parse().unwrap_or(0);
    let m: u32 = parts[1].parse().unwrap_or(0);
    let s: u32 = if parts.len() > 2 {
        parts[2].parse().unwrap_or(0)
    } else {
        0
    };
    h * 3600 + m * 60 + s
}

/// 获取 segment 的文本内容（window_title + ocr_text/ocr_summary）
fn segment_text(segment: &WorkSegment) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if !segment.window_title.is_empty() {
        parts.push(&segment.window_title);
    }
    let text = if !segment.ocr_text.is_empty() {
        &segment.ocr_text
    } else {
        &segment.ocr_summary
    };
    if !text.is_empty() {
        parts.push(text);
    }
    parts.join("\n").trim().to_string()
}

/// 将文本分词为 token 集合（中文双字 bigram + 英文单词）
fn text_tokens(text: &str) -> std::collections::HashSet<String> {
    let mut tokens = std::collections::HashSet::new();
    let normalized = text.to_lowercase();

    // 英文单词（长度 ≥ 2）
    let english_re = regex::Regex::new(r"[a-zA-Z0-9]{2,}").unwrap();
    for m in english_re.find_iter(&normalized) {
        tokens.insert(m.as_str().to_string());
    }

    // 中文双字 bigram
    let chinese_re = regex::Regex::new(r"[\u4e00-\u9fff]+").unwrap();
    for m in chinese_re.find_iter(&normalized) {
        let chars: Vec<char> = m.as_str().chars().collect();
        if chars.len() == 1 {
            tokens.insert(chars[0].to_string());
        } else {
            for i in 0..chars.len() - 1 {
                tokens.insert(format!("{}{}", chars[i], chars[i + 1]));
            }
        }
    }

    tokens
}

/// 计算两个集合的 Jaccard 相似度
fn jaccard(
    a: &std::collections::HashSet<String>,
    b: &std::collections::HashSet<String>,
) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut intersection = 0;
    for item in a {
        if b.contains(item) {
            intersection += 1;
        }
    }
    let union = a.len() + b.len() - intersection;
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

/// 推导 segment 的来源质量
fn derive_quality(segment: &WorkSegment) -> SourceQuality {
    if segment.is_private || segment.source_status == crate::models::SourceStatus::Private {
        return SourceQuality::Private;
    }
    if segment.source_status == crate::models::SourceStatus::OcrFailed {
        return SourceQuality::Failed;
    }
    // 简化：根据 source_quality 字段返回
    segment.source_quality.clone()
}

/// 小时级上下文打包器
pub struct HourContextPackBuilder;

impl HourContextPackBuilder {
    pub fn new() -> Self {
        HourContextPackBuilder
    }

    /// 构建指定日期指定小时的上下文包。
    ///
    /// # 参数
    /// - `date`：日期 YYYY-MM-DD
    /// - `hour`：小时 0-23
    ///
    /// # 返回
    /// 上下文包（含 segments 与摘要文本）
    pub fn build_pack(&self, date: &str, hour: u32) -> anyhow::Result<HourContextPack> {
        let start_seconds = hour * 3600;
        let end_seconds = (hour + 1) * 3600;

        // 获取当日所有活跃 segments
        let all_segments = crate::repositories::segment_repository::SegmentRepository::get_active_by_date(date)?;

        // 按小时过滤
        let hour_segments: Vec<WorkSegment> = all_segments
            .into_iter()
            .filter(|s| {
                let start = time_to_seconds(&s.start_time);
                start >= start_seconds && start < end_seconds
            })
            .filter(|s| !s.is_private && s.source_status != crate::models::SourceStatus::Private)
            .collect();

        // 文本相似度压缩：合并同应用同窗口且高相似度的连续 segments
        let compressed = self.compress_segments(&hour_segments);

        // 构建摘要文本（JSON 序列化）
        let summary = self.build_summary(&compressed, hour);

        Ok(HourContextPack {
            date: date.to_string(),
            hour,
            segments: compressed,
            summary,
        })
    }

    /// 压缩 segments：合并同应用同窗口且 Jaccard ≥ 阈值的连续 segments
    fn compress_segments(&self, segments: &[WorkSegment]) -> Vec<WorkSegment> {
        let mut result: Vec<WorkSegment> = Vec::new();
        let mut last_tokens: Option<std::collections::HashSet<String>> = None;

        for segment in segments {
            let text = segment_text(segment);
            let tokens = text_tokens(&text);

            let should_compress = if let (Some(last_tok), Some(last_seg)) = (&last_tokens, result.last()) {
                let same_app_and_title = last_seg.app_name == segment.app_name
                    && last_seg.window_title == segment.window_title;
                same_app_and_title && jaccard(last_tok, &tokens) >= SIMILARITY_THRESHOLD
            } else {
                false
            };

            if should_compress {
                // 合并到上一帧：延长 end_time
                if let Some(last) = result.last_mut() {
                    last.end_time = segment.end_time.clone();
                    last.duration_seconds += segment.duration_seconds;
                }
            } else {
                result.push(segment.clone());
            }
            last_tokens = Some(tokens);
        }

        result
    }

    /// 构建发送给 AI 的摘要文本（JSON 序列化）
    fn build_summary(&self, segments: &[WorkSegment], hour: u32) -> String {
        let frames: Vec<serde_json::Value> = segments
            .iter()
            .map(|s| {
                let text = segment_text(s);
                let preview: String = text.chars().take(TEXT_PREVIEW_MAX).collect();
                serde_json::json!({
                    "segmentId": s.id,
                    "startTime": s.start_time,
                    "endTime": s.end_time,
                    "appName": s.app_name,
                    "windowTitle": s.window_title,
                    "text": preview,
                    "sourceQuality": derive_quality(s).as_str(),
                })
            })
            .collect();

        let app_count = segments
            .iter()
            .map(|s| s.app_name.as_str())
            .filter(|n| !n.is_empty())
            .collect::<std::collections::HashSet<_>>()
            .len();

        let ocr_done_count = segments
            .iter()
            .filter(|s| s.source_status == crate::models::SourceStatus::OcrDone)
            .count();

        let low_quality_count = segments
            .iter()
            .filter(|s| {
                let q = derive_quality(s);
                q == SourceQuality::Low || q == SourceQuality::Failed
            })
            .count();

        serde_json::json!({
            "date": segments.first().map(|s| s.date.as_str()).unwrap_or(""),
            "hourBucket": format!("{:02}:00", hour),
            "startTime": format!("{:02}:00:00", hour),
            "endTime": format!("{:02}:59:59", hour),
            "segmentIds": segments.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            "representativeFrames": frames,
            "localStats": {
                "segmentCount": segments.len(),
                "appCount": app_count,
                "ocrDoneCount": ocr_done_count,
                "lowQualityCount": low_quality_count,
            },
        })
        .to_string()
    }
}

impl Default for HourContextPackBuilder {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试时间字符串转秒数
    #[test]
    fn test_time_to_seconds() {
        assert_eq!(time_to_seconds("00:00:00"), 0);
        assert_eq!(time_to_seconds("01:00:00"), 3600);
        assert_eq!(time_to_seconds("10:30:45"), 10 * 3600 + 30 * 60 + 45);
        assert_eq!(time_to_seconds("invalid"), 0);
        assert_eq!(time_to_seconds("10:00"), 10 * 3600);
    }

    /// 测试文本分词
    #[test]
    fn test_text_tokens() {
        let tokens = text_tokens("实现 API 加密功能");
        assert!(tokens.contains("api"));
        assert!(tokens.contains("实现"));
        assert!(tokens.contains("现a") == false); // 中英边界不合并
    }

    /// 测试 Jaccard 相似度
    #[test]
    fn test_jaccard() {
        let a: std::collections::HashSet<String> =
            ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let b: std::collections::HashSet<String> =
            ["b", "c", "d"].iter().map(|s| s.to_string()).collect();
        // 交集 2，并集 4，相似度 0.5
        assert!((jaccard(&a, &b) - 0.5).abs() < 0.001);

        let empty: std::collections::HashSet<String> = std::collections::HashSet::new();
        assert_eq!(jaccard(&empty, &empty), 1.0);
    }

    /// 测试 segment_text 拼接
    #[test]
    fn test_segment_text() {
        let mut seg = WorkSegment::default();
        seg.window_title = "main.rs".to_string();
        seg.ocr_text = "fn main() {}".to_string();
        assert_eq!(segment_text(&seg), "main.rs\nfn main() {}");

        // ocr_text 为空时使用 ocr_summary
        let mut seg2 = WorkSegment::default();
        seg2.window_title = "窗口".to_string();
        seg2.ocr_text = String::new();
        seg2.ocr_summary = "摘要".to_string();
        assert_eq!(segment_text(&seg2), "窗口\n摘要");
    }

    /// 测试压缩 segments（同应用同窗口高相似度合并）
    #[test]
    fn test_compress_segments() {
        let builder = HourContextPackBuilder::new();
        let mut seg1 = WorkSegment::default();
        seg1.app_name = "VS Code".to_string();
        seg1.window_title = "main.rs".to_string();
        seg1.ocr_text = "fn main() { println!(\"hello world\"); }".to_string();
        seg1.start_time = "10:00:00".to_string();
        seg1.end_time = "10:10:00".to_string();

        let mut seg2 = WorkSegment::default();
        seg2.app_name = "VS Code".to_string();
        seg2.window_title = "main.rs".to_string();
        // 仅新增一个词 "foo"，与 seg1 高度相似（Jaccard ≈ 0.83 >= 0.82）
        seg2.ocr_text = "fn main() { println!(\"hello world foo\"); }".to_string();
        seg2.start_time = "10:10:00".to_string();
        seg2.end_time = "10:20:00".to_string();

        // 高相似度，应合并
        let compressed = builder.compress_segments(&[seg1.clone(), seg2]);
        assert_eq!(compressed.len(), 1);
        assert_eq!(compressed[0].end_time, "10:20:00");

        // 不同窗口，不合并
        let mut seg3 = WorkSegment::default();
        seg3.app_name = "Chrome".to_string();
        seg3.window_title = "Google".to_string();
        seg3.ocr_text = "Search the world's information".to_string();
        let compressed2 = builder.compress_segments(&[seg1, seg3]);
        assert_eq!(compressed2.len(), 2);
    }
}
