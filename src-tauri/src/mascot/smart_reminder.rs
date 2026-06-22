//! SmartReminder：智能提醒分级（spec M13.7）
//!
//! 根据触发类型与上下文，决定是否真的弹出提醒，并生成对应优先级与动作。
//!
//! 核心机制：
//!  - 不同触发器对应不同优先级与文案
//!  - 免打扰：两次提醒之间至少间隔 30 分钟（可配置）
//!  - 高优先级（如 ReportReady）可绕过部分免打扰限制
//!
//! 触发器与默认优先级：
//!  - Scheduled: Medium
//!  - Focus25Min: Medium（建议休息）
//!  - Fragmented5Min: Low（建议聚焦）
//!  - Idle30Min: Low
//!  - LateWork: High
//!  - ReportReady: High
//!  - WikiReviewDue: Medium
//!  - SkillUnlocked: Medium

use serde::{Deserialize, Serialize};

// ===================== 触发器 =====================

/// 提醒触发器
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderTrigger {
    /// 定时提醒
    Scheduled,
    /// 持续专注 25 分钟（建议休息）
    Focus25Min,
    /// 5 分钟内窗口切换过多（碎片化）
    Fragmented5Min,
    /// 空闲 30 分钟
    Idle30Min,
    /// 深夜工作
    LateWork,
    /// 报告就绪
    ReportReady,
    /// Wiki 待审核
    WikiReviewDue,
    /// 技能解锁
    SkillUnlocked,
}

// ===================== 优先级 =====================

/// 提醒优先级
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReminderPriority {
    Low,
    Medium,
    High,
}

// ===================== 气泡动作 =====================

/// 气泡动作按钮
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleAction {
    /// 按钮文案
    pub label: String,
    /// 跳转页面
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// 自定义动作标识
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

// ===================== 提醒消息 =====================

/// 提醒消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderMessage {
    /// 标题
    pub title: String,
    /// 正文
    pub body: String,
    /// 动作按钮列表
    pub actions: Vec<BubbleAction>,
    /// 优先级
    pub priority: ReminderPriority,
}

// ===================== 提醒上下文 =====================

/// 提醒上下文：用于判断是否应触发提醒
#[derive(Debug, Clone, Default)]
pub struct ReminderContext {
    /// 当前时间戳（秒）
    pub current_time: i64,
    /// 上次提醒时间戳（秒）
    pub last_reminder_time: Option<i64>,
    /// 持续专注分钟数
    pub focus_minutes: u32,
    /// 5 分钟内窗口切换次数
    pub window_switches_5min: u32,
    /// 空闲分钟数
    pub idle_minutes: u32,
    /// Wiki 待审核数量
    pub wiki_review_count: u32,
}

// ===================== 智能提醒器 =====================

/// 默认免打扰最小间隔（秒）：30 分钟
const DEFAULT_MIN_INTERVAL_SEC: i64 = 30 * 60;

/// 智能提醒器
pub struct SmartReminder {
    /// 最小提醒间隔（秒），默认 30 分钟
    min_interval_sec: i64,
}

impl SmartReminder {
    /// 创建智能提醒器，使用默认 30 分钟间隔
    pub fn new() -> Self {
        Self {
            min_interval_sec: DEFAULT_MIN_INTERVAL_SEC,
        }
    }

    /// 设置最小提醒间隔（秒）
    pub fn set_min_interval(&mut self, seconds: i64) {
        self.min_interval_sec = seconds;
    }

    /// 判断是否应该提醒。
    /// 返回 Some(ReminderMessage) 表示应弹出提醒；None 表示被免打扰拦截
    pub fn should_remind(
        &self,
        trigger: ReminderTrigger,
        ctx: &ReminderContext,
    ) -> Option<ReminderMessage> {
        // 高优先级触发器：ReportReady / LateWork 不受免打扰限制
        let is_high_priority = matches!(
            trigger,
            ReminderTrigger::ReportReady | ReminderTrigger::LateWork
        );

        if !is_high_priority {
            // 检查免打扰：距上次提醒是否超过最小间隔
            if let Some(last) = ctx.last_reminder_time {
                let elapsed = ctx.current_time - last;
                if elapsed < self.min_interval_sec {
                    // 间隔不足，拦截
                    return None;
                }
            }
        }

        Some(self.build_message(trigger, ctx))
    }

