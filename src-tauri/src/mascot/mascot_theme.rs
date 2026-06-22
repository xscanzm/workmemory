//! MascotTheme：深色模式适配（spec M13.13）
//!
//! 根据系统/用户主题模式，提供 Mascot 气泡与角色配色方案。
//!
//! 配色规则：
//!  - 深色模式：
//!    - 气泡背景 #2D2D2D，文字 #E0E0E0，边框 #444444
//!    - 角色主色 #64B5F6，副色 #81C784，强调色 #FFB74D
//!  - 浅色模式：
//!    - 气泡背景 rgba(255,255,255,0.85)，文字 #333333，边框 #E0E0E0
//!    - 角色主色 #2196F3，副色 #4CAF50，强调色 #FF9800

use serde::{Deserialize, Serialize};

// ===================== 配色结构 =====================

/// 气泡配色
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BubbleColors {
    /// 背景色
    pub background: String,
    /// 文字颜色
    pub text: String,
    /// 边框颜色
    pub border: String,
}

/// Mascot 角色配色
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MascotColors {
    /// 主色
    pub primary: String,
    /// 副色
    pub secondary: String,
    /// 强调色
    pub accent: String,
}

// ===================== 主题管理器 =====================

/// 主题管理器：维护当前深/浅色模式并产出配色
pub struct MascotTheme {
    /// 是否为深色模式
    dark_mode: bool,
}

impl MascotTheme {
    /// 创建主题管理器，默认浅色模式
    pub fn new() -> Self {
        Self { dark_mode: false }
    }

    /// 创建指定模式的主题管理器
    pub fn with_mode(dark: bool) -> Self {
        Self { dark_mode: dark }
    }

    /// 当前是否为深色模式
    pub fn is_dark_mode(&self) -> bool {
        self.dark_mode
    }

    /// 设置深色/浅色模式
    pub fn set_dark_mode(&mut self, dark: bool) {
        self.dark_mode = dark;
    }

    /// 获取气泡配色
    pub fn get_bubble_colors(&self) -> BubbleColors {
        if self.dark_mode {
            BubbleColors {
                background: "#2D2D2D".to_string(),
                text: "#E0E0E0".to_string(),
                border: "#444444".to_string(),
            }
        } else {
            BubbleColors {
                background: "rgba(255,255,255,0.85)".to_string(),
                text: "#333333".to_string(),
                border: "#E0E0E0".to_string(),
            }
        }
    }

    /// 获取 Mascot 角色配色
    pub fn get_mascot_colors(&self) -> MascotColors {
        if self.dark_mode {
            MascotColors {
                primary: "#64B5F6".to_string(),
                secondary: "#81C784".to_string(),
                accent: "#FFB74D".to_string(),
            }
        } else {
            MascotColors {
                primary: "#2196F3".to_string(),
                secondary: "#4CAF50".to_string(),
                accent: "#FF9800".to_string(),
            }
        }
    }
}

impl Default for MascotTheme {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_is_light_mode() {
        let theme = MascotTheme::new();
        assert!(!theme.is_dark_mode());
    }

    #[test]
    fn test_light_mode_bubble_colors() {
        let theme = MascotTheme::with_mode(false);
        let colors = theme.get_bubble_colors();
        assert_eq!(colors.background, "rgba(255,255,255,0.85)");
        assert_eq!(colors.text, "#333333");
        assert_eq!(colors.border, "#E0E0E0");
    }

    #[test]
    fn test_dark_mode_bubble_colors() {
        let theme = MascotTheme::with_mode(true);
        let colors = theme.get_bubble_colors();
        assert_eq!(colors.background, "#2D2D2D");
        assert_eq!(colors.text, "#E0E0E0");
        assert_eq!(colors.border, "#444444");
    }

    #[test]
    fn test_light_mode_mascot_colors() {
        let theme = MascotTheme::with_mode(false);
        let colors = theme.get_mascot_colors();
        assert_eq!(colors.primary, "#2196F3");
        assert_eq!(colors.secondary, "#4CAF50");
        assert_eq!(colors.accent, "#FF9800");
    }

    #[test]
    fn test_dark_mode_mascot_colors() {
        let theme = MascotTheme::with_mode(true);
        let colors = theme.get_mascot_colors();
        assert_eq!(colors.primary, "#64B5F6");
        assert_eq!(colors.secondary, "#81C784");
        assert_eq!(colors.accent, "#FFB74D");
    }

    #[test]
    fn test_set_dark_mode_toggles_colors() {
        let mut theme = MascotTheme::new();
        // 初始浅色
        assert_eq!(theme.get_bubble_colors().background, "rgba(255,255,255,0.85)");

        // 切换到深色
        theme.set_dark_mode(true);
        assert!(theme.is_dark_mode());
        assert_eq!(theme.get_bubble_colors().background, "#2D2D2D");

        // 切换回浅色
        theme.set_dark_mode(false);
        assert!(!theme.is_dark_mode());
        assert_eq!(theme.get_bubble_colors().background, "rgba(255,255,255,0.85)");
    }

    #[test]
    fn test_colors_change_with_mode() {
        let mut theme = MascotTheme::new();
        let light_bubble = theme.get_bubble_colors();
        let light_mascot = theme.get_mascot_colors();

        theme.set_dark_mode(true);
        let dark_bubble = theme.get_bubble_colors();
        let dark_mascot = theme.get_mascot_colors();

        // 深浅模式配色应不同
        assert_ne!(light_bubble.background, dark_bubble.background);
        assert_ne!(light_bubble.text, dark_bubble.text);
        assert_ne!(light_mascot.primary, dark_mascot.primary);
        assert_ne!(light_mascot.secondary, dark_mascot.secondary);
        assert_ne!(light_mascot.accent, dark_mascot.accent);
    }
}
