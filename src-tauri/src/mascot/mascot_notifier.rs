//! MascotNotifier：桌面伙伴通知接口 + 安全实现（对应 electron/mascot/MascotNotifier.ts）
//!
//! 依赖倒置：ReminderScheduler 等模块依赖 IMascotNotifier 接口，
//! 阶段 10 实现 MascotManager 后注入真实实例。
//!
//! 当前 SafeMascotNotifier 实现：
//!  - 实现完整频率限制逻辑（每天最多 2 次；10 分钟内 3 次关闭则当天停止）
//!  - 不弹窗，仅日志记录（Null Object 模式，非 mock）
//!  - 阶段 10 替换为真实 MascotManager 后，频率限制由真实实现接管

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

/// 每天主动气泡最大次数
const DAILY_MAX_BUBBLES: u32 = 2;
/// 关闭冷却窗口（毫秒）：10 分钟
const DISMISS_WINDOW_MS: u64 = 10 * 60 * 1000;
/// 冷却窗口内最大关闭次数：3 次则当天停止
const DISMISS_THRESHOLD: usize = 3;

/// 气泡类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MascotBubbleType {
    Insight,
    Reminder,
    Info,
}

/// 气泡动作（点击气泡后跳转目标）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MascotBubbleAction {
    /// 动作类型：navigate 表示跳转页面
    #[serde(rename = "type")]
    pub action_type: String,
    /// 跳转目标页面
    pub page: String,
}

/// 气泡 payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MascotBubblePayload {
    /// 气泡类型
    pub bubble_type: MascotBubbleType,
    /// 标题
    pub title: String,
    /// 正文
    pub message: String,
    /// 可选动作
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<MascotBubbleAction>,
}

/// 主动建议（从 AI 模块传入，简化版）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Advice {
    /// 建议类型：skill_reference / rest_reminder / focus_suggestion
    #[serde(rename = "type")]
    pub advice_type: String,
    pub title: String,
    pub message: String,
    /// 可选动作
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<MascotBubbleAction>,
}

/// 桌面伙伴通知接口（trait）。
/// 阶段 10 的 MascotManager 须实现此接口并注入到 ReminderScheduler。
pub trait IMascotNotifier: Send + Sync {
    /// 尝试展示气泡。受频率限制约束。
    /// 返回 true 表示已展示（或日志记录）；false 表示被频率限制拦截
    fn try_show_bubble(&self, payload: &MascotBubblePayload) -> bool;

    /// 用户关闭气泡时调用。
    /// 用于频率限制器记录关闭次数（10 分钟内 3 次关闭则当天停止）。
    fn on_bubble_dismissed(&self);

    /// 重置当天频率限制（跨日时调用）
    fn reset_daily_limit(&self);

    /// 接收 ProactiveAdvisor 产出的 Advice 并通过气泡推送（Task R4）。
    /// 内部将 Advice 映射为 MascotBubblePayload 并调用 try_show_bubble。
    /// 返回 true 表示已展示（或日志记录）；false 表示被频率限制拦截
    fn notify_advice(&self, advice: &Advice) -> bool;
}

/// SafeMascotNotifier：安全实现（仅日志，不弹窗）。
///
/// 实现完整频率限制逻辑，确保阶段 10 替换前的行为正确性。
/// 真实 MascotManager 实现后，可复用此频率限制逻辑或自行实现。
pub struct SafeMascotNotifier {
    /// 当天已展示次数
    daily_count: Mutex<u32>,
    /// 当天日期标记（YYYY-MM-DD），用于跨日重置
    daily_date: Mutex<String>,
    /// 最近的关闭时间戳列表（用于 10 分钟窗口判断）
    recent_dismissals: Mutex<Vec<u64>>,
    /// 当天是否已被关闭冷却停止
    daily_stopped: Mutex<bool>,
}

