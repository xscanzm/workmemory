//! StateSync：与主窗口的状态同步（spec M13.15）
//!
//! 监听设置/捕获状态变化，生成对应的 Mascot 气泡消息，
//! 让用户通过 Mascot 感知后台状态切换。
//!
//! 处理的事件：
//!  - OcrDisabled / OcrEnabled：OCR 开关切换
//!  - CapturePaused / CaptureResumed：捕获暂停/恢复
//!  - on_pause：用户手动暂停
//!  - on_pause_timeout：暂停超时自动恢复
//!  - on_report_generated：报告生成完成

// ===================== 设置变更事件 =====================

/// 设置/捕获状态变更类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsChange {
    /// OCR 已关闭
    OcrDisabled,
    /// OCR 已开启
    OcrEnabled,
    /// 捕获已暂停
    CapturePaused,
    /// 捕获已恢复
    CaptureResumed,
}

// ===================== 状态同步器 =====================

/// 状态同步器：根据状态变更产出气泡消息
pub struct StateSync {
    /// 当前是否处于暂停状态（用于 on_pause_timeout 判断）
    paused: bool,
}

impl StateSync {
    /// 创建状态同步器
    pub fn new() -> Self {
        Self { paused: false }
    }

    /// 处理设置变更，返回应展示的气泡消息。
    /// 返回 None 表示该变更无需气泡提示。
    pub fn on_settings_change(&mut self, change: SettingsChange) -> Option<String> {
        match change {
            SettingsChange::OcrDisabled => {
                Some("OCR 已关闭，将仅记录窗口标题和活动 📷".to_string())
            }
            SettingsChange::OcrEnabled => {
                Some("OCR 已开启，可以识别屏幕文字啦 ✨".to_string())
            }
            SettingsChange::CapturePaused => {
                self.paused = true;
                Some("记录已暂停，我可以休息一下了 ⏸".to_string())
            }
            SettingsChange::CaptureResumed => {
                self.paused = false;
                Some("记录已恢复，继续帮你记工作 ▶️".to_string())
            }
        }
    }

    /// 用户手动暂停：返回气泡消息
    pub fn on_pause(&mut self) -> String {
        self.paused = true;
        "好的，我先安静一会，需要时随时叫我 ⏸".to_string()
    }

    /// 暂停超时自动恢复：返回气泡消息
    pub fn on_pause_timeout(&mut self, minutes: u32) -> String {
        self.paused = false;
        format!("暂停了 {} 分钟，我自动恢复记录啦 ▶️", minutes)
    }

    /// 报告生成完成：返回气泡消息
    pub fn on_report_generated(&self) -> String {
        "今日报告生成好啦，要看看吗？📋".to_string()
    }

    /// 当前是否处于暂停状态
    pub fn is_paused(&self) -> bool {
        self.paused
    }
}

impl Default for StateSync {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ocr_disabled_message() {
        let mut sync = StateSync::new();
        let msg = sync.on_settings_change(SettingsChange::OcrDisabled);
        assert!(msg.is_some());
        let msg = msg.unwrap();
        assert!(msg.contains("OCR"));
        assert!(msg.contains("关闭"));
    }

    #[test]
    fn test_ocr_enabled_message() {
        let mut sync = StateSync::new();
        let msg = sync.on_settings_change(SettingsChange::OcrEnabled);
        assert!(msg.is_some());
        let msg = msg.unwrap();
        assert!(msg.contains("OCR"));
        assert!(msg.contains("开启"));
    }

    #[test]
    fn test_capture_paused_sets_paused_flag() {
        let mut sync = StateSync::new();
        assert!(!sync.is_paused());
        let msg = sync.on_settings_change(SettingsChange::CapturePaused);
        assert!(msg.is_some());
        assert!(msg.unwrap().contains("暂停"));
        assert!(sync.is_paused());
    }

    #[test]
    fn test_capture_resumed_clears_paused_flag() {
        let mut sync = StateSync::new();
        sync.on_settings_change(SettingsChange::CapturePaused);
        assert!(sync.is_paused());

        let msg = sync.on_settings_change(SettingsChange::CaptureResumed);
        assert!(msg.is_some());
        assert!(msg.unwrap().contains("恢复"));
        assert!(!sync.is_paused());
    }

    #[test]
    fn test_on_pause_message() {
        let mut sync = StateSync::new();
        let msg = sync.on_pause();
        assert!(msg.contains("暂停") || msg.contains("安静"));
        assert!(sync.is_paused());
    }

    #[test]
    fn test_on_pause_timeout_message() {
        let mut sync = StateSync::new();
        sync.on_pause();
        assert!(sync.is_paused());

        let msg = sync.on_pause_timeout(15);
        assert!(msg.contains("15"));
        assert!(msg.contains("恢复"));
        assert!(!sync.is_paused());
    }

    #[test]
    fn test_on_report_generated_message() {
        let sync = StateSync::new();
        let msg = sync.on_report_generated();
        assert!(msg.contains("报告"));
        assert!(msg.contains("📋"));
    }

    #[test]
    fn test_pause_timeout_minutes_in_message() {
        let mut sync = StateSync::new();
        sync.on_pause();
        // 不同分钟数都应正确格式化
        let msg5 = sync.on_pause_timeout(5);
        assert!(msg5.contains("5"));
        sync.on_pause();
        let msg60 = sync.on_pause_timeout(60);
        assert!(msg60.contains("60"));
    }
}
