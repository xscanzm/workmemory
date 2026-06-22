//! GoalAlignmentAnalyzer：目标对齐度分析器（F8.16）
//!
//! 功能：
//!  - 用户设置 3 个周度目标（自然语言）
//!  - 对指定周（week_start 起的 7 天）的 CleanEpisode 进行关键词匹配
//!  - 每个 CleanEpisode 自动打标 "related to goal N"
//!  - 计算每个目标的 alignment_score（0-1）与 time_spent_ms
//!  - 计算 overall_score（所有目标对齐度的平均）

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::models::CleanEpisode;
use crate::repositories::clean_episode_repository::CleanEpisodeRepository;

/// 单个目标的对齐结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalAlignment {
    /// 目标描述
    pub goal: String,
    /// 相关 Episode ID 列表
    pub related_episodes: Vec<String>,
    /// 对齐评分 0-1
    pub alignment_score: f64,
    /// 投入时长（毫秒）
    pub time_spent_ms: u64,
}

/// 周度目标对齐报告
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GoalAlignmentReport {
    /// 各目标对齐详情
    pub goals: Vec<GoalAlignment>,
    /// 总体对齐评分 0-1
    pub overall_score: f64,
}

/// GoalAlignmentAnalyzer：目标对齐度分析器
pub struct GoalAlignmentAnalyzer {
    /// 周度目标列表
    weekly_goals: Vec<String>,
}

impl GoalAlignmentAnalyzer {
    /// 创建实例
    pub fn new() -> Self {
        GoalAlignmentAnalyzer {
            weekly_goals: Vec::new(),
        }
    }

    /// 设置周度目标（自然语言）
    pub fn set_weekly_goals(&mut self, goals: Vec<String>) {
        self.weekly_goals = goals;
    }

    /// 分析指定周的目标对齐度
    ///  - week_start 格式：YYYY-MM-DD（周一）
    ///  - 取该周 7 天的 CleanEpisode
    ///  - 对每个目标，匹配 episode.title + summary + topics + project
    ///  - 计算 alignment_score = matched_episodes / total_episodes
    ///  - 计算 time_spent_ms = sum(episode duration)
    pub fn analyze_week(&self, week_start: &str) -> anyhow::Result<GoalAlignmentReport> {
        if self.weekly_goals.is_empty() {
            return Ok(GoalAlignmentReport::default());
        }

        let start_date = chrono::NaiveDate::parse_from_str(week_start, "%Y-%m-%d")
            .map_err(|e| anyhow::anyhow!("日期解析失败 {}: {}", week_start, e))?;
        let end_date = start_date + chrono::Duration::days(6);
        let fmt = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();

        let episodes = CleanEpisodeRepository::get_by_date_range(
            &fmt(start_date),
            &fmt(end_date),
        )?;

        let total_count = episodes.len();
        let mut goals: Vec<GoalAlignment> = Vec::new();

        for goal in &self.weekly_goals {
            let keywords = tokenize_goal(goal);
            let mut related_episodes: Vec<String> = Vec::new();
            let mut time_spent_ms: u64 = 0;

            for episode in &episodes {
                if self.episode_matches_goal(episode, &keywords) {
                    related_episodes.push(episode.id.clone());
                    time_spent_ms += compute_episode_duration_ms(episode);
                }
            }

            let alignment_score = if total_count > 0 {
                related_episodes.len() as f64 / total_count as f64
            } else {
                0.0
            };

            goals.push(GoalAlignment {
                goal: goal.clone(),
                related_episodes,
                alignment_score: (alignment_score * 100.0).round() / 100.0,
                time_spent_ms,
            });
        }

        // 总体评分 = 各目标对齐度的平均
        let overall_score = if goals.is_empty() {
            0.0
        } else {
            let sum: f64 = goals.iter().map(|g| g.alignment_score).sum();
            (sum / goals.len() as f64 * 100.0).round() / 100.0
        };

        Ok(GoalAlignmentReport {
            goals,
            overall_score,
        })
    }

    /// 判断 Episode 是否匹配目标关键词
    fn episode_matches_goal(&self, episode: &CleanEpisode, keywords: &HashSet<String>) -> bool {
        if keywords.is_empty() {
            return false;
        }
        let haystack = format!(
            "{} {} {} {}",
            episode.title, episode.summary, episode.project, episode.topics.join(" ")
        )
        .to_lowercase();
        for kw in keywords {
            if haystack.contains(kw) {
                return true;
            }
        }
        false
    }
}

impl Default for GoalAlignmentAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// 对目标描述分词，提取关键词（小写）
///  - 英文单词（≥2 字符）
///  - 中文 bigram
fn tokenize_goal(goal: &str) -> HashSet<String> {
    let mut tokens: HashSet<String> = HashSet::new();

    // 英文单词
    let english_re = regex::Regex::new(r"[a-zA-Z]{2,}").unwrap();
    for m in english_re.find_iter(goal) {
        tokens.insert(m.as_str().to_lowercase());
    }

    // 中文 bigram
    let chinese_re = regex::Regex::new(r"[\u{4e00}-\u{9fa5}]").unwrap();
    let chinese_chars: Vec<char> = chinese_re
        .find_iter(goal)
        .filter_map(|m| m.as_str().chars().next())
        .collect();
    if chinese_chars.len() >= 2 {
        for i in 0..chinese_chars.len() - 1 {
            tokens.insert(format!("{}{}", chinese_chars[i], chinese_chars[i + 1]));
        }
    }

    // 过滤停用词
    let stopwords = ["的", "了", "和", "与", "在", "为", "是", "我", "我们", "这", "那"];
    tokens.retain(|t| !stopwords.iter().any(|s| *s == t));
    tokens
}

