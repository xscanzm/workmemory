//! CrossDayLinker：跨日任务连续性识别器（F8.4）
//!
//! 功能：
//!  - 对指定日期的每个 Episode 计算标题的词袋表示（简单分词）
//!  - 与过去 7 天的 Episode 比较 Jaccard 相似度
//!  - 相似度 > 0.8 时建立跨日关联，构造 related_episode_ids 字段
//!  - 返回具有跨日关联的 Episode ID 列表
//!
//! 简化策略：
//!  - 标题分词：中文按字 bigram + 英文按单词 + 数字 token
//!  - 不依赖外部 embedding 服务，纯本地计算

use std::collections::HashSet;

use crate::models::Episode;
use crate::repositories::episode_repository::EpisodeRepository;

/// 跨日关联相似度阈值
const SIMILARITY_THRESHOLD: f64 = 0.8;
/// 回溯天数
const LOOKBACK_DAYS: i64 = 7;

/// CrossDayLinker：跨日任务连续性识别器
pub struct CrossDayLinker;

impl CrossDayLinker {
    /// 创建实例
    pub fn new() -> Self {
        CrossDayLinker
    }

    /// 为指定日期的每个 Episode 计算跨日关联：
    ///  - 取该日期所有 Episode
    ///  - 取过去 LOOKBACK_DAYS 天的 Episode 作为候选
    ///  - 对每个当前 Episode，计算与候选 Episode 标题的 Jaccard 相似度
    ///  - 相似度 > SIMILARITY_THRESHOLD 时加入 related_episode_ids
    ///  - 返回具有跨日关联的当前 Episode ID 列表
    pub fn link_episodes(&self, date: &str) -> anyhow::Result<Vec<String>> {
        let current_episodes = EpisodeRepository::get_by_date(date)?;
        if current_episodes.is_empty() {
            return Ok(Vec::new());
        }

        // 计算回溯窗口 [start_date, prev_date]
        let today = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|e| anyhow::anyhow!("日期解析失败 {}: {}", date, e))?;
        let prev_date = today - chrono::Duration::days(1);
        let start_date = today - chrono::Duration::days(LOOKBACK_DAYS);
        let fmt = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();

        let candidates = EpisodeRepository::get_by_date_range(
            &fmt(start_date),
            &fmt(prev_date),
        )?;

        let mut linked_ids: Vec<String> = Vec::new();
        for episode in &current_episodes {
            let related = self.find_related_in_set(episode, &candidates);
            if !related.is_empty() {
                linked_ids.push(episode.id.clone());
            }
        }

        Ok(linked_ids)
    }

    /// 查找与指定 Episode 跨日相关的 Episode ID（回溯 days 天）
    pub fn find_related(&self, episode_id: &str, days: u32) -> anyhow::Result<Vec<String>> {
        let episode = match EpisodeRepository::get_by_id(episode_id)? {
            Some(e) => e,
            None => return Ok(Vec::new()),
        };

        let today = chrono::NaiveDate::parse_from_str(&episode.date, "%Y-%m-%d")
            .map_err(|e| anyhow::anyhow!("日期解析失败 {}: {}", episode.date, e))?;
        let start_date = today - chrono::Duration::days(days as i64);
        let prev_date = today - chrono::Duration::days(1);
        let fmt = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();

        let candidates = EpisodeRepository::get_by_date_range(
            &fmt(start_date),
            &fmt(prev_date),
        )?;

        Ok(self.find_related_in_set(&episode, &candidates))
    }

    /// 在候选集中查找与指定 Episode 相似的 ID 列表
    fn find_related_in_set(&self, episode: &Episode, candidates: &[Episode]) -> Vec<String> {
        let target_tokens = tokenize_title(&episode.title);
        if target_tokens.is_empty() {
            return Vec::new();
        }

        let mut related: Vec<String> = Vec::new();
        for candidate in candidates {
            if candidate.id == episode.id {
                continue;
            }
            let cand_tokens = tokenize_title(&candidate.title);
            if cand_tokens.is_empty() {
                continue;
            }
            let sim = jaccard_similarity(&target_tokens, &cand_tokens);
            if sim > SIMILARITY_THRESHOLD {
                related.push(candidate.id.clone());
            }
        }
        related
    }
}

impl Default for CrossDayLinker {
    fn default() -> Self {
        Self::new()
    }
}

