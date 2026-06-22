//! FocusStreakTracker：窗口切换成本追踪器（F8.1）
//!
//! 功能：
//!  - 追踪连续聚焦时段（同一窗口标题未中断的持续时间）
//!  - 统计每日窗口切换次数、聚焦总时长、最长聚焦段、平均聚焦段、碎片化评分
//!  - 将聚焦段以 JSON 形式存入 Segment.metadata.focusStreak
//!
//! 碎片化评分 fragmentation_score = switches / hours_worked（每小时切换次数）
//!
//! 设计说明：
//!  - on_window_change 接收 WindowInfo，与上次窗口比较，若 hwnd/进程/标题变化则视为切换
//!  - 当前聚焦段在切换时被结算并归档；新段从当前时间开始
//!  - get_day_stats 聚合当日全部已归档段 + 当前活跃段

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::capture::window_watcher::WindowInfo;

/// 单个聚焦段：同一窗口未中断的持续时间
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusStreak {
    /// 窗口标题
    pub window_title: String,
    /// 应用名
    pub app_name: String,
    /// 起始时间（Unix 毫秒）
    pub start_time: i64,
    /// 持续时长（毫秒）
    pub duration_ms: u64,
    /// 是否仍在进行中
    pub is_active: bool,
}

/// 单日聚焦统计
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FocusStreakStats {
    /// 总切换次数
    pub total_switches: u32,
    /// 总聚焦时长（毫秒）
    pub total_focus_ms: u64,
    /// 最长聚焦段（毫秒）
    pub max_streak_ms: u64,
    /// 平均聚焦段时长（毫秒）
    pub avg_streak_ms: u64,
    /// 碎片化评分（每小时切换次数）
    pub fragmentation_score: f64,
}

/// FocusStreakTracker：窗口切换成本追踪器
pub struct FocusStreakTracker {
    /// 当前聚焦段（进行中）
    current_streak: Option<FocusStreak>,
    /// 按日期归档的聚焦段列表
    archived: HashMap<String, Vec<FocusStreak>>,
    /// 按日期统计的切换次数
    switches_by_day: HashMap<String, u32>,
}

impl FocusStreakTracker {
    /// 创建实例
    pub fn new() -> Self {
        FocusStreakTracker {
            current_streak: None,
            archived: HashMap::new(),
            switches_by_day: HashMap::new(),
        }
    }

    /// 处理窗口变化事件：
    ///  - 若与当前聚焦段同窗口（hwnd+进程+标题一致），保持当前段
    ///  - 否则结算当前段并归档，开启新段；同时累计当日切换次数
    pub fn on_window_change(&mut self, window_info: &WindowInfo) {
        let now = chrono::Utc::now().timestamp_millis();
        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();

        // 判断是否为同窗口（hwnd 与进程名一致）
        let same_window = match &self.current_streak {
            None => false,
            Some(streak) => {
                // 这里只能依据 window_title + app_name 比较（WindowInfo 携带 hwnd 但 FocusStreak 不存）
                streak.window_title == window_info.window_title
                    && streak.app_name == window_info.app_name
            }
        };

        if same_window {
            // 同窗口，不视为切换，保持当前段
            return;
        }

        // 结算当前段
        if let Some(mut streak) = self.current_streak.take() {
            streak.duration_ms = (now - streak.start_time).max(0) as u64;
            streak.is_active = false;
            self.archived.entry(date.clone()).or_default().push(streak);
        }

        // 累计切换次数（首次进入不算切换）
        if self.current_streak.is_none() && !self.archived.contains_key(&date) && self.switches_by_day.get(&date).copied().unwrap_or(0) == 0 {
            // 首次进入该日，不计切换
        } else {
            *self.switches_by_day.entry(date.clone()).or_insert(0) += 1;
        }

        // 开启新段
        self.current_streak = Some(FocusStreak {
            window_title: window_info.window_title.clone(),
            app_name: window_info.app_name.clone(),
            start_time: now,
            duration_ms: 0,
            is_active: true,
        });
    }

    /// 获取当前进行中的聚焦段
    pub fn get_current_streak(&self) -> Option<FocusStreak> {
        let mut streak = self.current_streak.clone()?;
        let now = chrono::Utc::now().timestamp_millis();
        streak.duration_ms = (now - streak.start_time).max(0) as u64;
        Some(streak)
    }

