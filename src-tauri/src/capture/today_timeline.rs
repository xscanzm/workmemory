//! TodayTimeline：今日时间线视图（F8.18）
//!
//! 功能：
//!  - build_timeline(date)：构建指定日期的 24h 时间线
//!  - 将 Episode 转换为 TimelineBlock（按 activity_type 着色）
//!  - 计算 TimelineGap（未记录时段，可点击补录）
//!  - 颜色映射：coding=#4CAF50, writing=#2196F3, meeting=#FF9800,
//!    browsing=#9C27B0, reading=#00BCD4, communication=#FF5722,
//!    design=#E91E63, admin=#795548, other=#607D8B

use serde::{Deserialize, Serialize};

use crate::models::{ActivityType, Episode};
use crate::repositories::episode_repository::EpisodeRepository;

/// 时间线数据
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TimelineData {
    /// 日期 YYYY-MM-DD
    pub date: String,
    /// 时间块列表（已记录时段）
    pub blocks: Vec<TimelineBlock>,
    /// 间隙列表（未记录时段，可点击补录）
    pub gaps: Vec<TimelineGap>,
}

/// 时间块（一个 Episode 对应一个块）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBlock {
    /// Episode ID
    pub episode_id: String,
    /// 起始时间（Unix 毫秒）
    pub start_time: i64,
    /// 结束时间（Unix 毫秒）
    pub end_time: i64,
    /// 活动类型
    pub activity_type: ActivityType,
    /// 标题
    pub title: String,
    /// 颜色（按 activity_type 映射）
    pub color: String,
}

/// 时间间隙（未记录时段）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineGap {
    /// 起始时间（Unix 毫秒）
    pub start_time: i64,
    /// 结束时间（Unix 毫秒）
    pub end_time: i64,
    /// 持续时长（毫秒）
    pub duration_ms: u64,
}

/// 按 activity_type 返回固定色值
fn color_for_activity(activity: &ActivityType) -> &'static str {
    match activity {
        ActivityType::Coding => "#4CAF50",       // 编码：绿色
        ActivityType::Writing => "#2196F3",      // 写作：蓝色
        ActivityType::Meeting => "#FF9800",      // 会议：橙色
        ActivityType::Browsing => "#9C27B0",     // 浏览：紫色
        ActivityType::Reading => "#00BCD4",      // 阅读：青色
        ActivityType::Chatting => "#FF5722",     // 沟通：红色（communication）
        ActivityType::Designing => "#E91E63",    // 设计：粉色
        ActivityType::Managing => "#795548",     // 管理：棕色（admin）
        ActivityType::Idle => "#607D8B",         // 空闲：灰蓝（other）
    }
}

/// TodayTimeline：今日时间线视图构建器
pub struct TodayTimeline;

impl TodayTimeline {
    /// 创建实例
    pub fn new() -> Self {
        TodayTimeline
    }

    /// 构建指定日期的时间线。
    ///
    /// 流程：
    ///  1. 加载该日期所有 Episodes
    ///  2. 每个 Episode → TimelineBlock（start/end 转 Unix 毫秒）
    ///  3. 按 start_time 排序
    ///  4. 计算相邻 block 之间的 gap（未记录时段）
    pub fn build_timeline(&self, date: &str) -> anyhow::Result<TimelineData> {
        let episodes = EpisodeRepository::get_by_date(date)?;
        Ok(self.build_timeline_from_episodes(date, &episodes))
    }

    /// 从 Episode 列表构建时间线（公开供测试调用，不访问数据库）
    pub fn build_timeline_from_episodes(&self, date: &str, episodes: &[Episode]) -> TimelineData {
        // 1. 转换为 TimelineBlock
        let mut blocks: Vec<TimelineBlock> = episodes
            .iter()
            .filter_map(|ep| self.episode_to_block(date, ep))
            .collect();

        // 2. 按 start_time 排序
        blocks.sort_by_key(|b| b.start_time);

        // 3. 计算 gaps（相邻 block 之间的空隙）
        let gaps = self.compute_gaps(date, &blocks);

        TimelineData {
            date: date.to_string(),
            blocks,
            gaps,
        }
    }

    /// 将 Episode 转换为 TimelineBlock
    fn episode_to_block(&self, date: &str, episode: &Episode) -> Option<TimelineBlock> {
        let start_ms = datetime_to_ms(date, &episode.start_time)?;
        let end_ms = datetime_to_ms(date, &episode.end_time).unwrap_or(start_ms);
        let activity = episode
            .dominant_activity_type
            .clone()
            .unwrap_or(ActivityType::Idle);
        let color = color_for_activity(&activity).to_string();
        Some(TimelineBlock {
            episode_id: episode.id.clone(),
            start_time: start_ms,
            end_time: end_ms,
            activity_type: activity,
            title: episode.title.clone(),
            color,
        })
    }