impl SafeMascotNotifier {
    /// 创建 SafeMascotNotifier 实例
    pub fn new() -> Self {
        Self {
            daily_count: Mutex::new(0),
            daily_date: Mutex::new(today_string()),
            recent_dismissals: Mutex::new(Vec::new()),
            daily_stopped: Mutex::new(false),
        }
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

    /// 获取当前时间戳（毫秒）
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}

impl Default for SafeMascotNotifier {
    fn default() -> Self {
        Self::new()
    }
}

impl IMascotNotifier for SafeMascotNotifier {
    fn try_show_bubble(&self, payload: &MascotBubblePayload) -> bool {
        self.check_daily_reset();

        let stopped = *self.daily_stopped.lock().unwrap();
        if stopped {
            log::info!(
                "[MascotNotifier] 气泡被频率限制拦截（当天关闭冷却）：{}",
                payload.title
            );
            return false;
        }

        let count = *self.daily_count.lock().unwrap();
        if count >= DAILY_MAX_BUBBLES {
            log::info!(
                "[MascotNotifier] 气泡被频率限制拦截（当天已达上限 {} 次）：{}",
                DAILY_MAX_BUBBLES,
                payload.title
            );
            return false;
        }

        let mut count = self.daily_count.lock().unwrap();
        *count += 1;
        drop(count);

        log::info!(
            "[MascotNotifier] 展示气泡 [{:?}] \"{}\": {}{}",
            payload.bubble_type,
            payload.title,
            payload.message,
            if let Some(a) = &payload.action {
                format!(" → 跳转 {}", a.page)
            } else {
                String::new()
            }
        );
        true
    }

    fn on_bubble_dismissed(&self) {
        self.check_daily_reset();
        let now = Self::now_ms();
        let mut dismissals = self.recent_dismissals.lock().unwrap();
        dismissals.push(now);
        // 清理过期记录（超过 10 分钟）
        dismissals.retain(|&ts| now.saturating_sub(ts) < DISMISS_WINDOW_MS);
        if dismissals.len() >= DISMISS_THRESHOLD {
            let mut stopped = self.daily_stopped.lock().unwrap();
            *stopped = true;
            drop(stopped);
            log::info!(
                "[MascotNotifier] 10 分钟内关闭 {} 次，当天停止主动气泡",
                dismissals.len()
            );
        }
    }

    fn reset_daily_limit(&self) {
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

    fn notify_advice(&self, advice: &Advice) -> bool {
        // 将 Advice 映射为 MascotBubblePayload
        // skill_reference → insight；rest_reminder / focus_suggestion → reminder
        let bubble_type = if advice.advice_type == "skill_reference" {
            MascotBubbleType::Insight
        } else {
            MascotBubbleType::Reminder
        };
        let payload = MascotBubblePayload {
            bubble_type,
            title: advice.title.clone(),
            message: advice.message.clone(),
            action: advice.action.clone(),
        };
        self.try_show_bubble(&payload)
    }
}

// ===================== 单例 =====================

static NOTIFIER: Lazy<Mutex<Box<dyn IMascotNotifier>>> =
    Lazy::new(|| Mutex::new(Box::new(SafeMascotNotifier::new())));

/// 获取当前 MascotNotifier 单例（默认 SafeMascotNotifier）
pub fn get_mascot_notifier() -> std::sync::MutexGuard<'static, Box<dyn IMascotNotifier>> {
    NOTIFIER.lock().unwrap()
}

/// 注入真实 MascotNotifier（阶段 10 调用）
pub fn set_mascot_notifier(notifier: Box<dyn IMascotNotifier>) {
    let mut current = NOTIFIER.lock().unwrap();
    *current = notifier;
}

/// 推送主动建议到桌面伙伴（Task R4）。
///
/// 使用当前 MascotNotifier 单例将 Advice 转换为气泡并展示。
/// 受频率限制约束（每天最多 2 次；10 分钟内 3 次关闭则当天停止）。
pub fn notify_advice(advice: &Advice) -> bool {
    let notifier = NOTIFIER.lock().unwrap();
    notifier.notify_advice(advice)
}

// ===================== 工具函数 =====================

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
    fn test_safe_notifier_daily_limit() {
        let notifier = SafeMascotNotifier::new();
        let payload = MascotBubblePayload {
            bubble_type: MascotBubbleType::Reminder,
            title: "测试1".to_string(),
            message: "消息1".to_string(),
            action: None,
        };

        // 第 1 次：允许
        assert!(notifier.try_show_bubble(&payload));
        // 第 2 次：允许
        assert!(notifier.try_show_bubble(&payload));
        // 第 3 次：被拦截（已达上限 2 次）
        assert!(!notifier.try_show_bubble(&payload));
    }

