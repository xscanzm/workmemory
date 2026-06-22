//! EntityTimeline：实体时间线视图（F8.8）
//!
//! 功能：
//!  - 聚合所有与指定实体（人/项目）相关的 Episode，构造时间线
//!  - 时间线按时间戳升序排列
//!  - 每个 TimelineEntry 包含 episode_id / date / timestamp / title / duration_ms
//!
//! 实体匹配策略：
//!  - Episode.entities 中 name 与 entity_name 匹配（大小写不敏感）
//!  - Episode.title 中包含 entity_name
//!  - Episode.topics 中包含 entity_name

use serde::{Deserialize, Serialize};

use crate::models::Episode;
use crate::repositories::episode_repository::EpisodeRepository;

/// 单条时间线条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub episode_id: String,
    /// YYYY-MM-DD
    pub date: String,
    /// Unix 毫秒
    pub timestamp: i64,
    pub title: String,
    /// 持续时长（毫秒）
    pub duration_ms: u64,
}

/// EntityTimeline：实体时间线视图
pub struct EntityTimeline;

impl EntityTimeline {
    /// 创建实例
    pub fn new() -> Self {
        EntityTimeline
    }

    /// 获取指定实体（人/项目）的时间线
    ///  - 扫描全库所有 Episode
    ///  - 匹配 entities / title / topics 中包含 entity_name 的 Episode
    ///  - 按时间戳升序返回
    pub fn get_timeline(&self, entity_name: &str) -> anyhow::Result<Vec<TimelineEntry>> {
        let episodes = EpisodeRepository::get_all()?;
        let target = entity_name.to_lowercase();
        let mut entries: Vec<TimelineEntry> = Vec::new();

        for episode in episodes {
            if self.episode_matches_entity(&episode, &target) {
                if let Some(entry) = self.episode_to_timeline_entry(&episode) {
                    entries.push(entry);
                }
            }
        }

        // 按时间戳升序
        entries.sort_by_key(|e| e.timestamp);
        Ok(entries)
    }

    /// 判断 Episode 是否与指定实体相关
    fn episode_matches_entity(&self, episode: &Episode, target_lower: &str) -> bool {
        // 1. entities 中 name 匹配
        if episode
            .entities
            .iter()
            .any(|e| e.name.to_lowercase() == target_lower)
        {
            return true;
        }
        // 2. title 中包含
        if episode.title.to_lowercase().contains(target_lower) {
            return true;
        }
        // 3. topics 中包含
        if episode
            .topics
            .iter()
            .any(|t| t.to_lowercase().contains(target_lower))
        {
            return true;
        }
        false
    }

    /// 将 Episode 转换为 TimelineEntry
    fn episode_to_timeline_entry(&self, episode: &Episode) -> Option<TimelineEntry> {
        let timestamp = episode_date_time_to_millis(&episode.date, &episode.start_time)?;
        let duration_ms = compute_duration_ms(&episode.start_time, &episode.end_time);
        Some(TimelineEntry {
            episode_id: episode.id.clone(),
            date: episode.date.clone(),
            timestamp,
            title: episode.title.clone(),
            duration_ms,
        })
    }
}

impl Default for EntityTimeline {
    fn default() -> Self {
        Self::new()
    }
}

/// 将 "YYYY-MM-DD" + "HH:MM:SS" 转为 Unix 毫秒
fn episode_date_time_to_millis(date: &str, time_str: &str) -> Option<i64> {
    let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let parts: Vec<&str> = time_str.split(':').collect();
    let (h, m, s) = match parts.len() {
        3 => (
            parts[0].parse::<u32>().ok()?,
            parts[1].parse::<u32>().ok()?,
            parts[2].parse::<u32>().ok()?,
        ),
        2 => (
            parts[0].parse::<u32>().ok()?,
            parts[1].parse::<u32>().ok()?,
            0,
        ),
        _ => (0, 0, 0),
    };
    let time = chrono::NaiveTime::from_hms_opt(h, m, s)?;
    let dt = date.and_time(time);
    Some(dt.and_utc().timestamp_millis())
}

