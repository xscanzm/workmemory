//! NotificationCenter：通知中心（spec M13.14）
//!
//! 提供今日记忆汇总与悬浮卡片展示能力：
//!  - get_today_summary()：返回今日事件列表、专注小时数、切换次数
//!  - show_floating_card()：返回带动作按钮的悬浮卡片数据
//!
//! 数据来源由调用方注入（EpisodeManager 等），本模块仅负责结构化封装。

use serde::{Deserialize, Serialize};

use crate::mascot::smart_reminder::BubbleAction;

// ===================== 汇总结构 =====================

/// 今日汇总条目（单条事件）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SummaryEntry {
    /// 时间（HH:MM）
    pub time: String,
    /// 颜色标签（按活动类型着色）
    pub color: String,
    /// 标题
    pub title: String,
}

/// 今日汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodaySummary {
    /// 日期（YYYY-MM-DD）
    pub date: String,
    /// 事件列表
    pub episodes: Vec<SummaryEntry>,
    /// 专注小时数
    pub focus_hours: f64,
    /// 窗口切换次数
    pub switch_count: u32,
}

impl Default for TodaySummary {
    fn default() -> Self {
        Self {
            date: String::new(),
            episodes: Vec::new(),
            focus_hours: 0.0,
            switch_count: 0,
        }
    }
}

/// 悬浮卡片：汇总 + 动作按钮
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FloatingCard {
    /// 今日汇总
    pub summary: TodaySummary,
    /// 动作按钮列表
    pub actions: Vec<BubbleAction>,
}

// ===================== 通知中心 =====================

/// 通知中心：管理今日汇总与悬浮卡片
pub struct NotificationCenter {
    /// 今日汇总缓存
    today_summary: TodaySummary,
}

impl NotificationCenter {
    /// 创建通知中心，初始为空汇总
    pub fn new() -> Self {
        Self {
            today_summary: TodaySummary::default(),
        }
    }

    /// 更新今日汇总数据
    pub fn set_today_summary(&mut self, summary: TodaySummary) {
        self.today_summary = summary;
    }

    /// 获取今日汇总
    pub fn get_today_summary(&self) -> TodaySummary {
        self.today_summary.clone()
    }

    /// 生成悬浮卡片：包含今日汇总与默认动作按钮
    pub fn show_floating_card(&self) -> FloatingCard {
        FloatingCard {
            summary: self.today_summary.clone(),
            actions: vec![
                BubbleAction {
                    label: "查看今日".to_string(),
                    page: Some("today".to_string()),
                    action: None,
                },
                BubbleAction {
                    label: "生成报告".to_string(),
                    page: Some("reports".to_string()),
                    action: None,
                },
                BubbleAction {
                    label: "稍后再看".to_string(),
                    page: None,
                    action: Some("dismiss".to_string()),
                },
            ],
        }
    }
}

impl Default for NotificationCenter {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_summary_empty() {
        let center = NotificationCenter::new();
        let summary = center.get_today_summary();
        assert!(summary.episodes.is_empty());
        assert_eq!(summary.focus_hours, 0.0);
        assert_eq!(summary.switch_count, 0);
    }

    #[test]
    fn test_set_and_get_today_summary() {
        let mut center = NotificationCenter::new();
        let summary = TodaySummary {
            date: "2026-06-22".to_string(),
            episodes: vec![
                SummaryEntry {
                    time: "09:30".to_string(),
                    color: "#2196F3".to_string(),
                    title: "写需求文档".to_string(),
                },
                SummaryEntry {
                    time: "11:00".to_string(),
                    color: "#4CAF50".to_string(),
                    title: "代码评审".to_string(),
                },
            ],
            focus_hours: 2.5,
            switch_count: 15,
        };
        center.set_today_summary(summary);

        let got = center.get_today_summary();
        assert_eq!(got.date, "2026-06-22");
        assert_eq!(got.episodes.len(), 2);
        assert_eq!(got.episodes[0].time, "09:30");
        assert_eq!(got.episodes[1].title, "代码评审");
        assert_eq!(got.focus_hours, 2.5);
        assert_eq!(got.switch_count, 15);
    }

    #[test]
    fn test_floating_card_contains_summary_and_actions() {
        let mut center = NotificationCenter::new();
        center.set_today_summary(TodaySummary {
            date: "2026-06-22".to_string(),
            episodes: vec![SummaryEntry {
                time: "10:00".to_string(),
                color: "#FF9800".to_string(),
                title: "测试任务".to_string(),
            }],
            focus_hours: 1.0,
            switch_count: 5,
        });

        let card = center.show_floating_card();
        // 验证汇总已注入卡片
        assert_eq!(card.summary.date, "2026-06-22");
        assert_eq!(card.summary.episodes.len(), 1);
        // 验证动作按钮
        assert!(!card.actions.is_empty());
        let labels: Vec<&str> = card.actions.iter().map(|a| a.label.as_str()).collect();
        assert!(labels.contains(&"查看今日"));
        assert!(labels.contains(&"生成报告"));
        assert!(labels.contains(&"稍后再看"));
    }

    #[test]
    fn test_floating_card_default_actions() {
        let center = NotificationCenter::new();
        let card = center.show_floating_card();
        // 默认应有 3 个动作
        assert_eq!(card.actions.len(), 3);
        // 验证跳转目标
        assert!(card.actions.iter().any(|a| a.page.as_deref() == Some("today")));
        assert!(card.actions.iter().any(|a| a.page.as_deref() == Some("reports")));
        assert!(card.actions.iter().any(|a| a.action.as_deref() == Some("dismiss")));
    }
}
