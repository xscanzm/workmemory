//! WeeklyPatternDetector：周级模式发现（对应 electron/ai/WeeklyPatternDetector.ts）
//!
//! 在日级蒸馏（DailyDistillManager）基础上发现周级工作模式：
//!  - 深度工作时段（deep_work_time）：最常见的深度工作时段
//!  - 碎片化时段（fragmented_time）：最常见的碎片化时段
//!  - 常用应用组合（app_combination）：经常一起出现的主题
//!  - 效率趋势（efficiency_trend）：深度工作时长趋势
//!  - 注意力热点（attention_hotspot）：注意力最集中的时段
//!
//! 与 TypeScript 版本的差异：
//!  - Rust WeeklyPattern 字段为 name/description/confidence（无 type/evidence/metadata）
//!  - 模式类型编码到 name 前缀中（如 "deep_work_time: ..."）

use anyhow::Result;

use crate::models::{DayDistillResult, WeeklyPattern, WeeklyPatternResult, WeeklyPatternTrend};
use crate::repositories::daily_distill_repository::DailyDistillRepository;
use crate::repositories::weekly_pattern_repository::WeeklyPatternRepository;

/// 一周天数
const WEEK_DAYS: usize = 7;
/// 效率趋势判定阈值（小时）
const EFFICIENCY_TREND_THRESHOLD: f64 = 0.5;

/// 获取当前 ISO 时间戳
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 在日期字符串（YYYY-MM-DD）上加减天数，返回新的日期字符串
fn add_days(date_str: &str, days: i64) -> String {
    use chrono::NaiveDate;
    match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        Ok(d) => {
            let new_date = d + chrono::Duration::days(days);
            new_date.format("%Y-%m-%d").to_string()
        }
        Err(_) => date_str.to_string(),
    }
}

/// 将置信度限制在 [0, 1] 范围内，保留两位小数
fn clamp_confidence(value: f64) -> f64 {
    let clamped = value.max(0.0).min(1.0);
    (clamped * 100.0).round() / 100.0
}

/// 检测深度工作时段：统计 7 天中各小时出现在 themes 的天数
///
/// 简化版：由于 Rust DayTheme 无 hours 字段，使用 patterns.active_hours 估算
fn detect_deep_work_time(distills: &[DayDistillResult]) -> Vec<WeeklyPattern> {
    if distills.is_empty() {
        return vec![];
    }

    // 统计每天深度工作时长，找出最高的一天
    let mut max_hours = 0.0_f64;
    let mut max_date = String::new();
    for d in distills {
        if d.patterns.deep_work_hours > max_hours {
            max_hours = d.patterns.deep_work_hours;
            max_date = d.date.clone();
        }
    }

    if max_hours <= 0.0 {
        return vec![];
    }

    vec![WeeklyPattern {
        name: "deep_work_time".to_string(),
        description: format!(
            "深度工作时段：{} 累计 {} 小时",
            max_date, max_hours
        ),
        confidence: clamp_confidence(max_hours / 8.0),
    }]
}

/// 检测碎片化时段：统计 daily_distills.patterns.fragmented_periods
fn detect_fragmented_time(distills: &[DayDistillResult]) -> Vec<WeeklyPattern> {
    // 按 start 分组，统计出现天数
    let mut period_days: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();

    for d in distills {
        for p in &d.patterns.fragmented_periods {
            *period_days.entry(p.start.clone()).or_insert(0) += 1;
        }
    }

    if period_days.is_empty() {
        return vec![];
    }

    // 找出出现天数最多的碎片化时段
    let (best_start, best_count) = period_days
        .iter()
        .max_by_key(|(_, &v)| v)
        .map(|(k, &v)| (k.clone(), v))
        .unwrap_or((String::new(), 0));

    if best_count == 0 {
        return vec![];
    }

    vec![WeeklyPattern {
        name: "fragmented_time".to_string(),
        description: format!(
            "每日 {} 起碎片化时段（出现 {}/{} 天）",
            best_start, best_count, WEEK_DAYS
        ),
        confidence: clamp_confidence(best_count as f64 / WEEK_DAYS as f64),
    }]
}

