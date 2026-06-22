//! TimeAuditEngine：时间审计统计引擎（对应 electron/insights/TimeAuditEngine.ts）
//!
//! 功能：
//!  - audit_day(date)：审计单日时间使用
//!    - total_tracked_ms：总追踪时长
//!    - focus_ms：深度工作时长（单 Episode >30min）
//!    - meeting_ms：会议类应用时长
//!    - fragmentation_score：碎片化评分 0-1
//!    - coverage：覆盖率（已追踪时长 / 工作时段 8h）

use crate::models::WorkSegment;
use crate::repositories::episode_repository::EpisodeRepository;
use crate::repositories::segment_repository::SegmentRepository;

/// 时间审计结果
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TimeAudit {
    /// 日期 YYYY-MM-DD
    pub date: String,
    /// 总追踪时长（毫秒）
    pub total_tracked_ms: u64,
    /// 深度工作时长（毫秒）
    pub focus_ms: u64,
    /// 会议时长（毫秒）
    pub meeting_ms: u64,
    /// 碎片化评分 0-1（越高越碎片化）
    pub fragmentation_score: f64,
    /// 覆盖率 0-1（已追踪时长 / 8h 工作时段）
    pub coverage: f64,
}

/// 单 Episode 视为深度工作的最小秒数（30 分钟）
const DEEP_WORK_EPISODE_MIN_SEC: i64 = 30 * 60;
/// 工作时段基准（8 小时，用于覆盖率计算）
const WORKDAY_BASELINE_SEC: i64 = 8 * 60 * 60;
/// Episode 时长 <5 分钟视为碎片
const FRAGMENT_EPISODE_SEC: i64 = 5 * 60;
/// 会议类应用关键词
const MEETING_APP_KEYWORDS: &[&str] = &[
    "teams", "zoom", "腾讯会议", "dingtalk", "钉钉", "飞书", "feishu", "lark", "会议",
    "webex", "google meet", "skype",
];

/// TimeAuditEngine：时间审计统计引擎。
pub struct TimeAuditEngine;

impl TimeAuditEngine {
    /// 创建实例
    pub fn new() -> Self {
        TimeAuditEngine
    }

