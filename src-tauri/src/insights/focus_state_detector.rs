//! FocusStateDetector：实时专注状态检测器（F8.15）
//!
//! 功能：
//!  - on_focus_streak(streak)：根据当前聚焦段判断是否触发长时聚焦提醒
//!    - 持续聚焦 > 25 分钟 → "休息一下（番茄钟）"
//!  - on_window_switch(count_5min)：根据 5 分钟内窗口切换次数判断注意力分散
//!    - 5 分钟内切换 > 10 次 → "检测到注意力分散"
//!  - BreakReminder 类型供其他调度器触发

use serde::{Deserialize, Serialize};

use crate::capture::focus_streak_tracker::FocusStreak;

/// 专注告警类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FocusAlertType {
    /// 长时聚焦（25 分钟+）
    LongFocus,
    /// 注意力分散（5 分钟内 10+ 次切换）
    FragmentedAttention,
    /// 休息提醒
    BreakReminder,
}

/// 专注告警
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusAlert {
    pub alert_type: FocusAlertType,
    pub message: String,
    /// Unix 毫秒
    pub timestamp: i64,
}

/// 长时聚焦阈值（毫秒，25 分钟）
const LONG_FOCUS_THRESHOLD_MS: u64 = 25 * 60 * 1000;
/// 注意力分散阈值（5 分钟内切换次数）
const FRAGMENTED_SWITCH_THRESHOLD: u32 = 10;

/// FocusStateDetector：实时专注状态检测器
pub struct FocusStateDetector {
    /// 上次长时聚焦告警时间（避免重复告警）
    last_long_focus_alert_at: i64,
    /// 上次注意力分散告警时间
    last_fragmented_alert_at: i64,
}

impl FocusStateDetector {
    /// 创建实例
    pub fn new() -> Self {
        FocusStateDetector {
            last_long_focus_alert_at: 0,
            last_fragmented_alert_at: 0,
        }
    }

    /// 处理聚焦段更新：
    ///  - 若当前聚焦段持续 > 25 分钟且未在冷却期，触发 LongFocus 告警
    ///  - 冷却期：自上次告警后 25 分钟内不重复告警
    pub fn on_focus_streak(&mut self, streak: &FocusStreak) -> Option<FocusAlert> {
        // 严格大于 25 分钟才触发（>= 阈值不触发）
        if streak.duration_ms <= LONG_FOCUS_THRESHOLD_MS {
            return None;
        }
        let now = chrono::Utc::now().timestamp_millis();
        // 冷却期：上次告警后 25 分钟内不重复
        if now - self.last_long_focus_alert_at < (LONG_FOCUS_THRESHOLD_MS as i64) {
            return None;
        }
        self.last_long_focus_alert_at = now;
        Some(FocusAlert {
            alert_type: FocusAlertType::LongFocus,
            message: "休息一下（番茄钟）".to_string(),
            timestamp: now,
        })
    }

    /// 处理窗口切换次数更新：
    ///  - 5 分钟内切换 > 10 次且未在冷却期，触发 FragmentedAttention 告警
    ///  - 冷却期：5 分钟
    pub fn on_window_switch(&mut self, count_5min: u32) -> Option<FocusAlert> {
        if count_5min < FRAGMENTED_SWITCH_THRESHOLD {
            return None;
        }
        let now = chrono::Utc::now().timestamp_millis();
        // 冷却期 5 分钟
        if now - self.last_fragmented_alert_at < (5 * 60 * 1000) {
            return None;
        }
        self.last_fragmented_alert_at = now;
        Some(FocusAlert {
            alert_type: FocusAlertType::FragmentedAttention,
            message: "检测到注意力分散".to_string(),
            timestamp: now,
        })
    }

    /// 生成休息提醒（供外部调度器调用）
    pub fn break_reminder(&self) -> FocusAlert {
        FocusAlert {
            alert_type: FocusAlertType::BreakReminder,
            message: "该起来活动一下了".to_string(),
            timestamp: chrono::Utc::now().timestamp_millis(),
        }
    }
}

impl Default for FocusStateDetector {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_streak(duration_ms: u64) -> FocusStreak {
        FocusStreak {
            window_title: "main.rs".to_string(),
            app_name: "code".to_string(),
            start_time: chrono::Utc::now().timestamp_millis() - duration_ms as i64,
            duration_ms,
            is_active: true,
        }
    }

    #[test]
    fn test_short_focus_no_alert() {
        let mut detector = FocusStateDetector::new();
        // 10 分钟聚焦，不触发告警
        let streak = make_streak(10 * 60 * 1000);
        let alert = detector.on_focus_streak(&streak);
        assert!(alert.is_none());
    }

    #[test]
    fn test_long_focus_triggers_alert() {
        let mut detector = FocusStateDetector::new();
        // 30 分钟聚焦，触发告警
        let streak = make_streak(30 * 60 * 1000);
        let alert = detector.on_focus_streak(&streak);
        assert!(alert.is_some());
        let a = alert.unwrap();
        assert_eq!(a.alert_type, FocusAlertType::LongFocus);
        assert!(a.message.contains("番茄钟"));
    }

    #[test]
    fn test_long_focus_cooldown() {
        let mut detector = FocusStateDetector::new();
        let streak = make_streak(30 * 60 * 1000);
        // 第一次触发
        let a1 = detector.on_focus_streak(&streak);
        assert!(a1.is_some());
        // 立即再次调用，应被冷却期抑制
        let a2 = detector.on_focus_streak(&streak);
        assert!(a2.is_none());
    }

    #[test]
    fn test_low_switch_count_no_alert() {
        let mut detector = FocusStateDetector::new();
        let alert = detector.on_window_switch(5);
        assert!(alert.is_none());
    }

    #[test]
    fn test_high_switch_count_triggers_alert() {
        let mut detector = FocusStateDetector::new();
        let alert = detector.on_window_switch(15);
        assert!(alert.is_some());
        let a = alert.unwrap();
        assert_eq!(a.alert_type, FocusAlertType::FragmentedAttention);
        assert!(a.message.contains("注意力分散"));
    }

    #[test]
    fn test_high_switch_count_cooldown() {
        let mut detector = FocusStateDetector::new();
        // 第一次触发
        let a1 = detector.on_window_switch(15);
        assert!(a1.is_some());
        // 立即再次调用，应被冷却期抑制
        let a2 = detector.on_window_switch(15);
        assert!(a2.is_none());
    }

    #[test]
    fn test_break_reminder() {
        let detector = FocusStateDetector::new();
        let reminder = detector.break_reminder();
        assert_eq!(reminder.alert_type, FocusAlertType::BreakReminder);
        assert!(!reminder.message.is_empty());
    }

    #[test]
    fn test_threshold_boundary() {
        let mut detector = FocusStateDetector::new();
        // 恰好 25 分钟，不触发（> 25 分钟才触发）
        let streak = make_streak(25 * 60 * 1000);
        let alert = detector.on_focus_streak(&streak);
        assert!(alert.is_none());
        // 25 分钟 + 1 毫秒，触发
        let streak2 = make_streak(25 * 60 * 1000 + 1);
        let alert2 = detector.on_focus_streak(&streak2);
        assert!(alert2.is_some());
    }
}
