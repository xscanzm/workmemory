//! FrequencyLimiter：桌面伙伴气泡频率限制器（对应 electron/mascot/FrequencyLimiter.ts）
//!
//! 实现 spec 的硬约束：
//!  - 每天最多弹出 2 次主动气泡
//!  - 10 分钟内连续 3 次关闭则当天停止所有主动气泡
//!  - 跨天自动重置
//!
//! 状态存内存，重启后当天计数重置（合理行为：重启视为新的一天开始）。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::repositories::settings_store::SettingsStore;
use crate::models::MascotStyle;

/// 每天主动气泡最大次数
const DAILY_MAX_BUBBLES: u32 = 2;

/// 关闭冷却窗口（毫秒）：10 分钟
const DISMISS_WINDOW_MS: u64 = 10 * 60 * 1000;

/// 冷却窗口内最大关闭次数：3 次则当天停止
const DISMISS_THRESHOLD: usize = 3;

/// 频率限制统计
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyStats {
    /// 当天已展示次数
    pub today_shown: u32,
    /// 当前 10 分钟窗口内关闭次数
    pub today_closed_in_window: usize,
    /// 当天是否已被停止
    pub blocked_today: bool,
    /// 当天日期标记
    pub date: String,
}

/// FrequencyLimiter：气泡频率限制器。
///
/// 使用方法：
///  1. try_show_bubble()：检查是否允许展示，允许则调用 on_bubble_shown()
///  2. on_bubble_closed()：用户关闭气泡时调用
///  3. get_stats()：获取当前统计
///  4. reset_daily_limit()：手动重置（跨日自动检测）
pub struct FrequencyLimiter {
    /// 当天已展示次数
    daily_count: Mutex<u32>,
    /// 当天日期标记（YYYY-MM-DD），用于跨日重置
    daily_date: Mutex<String>,
    /// 最近的关闭时间戳列表（用于 10 分钟窗口判断）
    recent_dismissals: Mutex<Vec<u64>>,
    /// 当天是否已被关闭冷却停止
    daily_stopped: Mutex<bool>,
}

impl FrequencyLimiter {
    /// 创建 FrequencyLimiter 实例
    pub fn new() -> Self {
        Self {
            daily_count: Mutex::new(0),
            daily_date: Mutex::new(today_string()),
            recent_dismissals: Mutex::new(Vec::new()),
            daily_stopped: Mutex::new(false),
        }
    }

    /// 检查是否允许展示气泡。
    /// 不递增计数——调用方在确认展示后应调用 on_bubble_shown()。
    ///
    /// 返回 true 表示允许展示；false 表示被频率限制拦截
    pub fn try_show_bubble(&self) -> bool {
        self.check_daily_reset();

        let stopped = *self.daily_stopped.lock().unwrap();
        if stopped {
            return false;
        }

        let count = *self.daily_count.lock().unwrap();
        if count >= DAILY_MAX_BUBBLES {
            return false;
        }

        true
    }

    /// 气泡已展示时调用，递增当天计数
    pub fn on_bubble_shown(&self) {
        self.check_daily_reset();
        let mut count = self.daily_count.lock().unwrap();
        *count += 1;
    }

    /// 用户关闭气泡时调用，记录关闭时间戳。
    /// 若 10 分钟内关闭次数 ≥3，则当天停止主动气泡
    pub fn on_bubble_closed(&self) {
        self.check_daily_reset();
        let now = now_ms();
        let mut dismissals = self.recent_dismissals.lock().unwrap();
        dismissals.push(now);
        // 清理过期记录（超过 10 分钟）
        dismissals.retain(|&ts| now.saturating_sub(ts) < DISMISS_WINDOW_MS);
        if dismissals.len() >= DISMISS_THRESHOLD {
            let mut stopped = self.daily_stopped.lock().unwrap();
            *stopped = true;
            drop(stopped);
            log::info!(
                "[FrequencyLimiter] 10 分钟内关闭 {} 次，当天停止主动气泡",
                dismissals.len()
            );
        }
    }

    /// 重置当天频率限制（跨日时自动调用，也可手动调用）
    pub fn reset_daily_limit(&self) {
        let mut count = self.daily_count.lock().unwrap();
        *count = 0;
        drop(count);
        let mut dismissals = self.recent_dismissals.lock().unwrap();
        dismissals.clear();
        drop(dismissals);
        let mut stopped = self.daily_stopped.lock().unwrap();
        *stopped = false;
        drop(stopped);
        let mut date = self.daily_date.lock().unwrap();
        *date = today_string();
    }

