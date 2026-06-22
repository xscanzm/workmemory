//! DataHealthDashboard：数据健康仪表盘（F8.19）
//!
//! 功能：
//!  - 统计 OCR 识别率（已识别 segments / 总 segments）
//!  - 统计记录覆盖率（已记录小时数 / 工作时段 8h）
//!  - 统计 Wiki 规模与增长趋势
//!  - 统计 AI 调用次数与 token 用量

use serde::{Deserialize, Serialize};

use crate::repositories::segment_repository::SegmentRepository;
use crate::repositories::wiki_repository::WikiRepository;
use crate::models::SourceStatus;

/// 数据健康统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthStats {
    /// OCR 识别率（已识别 / 总 segments，0-1）
    pub ocr_recognition_rate: f64,
    /// 记录覆盖率（已记录小时 / 工作时段 8h，0-1）
    pub recording_coverage: f64,
    /// Wiki 页总数
    pub wiki_size: u32,
    /// Wiki 增长趋势（近 7 日新增页数）
    pub wiki_growth_trend: f64,
    /// AI 调用次数
    pub ai_call_count: u32,
    /// AI token 用量
    pub ai_token_usage: u64,
}

/// 工作时段基准（8 小时，毫秒）
const WORKDAY_BASELINE_MS: u64 = 8 * 60 * 60 * 1000;
/// Wiki 增长趋势回溯天数
const WIKI_GROWTH_LOOKBACK_DAYS: i64 = 7;

/// DataHealthDashboard：数据健康仪表盘
pub struct DataHealthDashboard;

impl DataHealthDashboard {
    /// 创建实例
    pub fn new() -> Self {
        DataHealthDashboard
    }

    /// 获取数据健康统计
    pub fn get_health_stats(&self) -> anyhow::Result<HealthStats> {
        // 1. OCR 识别率：今日已识别 segments / 今日总 segments
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let today_segments = SegmentRepository::get_active_by_date(&today).unwrap_or_default();
        let ocr_recognition_rate = self.compute_ocr_rate(&today_segments);

        // 2. 记录覆盖率：今日已记录时长 / 8h
        let total_recorded_ms: u64 = today_segments
            .iter()
            .map(|s| (s.duration_seconds.max(0) as u64) * 1000)
            .sum();
        let recording_coverage = if WORKDAY_BASELINE_MS > 0 {
            (total_recorded_ms as f64 / WORKDAY_BASELINE_MS as f64).min(1.0)
        } else {
            0.0
        };

        // 3. Wiki 规模与增长趋势
        let all_wiki = WikiRepository::get_all().unwrap_or_default();
        let wiki_size = all_wiki.len() as u32;
        let wiki_growth_trend = self.compute_wiki_growth(&all_wiki);

        // 4. AI 调用统计（暂未持久化，返回 0）
        let ai_call_count = 0u32;
        let ai_token_usage = 0u64;

        Ok(HealthStats {
            ocr_recognition_rate: (ocr_recognition_rate * 100.0).round() / 100.0,
            recording_coverage: (recording_coverage * 100.0).round() / 100.0,
            wiki_size,
            wiki_growth_trend,
            ai_call_count,
            ai_token_usage,
        })
    }

    /// 计算 OCR 识别率：source_status = OcrDone 的占比
    fn compute_ocr_rate(&self, segments: &[crate::models::WorkSegment]) -> f64 {
        if segments.is_empty() {
            return 0.0;
        }
        let identified = segments
            .iter()
            .filter(|s| s.source_status == SourceStatus::OcrDone)
            .count();
        identified as f64 / segments.len() as f64
    }

    /// 计算 Wiki 增长趋势：近 7 日新增页数
    fn compute_wiki_growth(&self, pages: &[crate::models::WikiPage]) -> f64 {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(WIKI_GROWTH_LOOKBACK_DAYS);
        let cutoff_str = cutoff.to_rfc3339();
        let recent_count = pages
            .iter()
            .filter(|p| p.created_at >= cutoff_str)
            .count();
        recent_count as f64
    }
}

impl Default for DataHealthDashboard {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{WorkSegment, SourceStatus};

    fn make_segment(status: SourceStatus, duration_sec: i64) -> WorkSegment {
        let mut seg = WorkSegment::default();
        seg.source_status = status;
        seg.duration_seconds = duration_sec;
        seg
    }

    #[test]
    fn test_compute_ocr_rate_empty() {
        let dashboard = DataHealthDashboard::new();
        let rate = dashboard.compute_ocr_rate(&[]);
        assert_eq!(rate, 0.0);
    }

    #[test]
    fn test_compute_ocr_rate_all_identified() {
        let dashboard = DataHealthDashboard::new();
        let segments = vec![
            make_segment(SourceStatus::OcrDone, 60),
            make_segment(SourceStatus::OcrDone, 60),
            make_segment(SourceStatus::OcrDone, 60),
        ];
        let rate = dashboard.compute_ocr_rate(&segments);
        assert!((rate - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_compute_ocr_rate_partial() {
        let dashboard = DataHealthDashboard::new();
        let segments = vec![
            make_segment(SourceStatus::OcrDone, 60),
            make_segment(SourceStatus::Pending, 60),
            make_segment(SourceStatus::OcrFailed, 60),
            make_segment(SourceStatus::OcrDone, 60),
        ];
        let rate = dashboard.compute_ocr_rate(&segments);
        // 2/4 = 0.5
        assert!((rate - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_compute_wiki_growth_empty() {
        let dashboard = DataHealthDashboard::new();
        let growth = dashboard.compute_wiki_growth(&[]);
        assert_eq!(growth, 0.0);
    }

    #[test]
    fn test_compute_wiki_growth_recent() {
        let dashboard = DataHealthDashboard::new();
        let now = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
        let pages = vec![
            crate::models::WikiPage {
                id: "1".to_string(),
                wiki_type: crate::models::WikiType::Topic,
                title: "recent1".to_string(),
                aliases: vec![],
                content: String::new(),
                sources: vec![],
                backlinks: vec![],
                confidence: 0.8,
                review_status: crate::models::WikiReviewStatus::Reviewed,
                created_at: now.clone(),
                updated_at: now,
            },
            crate::models::WikiPage {
                id: "2".to_string(),
                wiki_type: crate::models::WikiType::Topic,
                title: "old1".to_string(),
                aliases: vec![],
                content: String::new(),
                sources: vec![],
                backlinks: vec![],
                confidence: 0.8,
                review_status: crate::models::WikiReviewStatus::Reviewed,
                created_at: old.clone(),
                updated_at: old,
            },
        ];
        let growth = dashboard.compute_wiki_growth(&pages);
        // 近 7 日新增 1 页
        assert!((growth - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_health_stats_default() {
        let stats = HealthStats::default();
        assert_eq!(stats.ocr_recognition_rate, 0.0);
        assert_eq!(stats.recording_coverage, 0.0);
        assert_eq!(stats.wiki_size, 0);
        assert_eq!(stats.wiki_growth_trend, 0.0);
        assert_eq!(stats.ai_call_count, 0);
        assert_eq!(stats.ai_token_usage, 0);
    }
}
