//! OneLineSummary：今日一句话总结生成器（对应 electron/capture/OneLineSummary.ts）
//!
//! 功能：
//!  - generate_daily_summary(date)：读取该日期所有 Episodes，合成一句话总结
//!  - 规则：取耗时最长的 2-3 个 Episode 主题 + 动作词组合
//!  - 用户编辑保护：若该日期已有 user_edited 的每日总结 Episode，则不覆盖
//!  - set_daily_summary(date, text)：用户手动改写，标记 user_edited=true
//!  - get_daily_summary(date)：获取当前每日总结
//!
//! 每日总结存储：使用特殊的 Episode 记录，topics 包含 __daily_summary__ 标记，
//! segmentIds 为空。EpisodeBuilder 重建时保留此 Episode（不删除）。

use std::sync::OnceLock;

use regex::Regex;
use uuid::Uuid;

use crate::models::{Episode, Episode as EpisodeModel};
use crate::repositories::episode_repository::EpisodeRepository;

/// 每日总结标记 topic
pub const DAILY_SUMMARY_TOPIC: &str = "__daily_summary__";

/// 动作词映射（用于从 Episode title/summary 提取动作）
fn action_patterns() -> &'static [(Regex, &'static str)] {
    static P: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    P.get_or_init(|| vec![
        (Regex::new(r"(?i)(编写|开发|实现|编码|coding|implement)").unwrap(), "推进"),
        (Regex::new(r"(?i)(确认|核对|验证|检查|review|check|verify)").unwrap(), "确认"),
        (Regex::new(r"(?i)(沟通|讨论|交流|会议|chat|discuss|meeting)").unwrap(), "沟通"),
        (Regex::new(r"(?i)(修改|更新|调整|优化|重构|fix|update|refactor)").unwrap(), "完成"),
        (Regex::new(r"(?i)(测试|调试|test|debug)").unwrap(), "完成"),
        (Regex::new(r"(?i)(部署|发布|上线|deploy|release)").unwrap(), "完成"),
        (Regex::new(r"(?i)(设计|规划|架构|design|plan)").unwrap(), "推进"),
        (Regex::new(r"(?i)(搜索|查询|检索|search|query)").unwrap(), "进行"),
        (Regex::new(r"(?i)(阅读|查看|浏览|read|view|browse)").unwrap(), "查看"),
        (Regex::new(r"(?i)(创建|新建|添加|create|add)").unwrap(), "完成"),
    ])
}

/// 默认动作词
const DEFAULT_VERB: &str = "推进";

/// 将 "HH:MM:SS" 时间字符串转为秒数
fn time_to_seconds(time_str: &str) -> i64 {
    let parts: Vec<&str> = time_str.split(':').collect();
    if parts.len() == 3 {
        let h: i64 = parts[0].parse().unwrap_or(0);
        let m: i64 = parts[1].parse().unwrap_or(0);
        let s: i64 = parts[2].parse().unwrap_or(0);
        h * 3600 + m * 60 + s
    } else if parts.len() == 2 {
        let h: i64 = parts[0].parse().unwrap_or(0);
        let m: i64 = parts[1].parse().unwrap_or(0);
        h * 3600 + m * 60
    } else {
        0
    }
}

/// OneLineSummary：今日一句话总结生成器。
pub struct OneLineSummary;

impl OneLineSummary {
    /// 创建 OneLineSummary 实例
    pub fn new() -> Self {
        Self
    }

    /// 生成每日总结。
    ///
    /// 规则：
    ///  1. 若已有 user_edited 的每日总结 Episode，直接返回（不覆盖）
    ///  2. 否则读取所有 Episodes，取耗时最长的 2-3 个，提取主题 + 动作词组合
    ///  3. 合成一句话总结
    ///  4. 存储为每日总结 Episode（若已存在非 user_edited 的则更新）
    pub fn generate_daily_summary(&self, date: &str) -> String {
        // 检查是否已有每日总结 Episode
        let existing = match self.find_daily_summary_episode(date) {
            Some(e) => e,
            None => {
                // 无现有总结，生成新的
                let summary = self.synthesize_from_episodes(date);
                let _ = self.upsert_daily_summary(date, &summary, false);
                return summary;
            }
        };

        // 用户编辑保护：若 user_edited 则不覆盖
        if existing.user_edited {
            return existing.one_line_summary;
        }

        // 生成新总结并更新
        let summary = self.synthesize_from_episodes(date);
        let _ = self.upsert_daily_summary(date, &summary, false);
        summary
    }

