//! PrivacyGuard：隐私防护中心（对应 electron/capture/PrivacyGuard.ts）
//!
//! 功能：
//!  - check(window_info)：调用 PrivacyRuleRepository.match_rule 判断 skip/placeholder/allow
//!  - detect_incognito(window_info)：检测无痕浏览窗口
//!  - on_incognito_detected：触发桌面伙伴遮眼拉帘 + 系统切入隐私模式
//!  - seed_default_rules()：首次启动 seed 内置默认规则
//!
//! 硬约束（代码审计点）：
//!  本模块绝不引入任何键盘钩子，仅处理窗口标题、进程名等宏观信息。

use std::sync::Mutex;

use crate::capture::incognito_detector::IncognitoDetector;
use crate::capture::window_watcher::WindowInfo;
use crate::events::bus::{AppEvent, EventBus};
use crate::models::{PrivacyAction, PrivacyRule};
use crate::repositories::privacy_rule_repository::PrivacyRuleRepository;

/// PrivacyGuard 检查结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct PrivacyCheckResult {
    /// 动作：skip / placeholder / allow
    pub action: PrivacyAction,
    /// 原因说明
    pub reason: String,
    /// 命中的规则（若有）
    pub matched_rule: Option<PrivacyRule>,
}

/// PrivacyGuard：隐私防护中心。
pub struct PrivacyGuard {
    /// 无痕检测器
    incognito_detector: IncognitoDetector,
    /// 当前是否处于隐私模式
    privacy_mode: Mutex<bool>,
}

impl PrivacyGuard {
    /// 创建 PrivacyGuard 实例
    pub fn new() -> Self {
        Self {
            incognito_detector: IncognitoDetector::new(),
            privacy_mode: Mutex::new(false),
        }
    }

    /// 隐私检查：调用 PrivacyRuleRepository.match_rule 判断动作。
    pub fn check(&self, window_info: &WindowInfo) -> PrivacyCheckResult {
        let result = match PrivacyRuleRepository::match_rule(
            &window_info.app_name,
            &window_info.process_name,
            &window_info.window_title,
            "", // URL 暂不采集
        ) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[PrivacyGuard] 规则匹配失败: {}", e);
                return PrivacyCheckResult {
                    action: PrivacyAction::Allow,
                    reason: format!("规则匹配异常: {}", e),
                    matched_rule: None,
                };
            }
        };

        let reason = match &result.matched_rule {
            Some(rule) => format!(
                "命中{}规则: {}",
                rule.rule_type.as_str(),
                rule.pattern
            ),
            None => "未命中隐私规则".to_string(),
        };

        PrivacyCheckResult {
            action: result.action,
            reason,
            matched_rule: result.matched_rule,
        }
    }

    /// 检测窗口是否为无痕浏览窗口。委托给 IncognitoDetector.detect。
    pub fn detect_incognito(&self, window_info: &WindowInfo) -> bool {
        self.incognito_detector.detect(window_info)
    }

    /// 获取无痕检测器实例引用
    pub fn get_incognito_detector(&self) -> &IncognitoDetector {
        &self.incognito_detector
    }

    /// 当前是否处于隐私模式
    pub fn is_privacy_mode(&self) -> bool {
        *self.privacy_mode.lock().unwrap()
    }

    /// 无痕窗口检测回调：切入隐私模式
    pub fn on_incognito_detected(&self, info: &WindowInfo) {
        let mut mode = self.privacy_mode.lock().unwrap();
        *mode = true;
        drop(mode);
        log::warn!(
            "[PrivacyGuard] 检测到无痕浏览窗口，切入隐私模式: {} - {}",
            info.process_name,
            info.window_title
        );
        EventBus::publish(AppEvent::StateChange {
            state: "privacy".to_string(),
        });
    }

    /// 无痕窗口清除回调：退出隐私模式
    pub fn on_incognito_cleared(&self, _info: &WindowInfo) {
        let mut mode = self.privacy_mode.lock().unwrap();
        *mode = false;
        drop(mode);
        log::warn!("[PrivacyGuard] 离开无痕浏览窗口，退出隐私模式");
        EventBus::publish(AppEvent::StateChange {
            state: "recording".to_string(),
        });
    }

    /// 首次启动 seed 默认规则到 privacy_rules 表。
    /// 若表已有规则则跳过（不覆盖用户自定义规则）。
    pub fn seed_default_rules(&self) {
        if let Err(e) = PrivacyRuleRepository::seed_default_rules() {
            log::warn!("[PrivacyGuard] seed 默认规则失败: {}", e);
        }
    }
}

impl Default for PrivacyGuard {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_privacy_check_result_serialization() {
        let result = PrivacyCheckResult {
            action: PrivacyAction::Skip,
            reason: "命中规则".to_string(),
            matched_rule: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("skip"));
        assert!(json.contains("命中规则"));
    }

    #[test]
    fn test_privacy_mode_toggle() {
        let guard = PrivacyGuard::new();
        assert!(!guard.is_privacy_mode());

        let info = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: String::new(),
            window_title: "Incognito".to_string(),
            app_name: "chrome".to_string(),
        };
        guard.on_incognito_detected(&info);
        assert!(guard.is_privacy_mode());

        guard.on_incognito_cleared(&info);
        assert!(!guard.is_privacy_mode());
    }

    #[test]
    fn test_detect_incognito_delegates() {
        let guard = PrivacyGuard::new();
        let incognito_info = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: String::new(),
            window_title: "Incognito - Google Chrome".to_string(),
            app_name: "chrome".to_string(),
        };
        assert!(guard.detect_incognito(&incognito_info));

        let normal_info = WindowInfo {
            hwnd: 100,
            process_name: "chrome.exe".to_string(),
            process_path: String::new(),
            window_title: "Google".to_string(),
            app_name: "chrome".to_string(),
        };
        assert!(!guard.detect_incognito(&normal_info));
    }

    #[test]
    fn test_all_privacy_actions_serializable() {
        let actions = vec![
            PrivacyAction::Skip,
            PrivacyAction::Placeholder,
            PrivacyAction::Allow,
        ];
        for action in actions {
            let json = serde_json::to_string(&action).unwrap();
            let deserialized: PrivacyAction = serde_json::from_str(&json).unwrap();
            assert_eq!(action, deserialized);
        }
    }
}
