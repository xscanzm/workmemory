//! CaptureManager：捕获全链路编排单例（对应 electron/capture/CaptureManager.ts）
//!
//! 整合 WindowWatcher + Screenshot + CaptureDecision + PrivacyGuard + IncognitoDetector + SegmentRepository。
//!
//! 职责：
//!  - 启动/停止/暂停/恢复全链路捕获
//!  - 监听 CaptureDecision 事件，持久化 Segment 到数据库
//!  - 监听 IncognitoDetector 事件，广播 IPC 通知渲染进程（桌面伙伴遮眼拉帘）
//!  - 管理截图持久化设置（saveScreenshots / retentionDays）
//!  - 单例导出 get_capture_manager()
//!
//! 硬约束：不监听键盘，仅编排窗口/截图/隐私模块。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

use crate::capture::capture_decision::CaptureDecision;
use crate::capture::privacy_guard::PrivacyGuard;
use crate::capture::window_watcher::{WindowInfo, WindowWatcher};
use crate::events::bus::{AppEvent, EventBus};
use crate::models::RecordingState;

/// 与 CaptureDecision 空闲阈值对齐：3 分钟无活动进入 idle
pub const SYSTEM_IDLE_THRESHOLD_SECONDS: u64 = 3 * 60;
/// 系统活动轮询间隔（毫秒）
pub const ACTIVITY_POLL_INTERVAL_MS: u64 = 15000;

/// 捕获状态
#[derive(Debug, Clone)]
pub struct CaptureState {
    /// 基础状态（不含 privacy 覆盖）
    pub base_state: RecordingState,
    /// 是否处于隐私模式（无痕窗口激活时）
    pub privacy_mode: bool,
}

impl CaptureState {
    /// 获取当前记录状态（含 privacy 覆盖）
    pub fn effective_state(&self) -> RecordingState {
        if self.privacy_mode {
            RecordingState::Privacy
        } else {
            self.base_state.clone()
        }
    }
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            base_state: RecordingState::Idle,
            privacy_mode: false,
        }
    }
}

/// CaptureManager：捕获全链路编排单例。
pub struct CaptureManager {
    /// 窗口监听器
    watcher: Mutex<Option<WindowWatcher>>,
    /// 隐私守卫
    privacy_guard: PrivacyGuard,
    /// 截图决策
    decision: CaptureDecision,
    /// 捕获状态
    state: Mutex<CaptureState>,
    /// 是否持久保存截图
    save_screenshots: Mutex<bool>,
    /// 截图保留天数
    screenshot_retention_days: Mutex<i32>,
    /// 是否允许活跃窗口截图失败后整屏降级
    allow_full_screenshot_fallback: Mutex<bool>,
}

impl CaptureManager {
    /// 创建 CaptureManager 实例
    pub fn new() -> Self {
        Self {
            watcher: Mutex::new(None),
            privacy_guard: PrivacyGuard::new(),
            decision: CaptureDecision::new(),
            state: Mutex::new(CaptureState::default()),
            save_screenshots: Mutex::new(false),
            screenshot_retention_days: Mutex::new(0),
            allow_full_screenshot_fallback: Mutex::new(false),
        }
    }

    // ===================== 捕获控制 =====================

    /// 启动全链路捕获
    pub fn start_capture(&self) -> bool {
        self.privacy_guard.seed_default_rules();
        // 启动 WindowWatcher（如果可用）
        if let Ok(mut guard) = self.watcher.lock() {
            if guard.is_none() {
                let mut watcher = WindowWatcher::new();
                let _ = watcher.start();
                *guard = Some(watcher);
            }
        }
        self.decision.start();
        self.set_base_state(RecordingState::Recording);
        true
    }

    /// 停止捕获
    pub fn stop_capture(&self) -> bool {
        self.decision.stop();
        if let Ok(mut guard) = self.watcher.lock() {
            if let Some(mut watcher) = guard.take() {
                let _ = watcher.stop();
            }
        }
        self.set_base_state(RecordingState::Idle);
        true
    }

    /// 暂停捕获
    pub fn pause_capture(&self) -> bool {
        self.decision.pause();
        self.set_base_state(RecordingState::Paused);
        true
    }

    /// 恢复捕获
    pub fn resume_capture(&self) -> bool {
        self.decision.resume();
        self.set_base_state(RecordingState::Recording);
        true
    }

    /// 获取当前记录状态（含 privacy 覆盖）
    pub fn get_recording_state(&self) -> RecordingState {
        self.state.lock().unwrap().effective_state()
    }

    // ===================== 模块访问 =====================

    /// 获取隐私守卫引用
    pub fn get_privacy_guard(&self) -> &PrivacyGuard {
        &self.privacy_guard
    }

    /// 获取截图决策引用
    pub fn get_capture_decision(&self) -> &CaptureDecision {
        &self.decision
    }

    // ===================== 设置 =====================

    /// 设置是否持久保存截图
    pub fn set_save_screenshots(&self, enabled: bool) {
        *self.save_screenshots.lock().unwrap() = enabled;
    }