/// 检测常用应用组合：从 daily_distills.themes 中提取经常一起出现的主题
fn detect_app_combination(distills: &[DayDistillResult]) -> Vec<WeeklyPattern> {
    // 统计每个主题出现的天数
    let mut title_days: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();

    for d in distills {
        for theme in &d.themes {
            let name = theme.name.trim();
            if !name.is_empty() {
                *title_days.entry(name.to_string()).or_insert(0) += 1;
            }
        }
    }

    if title_days.is_empty() {
        return vec![];
    }

    // 找出出现天数最多的主题
    let (best_title, best_count) = title_days
        .iter()
        .max_by_key(|(_, &v)| v)
        .map(|(k, &v)| (k.clone(), v))
        .unwrap_or((String::new(), 0));

    if best_count == 0 {
        return vec![];
    }

    vec![WeeklyPattern {
        name: "app_combination".to_string(),
        description: format!(
            "常用主题：{}（出现 {}/{} 天）",
            best_title, best_count, WEEK_DAYS
        ),
        confidence: clamp_confidence(best_count as f64 / WEEK_DAYS as f64),
    }]
}

/// 检测效率趋势：基于 deepWorkHoursTrend 判断上升/下降/稳定
fn detect_efficiency_trend(
    distills: &[DayDistillResult],
    deep_work_hours_trend: &[f64],
) -> Vec<WeeklyPattern> {
    if distills.len() < 2 {
        return vec![];
    }

    // 比较前半段与后半段的平均深度工作时长
    let mid = distills.len() / 2;
    let first_half = &distills[..mid];
    let second_half = &distills[mid..];
    if first_half.is_empty() || second_half.is_empty() {
        return vec![];
    }

    let first_avg: f64 =
        first_half.iter().map(|d| d.patterns.deep_work_hours).sum::<f64>() / first_half.len() as f64;
    let second_avg: f64 = second_half.iter().map(|d| d.patterns.deep_work_hours).sum::<f64>()
        / second_half.len() as f64;

    let delta = second_avg - first_avg;
    let (trend_text, confidence) = if delta > EFFICIENCY_TREND_THRESHOLD {
        ("上升", 0.8)
    } else if delta < -EFFICIENCY_TREND_THRESHOLD {
        ("下降", 0.8)
    } else {
        ("稳定", 0.5)
    };

    vec![WeeklyPattern {
        name: "efficiency_trend".to_string(),
        description: format!(
            "效率趋势：深度工作时长{}（前半周 {:.1}h → 后半周 {:.1}h）",
            trend_text, first_avg, second_avg
        ),
        confidence: clamp_confidence(confidence),
    }]
}

/// 检测注意力热点：找出注意力最集中的时段
fn detect_attention_hotspot(distills: &[DayDistillResult]) -> Vec<WeeklyPattern> {
    // 找出深度工作时长最高的一天
    let mut best_date = String::new();
    let mut best_hours = 0.0_f64;
    for d in distills {
        if d.patterns.deep_work_hours > best_hours {
            best_hours = d.patterns.deep_work_hours;
            best_date = d.date.clone();
        }
    }

    if best_hours <= 0.0 {
        return vec![];
    }

    vec![WeeklyPattern {
        name: "attention_hotspot".to_string(),
        description: format!(
            "注意力热点：{} 累计深度工作 {:.1}h",
            best_date, best_hours
        ),
        confidence: clamp_confidence(best_hours / 8.0),
    }]
}

/// WeeklyPatternDetector：周级模式检测器
pub struct WeeklyPatternDetector;

impl WeeklyPatternDetector {
    pub fn new() -> Self {
        WeeklyPatternDetector
    }