    /// 用户手动改写每日总结。
    /// 标记 user_edited=true，此后自动更新永不覆盖。
    pub fn set_daily_summary(&self, date: &str, text: &str) -> bool {
        self.upsert_daily_summary(date, text, true).is_ok()
    }

    /// 获取当前每日总结。
    /// 若不存在则返回空字符串。
    pub fn get_daily_summary(&self, date: &str) -> String {
        self.find_daily_summary_episode(date)
            .map(|e| e.one_line_summary)
            .unwrap_or_default()
    }

    // ===================== 内部方法 =====================

    /// 查找指定日期的每日总结 Episode
    fn find_daily_summary_episode(&self, date: &str) -> Option<EpisodeModel> {
        let episodes = EpisodeRepository::get_by_date(date).ok()?;
        episodes.into_iter().find(|e| e.topics.iter().any(|t| t == DAILY_SUMMARY_TOPIC))
    }

    /// 从所有 Episodes 合成一句话总结
    fn synthesize_from_episodes(&self, date: &str) -> String {
        let all_episodes = match EpisodeRepository::get_by_date(date) {
            Ok(e) => e,
            Err(_) => return "今日暂无工作记录".to_string(),
        };
        // 排除每日总结本身
        let episodes: Vec<Episode> = all_episodes
            .into_iter()
            .filter(|e| !e.topics.iter().any(|t| t == DAILY_SUMMARY_TOPIC))
            .collect();

        if episodes.is_empty() {
            return "今日暂无工作记录".to_string();
        }

        // 按耗时排序（降序）
        let mut sorted: Vec<Episode> = episodes;
        sorted.sort_by(|a, b| {
            let da = Self::get_duration(a);
            let db = Self::get_duration(b);
            db.cmp(&da)
        });

        // 取耗时最长的 2-3 个
        let top_count = std::cmp::min(sorted.len(), if sorted.len() >= 3 { 3 } else { 2 });
        let top_episodes = &sorted[..top_count];

        Self::synthesize_summary(top_episodes)
    }

    /// 计算 Episode 耗时（秒）
    fn get_duration(episode: &Episode) -> i64 {
        time_to_seconds(&episode.end_time) - time_to_seconds(&episode.start_time)
    }

    /// 合成一句话总结
    fn synthesize_summary(episodes: &[Episode]) -> String {
        if episodes.is_empty() {
            return "今日暂无工作记录".to_string();
        }

        let mut parts: Vec<String> = Vec::new();
        for (i, episode) in episodes.iter().enumerate() {
            let topic = Self::extract_topic(episode);
            let verb = Self::extract_action_verb(episode);

            if i == 0 {
                // 第一个：主要推进...
                parts.push(format!("主要{}{}", verb, topic));
            } else if i == episodes.len() - 1 {
                // 最后一个：并完成...
                parts.push(format!("并{}{}", verb, topic));
            } else {
                // 中间：同时...
                parts.push(format!("{}{}", verb, topic));
            }
        }

        format!("今日{}。", parts.join("，"))
    }

    /// 从 Episode 提取主题
    fn extract_topic(episode: &Episode) -> String {
        // 优先使用 title 中的主题部分（去除 [项目名] 前缀）
        let bracket_re = Regex::new(r"^\[[^\]]+\]\s*(.+)$").unwrap();
        if let Some(caps) = bracket_re.captures(&episode.title) {
            return caps.get(1).unwrap().as_str().to_string();
        }

        // 使用 title 本身（去除应用名前缀）
        let app_prefix_re = Regex::new(r"^[^-]+-\s*(.+)$").unwrap();
        if let Some(caps) = app_prefix_re.captures(&episode.title) {
            return caps.get(1).unwrap().as_str().to_string();
        }

        // 使用 top 关键词
        if !episode.topics.is_empty() {
            return episode.topics.iter().take(3).cloned().collect::<String>();
        }

        episode.title.clone()
    }