    /// 获取当前频率限制统计
    pub fn get_stats(&self) -> FrequencyStats {
        self.check_daily_reset();
        let now = now_ms();
        let dismissals = self.recent_dismissals.lock().unwrap();
        let valid_count = dismissals
            .iter()
            .filter(|&&ts| now.saturating_sub(ts) < DISMISS_WINDOW_MS)
            .count();
        FrequencyStats {
            today_shown: *self.daily_count.lock().unwrap(),
            today_closed_in_window: valid_count,
            blocked_today: *self.daily_stopped.lock().unwrap(),
            date: self.daily_date.lock().unwrap().clone(),
        }
    }

    /// 当天是否已被停止
    pub fn is_blocked_today(&self) -> bool {
        self.check_daily_reset();
        *self.daily_stopped.lock().unwrap()
    }

    /// 获取当前 Mascot 样式（从 SettingsStore 读取）
    pub fn get_mascot_style(&self) -> MascotStyle {
        SettingsStore::get_mascot_style()
    }

    /// 跨日重置检测
    fn check_daily_reset(&self) {
        let today = today_string();
        let mut date = self.daily_date.lock().unwrap();
        if *date != today {
            *date = today;
            drop(date);
            self.reset_daily_limit();
        }
    }
}

impl Default for FrequencyLimiter {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 工具函数 =====================

/// 获取当前时间戳（毫秒）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 今日日期字符串 YYYY-MM-DD
pub fn today_string() -> String {
    let now = chrono::Local::now();
    now.format("%Y-%m-%d").to_string()
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daily_limit_enforced() {
        let limiter = FrequencyLimiter::new();
        // 第 1 次：允许
        assert!(limiter.try_show_bubble());
        limiter.on_bubble_shown();
        // 第 2 次：允许
        assert!(limiter.try_show_bubble());
        limiter.on_bubble_shown();
        // 第 3 次：被拦截（已达上限 2 次）
        assert!(!limiter.try_show_bubble());
    }

    #[test]
    fn test_dismiss_threshold_blocks() {
        let limiter = FrequencyLimiter::new();
        // 关闭 3 次（达到阈值）
        limiter.on_bubble_closed();
        limiter.on_bubble_closed();
        limiter.on_bubble_closed();

        // 尝试展示：被拦截（当天关闭冷却）
        assert!(!limiter.try_show_bubble());
        assert!(limiter.is_blocked_today());
    }

    #[test]
    fn test_reset_daily_limit() {
        let limiter = FrequencyLimiter::new();
        // 用完当天配额
        assert!(limiter.try_show_bubble());
        limiter.on_bubble_shown();
        assert!(limiter.try_show_bubble());
        limiter.on_bubble_shown();
        assert!(!limiter.try_show_bubble());

        // 重置后恢复
        limiter.reset_daily_limit();
        assert!(limiter.try_show_bubble());
    }

    #[test]
    fn test_get_stats_initial() {
        let limiter = FrequencyLimiter::new();
        let stats = limiter.get_stats();
        assert_eq!(stats.today_shown, 0);
        assert_eq!(stats.today_closed_in_window, 0);
        assert!(!stats.blocked_today);
        assert!(!stats.date.is_empty());
    }

    #[test]
    fn test_get_stats_after_bubbles() {
        let limiter = FrequencyLimiter::new();
        limiter.on_bubble_shown();
        limiter.on_bubble_closed();

        let stats = limiter.get_stats();
        assert_eq!(stats.today_shown, 1);
        assert_eq!(stats.today_closed_in_window, 1);
        assert!(!stats.blocked_today);
    }

    #[test]
    fn test_dismiss_below_threshold_does_not_block() {
        let limiter = FrequencyLimiter::new();
        // 关闭 2 次（未达阈值 3）
        limiter.on_bubble_closed();
        limiter.on_bubble_closed();

        // 仍允许展示
        assert!(limiter.try_show_bubble());
        assert!(!limiter.is_blocked_today());
    }

    #[test]
    fn test_today_string_format() {
        let today = today_string();
        assert_eq!(today.len(), 10);
        assert_eq!(today.chars().nth(4), Some('-'));
        assert_eq!(today.chars().nth(7), Some('-'));
    }
}
