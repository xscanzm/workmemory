//! BrowserContextCollector：浏览器上下文采集器（对应 electron/capture/BrowserContextCollector.ts）
//!
//! 采集浏览器窗口的 URL 上下文，增强对"浏览网页"活动的理解。
//!
//! 采集策略（首期实现）：
//!  - 标题解析通道：从 "页面标题 - 浏览器名" 格式提取页面标题
//!  - domain 推断：从 windowTitle 中匹配常见域名模式（如 "github.com"）
//!  - 隐私模式：调用 IncognitoDetector 检测无痕模式，无痕时返回空 URL
//!  - 浏览器扩展通道：首期不实现扩展通信，但 method 字段保留 'extension' 枚举值
//!
//! 置信度：
//!  - 标题解析成功：0.6
//!  - 含域名匹配：0.8
//!  - 无痕/非浏览器：0
//!
//! 硬约束：仅处理窗口标题文本信息，不监听键盘/鼠标。

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::capture::incognito_detector::IncognitoDetector;
use crate::capture::window_watcher::WindowInfo;

/// 支持识别的浏览器进程名（小写，含/不含 .exe 后缀）
const BROWSER_PROCESSES: &[&str] = &[
    "chrome.exe", "chrome",
    "chromium.exe", "chromium",
    "msedge.exe", "msedge",
    "firefox.exe", "firefox",
    "brave.exe", "brave",
    "safari.exe", "safari",
    "opera.exe", "opera",
    "vivaldi.exe", "vivaldi",
];

/// 浏览器标题后缀正则："页面标题 - 浏览器名" 格式（支持 - – — 三种连字符）
fn browser_title_suffix_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\s+[-–—]\s+(Google Chrome|Microsoft Edge|Mozilla Firefox|Firefox|Safari|Brave|Opera|Vivaldi|Chromium|Arc)\s*$").unwrap()
    })
}

/// Edge 个人资料后缀
fn edge_profile_suffix_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"\s+[-–—]\s+[^–—-]+?\s+[-–—]\s+Microsoft\s*Edge\s*$").unwrap()
    })
}

/// 常见域名匹配正则
fn domain_regex() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)\b([a-z0-9-]+\.(?:com|org|net|cn|io|dev|edu|gov|info|biz|co|ai|app|cloud|me|tv|us|uk|de|fr|jp|kr|ru|br|in|au|ca))\b").unwrap()
    })
}

/// 采集方法：title_parse=标题解析 / extension=浏览器扩展（首期未实现）/ none=未采集
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserContextMethod {
    /// 标题解析
    TitleParse,
    /// 浏览器扩展（首期未实现）
    Extension,
    /// 未采集
    None,
}

/// 采集结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserContext {
    /// 推断的 URL（首期可能仅含 domain 或为空）
    pub url: String,
    /// 采集方法
    pub method: BrowserContextMethod,
    /// 置信度 0-1
    pub confidence: f64,
}

/// 采集输入：浏览器窗口的关键字段
#[derive(Debug, Clone, Default)]
pub struct BrowserWindowInput {
    /// 进程名
    pub process_name: String,
    /// 窗口标题
    pub window_title: String,
}

/// 判断进程是否为支持的浏览器
fn is_browser_process(process_name: &str) -> bool {
    let normalized = process_name.to_lowercase();
    let normalized = normalized.trim();
    BROWSER_PROCESSES.contains(&normalized)
}

/// 从窗口标题中提取页面标题（去除浏览器名后缀）
fn parse_page_title(window_title: &str) -> Option<String> {
    if let Some(m) = browser_title_suffix_regex().find(window_title) {
        let title = window_title[..m.start()].trim();
        if !title.is_empty() {
            return Some(title.to_string());
        }
    }
    if let Some(m) = edge_profile_suffix_regex().find(window_title) {
        let title = window_title[..m.start()].trim();
        if !title.is_empty() {
            return Some(title.to_string());
        }
    }
    None
}

/// 从窗口标题中提取域名
fn extract_domain(window_title: &str) -> Option<String> {
    domain_regex()
        .captures(window_title)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_lowercase())
}

/// BrowserContextCollector：浏览器上下文采集器。
pub struct BrowserContextCollector {
    /// 无痕检测器实例
    incognito_detector: IncognitoDetector,
}

impl BrowserContextCollector {
    /// 创建 BrowserContextCollector 实例
    pub fn new() -> Self {
        Self {
            incognito_detector: IncognitoDetector::new(),
        }
    }