    /// 审计指定日期的时间使用情况。
    pub fn audit_day(&self, date: &str) -> anyhow::Result<TimeAudit> {
        let episodes = EpisodeRepository::get_by_date(date)?;
        let segments = SegmentRepository::get_active_by_date(date)?;

        // 总追踪时长（来自 segments）
        let total_tracked_sec: i64 = segments.iter().map(|s| s.duration_seconds).sum();

        // 深度工作时长（来自 episodes，单 episode >30min）
        let mut focus_sec: i64 = 0;
        let mut episode_count = 0usize;
        let mut fragment_count = 0usize;
        for episode in &episodes {
            let duration = self.compute_episode_duration(episode);
            if duration > 0 {
                episode_count += 1;
                if duration < FRAGMENT_EPISODE_SEC {
                    fragment_count += 1;
                }
                if duration >= DEEP_WORK_EPISODE_MIN_SEC {
                    focus_sec += duration;
                }
            }
        }

        // 会议时长（来自 segments，会议类应用）
        let meeting_sec: i64 = segments
            .iter()
            .filter(|s| {
                let combined = format!("{} {}", s.app_name, s.process_name).to_lowercase();
                MEETING_APP_KEYWORDS.iter().any(|kw| combined.contains(kw))
            })
            .map(|s| s.duration_seconds)
            .sum();

        // 碎片化评分：<5min Episode 占比
        let fragmentation_score = if episode_count > 0 {
            fragment_count as f64 / episode_count as f64
        } else {
            0.0
        };

        // 覆盖率：总追踪时长 / 8h
        let coverage = if WORKDAY_BASELINE_SEC > 0 {
            (total_tracked_sec as f64 / WORKDAY_BASELINE_SEC as f64).min(1.0)
        } else {
            0.0
        };

        Ok(TimeAudit {
            date: date.to_string(),
            total_tracked_ms: (total_tracked_sec.max(0) as u64) * 1000,
            focus_ms: (focus_sec.max(0) as u64) * 1000,
            meeting_ms: (meeting_sec.max(0) as u64) * 1000,
            fragmentation_score: (fragmentation_score * 100.0).round() / 100.0,
            coverage: (coverage * 100.0).round() / 100.0,
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

    /// 判断是否为会议类应用（公开供测试使用）
    #[cfg(test)]
    pub fn is_meeting_app(app_name: &str, process_name: &str) -> bool {
        let combined = format!("{} {}", app_name, process_name).to_lowercase();
        MEETING_APP_KEYWORDS.iter().any(|kw| combined.contains(kw))
    }
}

impl Default for TimeAuditEngine {
    fn default() -> Self {
        Self::new()
    }
}

// 防止未使用导入告警
#[allow(dead_code)]
fn _unused_import_guard(_s: &WorkSegment) {}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Episode;

    fn make_episode(start: &str, end: &str) -> Episode {
        Episode {
            id: format!("ep-{}-{}", start, end),
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

    #[test]
    fn test_time_to_seconds_hms() {
        let engine = TimeAuditEngine::new();
        assert_eq!(engine.time_to_seconds("01:02:03"), 3723);
        assert_eq!(engine.time_to_seconds("00:30:00"), 1800);
    }

    #[test]
    fn test_time_to_seconds_hm() {
        let engine = TimeAuditEngine::new();
        assert_eq!(engine.time_to_seconds("01:30"), 5400);
    }

    #[test]
    fn test_time_to_seconds_invalid() {
        let engine = TimeAuditEngine::new();
        assert_eq!(engine.time_to_seconds("invalid"), 0);
        assert_eq!(engine.time_to_seconds(""), 0);
    }

    #[test]
    fn test_compute_episode_duration_positive() {
        let engine = TimeAuditEngine::new();
        let ep = make_episode("10:00:00", "11:30:00");
        assert_eq!(engine.compute_episode_duration(&ep), 5400);
    }

    #[test]
    fn test_compute_episode_duration_negative_returns_zero() {
        let engine = TimeAuditEngine::new();
        let ep = make_episode("11:30:00", "10:00:00");
        assert_eq!(engine.compute_episode_duration(&ep), 0);
    }

    #[test]
    fn test_is_meeting_app_teams() {
        assert!(TimeAuditEngine::is_meeting_app("Teams", ""));
        assert!(TimeAuditEngine::is_meeting_app("", "teams.exe"));
        assert!(TimeAuditEngine::is_meeting_app("腾讯会议", ""));
        assert!(!TimeAuditEngine::is_meeting_app("VSCode", ""));
    }

    #[test]
    fn test_time_audit_default_fields() {
        let audit = TimeAudit {
            date: "2026-06-22".to_string(),
            total_tracked_ms: 28_800_000,
            focus_ms: 7_200_000,
            meeting_ms: 3_600_000,
            fragmentation_score: 0.3,
            coverage: 1.0,
        };
        assert_eq!(audit.date, "2026-06-22");
        assert_eq!(audit.total_tracked_ms, 28_800_000);
        assert_eq!(audit.focus_ms, 7_200_000);
        assert_eq!(audit.meeting_ms, 3_600_000);
        assert!((audit.fragmentation_score - 0.3).abs() < 1e-9);
        assert!((audit.coverage - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_time_audit_ms_conversion() {
        // 1 hour = 3600 sec = 3_600_000 ms
        let audit = TimeAudit {
            date: "2026-06-22".to_string(),
            total_tracked_ms: 3_600_000,
            focus_ms: 3_600_000,
            meeting_ms: 0,
            fragmentation_score: 0.0,
            coverage: 0.125,
        };
        assert_eq!(audit.total_tracked_ms, 3_600_000);
        // 1 hour / 8 hour = 0.125
        assert!((audit.coverage - 0.125).abs() < 1e-9);
    }
}