/// 标题分词：中文 bigram + 英文单词 + 数字 token
fn tokenize_title(title: &str) -> HashSet<String> {
    let mut tokens: HashSet<String> = HashSet::new();

    // 中文 bigram
    let chinese_re = regex::Regex::new(r"[\u{4e00}-\u{9fa5}]").unwrap();
    let chinese_chars: Vec<char> = chinese_re
        .find_iter(title)
        .filter_map(|m| m.as_str().chars().next())
        .collect();
    if !chinese_chars.is_empty() {
        if chinese_chars.len() == 1 {
            tokens.insert(chinese_chars.iter().collect());
        } else {
            for i in 0..chinese_chars.len() - 1 {
                tokens.insert(format!("{}{}", chinese_chars[i], chinese_chars[i + 1]));
            }
        }
    }

    // 英文单词（≥2 字符，小写）
    let english_re = regex::Regex::new(r"[a-zA-Z]+").unwrap();
    for m in english_re.find_iter(title) {
        let word = m.as_str();
        if word.len() >= 2 {
            tokens.insert(word.to_lowercase());
        }
    }

    // 数字 token
    let number_re = regex::Regex::new(r"\d+").unwrap();
    for m in number_re.find_iter(title) {
        tokens.insert(m.as_str().to_string());
    }

    tokens
}

/// 计算 Jaccard 相似度：|A ∩ B| / |A ∪ B|
fn jaccard_similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.union(b).count();
    if union == 0 {
        return 0.0;
    }
    intersection as f64 / union as f64
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_chinese_bigram() {
        let tokens = tokenize_title("和张三开会");
        // 应包含 bigram: 和张, 张三, 三开, 开会
        assert!(tokens.contains("张三"));
        assert!(tokens.contains("开会"));
    }

    #[test]
    fn test_tokenize_english_words() {
        let tokens = tokenize_title("Meeting with John about Project Alpha");
        assert!(tokens.contains("meeting"));
        assert!(tokens.contains("project"));
        assert!(tokens.contains("alpha"));
    }

    #[test]
    fn test_tokenize_numbers() {
        let tokens = tokenize_title("ORD-123 修复 BUG-456");
        assert!(tokens.contains("123"));
        assert!(tokens.contains("456"));
    }

    #[test]
    fn test_jaccard_similarity_identical() {
        let a = tokenize_title("和张三开会");
        let b = tokenize_title("和张三开会");
        let sim = jaccard_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_jaccard_similarity_disjoint() {
        let a = tokenize_title("张三开会");
        let b = tokenize_title("Project Alpha");
        let sim = jaccard_similarity(&a, &b);
        assert!(sim < 0.01);
    }

    #[test]
    fn test_jaccard_similarity_partial() {
        let a = tokenize_title("和张三开会讨论项目");
        let b = tokenize_title("和张三开会讨论需求");
        // 共享 token: 和张, 张三, 三开, 开会, 会讨, 讨论
        let sim = jaccard_similarity(&a, &b);
        assert!(sim > 0.5);
    }

    #[test]
    fn test_jaccard_similarity_empty() {
        let a: HashSet<String> = HashSet::new();
        let b: HashSet<String> = HashSet::new();
        let sim = jaccard_similarity(&a, &b);
        assert_eq!(sim, 0.0);
    }

    #[test]
    fn test_find_related_in_set_logic() {
        // 直接测试 find_related_in_set 内部逻辑（不依赖数据库）
        let linker = CrossDayLinker::new();
        let target = Episode {
            id: "ep-1".to_string(),
            date: "2026-06-22".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "和张三开会讨论项目进度".to_string(),
            one_line_summary: String::new(),
            segment_ids: vec![],
            entities: vec![],
            topics: vec![],
            user_edited: false,
            report_eligible: true,
            wiki_eligible: true,
            dominant_activity_type: None,
        };
        let candidates = vec![
            Episode {
                id: "ep-2".to_string(),
                date: "2026-06-21".to_string(),
                start_time: "10:00:00".to_string(),
                end_time: "11:00:00".to_string(),
                title: "和张三开会讨论项目进度".to_string(),
                one_line_summary: String::new(),
                segment_ids: vec![],
                entities: vec![],
                topics: vec![],
                user_edited: false,
                report_eligible: true,
                wiki_eligible: true,
                dominant_activity_type: None,
            },
            Episode {
                id: "ep-3".to_string(),
                date: "2026-06-20".to_string(),
                start_time: "10:00:00".to_string(),
                end_time: "11:00:00".to_string(),
                title: "Project Alpha Review".to_string(),
                one_line_summary: String::new(),
                segment_ids: vec![],
                entities: vec![],
                topics: vec![],
                user_edited: false,
                report_eligible: true,
                wiki_eligible: true,
                dominant_activity_type: None,
            },
        ];
        let related = linker.find_related_in_set(&target, &candidates);
        // ep-2 标题完全一致，Jaccard=1.0 > 0.8，应被关联
        assert!(related.contains(&"ep-2".to_string()));
        // ep-3 标题完全不同，不应被关联
        assert!(!related.contains(&"ep-3".to_string()));
    }
}
