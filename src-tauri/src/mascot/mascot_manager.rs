//! MascotManager：桌面伙伴编排层（对应 electron/mascot/MascotManager.ts）
//!
//! 整合 MascotWindow + FrequencyLimiter + TrayManager + 状态联动。
//!
//! 职责：
//!  - 实现 IMascotNotifier 接口（替换 SafeMascotNotifier 注入到 ReminderScheduler）
//!  - set_state(state)：更新 Mascot 表情
//!  - set_style(style)：切换形象
//!  - try_show_bubble(payload)：受频率限制的主动气泡
//!  - show_bubble_direct(payload)：用户触发的气泡（不受频率限制）
//!  - 状态联动：订阅 CaptureManager.on_state_change / on_incognito_detected / OcrQueue
//!  - 交互：左键单击（今日总结气泡 → 跳转）、右键双击（隐藏至托盘）

use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::models::{MascotState, MascotStyle};
use crate::mascot::frequency_limiter::{FrequencyLimiter, FrequencyStats};
use crate::mascot::mascot_window::MascotWindow;
use crate::mascot::tray_manager::TrayManager;
use crate::repositories::settings_store::SettingsStore;

/// OCR 完成后显示扫描状态的间隔（每 N 次完成显示一次）
const OCR_SCAN_INTERVAL: u32 = 5;

/// 扫描状态持续时间（毫秒）
const OCR_SCAN_DURATION_MS: u64 = 2000;

/// 今日总结气泡自动重置时间（毫秒）
const SUMMARY_BUBBLE_RESET_MS: u64 = 10000;

/// 气泡动作（点击气泡后跳转目标，spec M13.7）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleAction {
    /// 按钮文案
    pub label: String,
    /// 跳转页面（如 "today" / "reports" / "settings"）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// 自定义动作标识（如 "pause" / "resume"）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

/// 气泡 payload（spec M13.7）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubblePayload {
    /// 气泡文本
    pub text: String,
    /// 可选动作按钮列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<BubbleAction>>,
}

/// Mascot 形象列表项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MascotStyleOption {
    pub id: MascotStyle,
    pub label: String,
}

/// Mascot 形象可选项
pub fn mascot_style_options() -> Vec<MascotStyleOption> {
    vec![
        MascotStyleOption {
            id: MascotStyle::Note,
            label: "小记（便签）".to_string(),
        },
        MascotStyleOption {
            id: MascotStyle::Film,
            label: "胶片（复看）".to_string(),
        },
        MascotStyleOption {
            id: MascotStyle::Copilot,
            label: "副驾驶（技术）".to_string(),
        },
        MascotStyleOption {
            id: MascotStyle::Cursor,
            label: "极简光标".to_string(),
        },
        MascotStyleOption {
            id: MascotStyle::Paper,
            label: "纸页精灵（文档）".to_string(),
        },
    ]
}

/// MascotManager：桌面伙伴编排层。
///
/// 实现 IMascotNotifier 接口，整合窗口/频率限制/托盘/状态联动。
pub struct MascotManager {
    /// Mascot 窗口管理器
    mascot_window: MascotWindow,
    /// 频率限制器
    frequency_limiter: Mutex<FrequencyLimiter>,
    /// 托盘管理器
    tray_manager: Mutex<TrayManager>,
    /// 当前状态
    current_state: Mutex<MascotState>,
    /// 当前形象
    current_style: Mutex<MascotStyle>,
    /// OCR 完成计数（用于偶发显示扫描状态）
    ocr_completion_count: Mutex<u32>,
    /// 今日总结气泡是否已展示（用于左键单击的二次点击跳转）
    summary_bubble_shown: Mutex<bool>,
    /// 隐私模式前的状态（用于恢复）
    pre_privacy_state: Mutex<MascotState>,
    /// AppHandle 用于事件广播
    app: AppHandle,
}