    /// 采集浏览器 URL 上下文。
    ///
    /// 流程：
    ///  1. 非浏览器进程 → { url: '', method: 'none', confidence: 0 }
    ///  2. 无痕模式 → { url: '', method: 'none', confidence: 0 }
    ///  3. 标题解析失败 → { url: '', method: 'none', confidence: 0 }
    ///  4. 标题解析成功 + 域名匹配 → { url: 'https://domain', method: 'title_parse', confidence: 0.8 }
    ///  5. 标题解析成功（无域名）→ { url: '', method: 'title_parse', confidence: 0.6 }
    pub fn collect_browser_url(&self, window_info: &BrowserWindowInput) -> BrowserContext {
        let process_name = &window_info.process_name;
        let window_title = &window_info.window_title;

        // 1. 非浏览器进程
        if !is_browser_process(process_name) {
            return BrowserContext {
                url: String::new(),
                method: BrowserContextMethod::None,
                confidence: 0.0,
            };
        }

        // 2. 隐私模式检测：构造完整 WindowInfo 供 IncognitoDetector 使用
        let full_window_info = WindowInfo {
            hwnd: 0,
            process_name: process_name.clone(),
            process_path: String::new(),
            window_title: window_title.clone(),
            app_name: process_name.replace(".exe", "").replace(".EXE", ""),
        };
        if self.incognito_detector.detect(&full_window_info) {
            return BrowserContext {
                url: String::new(),
                method: BrowserContextMethod::None,
                confidence: 0.0,
            };
        }

        // 3. 标题解析通道
        let _page_title = match parse_page_title(window_title) {
            Some(t) => t,
            None => {
                return BrowserContext {
                    url: String::new(),
                    method: BrowserContextMethod::None,
                    confidence: 0.0,
                };
            }
        };

        // 4. domain 推断
        if let Some(domain) = extract_domain(window_title) {
            return BrowserContext {
                url: format!("https://{}", domain),
                method: BrowserContextMethod::TitleParse,
                confidence: 0.8,
            };
        }

        // 5. 仅标题解析成功，无域名匹配
        BrowserContext {
            url: String::new(),
            method: BrowserContextMethod::TitleParse,
            confidence: 0.6,
        }
    }
}

impl Default for BrowserContextCollector {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_non_browser_process_returns_none() {
        let collector = BrowserContextCollector::new();
        let input = BrowserWindowInput {
            process_name: "code.exe".to_string(),
            window_title: "main.rs - Code".to_string(),
        };
        let result = collector.collect_browser_url(&input);
        assert_eq!(result.method, BrowserContextMethod::None);
        assert_eq!(result.confidence, 0.0);
        assert!(result.url.is_empty());
    }

    #[test]
    fn test_browser_with_domain() {
        let collector = BrowserContextCollector::new();
        let input = BrowserWindowInput {
            process_name: "chrome.exe".to_string(),
            window_title: "WorkMemory - github.com - Google Chrome".to_string(),
        };
        let result = collector.collect_browser_url(&input);
        assert_eq!(result.method, BrowserContextMethod::TitleParse);
        assert_eq!(result.confidence, 0.8);
        assert!(result.url.starts_with("https://"));
        assert!(result.url.contains("github.com"));
    }

    #[test]
    fn test_browser_without_domain() {
        let collector = BrowserContextCollector::new();
        let input = BrowserWindowInput {
            process_name: "chrome.exe".to_string(),
            window_title: "新标签页 - Google Chrome".to_string(),
        };
        let result = collector.collect_browser_url(&input);
        assert_eq!(result.method, BrowserContextMethod::TitleParse);
        assert_eq!(result.confidence, 0.6);
        assert!(result.url.is_empty());
    }

    #[test]
    fn test_incognito_returns_none() {
        let collector = BrowserContextCollector::new();
        let input = BrowserWindowInput {
            process_name: "chrome.exe".to_string(),
            window_title: "Incognito - Google Chrome".to_string(),
        };
        let result = collector.collect_browser_url(&input);
        assert_eq!(result.method, BrowserContextMethod::None);
        assert_eq!(result.confidence, 0.0);
    }

    #[test]
    fn test_browser_no_suffix_returns_none() {
        let collector = BrowserContextCollector::new();
        let input = BrowserWindowInput {
            process_name: "chrome.exe".to_string(),
            window_title: "Some random title without browser suffix".to_string(),
        };
        let result = collector.collect_browser_url(&input);
        assert_eq!(result.method, BrowserContextMethod::None);
        assert_eq!(result.confidence, 0.0);
    }

    #[test]
    fn test_edge_browser_with_domain() {
        let collector = BrowserContextCollector::new();
        let input = BrowserWindowInput {
            process_name: "msedge.exe".to_string(),
            window_title: "Rust 文档 - doc.rust-lang.org - Microsoft Edge".to_string(),
        };
        let result = collector.collect_browser_url(&input);
        assert_eq!(result.method, BrowserContextMethod::TitleParse);
        assert!(result.confidence >= 0.8);
        assert!(result.url.contains("rust-lang.org"));
    }
}
