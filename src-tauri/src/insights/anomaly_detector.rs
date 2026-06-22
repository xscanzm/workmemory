//! AnomalyDetector：异常检测器（对应 electron/insights/AnomalyDetector.ts）
//!
//! 功能：
//!  - detect_anomalies(date)：返回当日 Anomaly 列表
//!    - low_focus：深度工作不足（focus time < 2h）
//!    - high_fragmentation：工作碎片化（<5min Episode 占比 > 40%）
//!    - unusual_app：单应用时长异常（> 6h）
//!    - long_meeting：长时间会议（> 4h）

use crate::models::WorkSegment;
use crate::repositories::episode_repository::EpisodeRepository;
use crate::repositories::segment_repository::SegmentRepository;

/// 异常类型常量
pub const ANOMALY_LOW_FOCUS: &str = "low_focus";
pub const ANOMALY_HIGH_FRAGMENTATION: &str = "high_fragmentation";
pub const ANOMALY_UNUSUAL_APP: &str = "unusual_app";
pub const ANOMALY_LONG_MEETING: &str = "long_meeting";

/// 异常结果
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Anomaly {
    /// 异常类型（low_focus/high_fragmentation/unusual_app/long_meeting）
    pub anomaly_type: String,
    /// 严重程度 0-1
    pub severity: f64,
    /// 描述
    pub description: String,
}

/// 阈值常量
/// 窗口切换次数异常阈值（次/日）
const WINDOW_SWITCH_THRESHOLD: usize = 50;
/// 碎片化阈值（<5min Episode 占比）
const FRAGMENTATION_THRESHOLD: f64 = 0.4;
/// 深度工作不足阈值（秒）
const DEEP_WORK_THRESHOLD_SEC: i64 = 2 * 60 * 60;
/// 单 Episode >30min 视为深度工作
const DEEP_WORK_EPISODE_MIN_SEC: i64 = 30 * 60;
/// 单应用时长异常阈值（秒，6 小时）
const UNUSUAL_APP_THRESHOLD_SEC: i64 = 6 * 60 * 60;
/// 长会议阈值（秒，4 小时）
const LONG_MEETING_THRESHOLD_SEC: i64 = 4 * 60 * 60;
/// Episode 时长 <5 分钟视为碎片
const FRAGMENT_EPISODE_SEC: i64 = 5 * 60;
/// 会议类应用关键词
const MEETING_APP_KEYWORDS: &[&str] = &[
    "teams", "zoom", "腾讯会议", "dingtalk", "钉钉", "飞书", "feishu", "lark", "会议",
    "webex", "google meet", "skype",
];

/// AnomalyDetector：异常检测器。
pub struct AnomalyDetector;

impl AnomalyDetector {
    /// 创建实例
    pub fn new() -> Self {
        AnomalyDetector
    }

    /// 检测指定日期的异常。
    pub fn detect_anomalies(&self, date: &str) -> Vec<Anomaly> {
        let mut anomalies: Vec<Anomaly> = Vec::new();

        // 获取当日 Episodes 与 Segments
        let episodes = EpisodeRepository::get_by_date(date).unwrap_or_default();
        let segments = SegmentRepository::get_active_by_date(date).unwrap_or_default();

        // 1. 深度工作不足
        if let Some(a) = self.detect_low_focus(&episodes) {
            anomalies.push(a);
        }

        // 2. 碎片化工作
        if let Some(a) = self.detect_high_fragmentation(&episodes) {
            anomalies.push(a);
        }

        // 3. 单应用时长异常
        anomalies.extend(self.detect_unusual_app(&segments, date));

        // 4. 长时间会议
        anomalies.extend(self.detect_long_meeting(&segments, date));

        // 5. 窗口切换频繁（>50）
        if let Some(a) = self.detect_window_switch(&segments) {
            anomalies.push(a);
        }

        anomalies
    }

    /// 深度工作不足：单 Episode >30min 总时长 <2h
    fn detect_low_focus(&self, episodes: &[crate::models::Episode]) -> Option<Anomaly> {
        if episodes.is_empty() {
            return None;
        }
        let mut deep_work_seconds: i64 = 0;
        for episode in episodes {
            let duration = self.compute_episode_duration(episode);
            if duration >= DEEP_WORK_EPISODE_MIN_SEC {
                deep_work_seconds += duration;
            }
        }
        if deep_work_seconds >= DEEP_WORK_THRESHOLD_SEC {
            return None;
        }
        let deep_work_minutes = deep_work_seconds / 60;
        let severity = if deep_work_seconds < DEEP_WORK_THRESHOLD_SEC / 2 {
            0.8
        } else {
            0.5
        };
        Some(Anomaly {
            anomaly_type: ANOMALY_LOW_FOCUS.to_string(),
            severity,
            description: format!(
                "今日深度工作（>30 分钟连续片段）仅 {} 分钟，不足 2 小时",
                deep_work_minutes
            ),
        })
    }