    /// 获取指定日期的聚焦统计
    pub fn get_day_stats(&self, date: &str) -> FocusStreakStats {
        let mut streaks: Vec<FocusStreak> = self
            .archived
            .get(date)
            .cloned()
            .unwrap_or_default();

        // 若当日存在进行中段，一并计入
        if let Some(current) = self.get_current_streak() {
            let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
            if today == date {
                streaks.push(current);
            }
        }

        if streaks.is_empty() {
            return FocusStreakStats::default();
        }

        let total_switches = self.switches_by_day.get(date).copied().unwrap_or(0);
        let total_focus_ms: u64 = streaks.iter().map(|s| s.duration_ms).sum();
        let max_streak_ms = streaks.iter().map(|s| s.duration_ms).max().unwrap_or(0);
        let avg_streak_ms = if streaks.is_empty() {
            0
        } else {
            total_focus_ms / streaks.len() as u64
        };

        // 碎片化评分：每小时切换次数 = switches / hours_worked
        // hours_worked = total_focus_ms / 3600_000
        let hours_worked = total_focus_ms as f64 / 3_600_000.0;
        let fragmentation_score = if hours_worked > 0.0 {
            total_switches as f64 / hours_worked
        } else {
            0.0
        };

        // 保留两位小数
        let fragmentation_score = (fragmentation_score * 100.0).round() / 100.0;

        FocusStreakStats {
            total_switches,
            total_focus_ms,
            max_streak_ms,
            avg_streak_ms,
            fragmentation_score,
        }
    }

    /// 将指定聚焦段序列化为 JSON 字符串，供存入 Segment.metadata.focusStreak
    pub fn streak_to_metadata_json(streak: &FocusStreak) -> String {
        serde_json::to_string(streak).unwrap_or_else(|_| "{}".to_string())
    }
}

impl Default for FocusStreakTracker {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_window(title: &str, app: &str) -> WindowInfo {
        WindowInfo {
            hwnd: 100,
            process_name: format!("{}.exe", app),
            process_path: String::new(),
            window_title: title.to_string(),
            app_name: app.to_string(),
        }
    }

    #[test]
    fn test_new_tracker_has_no_current_streak() {
        let tracker = FocusStreakTracker::new();
        assert!(tracker.get_current_streak().is_none());
    }

    #[test]
    fn test_on_window_change_creates_current_streak() {
        let mut tracker = FocusStreakTracker::new();
        let win = make_window("main.rs", "code");
        tracker.on_window_change(&win);
        let current = tracker.get_current_streak();
        assert!(current.is_some());
        let s = current.unwrap();
        assert_eq!(s.window_title, "main.rs");
        assert_eq!(s.app_name, "code");
        assert!(s.is_active);
    }

    #[test]
    fn test_same_window_does_not_switch() {
        let mut tracker = FocusStreakTracker::new();
        let win = make_window("main.rs", "code");
        tracker.on_window_change(&win);
        // 再次发送同窗口，不应切换
        tracker.on_window_change(&win);
        let current = tracker.get_current_streak().unwrap();
        assert_eq!(current.window_title, "main.rs");
        // 切换次数应为 0（首次进入不计切换）
        let stats = tracker.get_day_stats(&chrono::Utc::now().format("%Y-%m-%d").to_string());
        assert_eq!(stats.total_switches, 0);
    }

    #[test]
    fn test_different_window_increments_switches() {
        let mut tracker = FocusStreakTracker::new();
        tracker.on_window_change(&make_window("main.rs", "code"));
        tracker.on_window_change(&make_window("Google", "chrome"));
        tracker.on_window_change(&make_window("Slack", "slack"));
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let stats = tracker.get_day_stats(&today);
        // 首次进入不计切换，后续 2 次切换
        assert_eq!(stats.total_switches, 2);
    }

    #[test]
    fn test_day_stats_empty_returns_default() {
        let tracker = FocusStreakTracker::new();
        let stats = tracker.get_day_stats("2020-01-01");
        assert_eq!(stats.total_switches, 0);
        assert_eq!(stats.total_focus_ms, 0);
        assert_eq!(stats.max_streak_ms, 0);
        assert_eq!(stats.avg_streak_ms, 0);
        assert_eq!(stats.fragmentation_score, 0.0);
    }

    #[test]
    fn test_streak_to_metadata_json_serializes() {
        let streak = FocusStreak {
            window_title: "main.rs".to_string(),
            app_name: "code".to_string(),
            start_time: 1_700_000_000_000,
            duration_ms: 60_000,
            is_active: false,
        };
        let json = FocusStreakTracker::streak_to_metadata_json(&streak);
        assert!(json.contains("main.rs"));
        assert!(json.contains("windowTitle"));
        assert!(json.contains("durationMs"));
    }

    #[test]
    fn test_fragmentation_score_calculation() {
        let mut tracker = FocusStreakTracker::new();
        // 模拟多次切换
        for i in 0..5 {
            let win = make_window(&format!("title-{}", i), "app");
            tracker.on_window_change(&win);
        }
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let stats = tracker.get_day_stats(&today);
        // 5 次进入，首次不计切换，故 4 次切换
        assert_eq!(stats.total_switches, 4);
        // 碎片化评分应非负
        assert!(stats.fragmentation_score >= 0.0);
    }
}
