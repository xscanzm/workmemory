//! CaptureDecision：截图决策核心（对应 electron/capture/CaptureDecision.ts）
//!
//! 接收 WindowWatcher 事件 + PrivacyGuard 判断 + ImageHash 比对，决定：
//!  合并至前一片段 / 新建 WorkSegment / 跳过 / 生成隐私占位
//!
//! 截图频率约束：
//!  - 快速切换节流：2 秒内频繁切换暂缓，等窗口稳定 3 秒后再截取最终画面（debounce）
//!  - 静止阅读降频：仅 scroll-stop 事件触发截图（标题稳定 2 秒推断）
//!  - 空闲检测：3 分钟无窗口变化标记 idle，停止队列；重新检测到变化恢复
//!
//! 硬约束：不监听键盘，仅处理窗口信息。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::capture::window_watcher::WindowInfo;
use crate::events::bus::{AppEvent, EventBus};
use crate::models::{CaptureSource, RecordingState, SourceQuality, SourceStatus, WorkSegment};

/// debounce 等待时长（毫秒）：窗口稳定 3 秒后截取
pub const DEBOUNCE_MS: u64 = 3000;
/// 快速切换判定阈值（毫秒）：2 秒内事件视为频繁切换
pub const FAST_SWITCH_MS: u64 = 2000;
/// 空闲检测时长（毫秒）：3 分钟无事件标记 idle
pub const IDLE_MS: u64 = 3 * 60 * 1000;

/// 截图决策动作类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureAction {
    /// 新建片段
    Create,
    /// 合并到前一片段
    Merge,
    /// 跳过本次捕获
    Skip,
    /// 生成隐私占位片段
    PrivacyPlaceholder,
}

/// 截图决策结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureDecisionResult {
    /// 决策动作
    pub action: CaptureAction,
    /// 关联的 segment id（Create/PrivacyPlaceholder 为新 id，Merge 为前一片段 id，Skip 为 None）
    pub segment_id: Option<String>,
    /// 决策原因
    pub reason: String,
}

/// CaptureDecision：截图决策核心。
///
/// 由于真实截图/OCR 涉及异步 IO 与平台 API，本结构主要提供决策逻辑的纯函数入口
/// 与状态管理；实际截图由 CaptureManager 调用 screenshot 模块完成。
pub struct CaptureDecision {
    /// 当前记录状态
    state: Mutex<RecordingState>,
    /// 是否允许整屏降级
    allow_full_screenshot_fallback: Mutex<bool>,
    /// 当前片段 id
    current_segment_id: Mutex<Option<String>>,
    /// 当前片段是否为隐私占位
    current_segment_is_private: Mutex<bool>,
    /// 当前片段应用名
    current_segment_app: Mutex<String>,
    /// 最近一次事件时间戳（毫秒）
    last_event_time: Mutex<u64>,
}

impl CaptureDecision {
    /// 创建 CaptureDecision 实例
    pub fn new() -> Self {
        Self {
            state: Mutex::new(RecordingState::Idle),
            allow_full_screenshot_fallback: Mutex::new(false),
            current_segment_id: Mutex::new(None),
            current_segment_is_private: Mutex::new(false),
            current_segment_app: Mutex::new(String::new()),
            last_event_time: Mutex::new(0),
        }
    }

    /// 启动决策引擎
    pub fn start(&self) {
        let mut state = self.state.lock().unwrap();
        *state = RecordingState::Recording;
        drop(state);
        EventBus::publish(AppEvent::StateChange {
            state: "recording".to_string(),
        });
    }

    /// 停止决策引擎
    pub fn stop(&self) {
        self.reset_current_segment();
        let mut state = self.state.lock().unwrap();
        *state = RecordingState::Idle;
        drop(state);
        EventBus::publish(AppEvent::StateChange {
            state: "idle".to_string(),
        });
    }

    /// 暂停（不退出订阅，但停止处理事件）
    pub fn pause(&self) {
        let mut state = self.state.lock().unwrap();
        *state = RecordingState::Paused;
        drop(state);
        EventBus::publish(AppEvent::StateChange {
            state: "paused".to_string(),
        });
    }

    /// 恢复处理
    pub fn resume(&self) {
        let mut state = self.state.lock().unwrap();
        *state = RecordingState::Recording;
        drop(state);
        EventBus::publish(AppEvent::StateChange {
            state: "recording".to_string(),
        });
    }