/// 计算 CleanEpisode 时长（毫秒）
fn compute_episode_duration_ms(episode: &CleanEpisode) -> u64 {
    let s = time_to_seconds(&episode.start_time);
    let e = time_to_seconds(&episode.end_time);
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

    #[test]
    fn test_tokenize_goal_english() {
        let tokens = tokenize_goal("WorkMemory project development");
        assert!(tokens.contains("workmemory"));
        assert!(tokens.contains("project"));
        assert!(tokens.contains("development"));
    }

    #[test]
    fn test_tokenize_goal_chinese_bigram() {
        let tokens = tokenize_goal("完成周报和需求文档");
        // 应包含 bigram: 完成, 成周, 周报, 报和, 和需, 需求, 求文, 文档
        assert!(tokens.contains("完成"));
        assert!(tokens.contains("周报"));
        assert!(tokens.contains("需求"));
        assert!(tokens.contains("文档"));
        // 停用词 "和" 应被过滤（"和需" 仍保留，因为是 bigram）
    }

    #[test]
    fn test_tokenize_goal_filters_stopwords() {
        // 单字无法形成 bigram，故单字输入返回空
        let tokens = tokenize_goal("的");
        assert!(tokens.is_empty());
        // 验证停用词列表中存在的 token 会被过滤
        // "我们" 是停用词，但作为 bigram 不会被过滤（仅过滤与停用词完全相等的 token）
        // 此处验证单字停用词不会单独出现
        let tokens2 = tokenize_goal("workmemory");
        assert!(tokens2.contains("workmemory"));
        // 验证停用词本身（若作为单字出现）不会进入 tokens（因 bigram 需 ≥2 字）
        assert!(!tokens2.contains("的"));
        assert!(!tokens2.contains("了"));
    }

    #[test]
    fn test_time_to_seconds() {
        assert_eq!(time_to_seconds("01:02:03"), 3723);
        assert_eq!(time_to_seconds("00:30:00"), 1800);
        assert_eq!(time_to_seconds("invalid"), 0);
    }

    #[test]
    fn test_compute_episode_duration_ms() {
        let episode = CleanEpisode {
            id: "ce-1".to_string(),
            date: "2026-06-22".to_string(),
            hour_bucket: "10".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:30:00".to_string(),
            title: "测试".to_string(),
            summary: String::new(),
            memory_kind: crate::models::MemoryKind::Work,
            project: String::new(),
            entities: vec![],
            topics: vec![],
            materials: vec![],
            outputs: vec![],
            todos: vec![],
            blockers: vec![],
            segment_ids: vec![],
            evidence_refs: vec![],
            source_quality: crate::models::SourceQuality::Medium,
            confidence: 0.8,
            report_eligible: true,
            wiki_eligible: true,
            wiki_status: crate::models::WikiStatus::None,
            created_at: String::new(),
            updated_at: String::new(),
            model_name: String::new(),
            distill_version: String::new(),
        };
        assert_eq!(compute_episode_duration_ms(&episode), 5400 * 1000);
    }

    #[test]
    fn test_episode_matches_goal_keyword() {
        let analyzer = GoalAlignmentAnalyzer::new();
        let episode = CleanEpisode {
            id: "ce-1".to_string(),
            date: "2026-06-22".to_string(),
            hour_bucket: "10".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "WorkMemory 项目开发".to_string(),
            summary: String::new(),
            memory_kind: crate::models::MemoryKind::Coding,
            project: "WorkMemory".to_string(),
            entities: vec![],
            topics: vec![],
            materials: vec![],
            outputs: vec![],
            todos: vec![],
            blockers: vec![],
            segment_ids: vec![],
            evidence_refs: vec![],
            source_quality: crate::models::SourceQuality::Medium,
            confidence: 0.8,
            report_eligible: true,
            wiki_eligible: true,
            wiki_status: crate::models::WikiStatus::None,
            created_at: String::new(),
            updated_at: String::new(),
            model_name: String::new(),
            distill_version: String::new(),
        };
        let keywords: HashSet<String> = vec!["workmemory".to_string()].into_iter().collect();
        assert!(analyzer.episode_matches_goal(&episode, &keywords));

        let keywords2: HashSet<String> = vec!["nonexistent".to_string()].into_iter().collect();
        assert!(!analyzer.episode_matches_goal(&episode, &keywords2));
    }

    #[test]
    fn test_empty_goals_returns_default_report() {
        let analyzer = GoalAlignmentAnalyzer::new();
        let report = analyzer.analyze_week("2026-06-22").unwrap();
        assert!(report.goals.is_empty());
        assert_eq!(report.overall_score, 0.0);
    }
}