    /// 从 Episode 提取动作词
    fn extract_action_verb(episode: &Episode) -> &'static str {
        let text = format!("{} {}", episode.title, episode.one_line_summary);
        for (pattern, verb) in action_patterns() {
            if pattern.is_match(&text) {
                return verb;
            }
        }
        DEFAULT_VERB
    }

    /// 插入或更新每日总结 Episode
    fn upsert_daily_summary(&self, date: &str, summary: &str, user_edited: bool) -> anyhow::Result<()> {
        let existing = self.find_daily_summary_episode(date);

        if let Some(existing) = existing {
            // 更新现有每日总结
            let mut updated = existing.clone();
            updated.one_line_summary = summary.to_string();
            updated.user_edited = user_edited;
            updated.date = date.to_string();
            updated.start_time = "00:00:00".to_string();
            updated.end_time = "23:59:59".to_string();
            EpisodeRepository::update(&existing.id, updated)?;
        } else {
            // 插入新的每日总结 Episode
            let daily_episode = Episode {
                id: Uuid::new_v4().to_string(),
                date: date.to_string(),
                start_time: "00:00:00".to_string(),
                end_time: "23:59:59".to_string(),
                title: format!("{} 今日总结", date),
                one_line_summary: summary.to_string(),
                segment_ids: vec![],
                entities: vec![],
                topics: vec![DAILY_SUMMARY_TOPIC.to_string()],
                user_edited,
                report_eligible: false,
                wiki_eligible: false,
                dominant_activity_type: None,
            };
            EpisodeRepository::insert(daily_episode)?;
        }
        Ok(())
    }
}

impl Default for OneLineSummary {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_topic_with_bracket() {
        let episode = Episode {
            id: "1".to_string(),
            date: "2026-06-22".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "[订单] 处理订单模块".to_string(),
            one_line_summary: String::new(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: false,
            wiki_eligible: false,
            dominant_activity_type: None,
        };
        assert_eq!(OneLineSummary::extract_topic(&episode), "处理订单模块");
    }

    #[test]
    fn test_extract_topic_with_app_prefix() {
        let episode = Episode {
            id: "1".to_string(),
            date: "2026-06-22".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "VSCode - main.rs".to_string(),
            one_line_summary: String::new(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: false,
            wiki_eligible: false,
            dominant_activity_type: None,
        };
        assert_eq!(OneLineSummary::extract_topic(&episode), "main.rs");
    }

    #[test]
    fn test_extract_action_verb_coding() {
        let episode = Episode {
            id: "1".to_string(),
            date: "2026-06-22".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "编写代码".to_string(),
            one_line_summary: "实现新功能".to_string(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: false,
            wiki_eligible: false,
            dominant_activity_type: None,
        };
        assert_eq!(OneLineSummary::extract_action_verb(&episode), "推进");
    }

    #[test]
    fn test_extract_action_verb_default() {
        let episode = Episode {
            id: "1".to_string(),
            date: "2026-06-22".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "未知操作".to_string(),
            one_line_summary: "做了一些事情".to_string(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: false,
            wiki_eligible: false,
            dominant_activity_type: None,
        };
        assert_eq!(OneLineSummary::extract_action_verb(&episode), DEFAULT_VERB);
    }

    #[test]
    fn test_synthesize_summary_single() {
        let episode = Episode {
            id: "1".to_string(),
            date: "2026-06-22".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "[项目] 编写代码".to_string(),
            one_line_summary: "实现新功能".to_string(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: false,
            wiki_eligible: false,
            dominant_activity_type: None,
        };
        let summary = OneLineSummary::synthesize_summary(&[episode]);
        assert!(summary.starts_with("今日主要"));
        assert!(summary.ends_with("。"));
    }

    #[test]
    fn test_synthesize_summary_empty() {
        let summary = OneLineSummary::synthesize_summary(&[]);
        assert_eq!(summary, "今日暂无工作记录");
    }

    #[test]
    fn test_time_to_seconds() {
        assert_eq!(time_to_seconds("01:30:45"), 5445);
        assert_eq!(time_to_seconds("00:00:00"), 0);
        assert_eq!(time_to_seconds("invalid"), 0);
    }
}
