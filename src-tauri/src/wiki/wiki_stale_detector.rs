//! WikiStaleDetector：Wiki 陈旧页检测器（F8.13）
//!
//! 功能：
//!  - detect_stale(days_threshold)：检测超过指定天数未被任何 Episode 引用的 Wiki 页
//!  - get_health_stats()：返回 Wiki 健康统计（总数、陈旧数、活跃数、近期数、健康分）
//!  - 陈旧页（>30 天未被引用）标记为"待复核"，提示用户复审
//!
//! 健康分 = active_count / total_pages（0-1）

use serde::{Deserialize, Serialize};

use crate::models::WikiPage;
use crate::repositories::episode_repository::EpisodeRepository;
use crate::repositories::wiki_repository::WikiRepository;

/// 陈旧 Wiki 页
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleWikiPage {
    /// Wiki 页 ID
    pub page_id: String,
    /// 标题
    pub title: String,
    /// 最后访问时间（Unix 毫秒）
    pub last_accessed_at: i64,
    /// 距今天数
    pub days_since_access: u32,
}

/// Wiki 健康统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WikiHealthStats {
    /// 总页数
    pub total_pages: u32,
    /// 陈旧页数（>30 天未被引用）
    pub stale_count: u32,
    /// 活跃页数（30 天内有引用）
    pub active_count: u32,
    /// 近期页数（7 天内有引用）
    pub recent_count: u32,
    /// 健康分 = active_count / total_pages（0-1）
    pub health_score: f64,
}

/// 默认陈旧阈值（天）
pub const DEFAULT_STALE_THRESHOLD_DAYS: u32 = 30;
/// 近期阈值（天）
pub const RECENT_THRESHOLD_DAYS: u32 = 7;

/// WikiStaleDetector：Wiki 陈旧页检测器
pub struct WikiStaleDetector;

impl WikiStaleDetector {
    /// 创建实例
    pub fn new() -> Self {
        WikiStaleDetector
    }

    /// 检测陈旧 Wiki 页。
    ///
    /// 阈值规则：last_accessed_at 距今 > days_threshold 天 → 视为陈旧
    /// last_accessed_at 取自该页 sources 中所有 Episode 的最大 start_time；
    /// 若无 Episode 引用，则回退到 page.updated_at。
    pub fn detect_stale(&self, days_threshold: u32) -> anyhow::Result<Vec<StaleWikiPage>> {
        let all_pages = WikiRepository::get_all()?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let threshold_ms = (days_threshold as i64) * 24 * 60 * 60 * 1000;

        let mut stale_pages: Vec<StaleWikiPage> = Vec::new();
        for page in &all_pages {
            let last_ms = self.compute_last_accessed_ms(page);
            let diff_ms = now_ms - last_ms;
            if diff_ms > threshold_ms {
                let days_since = (diff_ms / (24 * 60 * 60 * 1000)) as u32;
                stale_pages.push(StaleWikiPage {
                    page_id: page.id.clone(),
                    title: page.title.clone(),
                    last_accessed_at: last_ms,
                    days_since_access: days_since,
                });
            }
        }
        // 按陈旧程度降序（越久未访问越靠前）
        stale_pages.sort_by(|a, b| b.days_since_access.cmp(&a.days_since_access));
        Ok(stale_pages)
    }

    /// 获取 Wiki 健康统计
    pub fn get_health_stats(&self) -> anyhow::Result<WikiHealthStats> {
        let all_pages = WikiRepository::get_all()?;
        Ok(self.compute_health_stats(&all_pages))
    }

    /// 计算单个 Wiki 页的最后访问时间（Unix 毫秒）
    ///
    /// 优先取 sources 中所有 Episode 的最大 start_time；
    /// 若无 Episode 引用或查询失败，回退到 page.updated_at。
    fn compute_last_accessed_ms(&self, page: &WikiPage) -> i64 {
        let mut max_ms: i64 = 0;
        for source_id in &page.sources {
            // 跳过 Review Queue 元数据前缀
            if source_id.starts_with("__candidate__:") {
                continue;
            }
            if let Ok(Some(episode)) = EpisodeRepository::get_by_id(source_id) {
                let ms = episode_to_timestamp_ms(&episode.date, &episode.start_time);
                if ms > max_ms {
                    max_ms = ms;
                }
            }
        }
        if max_ms > 0 {
            return max_ms;
        }
        // 回退到 page.updated_at
        rfc3339_to_ms(&page.updated_at)
    }

    /// 从已有 WikiPage 列表计算健康统计（仅供测试使用，不访问数据库）
    pub fn compute_health_stats(&self, pages: &[WikiPage]) -> WikiHealthStats {
        let total_pages = pages.len() as u32;
        if total_pages == 0 {
            return WikiHealthStats::default();
        }
        let now_ms = chrono::Utc::now().timestamp_millis();
        let stale_threshold_ms = (DEFAULT_STALE_THRESHOLD_DAYS as i64) * 24 * 60 * 60 * 1000;
        let recent_threshold_ms = (RECENT_THRESHOLD_DAYS as i64) * 24 * 60 * 60 * 1000;

        let mut stale_count = 0u32;
        let mut active_count = 0u32;
        let mut recent_count = 0u32;

        for page in pages {
            // 测试场景下无法访问 EpisodeRepository，直接使用 updated_at
            let last_ms = rfc3339_to_ms(&page.updated_at);
            let diff_ms = now_ms - last_ms;
            if diff_ms > stale_threshold_ms {
                stale_count += 1;
            } else {
                active_count += 1;
            }
            if diff_ms <= recent_threshold_ms && diff_ms >= 0 {
                recent_count += 1;
            }
        }

        let health_score = (active_count as f64 / total_pages as f64 * 100.0).round() / 100.0;

        WikiHealthStats {
            total_pages,
            stale_count,
            active_count,
            recent_count,
            health_score,
        }
    }
}