    /// 获取当前状态
    pub fn get_state(&self) -> RecordingState {
        self.state.lock().unwrap().clone()
    }

    /// 设置是否允许整屏降级
    pub fn set_allow_full_screenshot_fallback(&self, enabled: bool) {
        let mut flag = self.allow_full_screenshot_fallback.lock().unwrap();
        *flag = enabled;
    }

    /// 查询当前是否允许整屏降级
    pub fn is_full_screenshot_fallback_allowed(&self) -> bool {
        *self.allow_full_screenshot_fallback.lock().unwrap()
    }

    /// 处理窗口事件，返回是否应触发截图决策。
    /// 真实场景下由 CaptureManager 在 debounce 计时器到期后调用 execute_capture。
    pub fn handle_event(&self, _info: &WindowInfo) -> bool {
        let state = self.state.lock().unwrap();
        if *state == RecordingState::Paused {
            return false;
        }
        drop(state);

        let now = now_ms();
        let mut last = self.last_event_time.lock().unwrap();
        let is_fast_switch = now.saturating_sub(*last) < FAST_SWITCH_MS;
        *last = now;
        drop(last);

        // 从 idle 恢复到 recording
        let mut state = self.state.lock().unwrap();
        if *state == RecordingState::Idle {
            *state = RecordingState::Recording;
            drop(state);
            EventBus::publish(AppEvent::StateChange {
                state: "recording".to_string(),
            });
        }

        // 快速切换时仍返回 true，由调用方 debounce
        let _ = is_fast_switch;
        true
    }

    /// 外部活动唤醒：从 idle 恢复为 recording
    pub fn wake_from_activity(&self) {
        let mut state = self.state.lock().unwrap();
        if *state == RecordingState::Paused {
            return;
        }
        if *state == RecordingState::Idle {
            *state = RecordingState::Recording;
            drop(state);
            EventBus::publish(AppEvent::StateChange {
                state: "recording".to_string(),
            });
        }
    }

    /// 判定截图后的决策动作（合并 / 新建 / 跳过）。
    ///
    /// 此为纯逻辑判定：调用方先完成截图与图像哈希计算，再传入比对结果。
    pub fn decide_capture(
        &self,
        info: &WindowInfo,
        image_hash: &str,
        last_image_hash: &str,
        is_similar: bool,
    ) -> CaptureDecisionResult {
        let current_app = self.current_segment_app.lock().unwrap().clone();
        let current_is_private = *self.current_segment_is_private.lock().unwrap();
        let current_id = self.current_segment_id.lock().unwrap().clone();

        let same_app = !current_is_private && current_app == info.app_name;

        if same_app && is_similar && !last_image_hash.is_empty() && current_id.is_some() {
            // 合并到前一片段
            return CaptureDecisionResult {
                action: CaptureAction::Merge,
                segment_id: current_id,
                reason: "同应用且图像相似，合并到前一片段".to_string(),
            };
        }

        // 新建片段
        let new_id = uuid::Uuid::new_v4().to_string();
        CaptureDecisionResult {
            action: CaptureAction::Create,
            segment_id: Some(new_id.clone()),
            reason: "新建片段".to_string(),
        }
    }

    /// 处理隐私占位决策
    pub fn handle_placeholder(&self, info: &WindowInfo) -> CaptureDecisionResult {
        let current_app = self.current_segment_app.lock().unwrap().clone();
        let current_is_private = *self.current_segment_is_private.lock().unwrap();
        let current_id = self.current_segment_id.lock().unwrap().clone();

        let same_app = current_is_private && current_app == info.app_name;

        if same_app && current_id.is_some() {
            // 合并到现有隐私占位
            return CaptureDecisionResult {
                action: CaptureAction::Merge,
                segment_id: current_id,
                reason: "合并到现有隐私占位片段".to_string(),
            };
        }

        // 新建隐私占位片段
        let new_id = uuid::Uuid::new_v4().to_string();
        CaptureDecisionResult {
            action: CaptureAction::PrivacyPlaceholder,
            segment_id: Some(new_id),
            reason: "新建隐私占位片段".to_string(),
        }
    }

    /// 更新当前片段追踪状态（在决策完成后调用）
    pub fn update_current_segment(
        &self,
        segment_id: Option<String>,
        is_private: bool,
        app_name: &str,
    ) {
        let mut id = self.current_segment_id.lock().unwrap();
        *id = segment_id;
        drop(id);
        let mut private = self.current_segment_is_private.lock().unwrap();
        *private = is_private;
        drop(private);
        let mut app = self.current_segment_app.lock().unwrap();
        *app = app_name.to_string();
    }