impl MascotManager {
    /// 创建 MascotManager 实例
    pub fn new(app: &AppHandle) -> Self {
        let style = SettingsStore::get_mascot_style();
        Self {
            mascot_window: MascotWindow::new(app),
            frequency_limiter: Mutex::new(FrequencyLimiter::new()),
            tray_manager: Mutex::new(TrayManager::new(app)),
            current_state: Mutex::new(MascotState::Recording),
            current_style: Mutex::new(style),
            ocr_completion_count: Mutex::new(0),
            summary_bubble_shown: Mutex::new(false),
            pre_privacy_state: Mutex::new(MascotState::Recording),
            app: app.clone(),
        }
    }

    /// 获取 mascot WebviewWindow
    pub fn get_window(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window("mascot")
    }

    /// 设置 Mascot 状态
    pub fn set_state(&self, state: MascotState) {
        {
            let mut current = self.current_state.lock().unwrap();
            *current = state.clone();
        }
        // 通知前端状态变化
        if let Some(window) = self.get_window() {
            let _ = window.emit("mascot:state-changed", state.as_str());
        }
        // 更新托盘图标
        if let Ok(tray) = self.tray_manager.lock() {
            tray.update_icon(state.clone());
        }
    }

    /// 获取当前状态
    pub fn get_state(&self) -> MascotState {
        self.current_state.lock().unwrap().clone()
    }

    /// 设置 Mascot 形象
    pub fn set_style(&self, style: MascotStyle) {
        {
            let mut current = self.current_style.lock().unwrap();
            *current = style.clone();
        }
        // 通知前端形象变化
        if let Some(window) = self.get_window() {
            let _ = window.emit("mascot:style-changed", style.as_str());
        }
        // 持久化到设置（SettingsStore 无 set_mascot_style，使用 set 合并 patch）
        let mut patch = SettingsStore::get();
        patch.mascot_style = style;
        let _ = SettingsStore::set(patch);
    }

    /// 获取当前形象
    pub fn get_style(&self) -> MascotStyle {
        self.current_style.lock().unwrap().clone()
    }

    /// 获取频率限制统计
    pub fn get_stats(&self) -> FrequencyStats {
        self.frequency_limiter.lock().unwrap().get_stats()
    }

    /// 显示气泡（用户触发，不受频率限制）
    pub fn show_bubble(&self, text: &str) {
        let payload = BubblePayload {
            text: text.to_string(),
            actions: None,
        };
        self.send_bubble_to_window(&payload);
    }

    /// 显示带动作的气泡（用户触发，不受频率限制）
    pub fn show_bubble_with_payload(&self, payload: &BubblePayload) {
        self.send_bubble_to_window(payload);
    }

    /// 隐藏气泡
    pub fn hide_bubble(&self) {
        if let Some(window) = self.get_window() {
            let _ = window.emit("mascot:hide-bubble", ());
        }
    }

    /// 尝试展示主动气泡（受频率限制）。
    /// 返回 true 表示已展示；false 表示被频率限制拦截
    pub fn try_show_bubble(&self, payload: &BubblePayload) -> bool {
        let mut limiter = self.frequency_limiter.lock().unwrap();
        if !limiter.try_show_bubble() {
            log::info!(
                "[MascotManager] 主动气泡被频率限制拦截：{}",
                payload.text
            );
            // 频率限制下仅显示表情动作（如递出小信封），不展示文字弹框
            drop(limiter);
            self.set_state(MascotState::ReportReady);
            return false;
        }
        limiter.on_bubble_shown();
        drop(limiter);
        self.send_bubble_to_window(payload);
        true
    }

    /// 用户关闭气泡时调用（频率限制器记录关闭次数）
    pub fn on_bubble_dismissed(&self) {
        self.frequency_limiter.lock().unwrap().on_bubble_closed();
    }

    /// 重置当天频率限制（跨日时调用）
    pub fn reset_daily_limit(&self) {
        self.frequency_limiter
            .lock()
            .unwrap()
            .reset_daily_limit();
    }

    /// 显示 Mascot
    pub fn show(&self) {
        self.mascot_window.show();
    }