/// 计算 "HH:MM:SS" 时长差，返回毫秒
fn compute_duration_ms(start: &str, end: &str) -> u64 {
    let s = time_to_seconds(start);
    let e = time_to_seconds(end);
    let diff = e - s;
    if diff > 0 {
        (diff as u64) * 1000
    } else {
        0
    }
}

/// "HH:MM:SS" → 秒
fn time_to_seconds(time_str: &str) -> i64 {
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

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{EntityRef, EntityRefType};

    fn make_episode_with_entity(id: &str, date: &str, start: &str, end: &str, title: &str, entity_name: &str) -> Episode {
        Episode {
            id: id.to_string(),
            date: date.to_string(),
            start_time: start.to_string(),
            end_time: end.to_string(),
            title: title.to_string(),
            one_line_summary: String::new(),
            segment_ids: vec![],
            entities: vec![EntityRef {
                ref_type: EntityRefType::Person,
                name: entity_name.to_string(),
                value: None,
                confidence: 0.9,
                user_confirmed: false,
            }],
            topics: vec![],
            user_edited: false,
            report_eligible: true,
            wiki_eligible: true,
            dominant_activity_type: None,
        }
    }

    #[test]
    fn test_time_to_seconds_hms() {
        assert_eq!(time_to_seconds("01:02:03"), 3723);
        assert_eq!(time_to_seconds("00:30:00"), 1800);
    }

    #[test]
    fn test_compute_duration_ms_positive() {
        let ms = compute_duration_ms("10:00:00", "11:30:00");
        assert_eq!(ms, 5400 * 1000);
    }

    #[test]
    fn test_compute_duration_ms_negative_returns_zero() {
        let ms = compute_duration_ms("11:30:00", "10:00:00");
        assert_eq!(ms, 0);
    }

    #[test]
    fn test_episode_date_time_to_millis() {
        let ts = episode_date_time_to_millis("2026-06-22", "10:00:00");
        assert!(ts.is_some());
        let ts2 = episode_date_time_to_millis("invalid", "10:00:00");
        assert!(ts2.is_none());
    }

    #[test]
    fn test_episode_matches_entity_by_entities_field() {
        let timeline = EntityTimeline::new();
        let episode = make_episode_with_entity(
            "ep-1",
            "2026-06-22",
            "10:00:00",
            "11:00:00",
            "讨论需求",
            "张三",
        );
        assert!(timeline.episode_matches_entity(&episode, "张三"));
        // 大小写不敏感
        assert!(timeline.episode_matches_entity(&episode, "张三"));
        assert!(!timeline.episode_matches_entity(&episode, "李四"));
    }

    #[test]
    fn test_episode_matches_entity_by_title() {
        let timeline = EntityTimeline::new();
        let mut episode = make_episode_with_entity(
            "ep-1",
            "2026-06-22",
            "10:00:00",
            "11:00:00",
            "和张三讨论需求",
            "李四",
        );
        // entities 是李四，但 title 含张三
        episode.entities.clear();
        assert!(timeline.episode_matches_entity(&episode, "张三"));
    }

    #[test]
    fn test_episode_to_timeline_entry() {
        let timeline = EntityTimeline::new();
        let episode = make_episode_with_entity(
            "ep-1",
            "2026-06-22",
            "10:00:00",
            "11:00:00",
            "讨论需求",
            "张三",
        );
        let entry = timeline.episode_to_timeline_entry(&episode);
        assert!(entry.is_some());
        let e = entry.unwrap();
        assert_eq!(e.episode_id, "ep-1");
        assert_eq!(e.date, "2026-06-22");
        assert_eq!(e.title, "讨论需求");
        assert_eq!(e.duration_ms, 3600 * 1000);
    }
}