    /// 重置当前片段追踪
    pub fn reset_current_segment(&self) {
        let mut id = self.current_segment_id.lock().unwrap();
        *id = None;
        drop(id);
        let mut private = self.current_segment_is_private.lock().unwrap();
        *private = false;
        drop(private);
        let mut app = self.current_segment_app.lock().unwrap();
        *app = String::new();
    }
}

impl Default for CaptureDecision {
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

/// 格式化日期为 YYYY-MM-DD
pub fn format_date(d: &chrono::DateTime<chrono::Local>) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// 格式化时间为 HH:MM:SS
pub fn format_time(d: &chrono::DateTime<chrono::Local>) -> String {
    d.format("%H:%M:%S").to_string()
}

/// 格式化短时间 HH:MM
pub fn format_time_short(d: &chrono::DateTime<chrono::Local>) -> String {
    d.format("%H:%M").to_string()
}

/// 创建普通片段（source_status='pending'，待 OCR）
pub fn create_segment(
    info: &WindowInfo,
    now: &chrono::DateTime<chrono::Local>,
    hash: &str,
    screenshot_path: &str,
    is_fallback: bool,
) -> WorkSegment {
    let time_str = format_time(now);
    WorkSegment {
        id: uuid::Uuid::new_v4().to_string(),
        date: format_date(now),
        start_time: time_str.clone(),
        end_time: time_str,
        duration_seconds: 0,
        app_name: info.app_name.clone(),
        process_name: info.process_name.clone(),
        window_title: info.window_title.clone(),
        ocr_text: String::new(),
        ocr_summary: String::new(),
        image_hash: hash.to_string(),
        screenshot_path: screenshot_path.to_string(),
        is_selected_for_report: false,
        is_private: false,
        is_important: false,
        is_deleted: false,
        source_status: SourceStatus::Pending,
        user_title: String::new(),
        user_summary: String::new(),
        user_note: String::new(),
        tags: Vec::new(),
        ocr_blocks: Vec::new(),
        ocr_confidence: 0.0,
        capture_source: if is_fallback {
            CaptureSource::FullScreenFallback
        } else {
            CaptureSource::ActiveWindow
        },
        source_quality: if is_fallback {
            SourceQuality::Medium
        } else {
            SourceQuality::High
        },
        active_window_bounds: None,
        display_bounds: None,
        ocr_raw_text: None,
        noise_score: None,
        activity_type: None,
        content_type: None,
        content_data: None,
        browser_url: None,
        layout_type: None,
        action_flow: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// 创建隐私占位片段（is_private=1, source_status='private'）
pub fn create_privacy_segment(
    info: &WindowInfo,
    now: &chrono::DateTime<chrono::Local>,
    start_time_str: &str,
) -> WorkSegment {
    let time_str = format_time(now);
    WorkSegment {
        id: uuid::Uuid::new_v4().to_string(),
        date: format_date(now),
        start_time: time_str.clone(),
        end_time: time_str,
        duration_seconds: 0,
        app_name: info.app_name.clone(),
        process_name: info.process_name.clone(),
        window_title: format!("[{} - {} 隐私窗口被保护]", start_time_str, start_time_str),
        ocr_text: String::new(),
        ocr_summary: String::new(),
        image_hash: String::new(),
        screenshot_path: String::new(),
        is_selected_for_report: false,
        is_private: true,
        is_important: false,
        is_deleted: false,
        source_status: SourceStatus::Private,
        user_title: String::new(),
        user_summary: String::new(),
        user_note: String::new(),
        tags: Vec::new(),
        ocr_blocks: Vec::new(),
        ocr_confidence: 0.0,
        capture_source: CaptureSource::PrivacyPlaceholder,
        source_quality: SourceQuality::Private,
        active_window_bounds: None,
        display_bounds: None,
        ocr_raw_text: None,
        noise_score: None,
        activity_type: None,
        content_type: None,
        content_data: None,
        browser_url: None,
        layout_type: None,
        action_flow: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_window_info(app: &str, title: &str) -> WindowInfo {
        WindowInfo {
            hwnd: 100,
            process_name: format!("{}.exe", app),
            process_path: format!("C:\\{}.exe", app),
            window_title: title.to_string(),
            app_name: app.to_string(),
        }
    }

    #[test]
    fn test_decide_capture_new_segment() {
        let decision = CaptureDecision::new();
        let info = make_window_info("chrome", "Google");
        // 无前一片段，应新建
        let result = decision.decide_capture(&info, "hash1", "", false);
        assert_eq!(result.action, CaptureAction::Create);
        assert!(result.segment_id.is_some());
    }

    #[test]
    fn test_decide_capture_merge_similar() {
        let decision = CaptureDecision::new();
        let info = make_window_info("chrome", "Google");
        // 设置当前片段为同应用
        decision.update_current_segment(Some("seg-1".to_string()), false, "chrome");
        // 图像相似 → 合并
        let result = decision.decide_capture(&info, "hash2", "hash1", true);
        assert_eq!(result.action, CaptureAction::Merge);
        assert_eq!(result.segment_id, Some("seg-1".to_string()));
    }

    #[test]
    fn test_decide_capture_new_when_different_app() {
        let decision = CaptureDecision::new();
        let info = make_window_info("code", "main.rs");
        // 当前片段为 chrome，新片段为 code → 新建
        decision.update_current_segment(Some("seg-1".to_string()), false, "chrome");
        let result = decision.decide_capture(&info, "hash2", "hash1", false);
        assert_eq!(result.action, CaptureAction::Create);
    }

    #[test]
    fn test_handle_placeholder_new() {
        let decision = CaptureDecision::new();
        let info = make_window_info("chrome", "银行");
        // 无前一片段 → 新建隐私占位
        let result = decision.handle_placeholder(&info);
        assert_eq!(result.action, CaptureAction::PrivacyPlaceholder);
        assert!(result.segment_id.is_some());
    }

    #[test]
    fn test_handle_placeholder_merge_same_app() {
        let decision = CaptureDecision::new();
        let info = make_window_info("chrome", "银行");
        // 当前片段为同应用隐私占位 → 合并
        decision.update_current_segment(Some("seg-1".to_string()), true, "chrome");
        let result = decision.handle_placeholder(&info);
        assert_eq!(result.action, CaptureAction::Merge);
        assert_eq!(result.segment_id, Some("seg-1".to_string()));
    }

    #[test]
    fn test_state_transitions() {
        let decision = CaptureDecision::new();
        assert_eq!(decision.get_state(), RecordingState::Idle);
        decision.start();
        assert_eq!(decision.get_state(), RecordingState::Recording);
        decision.pause();
        assert_eq!(decision.get_state(), RecordingState::Paused);
        decision.resume();
        assert_eq!(decision.get_state(), RecordingState::Recording);
        decision.stop();
        assert_eq!(decision.get_state(), RecordingState::Idle);
    }

    #[test]
    fn test_full_screenshot_fallback_flag() {
        let decision = CaptureDecision::new();
        assert!(!decision.is_full_screenshot_fallback_allowed());
        decision.set_allow_full_screenshot_fallback(true);
        assert!(decision.is_full_screenshot_fallback_allowed());
    }

    #[test]
    fn test_create_segment_fields() {
        let info = make_window_info("code", "main.rs");
        let now = chrono::Local::now();
        let segment = create_segment(&info, &now, "abc123", "/tmp/shot.png", false);
        assert_eq!(segment.app_name, "code");
        assert_eq!(segment.window_title, "main.rs");
        assert_eq!(segment.image_hash, "abc123");
        assert_eq!(segment.screenshot_path, "/tmp/shot.png");
        assert_eq!(segment.source_status, SourceStatus::Pending);
        assert_eq!(segment.capture_source, CaptureSource::ActiveWindow);
        assert_eq!(segment.source_quality, SourceQuality::High);
        assert!(!segment.is_private);
    }

    #[test]
    fn test_create_privacy_segment_fields() {
        let info = make_window_info("chrome", "银行");
        let now = chrono::Local::now();
        let segment = create_privacy_segment(&info, &now, "10:30");
        assert!(segment.is_private);
        assert_eq!(segment.source_status, SourceStatus::Private);
        assert_eq!(segment.capture_source, CaptureSource::PrivacyPlaceholder);
        assert_eq!(segment.source_quality, SourceQuality::Private);
        assert!(segment.window_title.contains("隐私窗口被保护"));
        assert!(segment.image_hash.is_empty());
    }
}