    /// 碎片化工作：<5min Episode 占比 >40%
    fn detect_high_fragmentation(
        &self,
        episodes: &[crate::models::Episode],
    ) -> Option<Anomaly> {
        if episodes.is_empty() {
            return None;
        }
        let mut fragment_count = 0usize;
        for episode in episodes {
            let duration = self.compute_episode_duration(episode);
            if duration > 0 && duration < FRAGMENT_EPISODE_SEC {
                fragment_count += 1;
            }
        }
        let ratio = fragment_count as f64 / episodes.len() as f64;
        if ratio <= FRAGMENTATION_THRESHOLD {
            return None;
        }
        let severity = if ratio >= 0.6 { 0.8 } else { 0.5 };
        let percentage = (ratio * 100.0).round() as i32;
        Some(Anomaly {
            anomaly_type: ANOMALY_HIGH_FRAGMENTATION.to_string(),
            severity,
            description: format!(
                "今日 {}% 的工作片段不足 5 分钟，注意力过于分散",
                percentage
            ),
        })
    }

    /// 单应用时长异常：单应用 >6h
    fn detect_unusual_app(&self, segments: &[WorkSegment], date: &str) -> Vec<Anomaly> {
        let mut anomalies = Vec::new();
        if segments.is_empty() {
            return anomalies;
        }
        // 按应用名聚合时长
        let mut app_durations: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for segment in segments {
            let app_name = if !segment.app_name.trim().is_empty() {
                segment.app_name.trim().to_string()
            } else if !segment.process_name.trim().is_empty() {
                segment.process_name.trim().to_string()
            } else {
                "未知应用".to_string()
            };
            *app_durations.entry(app_name).or_insert(0) += segment.duration_seconds;
        }
        for (app_name, seconds) in app_durations {
            if seconds <= UNUSUAL_APP_THRESHOLD_SEC {
                continue;
            }
            let hours = (seconds as f64 / 3600.0 * 10.0).round() / 10.0;
            let severity = if seconds > UNUSUAL_APP_THRESHOLD_SEC * 2 {
                0.8
            } else {
                0.5
            };
            anomalies.push(Anomaly {
                anomaly_type: ANOMALY_UNUSUAL_APP.to_string(),
                severity,
                description: format!(
                    "在 {} 连续工作 {} 小时（日期 {}），建议休息",
                    app_name, hours, date
                ),
            });
        }
        anomalies
    }

    /// 长时间会议：会议类应用 >4h
    fn detect_long_meeting(&self, segments: &[WorkSegment], date: &str) -> Vec<Anomaly> {
        let mut anomalies = Vec::new();
        if segments.is_empty() {
            return anomalies;
        }
        let mut meeting_seconds: i64 = 0;
        for segment in segments {
            let combined = format!("{} {}", segment.app_name, segment.process_name).to_lowercase();
            if MEETING_APP_KEYWORDS.iter().any(|kw| combined.contains(kw)) {
                meeting_seconds += segment.duration_seconds;
            }
        }
        if meeting_seconds <= LONG_MEETING_THRESHOLD_SEC {
            return anomalies;
        }
        let hours = (meeting_seconds as f64 / 3600.0 * 10.0).round() / 10.0;
        let severity = if meeting_seconds > LONG_MEETING_THRESHOLD_SEC * 2 {
            0.8
        } else {
            0.5
        };
        anomalies.push(Anomaly {
            anomaly_type: ANOMALY_LONG_MEETING.to_string(),
            severity,
            description: format!("今日会议时长 {} 小时（日期 {}），建议预留专注时间", hours, date),
        });
        anomalies
    }

    /// 窗口切换频繁：当日 segment 数 >50
    fn detect_window_switch(&self, segments: &[WorkSegment]) -> Option<Anomaly> {
        if segments.len() <= WINDOW_SWITCH_THRESHOLD {
            return None;
        }
        let severity = if segments.len() >= WINDOW_SWITCH_THRESHOLD * 2 {
            0.8
        } else {
            0.5
        };
        Some(Anomaly {
            anomaly_type: ANOMALY_HIGH_FRAGMENTATION.to_string(),
            severity,
            description: format!("今日窗口切换 {} 次，建议合并碎片", segments.len()),
        })
    }

    /// 计算 Episode 时长（秒）：endTime - startTime
    fn compute_episode_duration(&self, episode: &crate::models::Episode) -> i64 {
        let start = self.time_to_seconds(&episode.start_time);
        let end = self.time_to_seconds(&episode.end_time);
        let diff = end - start;
        if diff > 0 {
            diff
        } else {
            0
        }
    }

    /// "HH:MM:SS" → 秒
    fn time_to_seconds(&self, time_str: &str) -> i64 {
        let parts: Vec<&str> = time_str.split(':').collect();
        if parts.len() == 3 {
            parts[0].parse::<i64>().unwrap_or(0) * 3600
                + parts[1].parse::<i64>().unwrap_or(0) * 60
                + parts[2].parse::<i64>().unwrap_or(0)
        } else if parts.len() == 2 {
            parts[0].parse::<i64>().unwrap_or(0) * 3600
                + parts[1].parse::<i64>().unwrap_or(0) * 60
        } else {
            0
        }
    }
}