    /// 计算相邻 block 之间的 gap
    fn compute_gaps(&self, date: &str, blocks: &[TimelineBlock]) -> Vec<TimelineGap> {
        if blocks.is_empty() {
            return Vec::new();
        }
        let mut gaps: Vec<TimelineGap> = Vec::new();
        for window in blocks.windows(2) {
            let prev_end = window[0].end_time;
            let next_start = window[1].start_time;
            if next_start > prev_end {
                let duration_ms = (next_start - prev_end) as u64;
                gaps.push(TimelineGap {
                    start_time: prev_end,
                    end_time: next_start,
                    duration_ms,
                });
            }
        }
        // 防止未使用 date 变量告警（date 已用于 block 构建）
        let _ = date;
        gaps
    }
}

impl Default for TodayTimeline {
    fn default() -> Self {
        Self::new()
    }
}

/// 将 date + "HH:MM:SS" 转换为 Unix 毫秒
fn datetime_to_ms(date: &str, time: &str) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let parts: Vec<&str> = time.split(':').collect();
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
        _ => return None,
    };
    let t = chrono::NaiveTime::from_hms_opt(h, m, s)?;
    Some(d.and_time(t).and_utc().timestamp_millis())
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{EntityRef};

    fn make_episode(
        id: &str,
        date: &str,
        start: &str,
        end: &str,
        title: &str,
        activity: Option<ActivityType>,
    ) -> Episode {
        Episode {
            id: id.to_string(),
            date: date.to_string(),
            start_time: start.to_string(),
            end_time: end.to_string(),
            title: title.to_string(),
            one_line_summary: String::new(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: true,
            wiki_eligible: true,
            dominant_activity_type: activity,
        }
    }

    #[test]
    fn test_color_for_activity_mapping() {
        assert_eq!(color_for_activity(&ActivityType::Coding), "#4CAF50");
        assert_eq!(color_for_activity(&ActivityType::Writing), "#2196F3");
        assert_eq!(color_for_activity(&ActivityType::Meeting), "#FF9800");
        assert_eq!(color_for_activity(&ActivityType::Browsing), "#9C27B0");
        assert_eq!(color_for_activity(&ActivityType::Reading), "#00BCD4");
        assert_eq!(color_for_activity(&ActivityType::Chatting), "#FF5722");
        assert_eq!(color_for_activity(&ActivityType::Designing), "#E91E63");
        assert_eq!(color_for_activity(&ActivityType::Managing), "#795548");
        assert_eq!(color_for_activity(&ActivityType::Idle), "#607D8B");
    }

    #[test]
    fn test_datetime_to_ms_valid() {
        let ms = datetime_to_ms("2026-06-22", "10:30:00");
        assert!(ms.is_some());
        let ms = ms.unwrap();
        let expected = chrono::NaiveDate::parse_from_str("2026-06-22", "%Y-%m-%d")
            .unwrap()
            .and_time(chrono::NaiveTime::from_hms_opt(10, 30, 0).unwrap())
            .and_utc()
            .timestamp_millis();
        assert_eq!(ms, expected);
    }

    #[test]
    fn test_datetime_to_ms_invalid() {
        assert!(datetime_to_ms("invalid", "10:00:00").is_none());
        assert!(datetime_to_ms("2026-06-22", "invalid").is_none());
        assert!(datetime_to_ms("2026-06-22", "").is_none());
    }

    #[test]
    fn test_build_timeline_empty_episodes() {
        let timeline = TodayTimeline::new();
        let data = timeline.build_timeline_from_episodes("2026-06-22", &[]);
        assert_eq!(data.date, "2026-06-22");
        assert!(data.blocks.is_empty());
        assert!(data.gaps.is_empty());
    }

    #[test]
    fn test_build_timeline_single_block() {
        let timeline = TodayTimeline::new();
        let episodes = vec![make_episode(
            "ep1",
            "2026-06-22",
            "10:00:00",
            "11:00:00",
            "编码",
            Some(ActivityType::Coding),
        )];
        let data = timeline.build_timeline_from_episodes("2026-06-22", &episodes);
        assert_eq!(data.blocks.len(), 1);
        assert_eq!(data.blocks[0].episode_id, "ep1");
        assert_eq!(data.blocks[0].color, "#4CAF50");
        assert_eq!(data.blocks[0].title, "编码");
        // 单个 block 无 gap
        assert!(data.gaps.is_empty());
    }

    #[test]
    fn test_build_timeline_multiple_blocks_with_gap() {
        let timeline = TodayTimeline::new();
        let episodes = vec![
            make_episode(
                "ep1",
                "2026-06-22",
                "09:00:00",
                "10:00:00",
                "编码",
                Some(ActivityType::Coding),
            ),
            make_episode(
                "ep2",
                "2026-06-22",
                "11:00:00",
                "12:00:00",
                "会议",
                Some(ActivityType::Meeting),
            ),
        ];
        let data = timeline.build_timeline_from_episodes("2026-06-22", &episodes);
        assert_eq!(data.blocks.len(), 2);
        // 应有 1 个 gap（10:00-11:00）
        assert_eq!(data.gaps.len(), 1);
        let gap = &data.gaps[0];
        assert_eq!(gap.duration_ms, 60 * 60 * 1000); // 1 小时
    }

    #[test]
    fn test_build_timeline_sorts_blocks_by_start_time() {
        let timeline = TodayTimeline::new();
        let episodes = vec![
            make_episode(
                "ep2",
                "2026-06-22",
                "14:00:00",
                "15:00:00",
                "下午",
                Some(ActivityType::Writing),
            ),
            make_episode(
                "ep1",
                "2026-06-22",
                "09:00:00",
                "10:00:00",
                "上午",
                Some(ActivityType::Coding),
            ),
        ];
        let data = timeline.build_timeline_from_episodes("2026-06-22", &episodes);
        assert_eq!(data.blocks.len(), 2);
        // 应按 start_time 升序排列
        assert_eq!(data.blocks[0].episode_id, "ep1");
        assert_eq!(data.blocks[1].episode_id, "ep2");
    }

    #[test]
    fn test_build_timeline_default_activity_when_none() {
        let timeline = TodayTimeline::new();
        let episodes = vec![make_episode(
            "ep1",
            "2026-06-22",
            "10:00:00",
            "11:00:00",
            "无活动类型",
            None,
        )];
        let data = timeline.build_timeline_from_episodes("2026-06-22", &episodes);
        assert_eq!(data.blocks.len(), 1);
        // dominant_activity_type 为 None 时默认 Idle
        assert_eq!(data.blocks[0].activity_type, ActivityType::Idle);
        assert_eq!(data.blocks[0].color, "#607D8B");
    }

    #[test]
    fn test_timeline_data_serialization() {
        let data = TimelineData {
            date: "2026-06-22".to_string(),
            blocks: vec![TimelineBlock {
                episode_id: "ep1".to_string(),
                start_time: 1000,
                end_time: 2000,
                activity_type: ActivityType::Coding,
                title: "测试".to_string(),
                color: "#4CAF50".to_string(),
            }],
            gaps: vec![TimelineGap {
                start_time: 2000,
                end_time: 3000,
                duration_ms: 1000,
            }],
        };
        let json = serde_json::to_string(&data).expect("序列化失败");
        assert!(json.contains("\"date\":\"2026-06-22\""));
        assert!(json.contains("\"episodeId\":\"ep1\""));
        assert!(json.contains("\"durationMs\":1000"));
    }

    #[test]
    fn test_episode_to_block_with_invalid_time_returns_none() {
        let timeline = TodayTimeline::new();
        let episode = make_episode(
            "ep1",
            "invalid-date",
            "10:00:00",
            "11:00:00",
            "测试",
            None,
        );
        // date 无效时 episode_to_block 返回 None，被 filter_map 过滤
        let data = timeline.build_timeline_from_episodes("invalid-date", &[episode]);
        assert!(data.blocks.is_empty());
    }

    #[test]
    fn test_compute_gaps_contiguous_blocks_no_gap() {
        let timeline = TodayTimeline::new();
        // 两个相邻 block（前一个 end = 后一个 start）应无 gap
        let blocks = vec![
            TimelineBlock {
                episode_id: "ep1".to_string(),
                start_time: 1000,
                end_time: 2000,
                activity_type: ActivityType::Coding,
                title: "a".to_string(),
                color: "#4CAF50".to_string(),
            },
            TimelineBlock {
                episode_id: "ep2".to_string(),
                start_time: 2000,
                end_time: 3000,
                activity_type: ActivityType::Coding,
                title: "b".to_string(),
                color: "#4CAF50".to_string(),
            },
        ];
        let gaps = timeline.compute_gaps("2026-06-22", &blocks);
        assert!(gaps.is_empty());
    }
}