    /// 设置截图保留天数
    pub fn set_screenshot_retention_days(&self, days: i32) {
        *self.screenshot_retention_days.lock().unwrap() = days.max(0).min(7);
    }

    /// 设置是否允许活跃窗口截图失败后整屏降级，并立即下发到 CaptureDecision。
    /// 默认 false：窗口截图失败即跳过，绝不自动整屏。
    pub fn set_allow_full_screenshot_fallback(&self, enabled: bool) {
        *self.allow_full_screenshot_fallback.lock().unwrap() = enabled;
        self.decision.set_allow_full_screenshot_fallback(enabled);
    }

    /// 查询当前是否允许整屏降级
    pub fn is_full_screenshot_fallback_allowed(&self) -> bool {
        *self.allow_full_screenshot_fallback.lock().unwrap()
    }

    /// 用户从空闲恢复活动时唤醒决策引擎
    pub fn wake_from_activity(&self, _window_info: &WindowInfo) {
        self.decision.wake_from_activity();
        let mut state = self.state.lock().unwrap();
        if !state.privacy_mode && state.base_state == RecordingState::Idle {
            state.base_state = RecordingState::Recording;
            drop(state);
            self.broadcast_state();
        }
    }

    // ===================== 内部工具 =====================

    /// 设置基础状态并广播
    fn set_base_state(&self, state: RecordingState) {
        {
            let mut s = self.state.lock().unwrap();
            s.base_state = state;
        }
        self.broadcast_state();
    }

    /// 广播状态变化
    fn broadcast_state(&self) {
        let state = self.get_recording_state();
        let state_str = match state {
            RecordingState::Recording => "recording",
            RecordingState::Paused => "paused",
            RecordingState::Idle => "idle",
            RecordingState::Privacy => "privacy",
        };
        EventBus::publish(AppEvent::StateChange {
            state: state_str.to_string(),
        });
    }
}

impl Default for CaptureManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 获取当前时间戳（毫秒）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===================== 单例 =====================

/// CaptureManager 单例
static MANAGER_INSTANCE: Lazy<Mutex<Option<CaptureManager>>> = Lazy::new(|| Mutex::new(None));

/// 获取 CaptureManager 单例锁
pub fn get_capture_manager() -> &'static Mutex<Option<CaptureManager>> {
    &MANAGER_INSTANCE
}

/// 初始化单例（app ready 后调用）
pub fn init_capture_manager() {
    let mut guard = MANAGER_INSTANCE.lock().unwrap();
    if guard.is_none() {
        *guard = Some(CaptureManager::new());
    }
}

/// 重置单例（仅供测试）
pub fn reset_capture_manager() {
    let mut guard = MANAGER_INSTANCE.lock().unwrap();
    if let Some(manager) = guard.take() {
        manager.stop_capture();
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capture_state_default() {
        let state = CaptureState::default();
        assert_eq!(state.base_state, RecordingState::Idle);
        assert!(!state.privacy_mode);
        assert_eq!(state.effective_state(), RecordingState::Idle);
    }

    #[test]
    fn test_capture_state_privacy_override() {
        let mut state = CaptureState::default();
        state.base_state = RecordingState::Recording;
        state.privacy_mode = true;
        // 隐私模式覆盖基础状态
        assert_eq!(state.effective_state(), RecordingState::Privacy);
    }

    #[test]
    fn test_capture_manager_creation() {
        let manager = CaptureManager::new();
        assert_eq!(manager.get_recording_state(), RecordingState::Idle);
        assert!(!manager.is_full_screenshot_fallback_allowed());
    }

    #[test]
    fn test_set_save_screenshots() {
        let manager = CaptureManager::new();
        manager.set_save_screenshots(true);
        assert!(*manager.save_screenshots.lock().unwrap());
        manager.set_save_screenshots(false);
        assert!(!*manager.save_screenshots.lock().unwrap());
    }

    #[test]
    fn test_set_screenshot_retention_days_clamped() {
        let manager = CaptureManager::new();
        manager.set_screenshot_retention_days(100);
        assert_eq!(*manager.screenshot_retention_days.lock().unwrap(), 7);
        manager.set_screenshot_retention_days(-5);
        assert_eq!(*manager.screenshot_retention_days.lock().unwrap(), 0);
        manager.set_screenshot_retention_days(3);
        assert_eq!(*manager.screenshot_retention_days.lock().unwrap(), 3);
    }

    #[test]
    fn test_set_allow_full_screenshot_fallback() {
        let manager = CaptureManager::new();
        assert!(!manager.is_full_screenshot_fallback_allowed());
        manager.set_allow_full_screenshot_fallback(true);
        assert!(manager.is_full_screenshot_fallback_allowed());
    }

    #[test]
    fn test_pause_and_resume() {
        let manager = CaptureManager::new();
        manager.pause_capture();
        assert_eq!(manager.get_recording_state(), RecordingState::Paused);
        manager.resume_capture();
        assert_eq!(manager.get_recording_state(), RecordingState::Recording);
    }
}
