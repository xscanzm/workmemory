//! MascotInteraction：分层点击交互（spec M13.6）
//!
//! 为桌面伙伴提供分层点击行为：
//!  - 左键单击：根据上下文导航（未读报告 → 待办 → 名言）
//!  - 右键单击：弹出上下文菜单
//!  - 鼠标悬停：显示工具提示
//!  - 右键双击：触发幽灵捕获（Ghost Capture）
//!
//! 交互上下文由调用方注入（如未读报告标志、待办数量、今日记录数、专注小时数）。

use serde::{Deserialize, Serialize};

// ===================== 点击动作 =====================

/// 左键单击触发的动作
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClickAction {
    /// 跳转到今日报告
    NavigateToReport,
    /// 显示待办列表
    ShowTodos,
    /// 显示一句名言/鼓励
    ShowQuote,
    /// 触发幽灵捕获（手动抓取当前屏幕快照）
    TriggerGhostCapture,
}

// ===================== 上下文菜单 =====================

/// 上下文菜单项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenuItem {
    /// 菜单文案
    pub label: String,
    /// 图标（emoji 或图标名）
    pub icon: String,
    /// 动作标识
    pub action: String,
}

/// 上下文菜单
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMenu {
    /// 菜单项列表
    pub items: Vec<ContextMenuItem>,
}

// ===================== 悬停提示 =====================

/// 鼠标悬停时显示的工具提示
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HoverTooltip {
    /// 提示文本，例如 "今日已记录 5 件事，专注 2.5h"
    pub text: String,
}

// ===================== 交互上下文 =====================

/// 交互上下文：由调用方注入，决定左键单击行为
#[derive(Debug, Clone, Default)]
pub struct InteractionContext {
    /// 是否有未读报告
    pub unread_report: bool,
    /// 是否有待办事项
    pub has_todos: bool,
    /// 今日已记录事件数
    pub today_episode_count: u32,
    /// 今日专注小时数
    pub focus_hours: f64,
}

// ===================== 交互处理器 =====================

/// 分层点击交互处理器
pub struct MascotInteraction {
    /// 交互上下文
    ctx: InteractionContext,
}

impl MascotInteraction {
    /// 创建交互处理器
    pub fn new() -> Self {
        Self {
            ctx: InteractionContext::default(),
        }
    }

    /// 更新交互上下文
    pub fn set_context(&mut self, ctx: InteractionContext) {
        self.ctx = ctx;
    }

    /// 左键单击：按优先级返回导航动作
    /// 优先级：未读报告 > 待办 > 名言
    pub fn on_left_click(&self) -> ClickAction {
        if self.ctx.unread_report {
            ClickAction::NavigateToReport
        } else if self.ctx.has_todos {
            ClickAction::ShowTodos
        } else {
            ClickAction::ShowQuote
        }
    }

    /// 右键单击：返回上下文菜单
    pub fn on_right_click(&self) -> ContextMenu {
        ContextMenu {
            items: vec![
                ContextMenuItem {
                    label: "今日记忆".to_string(),
                    icon: "📋".to_string(),
                    action: "today_memory".to_string(),
                },
                ContextMenuItem {
                    label: "暂停记录".to_string(),
                    icon: "⏸".to_string(),
                    action: "pause_capture".to_string(),
                },
                ContextMenuItem {
                    label: "快速记一笔".to_string(),
                    icon: "📝".to_string(),
                    action: "quick_note".to_string(),
                },
                ContextMenuItem {
                    label: "设置".to_string(),
                    icon: "⚙️".to_string(),
                    action: "settings".to_string(),
                },
                ContextMenuItem {
                    label: "隐藏 10min".to_string(),
                    icon: "👁".to_string(),
                    action: "hide_10min".to_string(),
                },
            ],
        }
    }

    /// 鼠标悬停：返回工具提示
    pub fn on_hover(&self) -> HoverTooltip {
        HoverTooltip {
            text: format!(
                "今日已记录 {} 件事，专注 {}h",
                self.ctx.today_episode_count, self.ctx.focus_hours
            ),
        }
    }

    /// 右键双击：触发幽灵捕获
    pub fn on_right_double_click(&self) -> ClickAction {
        ClickAction::TriggerGhostCapture
    }
}

impl Default for MascotInteraction {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_left_click_unread_report_priority() {
        let mut interaction = MascotInteraction::new();
        interaction.set_context(InteractionContext {
            unread_report: true,
            has_todos: true,
            today_episode_count: 5,
            focus_hours: 2.5,
        });
        // 未读报告优先级最高
        assert_eq!(interaction.on_left_click(), ClickAction::NavigateToReport);
    }

    #[test]
    fn test_left_click_todos_when_no_report() {
        let mut interaction = MascotInteraction::new();
        interaction.set_context(InteractionContext {
            unread_report: false,
            has_todos: true,
            today_episode_count: 3,
            focus_hours: 1.0,
        });
        assert_eq!(interaction.on_left_click(), ClickAction::ShowTodos);
    }

    #[test]
    fn test_left_click_quote_when_nothing_else() {
        let mut interaction = MascotInteraction::new();
        interaction.set_context(InteractionContext {
            unread_report: false,
            has_todos: false,
            today_episode_count: 0,
            focus_hours: 0.0,
        });
        assert_eq!(interaction.on_left_click(), ClickAction::ShowQuote);
    }

    #[test]
    fn test_right_click_menu_items() {
        let interaction = MascotInteraction::new();
        let menu = interaction.on_right_click();
        assert_eq!(menu.items.len(), 5);

        // 验证菜单项内容
        let labels: Vec<&str> = menu.items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"今日记忆"));
        assert!(labels.contains(&"暂停记录"));
        assert!(labels.contains(&"快速记一笔"));
        assert!(labels.contains(&"设置"));
        assert!(labels.contains(&"隐藏 10min"));

        // 验证图标存在
        for item in &menu.items {
            assert!(!item.icon.is_empty());
            assert!(!item.action.is_empty());
        }
    }

    #[test]
    fn test_hover_tooltip_content() {
        let mut interaction = MascotInteraction::new();
        interaction.set_context(InteractionContext {
            unread_report: false,
            has_todos: false,
            today_episode_count: 7,
            focus_hours: 3.5,
        });
        let tooltip = interaction.on_hover();
        assert!(tooltip.text.contains("7"));
        assert!(tooltip.text.contains("3.5"));
        assert!(tooltip.text.contains("件事"));
        assert!(tooltip.text.contains("专注"));
    }

    #[test]
    fn test_right_double_click_triggers_ghost_capture() {
        let interaction = MascotInteraction::new();
        assert_eq!(
            interaction.on_right_double_click(),
            ClickAction::TriggerGhostCapture
        );
    }

    #[test]
    fn test_default_context_left_click_is_quote() {
        let interaction = MascotInteraction::new();
        // 默认上下文：无未读报告、无待办
        assert_eq!(interaction.on_left_click(), ClickAction::ShowQuote);
    }
}