    /// 隐藏 Mascot（至托盘）
    pub fn hide(&self) {
        self.mascot_window.hide();
    }

    /// Mascot 是否可见
    pub fn is_visible(&self) -> bool {
        self.mascot_window.is_visible()
    }

    /// 导航到主窗口指定页面
    pub fn navigate(&self, page: &str) {
        if let Some(main_window) = self.app.get_webview_window("main") {
            let _ = main_window.show();
            let _ = main_window.set_focus();
            let _ = main_window.emit("mascot:navigate-main", page);
        }
    }

    /// 左键单击：首次显示今日总结气泡，再次点击跳转今日页
    pub fn on_left_click(&self) {
        let mut shown = self.summary_bubble_shown.lock().unwrap();
        if *shown {
            // 第二次点击：跳转今日页
            *shown = false;
            drop(shown);
            self.navigate("today");
        } else {
            // 第一次点击：显示今日总结气泡
            *shown = true;
            drop(shown);
            let summary = self.get_today_summary();
            self.show_bubble(&summary);
            // 超时后重置（简化实现：仅记录状态，真实计时器由调用方管理）
            // 真实场景下应使用 tokio::time::sleep 延迟重置
            let shown_clone = *self.summary_bubble_shown.lock().unwrap();
            // 注：此处仅占位，实际重置由前端超时事件触发
            let _ = shown_clone;
        }
    }

    /// 右键双击：隐藏至托盘
    pub fn on_right_double_click(&self) {
        self.hide();
    }

    /// OCR 完成回调（偶发显示扫描状态）
    pub fn on_ocr_completed(&self) {
        let mut count = self.ocr_completion_count.lock().unwrap();
        *count += 1;
        if *count % OCR_SCAN_INTERVAL != 0 {
            return;
        }
        let current = self.current_state.lock().unwrap();
        if *current == MascotState::Privacy {
            return;
        }
        drop(current);
        drop(count);

        // 显示扫描状态
        self.set_state(MascotState::OcrScanning);
        // 真实场景下应使用 tokio::time::sleep 在 OCR_SCAN_DURATION_MS 后恢复
        // 此处简化：仅设置状态，由下次状态联动恢复
        let _ = OCR_SCAN_DURATION_MS;
    }

    /// CaptureManager 状态变化回调
    pub fn on_capture_state_changed(&self, state: &str) {
        // 隐私模式由 IncognitoDetector 单独处理
        // 这里处理 recording / paused / idle
        if state == "privacy" {
            let mut pre = self.pre_privacy_state.lock().unwrap();
            let current = self.current_state.lock().unwrap();
            if *current != MascotState::Privacy {
                *pre = current.clone();
            }
            drop(current);
            drop(pre);
            self.set_state(MascotState::Privacy);
        } else if state == "recording" {
            self.set_state(MascotState::Recording);
        } else if state == "paused" {
            self.set_state(MascotState::Paused);
        } else if state == "idle" {
            self.set_state(MascotState::Paused);
        }
    }

    /// 切换隐私模式
    pub fn toggle_privacy_mode(&self, current_recording_state: &str) {
        if current_recording_state == "privacy" || current_recording_state == "paused" {
            // 恢复记录（由调用方执行 resumeCapture）
            log::info!("[MascotManager] 切换隐私模式：恢复记录");
        } else {
            // 进入隐私模式
            let mut pre = self.pre_privacy_state.lock().unwrap();
            let current = self.current_state.lock().unwrap();
            *pre = current.clone();
            drop(current);
            drop(pre);
            self.set_state(MascotState::Privacy);
        }
    }

    /// 获取今日一句话总结
    fn get_today_summary(&self) -> String {
        // 简化实现：真实场景下调用 EpisodeManager.get_daily_summary(today)
        // 此处返回默认文案，避免循环依赖
        "今天还没有记录，开始工作吧～".to_string()
    }

