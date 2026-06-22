//! IncognitoDetector：无痕模式检测器（对应 electron/capture/IncognitoDetector.ts）
//!
//! 从 PrivacyGuard 拆出的独立检测器，便于复用。
//! 检测 Chrome/Edge/Firefox 窗口标题中的隐私浏览关键词。
//!
//! 硬约束：仅处理窗口标题文本信息，不监听键盘/鼠标。

use std::sync::Mutex;

use crate::capture::window_watcher::WindowInfo;

/// 无痕模式关键词（小写匹配）
const INCOGNITO_KEYWORDS: &[&str] = &[
    "incognito",
    "inprivate",
    "private browsing",
    "隐私浏览",
    "无痕",
];

/// 支持检测的浏览器进程名（小写）
const BROWSER_PROCESSES: &[&str] = &["chrome.exe", "msedge.exe", "firefox.exe"];

/// IncognitoDetector：无痕模式检测器。
pub struct IncognitoDetector {
    /// 当前是否处于无痕模式
    incognito_active: Mutex<bool>,
}

impl IncognitoDetector {
    /// 创建 IncognitoDetector 实例
    pub fn new() -> Self {
        Self {
            incognito_active: Mutex::new(false),
        }
    }

    /// 检测给定窗口信息是否为无痕浏览窗口。
    /// 仅检测浏览器进程（chrome/msedge/firefox）且标题含无痕关键词。
    pub fn detect(&self, window_info: &WindowInfo) -> bool {
        let process_name = window_info.process_name.to_lowercase();
        if !BROWSER_PROCESSES.contains(&process_name.as_str()) {
            return false;
        }
        let title = window_info.window_title.to_lowercase();
        INCOGNITO_KEYWORDS.iter().any(|kw| title.contains(kw))
    }

    /// 当前是否处于无痕模式
    pub fn is_incognito_active(&self) -> bool {
        *self.incognito_active.lock().unwrap()
    }

    /// 处理窗口变化事件，返回事件类型（检测到 / 清除 / 无变化）。
    ///
    /// 返回值：
    ///  - Some(true)：新检测到无痕窗口
    ///  - Some(false)：离开无痕窗口
    ///  - None：无状态变化
    pub fn on_window_change(&self, info: &WindowInfo) -> Option<bool> {
        let is_incognito = self.detect(info);
        let mut active = self.incognito_active.lock().unwrap();
        if is_incognito && !*active {
            *active = true;
            Some(true)
        } else if !is_incognito && *active {
            *active = false;
            Some(false)
        } else {
            None
        }
    }

    /// 重置状态（取消订阅时调用）
    pub fn reset(&self) {
        let mut active = self.incognito_active.lock().unwrap();
        *active = false;
    }
}

impl Default for IncognitoDetector {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_window_info(process: &str, title: &str) -> WindowInfo {
        WindowInfo {
            hwnd: 100,
            process_name: process.to_string(),
            process_path: String::new(),
            window_title: title.to_string(),
            app_name: process.replace(".exe", ""),
        }
    }

    #[test]
    fn test_detect_chrome_incognito() {
        let detector = IncognitoDetector::new();
        let info = make_window_info("chrome.exe", "Incognito - Google Chrome");
        assert!(detector.detect(&info));
    }

    #[test]
    fn test_detect_edge_inprivate() {
        let detector = IncognitoDetector::new();
        let info = make_window_info("msedge.exe", "InPrivate - Microsoft Edge");
        assert!(detector.detect(&info));
    }

    #[test]
    fn test_detect_firefox_private_browsing() {
        let detector = IncognitoDetector::new();
        let info = make_window_info("firefox.exe", "Private Browsing - Mozilla Firefox");
        assert!(detector.detect(&info));
    }

    #[test]
    fn test_detect_chinese_incognito() {
        let detector = IncognitoDetector::new();
        let info = make_window_info("chrome.exe", "无痕模式 - Google Chrome");
        assert!(detector.detect(&info));

        let info2 = make_window_info("chrome.exe", "隐私浏览窗口");
        assert!(detector.detect(&info2));
    }

    #[test]
    fn test_not_detect_non_browser() {
        let detector = IncognitoDetector::new();
        let info = make_window_info("code.exe", "Incognito window");
        // 非浏览器进程，即使标题含关键词也不检测
        assert!(!detector.detect(&info));
    }

    #[test]
    fn test_not_detect_normal_browser() {
        let detector = IncognitoDetector::new();
        let info = make_window_info("chrome.exe", "Google - Google Chrome");
        assert!(!detector.detect(&info));
    }

    #[test]
    fn test_on_window_change_state_transitions() {
        let detector = IncognitoDetector::new();
        assert!(!detector.is_incognito_active());

        // 检测到无痕窗口
        let incognito = make_window_info("chrome.exe", "Incognito");
        assert_eq!(detector.on_window_change(&incognito), Some(true));
        assert!(detector.is_incognito_active());

        // 重复检测同一无痕窗口，无状态变化
        assert_eq!(detector.on_window_change(&incognito), None);

        // 离开无痕窗口
        let normal = make_window_info("chrome.exe", "Google");
        assert_eq!(detector.on_window_change(&normal), Some(false));
        assert!(!detector.is_incognito_active());

        // 重复检测同一普通窗口，无状态变化
        assert_eq!(detector.on_window_change(&normal), None);
    }

    #[test]
    fn test_reset() {
        let detector = IncognitoDetector::new();
        let incognito = make_window_info("chrome.exe", "Incognito");
        detector.on_window_change(&incognito);
        assert!(detector.is_incognito_active());

        detector.reset();
        assert!(!detector.is_incognito_active());
    }
}