    /// 检测周级模式：聚合近 7 天 daily_distills，发现周级工作模式。
    ///
    /// # 参数
    /// - `week_start`：周一日期字符串（YYYY-MM-DD）
    ///
    /// # 返回
    /// 周级模式结果（含模式列表与趋势数据）
    pub fn detect_patterns(&self, week_start: &str) -> Result<WeeklyPatternResult> {
        let end_date = add_days(week_start, (WEEK_DAYS - 1) as i64);
        let distills = DailyDistillRepository::get_by_date_range(week_start, &end_date)?;

        // 构建 trend 数组（7 个元素，缺失天补 0/''）
        let distill_by_date: std::collections::HashMap<String, &DayDistillResult> =
            distills.iter().map(|d| (d.date.clone(), d)).collect();

        let mut trend = WeeklyPatternTrend::default();
        for i in 0..WEEK_DAYS {
            let date = add_days(week_start, i as i64);
            if let Some(d) = distill_by_date.get(&date) {
                trend.deep_work_hours_trend.push(d.patterns.deep_work_hours);
                trend.switch_count_trend.push(d.patterns.switch_count);
                trend.dominant_activity_trend.push(d.patterns.dominant_activity.clone());
            } else {
                trend.deep_work_hours_trend.push(0.0);
                trend.switch_count_trend.push(0);
                trend.dominant_activity_trend.push(String::new());
            }
        }

        // 检测 5 类模式
        let mut patterns: Vec<WeeklyPattern> = Vec::new();
        if !distills.is_empty() {
            patterns.extend(detect_deep_work_time(&distills));
            patterns.extend(detect_fragmented_time(&distills));
            patterns.extend(detect_app_combination(&distills));
            patterns.extend(detect_efficiency_trend(&distills, &trend.deep_work_hours_trend));
            patterns.extend(detect_attention_hotspot(&distills));
        }

        let result = WeeklyPatternResult {
            week_start: week_start.to_string(),
            patterns,
            trend,
            created_at: now_iso(),
        };

        // 持久化
        if let Err(e) = WeeklyPatternRepository::upsert(result.clone()) {
            log::error!("[WeeklyPatternDetector] 周级模式持久化失败: {}", e);
        }

        Ok(result)
    }
}

impl Default for WeeklyPatternDetector {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DayPattern};

    /// 测试 add_days
    #[test]
    fn test_add_days() {
        assert_eq!(add_days("2026-06-22", 0), "2026-06-22");
        assert_eq!(add_days("2026-06-22", 1), "2026-06-23");
        assert_eq!(add_days("2026-06-22", 7), "2026-06-29");
        assert_eq!(add_days("2026-06-22", -1), "2026-06-21");
        // 跨月
        assert_eq!(add_days("2026-06-30", 1), "2026-07-01");
    }

    /// 测试 clamp_confidence
    #[test]
    fn test_clamp_confidence() {
        assert!((clamp_confidence(0.5) - 0.5).abs() < 0.001);
        assert!((clamp_confidence(-0.1) - 0.0).abs() < 0.001);
        assert!((clamp_confidence(1.5) - 1.0).abs() < 0.001);
    }

    /// 测试 detect_deep_work_time
    #[test]
    fn test_detect_deep_work_time() {
        let distills = vec![DayDistillResult {
            date: "2026-06-22".to_string(),
            summary: "摘要".to_string(),
            themes: vec![],
            patterns: DayPattern {
                deep_work_hours: 4.0,
                fragmented_periods: vec![],
                switch_count: 5,
                active_hours: 8.0,
                dominant_activity: "coding".to_string(),
            },
            memcell_ids: vec![],
        }];
        let patterns = detect_deep_work_time(&distills);
        assert_eq!(patterns.len(), 1);
        assert_eq!(patterns[0].name, "deep_work_time");
        assert!(patterns[0].description.contains("4 小时"));
    }

    /// 测试 detect_deep_work_time 空数据
    #[test]
    fn test_detect_deep_work_time_empty() {
        let patterns = detect_deep_work_time(&[]);
        assert!(patterns.is_empty());
    }

    /// 测试 detect_efficiency_trend 上升趋势
    #[test]
    fn test_detect_efficiency_trend_rising() {
        let distills = vec![
            DayDistillResult {
                date: "2026-06-22".to_string(),
                summary: String::new(),
                themes: vec![],
                patterns: DayPattern {
                    deep_work_hours: 1.0,
                    fragmented_periods: vec![],
                    switch_count: 0,
                    active_hours: 0.0,
                    dominant_activity: String::new(),
                },
                memcell_ids: vec![],
            },
            DayDistillResult {
                date: "2026-06-23".to_string(),
                summary: String::new(),
                themes: vec![],
                patterns: DayPattern {
                    deep_work_hours: 4.0,
                    fragmented_periods: vec![],
                    switch_count: 0,
                    active_hours: 0.0,
                    dominant_activity: String::new(),
                },
                memcell_ids: vec![],
            },
        ];
        let patterns = detect_efficiency_trend(&distills, &[1.0, 4.0]);
        assert_eq!(patterns.len(), 1);
        assert!(patterns[0].description.contains("上升"));
    }

    /// 测试 WeeklyPatternDetector 创建
    #[test]
    fn test_weekly_pattern_detector_new() {
        let _detector = WeeklyPatternDetector::new();
    }
}