    /// 向 Mascot 窗口发送气泡展示命令
    fn send_bubble_to_window(&self, payload: &BubblePayload) {
        if let Some(window) = self.get_window() {
            let _ = window.emit("mascot:show-bubble", payload);
        }
    }

    /// 获取托盘管理器（供外部注册回调）
    pub fn get_tray_manager(&self) -> std::sync::MutexGuard<'_, TrayManager> {
        self.tray_manager.lock().unwrap()
    }

    /// 获取 MascotWindow 引用
    pub fn get_mascot_window(&self) -> &MascotWindow {
        &self.mascot_window
    }

    /// 创建托盘
    pub fn create_tray(&self) {
        if let Ok(mut tray) = self.tray_manager.lock() {
            tray.create();
        }
    }

    /// 停止管理器
    pub fn stop(&self) {
        self.mascot_window.hide();
    }
}

// ===================== 单例 =====================

static MASCOT_MANAGER: Lazy<Mutex<Option<MascotManager>>> = Lazy::new(|| Mutex::new(None));

/// 初始化 MascotManager 单例（在 Tauri setup 中调用）
pub fn init_mascot_manager(app: &AppHandle) {
    let mut manager = MASCOT_MANAGER.lock().unwrap();
    *manager = Some(MascotManager::new(app));
}

/// 获取 MascotManager 单例（已初始化时返回 Some）
pub fn get_mascot_manager() -> Option<std::sync::MutexGuard<'static, Option<MascotManager>>> {
    let guard = MASCOT_MANAGER.lock().ok()?;
    if guard.is_none() {
        return None;
    }
    Some(guard)
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bubble_payload_serialization() {
        // 无动作的气泡
        let payload = BubblePayload {
            text: "今日总结".to_string(),
            actions: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("今日总结"));
        assert!(!json.contains("actions"));

        // 带动作的气泡
        let payload = BubblePayload {
            text: "查看今日日报".to_string(),
            actions: Some(vec![BubbleAction {
                label: "查看".to_string(),
                page: Some("reports".to_string()),
                action: None,
            }]),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("actions"));
        assert!(json.contains("reports"));
    }

    #[test]
    fn test_bubble_action_serialization() {
        let action = BubbleAction {
            label: "暂停".to_string(),
            page: None,
            action: Some("pause".to_string()),
        };
        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("暂停"));
        assert!(json.contains("pause"));
        assert!(!json.contains("page"));

        // 反序列化
        let deserialized: BubbleAction = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.label, "暂停");
        assert_eq!(deserialized.action, Some("pause".to_string()));
        assert_eq!(deserialized.page, None);
    }

    #[test]
    fn test_mascot_style_options() {
        let options = mascot_style_options();
        assert_eq!(options.len(), 5);
        assert!(options.iter().any(|o| o.id == MascotStyle::Note));
        assert!(options.iter().any(|o| o.id == MascotStyle::Film));
        assert!(options.iter().any(|o| o.id == MascotStyle::Copilot));
        assert!(options.iter().any(|o| o.id == MascotStyle::Cursor));
        assert!(options.iter().any(|o| o.id == MascotStyle::Paper));
    }

    #[test]
    fn test_mascot_state_focused_variant() {
        // 验证 Focused 变体存在且可序列化
        let state = MascotState::Focused;
        assert_eq!(state.as_str(), "focused");

        // 反序列化
        let deserialized = MascotState::from_str("focused");
        assert_eq!(deserialized, MascotState::Focused);

        // JSON 序列化
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("focused"));
    }

    #[test]
    fn test_mascot_state_all_variants() {
        // 验证所有状态变体可往返序列化
        let states = vec![
            MascotState::Recording,
            MascotState::Paused,
            MascotState::Privacy,
            MascotState::OcrScanning,
            MascotState::ReportReady,
            MascotState::Focused,
        ];
        for state in states {
            let json = serde_json::to_string(&state).unwrap();
            let deserialized: MascotState = serde_json::from_str(&json).unwrap();
            assert_eq!(state, deserialized);
        }
    }
}