    #[test]
    fn test_safe_notifier_dismiss_threshold() {
        let notifier = SafeMascotNotifier::new();
        let payload = MascotBubblePayload {
            bubble_type: MascotBubbleType::Insight,
            title: "测试".to_string(),
            message: "消息".to_string(),
            action: None,
        };

        // 展示一次
        assert!(notifier.try_show_bubble(&payload));

        // 关闭 3 次（达到阈值）
        notifier.on_bubble_dismissed();
        notifier.on_bubble_dismissed();
        notifier.on_bubble_dismissed();

        // 再次尝试展示：被拦截（当天关闭冷却）
        assert!(!notifier.try_show_bubble(&payload));
    }

    #[test]
    fn test_safe_notifier_reset_daily_limit() {
        let notifier = SafeMascotNotifier::new();
        let payload = MascotBubblePayload {
            bubble_type: MascotBubbleType::Info,
            title: "测试".to_string(),
            message: "消息".to_string(),
            action: None,
        };

        // 用完当天配额
        assert!(notifier.try_show_bubble(&payload));
        assert!(notifier.try_show_bubble(&payload));
        assert!(!notifier.try_show_bubble(&payload));

        // 重置后恢复
        notifier.reset_daily_limit();
        assert!(notifier.try_show_bubble(&payload));
    }

    #[test]
    fn test_notify_advice_skill_reference() {
        let notifier = SafeMascotNotifier::new();
        let advice = Advice {
            advice_type: "skill_reference".to_string(),
            title: "技能卡".to_string(),
            message: "建议参考技能卡".to_string(),
            action: Some(MascotBubbleAction {
                action_type: "navigate".to_string(),
                page: "skills".to_string(),
            }),
        };
        assert!(notifier.notify_advice(&advice));
    }

    #[test]
    fn test_notify_advice_rest_reminder() {
        let notifier = SafeMascotNotifier::new();
        let advice = Advice {
            advice_type: "rest_reminder".to_string(),
            title: "休息提醒".to_string(),
            message: "建议休息一下".to_string(),
            action: Some(MascotBubbleAction {
                action_type: "navigate".to_string(),
                page: "reflection".to_string(),
            }),
        };
        assert!(notifier.notify_advice(&advice));
    }

    #[test]
    fn test_bubble_payload_serialization() {
        let payload = MascotBubblePayload {
            bubble_type: MascotBubbleType::Insight,
            title: "标题".to_string(),
            message: "正文".to_string(),
            action: Some(MascotBubbleAction {
                action_type: "navigate".to_string(),
                page: "skills".to_string(),
            }),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("insight"));
        assert!(json.contains("标题"));
        assert!(json.contains("skills"));

        let deserialized: MascotBubblePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.bubble_type, MascotBubbleType::Insight);
        assert_eq!(deserialized.action.as_ref().unwrap().page, "skills");
    }

    #[test]
    fn test_today_string_format() {
        let today = today_string();
        // 格式应为 YYYY-MM-DD
        assert_eq!(today.len(), 10);
        assert_eq!(today.chars().nth(4), Some('-'));
        assert_eq!(today.chars().nth(7), Some('-'));
    }
}