impl Default for AnomalyDetector {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Episode, WorkSegment};

    fn make_episode(start: &str, end: &str) -> Episode {
        Episode {
            id: "ep-1".to_string(),
            date: "2026-06-22".to_string(),
            start_time: start.to_string(),
            end_time: end.to_string(),
            title: "测试".to_string(),
            one_line_summary: String::new(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: true,
            wiki_eligible: true,
            dominant_activity_type: None,
        }
    }

    fn make_segment(app: &str, duration_sec: i64) -> WorkSegment {
        let mut seg = WorkSegment::default();
        seg.app_name = app.to_string();
        seg.duration_seconds = duration_sec;
        seg
    }

    #[test]
    fn test_time_to_seconds_hms() {
        let detector = AnomalyDetector::new();
        assert_eq!(detector.time_to_seconds("01:02:03"), 3723);
        assert_eq!(detector.time_to_seconds("00:30:00"), 1800);
    }

    #[test]
    fn test_time_to_seconds_hm() {
        let detector = AnomalyDetector::new();
        assert_eq!(detector.time_to_seconds("01:30"), 5400);
    }

    #[test]
    fn test_time_to_seconds_invalid() {
        let detector = AnomalyDetector::new();
        assert_eq!(detector.time_to_seconds("invalid"), 0);
        assert_eq!(detector.time_to_seconds(""), 0);
    }

    #[test]
    fn test_compute_episode_duration() {
        let detector = AnomalyDetector::new();
        let ep = make_episode("10:00:00", "11:30:00");
        assert_eq!(detector.compute_episode_duration(&ep), 5400);
    }

    #[test]
    fn test_compute_episode_duration_negative_returns_zero() {
        let detector = AnomalyDetector::new();
        let ep = make_episode("11:30:00", "10:00:00");
        assert_eq!(detector.compute_episode_duration(&ep), 0);
    }

    #[test]
    fn test_detect_low_focus_triggered() {
        let detector = AnomalyDetector::new();
        // 仅有一个 10 分钟的 episode，深度工作为 0
        let episodes = vec![make_episode("10:00:00", "10:10:00")];
        let anomaly = detector.detect_low_focus(&episodes);
        assert!(anomaly.is_some());
        let a = anomaly.unwrap();
        assert_eq!(a.anomaly_type, ANOMALY_LOW_FOCUS);
        assert!(a.description.contains("深度工作"));
    }

    #[test]
    fn test_detect_low_focus_not_triggered_when_deep_work_sufficient() {
        let detector = AnomalyDetector::new();
        // 一个 3 小时的 episode，深度工作 = 3h > 2h
        let episodes = vec![make_episode("10:00:00", "13:00:00")];
        let anomaly = detector.detect_low_focus(&episodes);
        assert!(anomaly.is_none());
    }

    #[test]
    fn test_detect_high_fragmentation_triggered() {
        let detector = AnomalyDetector::new();
        // 5 个 3 分钟的 episode + 1 个 30 分钟的，碎片占比 5/6 > 0.4
        let mut episodes = vec![];
        for _ in 0..5 {
            episodes.push(make_episode("10:00:00", "10:03:00"));
        }
        episodes.push(make_episode("10:00:00", "10:30:00"));
        let anomaly = detector.detect_high_fragmentation(&episodes);
        assert!(anomaly.is_some());
        let a = anomaly.unwrap();
        assert_eq!(a.anomaly_type, ANOMALY_HIGH_FRAGMENTATION);
    }

    #[test]
    fn test_detect_unusual_app_triggered() {
        let detector = AnomalyDetector::new();
        // 单应用 7 小时
        let segments = vec![make_segment("VSCode", 7 * 3600)];
        let anomalies = detector.detect_unusual_app(&segments, "2026-06-22");
        assert_eq!(anomalies.len(), 1);
        assert_eq!(anomalies[0].anomaly_type, ANOMALY_UNUSUAL_APP);
        assert!(anomalies[0].description.contains("VSCode"));
    }

    #[test]
    fn test_detect_unusual_app_not_triggered_below_threshold() {
        let detector = AnomalyDetector::new();
        let segments = vec![make_segment("VSCode", 5 * 3600)];
        let anomalies = detector.detect_unusual_app(&segments, "2026-06-22");
        assert!(anomalies.is_empty());
    }

    #[test]
    fn test_detect_long_meeting_triggered() {
        let detector = AnomalyDetector::new();
        let segments = vec![make_segment("Teams", 5 * 3600)];
        let anomalies = detector.detect_long_meeting(&segments, "2026-06-22");
        assert_eq!(anomalies.len(), 1);
        assert_eq!(anomalies[0].anomaly_type, ANOMALY_LONG_MEETING);
    }

    #[test]
    fn test_detect_long_meeting_not_triggered() {
        let detector = AnomalyDetector::new();
        let segments = vec![make_segment("VSCode", 5 * 3600)];
        let anomalies = detector.detect_long_meeting(&segments, "2026-06-22");
        assert!(anomalies.is_empty());
    }
}