    /// 根据触发器构建提醒消息
    fn build_message(&self, trigger: ReminderTrigger, ctx: &ReminderContext) -> ReminderMessage {
        match trigger {
            ReminderTrigger::Scheduled => ReminderMessage {
                title: "该休息一下啦".to_string(),
                body: "已经工作一段时间了，站起来活动活动吧～".to_string(),
                actions: vec![BubbleAction {
                    label: "稍后提醒".to_string(),
                    page: None,
                    action: Some("snooze".to_string()),
                }],
                priority: ReminderPriority::Medium,
            },
            ReminderTrigger::Focus25Min => ReminderMessage {
                title: "专注 25 分钟啦 🎯".to_string(),
                body: format!(
                    "已连续专注 {} 分钟，建议休息 5 分钟保持节奏",
                    ctx.focus_minutes
                ),
                actions: vec![
                    BubbleAction {
                        label: "休息 5 分钟".to_string(),
                        page: None,
                        action: Some("take_break".to_string()),
                    },
                    BubbleAction {
                        label: "继续专注".to_string(),
                        page: None,
                        action: Some("continue_focus".to_string()),
                    },
                ],
                priority: ReminderPriority::Medium,
            },
            ReminderTrigger::Fragmented5Min => ReminderMessage {
                title: "注意力有点分散".to_string(),
                body: format!(
                    "5 分钟内切换了 {} 次窗口，要不要聚焦一件事？",
                    ctx.window_switches_5min
                ),
                actions: vec![BubbleAction {
                    label: "进入专注模式".to_string(),
                    page: Some("today".to_string()),
                    action: None,
                }],
                priority: ReminderPriority::Low,
            },
            ReminderTrigger::Idle30Min => ReminderMessage {
                title: "好像走神了".to_string(),
                body: format!("已空闲 {} 分钟，需要记录一下刚才在做什么吗？", ctx.idle_minutes),
                actions: vec![BubbleAction {
                    label: "快速记一笔".to_string(),
                    page: None,
                    action: Some("quick_note".to_string()),
                }],
                priority: ReminderPriority::Low,
            },
            ReminderTrigger::LateWork => ReminderMessage {
                title: "夜深了 🌙".to_string(),
                body: "这么晚还在工作，注意身体哦。要不要生成今日报告然后休息？".to_string(),
                actions: vec![
                    BubbleAction {
                        label: "生成报告".to_string(),
                        page: Some("reports".to_string()),
                        action: None,
                    },
                    BubbleAction {
                        label: "再坚持一会".to_string(),
                        page: None,
                        action: Some("snooze".to_string()),
                    },
                ],
                priority: ReminderPriority::High,
            },
            ReminderTrigger::ReportReady => ReminderMessage {
                title: "今日报告已就绪 📋".to_string(),
                body: "今天的工作记忆已整理完毕，要看看吗？".to_string(),
                actions: vec![BubbleAction {
                    label: "查看报告".to_string(),
                    page: Some("reports".to_string()),
                    action: None,
                }],
                priority: ReminderPriority::High,
            },
            ReminderTrigger::WikiReviewDue => ReminderMessage {
                title: "有知识待审核".to_string(),
                body: format!(
                    "当前有 {} 条 Wiki 知识等待你审核，要不要现在处理？",
                    ctx.wiki_review_count
                ),
                actions: vec![BubbleAction {
                    label: "去审核".to_string(),
                    page: Some("wiki".to_string()),
                    action: None,
                }],
                priority: ReminderPriority::Medium,
            },
            ReminderTrigger::SkillUnlocked => ReminderMessage {
                title: "解锁新技能 🎉".to_string(),
                body: "从近期工作中提炼出了一条新技能，来看看吧！".to_string(),
                actions: vec![BubbleAction {
                    label: "查看技能".to_string(),
                    page: Some("skills".to_string()),
                    action: None,
                }],
                priority: ReminderPriority::Medium,
            },
        }
    }
}

impl Default for SmartReminder {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_report_ready_bypasses_dnd() {
        let reminder = SmartReminder::new();
        // 上次提醒 1 分钟前（小于 30 分钟间隔）
        let ctx = ReminderContext {
            current_time: 1000,
            last_reminder_time: Some(940), // 60 秒前
            focus_minutes: 0,
            window_switches_5min: 0,
            idle_minutes: 0,
            wiki_review_count: 0,
        };
        // ReportReady 是高优先级，应绕过免打扰
        let msg = reminder.should_remind(ReminderTrigger::ReportReady, &ctx);
        assert!(msg.is_some());
        let msg = msg.unwrap();
        assert_eq!(msg.priority, ReminderPriority::High);
        assert!(msg.title.contains("报告"));
    }