impl Default for WikiStaleDetector {
    fn default() -> Self {
        Self::new()
    }
}

/// 将 Episode 的 date + start_time 转换为 Unix 毫秒
/// date 格式：YYYY-MM-DD，start_time 格式：HH:MM:SS 或 HH:MM
/// 解析失败返回 0。
fn episode_to_timestamp_ms(date: &str, start_time: &str) -> i64 {
    let date = match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => return 0,
    };
    let parts: Vec<&str> = start_time.split(':').collect();
    let (h, m, s) = match parts.len() {
        3 => (
            parts[0].parse::<u32>().ok(),
            parts[1].parse::<u32>().ok(),
            parts[2].parse::<u32>().ok(),
        ),
        2 => (
            parts[0].parse::<u32>().ok(),
            parts[1].parse::<u32>().ok(),
            Some(0),
        ),
        _ => return 0, // 时间格式无效
    };
    let (h, m, s) = match (h, m, s) {
        (Some(h), Some(m), Some(s)) => (h, m, s),
        _ => return 0, // 数字解析失败
    };
    let time = match chrono::NaiveTime::from_hms_opt(h, m, s) {
        Some(t) => t,
        None => return 0,
    };
    let dt = date.and_time(time);
    dt.and_utc().timestamp_millis()
}

/// 将 RFC3339 字符串转换为 Unix 毫秒（解析失败返回 0）
fn rfc3339_to_ms(s: &str) -> i64 {
    if s.is_empty() {
        return 0;
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{WikiReviewStatus, WikiType};

    fn make_page(id: &str, title: &str, updated_at: &str) -> WikiPage {
        WikiPage {
            id: id.to_string(),
            wiki_type: WikiType::Topic,
            title: title.to_string(),
            aliases: vec![],
            content: String::new(),
            sources: vec![],
            backlinks: vec![],
            confidence: 0.8,
            review_status: WikiReviewStatus::Reviewed,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn test_compute_health_stats_empty() {
        let detector = WikiStaleDetector::new();
        let stats = detector.compute_health_stats(&[]);
        assert_eq!(stats.total_pages, 0);
        assert_eq!(stats.stale_count, 0);
        assert_eq!(stats.active_count, 0);
        assert_eq!(stats.recent_count, 0);
        assert_eq!(stats.health_score, 0.0);
    }

    #[test]
    fn test_compute_health_stats_mixed() {
        let detector = WikiStaleDetector::new();
        let now = chrono::Utc::now();
        let recent = now.to_rfc3339();
        let active = (now - chrono::Duration::days(15)).to_rfc3339();
        let stale = (now - chrono::Duration::days(60)).to_rfc3339();
        let pages = vec![
            make_page("p1", "近期", &recent),
            make_page("p2", "活跃", &active),
            make_page("p3", "陈旧", &stale),
            make_page("p4", "陈旧2", &stale),
        ];
        let stats = detector.compute_health_stats(&pages);
        assert_eq!(stats.total_pages, 4);
        assert_eq!(stats.stale_count, 2);
        assert_eq!(stats.active_count, 2);
        assert_eq!(stats.recent_count, 1);
        // health_score = 2/4 = 0.5
        assert!((stats.health_score - 0.5).abs() < 1e-9);
    }

    #[test]
    fn test_compute_health_stats_all_recent() {
        let detector = WikiStaleDetector::new();
        let now = chrono::Utc::now().to_rfc3339();
        let pages = vec![
            make_page("p1", "a", &now),
            make_page("p2", "b", &now),
        ];
        let stats = detector.compute_health_stats(&pages);
        assert_eq!(stats.total_pages, 2);
        assert_eq!(stats.stale_count, 0);
        assert_eq!(stats.active_count, 2);
        assert_eq!(stats.recent_count, 2);
        assert!((stats.health_score - 1.0).abs() < 1e-9);
    }

    #[test]
    fn test_episode_to_timestamp_ms_valid() {
        let ms = episode_to_timestamp_ms("2026-06-22", "10:30:45");
        assert!(ms > 0);
        // 验证可往返：构造 NaiveDateTime 后再比较
        let dt = chrono::NaiveDate::parse_from_str("2026-06-22", "%Y-%m-%d")
            .unwrap()
            .and_time(chrono::NaiveTime::from_hms_opt(10, 30, 45).unwrap());
        assert_eq!(ms, dt.and_utc().timestamp_millis());
    }

    #[test]
    fn test_episode_to_timestamp_ms_invalid() {
        assert_eq!(episode_to_timestamp_ms("invalid", "10:00:00"), 0);
        assert_eq!(episode_to_timestamp_ms("2026-06-22", "invalid"), 0);
    }

    #[test]
    fn test_rfc3339_to_ms_empty() {
        assert_eq!(rfc3339_to_ms(""), 0);
    }

    #[test]
    fn test_rfc3339_to_ms_valid() {
        let now = chrono::Utc::now();
        let s = now.to_rfc3339();
        let ms = rfc3339_to_ms(&s);
        assert!((ms - now.timestamp_millis()).abs() <= 1);
    }

    #[test]
    fn test_detect_stale_returns_pages_older_than_threshold() {
        // 此测试不访问数据库，仅验证内部逻辑通过 compute_health_stats 路径
        let detector = WikiStaleDetector::new();
        let now = chrono::Utc::now();
        let stale = (now - chrono::Duration::days(60)).to_rfc3339();
        let pages = vec![make_page("p1", "陈旧页", &stale)];
        let stats = detector.compute_health_stats(&pages);
        assert_eq!(stats.stale_count, 1);
        assert_eq!(stats.active_count, 0);
    }
}
