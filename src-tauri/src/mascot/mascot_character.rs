//! MascotCharacter：角色设计系统（spec M13.10）
//!
//! 为每种 MascotStyle 定义完整的角色设定：
//!  - 名字、性格、默认姿势、动画帧数
//!  - 气泡配色、问候风格
//!
//! 角色定义：
//!  - note（备忘录小鸟 📝）：认真负责，爱整理
//!  - film（胶片小熊 🎞）：浪漫文艺，善于回忆
//!  - copilot（宇航员猫 🚀）：高效专业，技术范
//!  - cursor（光标精灵 ✨）：灵动活泼，喜欢到处跑
//!  - paper（折纸狐狸 📜）：智慧温和，知识渊博

use serde::{Deserialize, Serialize};

use crate::models::MascotStyle;

// ===================== 角色结构 =====================

/// Mascot 角色完整设定
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MascotCharacter {
    /// 形象样式
    pub style: MascotStyle,
    /// 角色名字（含 emoji）
    pub name: String,
    /// 性格描述
    pub personality: String,
    /// 默认姿势
    pub default_pose: String,
    /// 动画帧数
    pub animation_frames: u8,
    /// 气泡背景色
    pub bubble_color: String,
    /// 问候风格
    pub greeting_style: String,
}

// ===================== 角色工厂 =====================

/// 根据样式获取角色设定
pub fn get_character(style: MascotStyle) -> MascotCharacter {
    match style {
        MascotStyle::Note => MascotCharacter {
            style: MascotStyle::Note,
            name: "备忘录小鸟 📝".to_string(),
            personality: "认真负责，爱整理".to_string(),
            default_pose: "standby".to_string(),
            animation_frames: 8,
            bubble_color: "#FFF9C4".to_string(),
            greeting_style: "friendly".to_string(),
        },
        MascotStyle::Film => MascotCharacter {
            style: MascotStyle::Film,
            name: "胶片小熊 🎞".to_string(),
            personality: "浪漫文艺，善于回忆".to_string(),
            default_pose: "standby".to_string(),
            animation_frames: 8,
            bubble_color: "#F3E5F5".to_string(),
            greeting_style: "poetic".to_string(),
        },
        MascotStyle::Copilot => MascotCharacter {
            style: MascotStyle::Copilot,
            name: "宇航员猫 🚀".to_string(),
            personality: "高效专业，技术范".to_string(),
            default_pose: "standby".to_string(),
            animation_frames: 6,
            bubble_color: "#E3F2FD".to_string(),
            greeting_style: "concise".to_string(),
        },
        MascotStyle::Cursor => MascotCharacter {
            style: MascotStyle::Cursor,
            name: "光标精灵 ✨".to_string(),
            personality: "灵动活泼，喜欢到处跑".to_string(),
            default_pose: "standby".to_string(),
            animation_frames: 8,
            bubble_color: "#E8F5E9".to_string(),
            greeting_style: "playful".to_string(),
        },
        MascotStyle::Paper => MascotCharacter {
            style: MascotStyle::Paper,
            name: "折纸狐狸 📜".to_string(),
            personality: "智慧温和，知识渊博".to_string(),
            default_pose: "standby".to_string(),
            animation_frames: 6,
            bubble_color: "#FFF3E0".to_string(),
            greeting_style: "wise".to_string(),
        },
    }
}

/// 获取所有角色设定
pub fn get_all_characters() -> Vec<MascotCharacter> {
    vec![
        get_character(MascotStyle::Note),
        get_character(MascotStyle::Film),
        get_character(MascotStyle::Copilot),
        get_character(MascotStyle::Cursor),
        get_character(MascotStyle::Paper),
    ]
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_note_character() {
        let c = get_character(MascotStyle::Note);
        assert_eq!(c.style, MascotStyle::Note);
        assert!(c.name.contains("备忘录小鸟"));
        assert!(c.name.contains("📝"));
        assert_eq!(c.personality, "认真负责，爱整理");
        assert_eq!(c.animation_frames, 8);
        assert_eq!(c.bubble_color, "#FFF9C4");
    }

    #[test]
    fn test_film_character() {
        let c = get_character(MascotStyle::Film);
        assert_eq!(c.style, MascotStyle::Film);
        assert!(c.name.contains("胶片小熊"));
        assert!(c.name.contains("🎞"));
        assert_eq!(c.personality, "浪漫文艺，善于回忆");
        assert_eq!(c.animation_frames, 8);
        assert_eq!(c.bubble_color, "#F3E5F5");
    }

    #[test]
    fn test_copilot_character() {
        let c = get_character(MascotStyle::Copilot);
        assert_eq!(c.style, MascotStyle::Copilot);
        assert!(c.name.contains("宇航员猫"));
        assert!(c.name.contains("🚀"));
        assert_eq!(c.personality, "高效专业，技术范");
        assert_eq!(c.animation_frames, 6);
        assert_eq!(c.bubble_color, "#E3F2FD");
    }

    #[test]
    fn test_cursor_character() {
        let c = get_character(MascotStyle::Cursor);
        assert_eq!(c.style, MascotStyle::Cursor);
        assert!(c.name.contains("光标精灵"));
        assert!(c.name.contains("✨"));
        assert_eq!(c.personality, "灵动活泼，喜欢到处跑");
        assert_eq!(c.animation_frames, 8);
        assert_eq!(c.bubble_color, "#E8F5E9");
    }

    #[test]
    fn test_paper_character() {
        let c = get_character(MascotStyle::Paper);
        assert_eq!(c.style, MascotStyle::Paper);
        assert!(c.name.contains("折纸狐狸"));
        assert!(c.name.contains("📜"));
        assert_eq!(c.personality, "智慧温和，知识渊博");
        assert_eq!(c.animation_frames, 6);
        assert_eq!(c.bubble_color, "#FFF3E0");
    }

    #[test]
    fn test_all_characters_count() {
        let all = get_all_characters();
        assert_eq!(all.len(), 5);
        // 验证每个角色名字非空
        for c in &all {
            assert!(!c.name.is_empty());
            assert!(!c.personality.is_empty());
            assert!(!c.bubble_color.is_empty());
            assert!(!c.greeting_style.is_empty());
            assert!(!c.default_pose.is_empty());
        }
    }

    #[test]
    fn test_all_bubble_colors_unique() {
        let all = get_all_characters();
        let colors: Vec<&str> = all.iter().map(|c| c.bubble_color.as_str()).collect();
        // 转为集合去重
        let unique: std::collections::HashSet<&str> = colors.iter().copied().collect();
        assert_eq!(unique.len(), 5, "每个角色的气泡颜色应唯一");
    }
}