    #[test]
    fn test_late_work_bypasses_dnd() {
        let reminder = SmartReminder::new();
        let ctx = ReminderContext {
            current_time: 1000,
            last_reminder_time: Some(990), // 10 秒前
            ..Default::default()
        };
        let msg = reminder.should_remind(ReminderTrigger::LateWork, &ctx);
        assert!(msg.is_some());
        assert_eq!(msg.unwrap().priority, ReminderPriority::High);
    }

    #[test]
    fn test_normal_reminder_blocked_by_dnd() {
        let reminder = SmartReminder::new();
        // 上次提醒 10 分钟前（小于 30 分钟间隔）
        let ctx = ReminderContext {
            current_time: 1000,
            last_reminder_time: Some(400), // 600 秒前 = 10 分钟
            ..Default::default()
        };
        // Scheduled 是普通优先级，应被免打扰拦截
        let msg = reminder.should_remind(ReminderTrigger::Scheduled, &ctx);
        assert!(msg.is_none());
    }

    #[test]
    fn test_normal_reminder_allowed_after_interval() {
        let reminder = SmartReminder::new();
        // 上次提醒 31 分钟前（超过 30 分钟间隔）
        let ctx = ReminderContext {
            current_time: 1000,
            last_reminder_time: Some(1000 - 31 * 60), // 31 分钟前
            ..Default::default()
        };
        let msg = reminder.should_remind(ReminderTrigger::Scheduled, &ctx);
        assert!(msg.is_some());
        assert_eq!(msg.unwrap().priority, ReminderPriority::Medium);
    }

    #[test]
    fn test_first_reminder_no_dnd_check() {
        let reminder = SmartReminder::new();
        // 没有上次提醒记录，不应被拦截
        let ctx = ReminderContext {
            current_time: 1000,
            last_reminder_time: None,
            ..Default::default()
        };
        let msg = reminder.should_remind(ReminderTrigger::Focus25Min, &ctx);
        assert!(msg.is_some());
    }

    #[test]
    fn test_focus_25min_message_content() {
        let reminder = SmartReminder::new();
        let ctx = ReminderContext {
            focus_minutes: 28,
            ..Default::default()
        };
        let msg = reminder.should_remind(ReminderTrigger::Focus25Min, &ctx).unwrap();
        assert!(msg.title.contains("25"));
        assert!(msg.body.contains("28"));
        assert_eq!(msg.actions.len(), 2);
        assert_eq!(msg.priority, ReminderPriority::Medium);
    }

    #[test]
    fn test_fragmented_message_content() {
        let reminder = SmartReminder::new();
        let ctx = ReminderContext {
            window_switches_5min: 12,
            ..Default::default()
        };
        let msg = reminder.should_remind(ReminderTrigger::Fragmented5Min, &ctx).unwrap();
        assert!(msg.body.contains("12"));
        assert_eq!(msg.priority, ReminderPriority::Low);
    }

    #[test]
    fn test_wiki_review_message_content() {
        let reminder = SmartReminder::new();
        let ctx = ReminderContext {
            wiki_review_count: 5,
            ..Default::default()
        };
        let msg = reminder.should_remind(ReminderTrigger::WikiReviewDue, &ctx).unwrap();
        assert!(msg.body.contains("5"));
        assert_eq!(msg.priority, ReminderPriority::Medium);
    }

    #[test]
    fn test_skill_unlocked_message_content() {
        let reminder = SmartReminder::new();
        let ctx = ReminderContext::default();
        let msg = reminder.should_remind(ReminderTrigger::SkillUnlocked, &ctx).unwrap();
        assert!(msg.title.contains("技能"));
        assert_eq!(msg.priority, ReminderPriority::Medium);
    }

    #[test]
    fn test_configurable_interval() {
        let mut reminder = SmartReminder::new();
        // 设置为 60 分钟
        reminder.set_min_interval(60 * 60);

        let ctx = ReminderContext {
            current_time: 10_000,
            last_reminder_time: Some(10_000 - 40 * 60), // 40 分钟前
            ..Default::default()
        };
        // 40 分钟 < 60 分钟间隔，应被拦截
        assert!(reminder
            .should_remind(ReminderTrigger::Scheduled, &ctx)
            .is_none());

        // 调回 30 分钟，40 分钟前 > 30 分钟，应允许
        reminder.set_min_interval(30 * 60);
        assert!(reminder
            .should_remind(ReminderTrigger::Scheduled, &ctx)
            .is_some());
    }
}
