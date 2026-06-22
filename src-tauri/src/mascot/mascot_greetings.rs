//! MascotGreetings：上下文感知问候语生成（spec M13.5）
//!
//! 根据时段、记录状态、专注时长、Episode 数量、报告状态等上下文
//! 生成合适的问候/提示文案，让 Mascot 显得更"懂你"。
//!
//! 问候规则（按优先级从高到低匹配）：
//!  1. 深夜（hour >= 23）：提醒休息
//!  2. 周一早晨（day=1, 6-9h）：回顾上周成果
//!  3. 报告就绪：邀请查看报告
//!  4. 长时间专注（focus_minutes > 20）：表扬并建议休息
//!  5. 第一件事（episode_count == 1）：欢迎首次记录
//!  6. 早晨开始（6-9h）：早安问候
//!  7. 默认：通用问候

use crate::models::MascotState;

// ===================== 上下文结构 =====================

/// 问候上下文：包含生成问候所需的全部信号
#[derive(Debug, Clone)]
pub struct GreetingContext {
    /// 当前小时（0-23）
    pub hour: u32,
    /// 当前 Mascot 记录状态
    pub state: MascotState,
    /// 持续专注分钟数
    pub focus_minutes: u32,
    /// 当天已记录的 Episode 数量
    pub episode_count: u32,
    /// 报告是否已就绪
    pub report_ready: bool,
    /// 星期几（1=周一 ... 7=周日）
    pub day_of_week: u32,
    /// 上周完成的项目数
    pub last_week_projects: u32,
    /// 第一件事的标题（episode_count == 1 时使用）
    pub first_episode_title: String,
}

impl Default for GreetingContext {
    fn default() -> Self {
        Self {
            hour: 9,
            state: MascotState::Recording,
            focus_minutes: 0,
            episode_count: 0,
            report_ready: false,
            day_of_week: 1,
            last_week_projects: 0,
            first_episode_title: String::new(),
        }
    }
}

// ===================== 问候生成器 =====================

/// 问候生成器：根据上下文产出问候文案
pub struct GreetingGenerator;

impl GreetingGenerator {
    /// 创建问候生成器
    pub fn new() -> Self {
        Self
    }

    /// 根据上下文生成问候语
    pub fn generate_greeting(&self, ctx: &GreetingContext) -> String {
        // 1. 深夜提醒（最高优先级）
        if ctx.hour >= 23 {
            return format!("都 {} 点了，注意休息哦 🌙", ctx.hour);
        }

        // 2. 周一早晨：回顾上周成果
        if ctx.day_of_week == 1 && ctx.hour >= 6 && ctx.hour <= 9 {
            return format!(
                "新的一周开始！上周你完成了 {} 个项目 💪",
                ctx.last_week_projects
            );
        }

        // 3. 报告就绪
        if ctx.report_ready {
            return "今天的工作报告整理好啦，要看看吗？📋".to_string();
        }

        // 4. 长时间专注：表扬并建议休息
        if ctx.focus_minutes > 20 {
            return format!(
                "刚才连续专注了 {} 分钟，厉害！可以休息一下了 ☕",
                ctx.focus_minutes
            );
        }

        // 5. 第一件事：欢迎首次记录
        if ctx.episode_count == 1 && !ctx.first_episode_title.is_empty() {
            return format!("记录到第一件事啦：{}", ctx.first_episode_title);
        }

        // 6. 早晨开始
        if ctx.hour >= 6 && ctx.hour <= 9 {
            // 偶数小时返回第一种文案，奇数小时返回第二种，增加变化
            if ctx.hour % 2 == 0 {
                return "早上好！今天要做什么大事？☀️".to_string();
            } else {
                return "新的一天，准备好了吗 👊".to_string();
            }
        }

        // 7. 默认问候
        "继续加油吧，我在旁边陪着你～".to_string()
    }
}

impl Default for GreetingGenerator {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_morning_start_greeting() {
        let gen = GreetingGenerator::new();
        // 6 点（偶数）：第一种文案。使用周二避免周一早晨规则优先触发
        let ctx = GreetingContext {
            hour: 6,
            day_of_week: 2,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(g.contains("早上好"));
        assert!(g.contains("☀️"));

        // 7 点（奇数）：第二种文案
        let ctx = GreetingContext {
            hour: 7,
            day_of_week: 3,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(g.contains("新的一天"));
        assert!(g.contains("👊"));
    }

    #[test]
    fn test_after_focus_greeting() {
        let gen = GreetingGenerator::new();
        let ctx = GreetingContext {
            hour: 14,
            focus_minutes: 45,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(g.contains("45"));
        assert!(g.contains("专注"));
        assert!(g.contains("☕"));
    }

    #[test]
    fn test_after_focus_boundary_not_triggered() {
        let gen = GreetingGenerator::new();
        // 恰好 20 分钟：不触发（条件是 > 20）
        let ctx = GreetingContext {
            hour: 14,
            focus_minutes: 20,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(!g.contains("专注"));
    }

    #[test]
    fn test_report_ready_greeting() {
        let gen = GreetingGenerator::new();
        let ctx = GreetingContext {
            hour: 14,
            report_ready: true,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(g.contains("工作报告"));
        assert!(g.contains("📋"));
    }

    #[test]
    fn test_late_night_greeting() {
        let gen = GreetingGenerator::new();
        // hour >= 23 触发深夜提醒
        let ctx = GreetingContext {
            hour: 23,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(g.contains("23"));
        assert!(g.contains("休息"));
        assert!(g.contains("🌙"));

        // hour=1 不在深夜提醒范围（spec: hour >= 23），应返回其他问候
        let ctx = GreetingContext {
            hour: 1,
            day_of_week: 3,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(!g.contains("🌙"));
    }

    #[test]
    fn test_monday_morning_greeting() {
        let gen = GreetingGenerator::new();
        let ctx = GreetingContext {
            hour: 8,
            day_of_week: 1,
            last_week_projects: 3,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(g.contains("新的一周"));
        assert!(g.contains("3"));
        assert!(g.contains("💪"));
    }

    #[test]
    fn test_monday_morning_outside_window() {
        let gen = GreetingGenerator::new();
        // 周一但不在 6-9h 范围
        let ctx = GreetingContext {
            hour: 11,
            day_of_week: 1,
            last_week_projects: 3,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(!g.contains("新的一周"));
    }

    #[test]
    fn test_first_episode_greeting() {
        let gen = GreetingGenerator::new();
        let ctx = GreetingContext {
            hour: 14,
            episode_count: 1,
            first_episode_title: "写需求文档".to_string(),
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(g.contains("第一件事"));
        assert!(g.contains("写需求文档"));
    }

    #[test]
    fn test_default_greeting() {
        let gen = GreetingGenerator::new();
        // 下午 14 点，无任何特殊上下文
        let ctx = GreetingContext {
            hour: 14,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        assert!(!g.is_empty());
    }

    #[test]
    fn test_priority_late_night_over_monday() {
        let gen = GreetingGenerator::new();
        // 周一深夜 23 点：深夜提醒优先于周一早晨（虽然周一早晨窗口是 6-9h，此处验证深夜优先级）
        let ctx = GreetingContext {
            hour: 23,
            day_of_week: 1,
            last_week_projects: 5,
            ..Default::default()
        };
        let g = gen.generate_greeting(&ctx);
        // 应该是深夜提醒，不是周一早晨
        assert!(g.contains("🌙"));
        assert!(!g.contains("新的一周"));
    }
}
