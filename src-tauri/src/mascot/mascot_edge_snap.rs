//! MascotEdgeSnap：边缘吸附（spec M13.12）
//!
//! 当 Mascot 被拖动到屏幕边缘 50px 范围内时，自动吸附到屏幕左/右边缘。
//! 吸附位置：
//!  - 左边缘：x = 20
//!  - 右边缘：x = screen_w - mascot_size - 20
//!  - Y 坐标保持不变
//!
//! 不在 50px 吸附范围内则保持原位置。

// ===================== 边缘吸附器 =====================

/// 吸附边缘阈值（像素）：距边缘 50px 内触发吸附
const SNAP_THRESHOLD: i32 = 50;

/// 吸附后距边缘的留白（像素）
const SNAP_MARGIN: i32 = 20;

/// 边缘吸附器
pub struct EdgeSnap;

impl EdgeSnap {
    /// 创建边缘吸附器
    pub fn new() -> Self {
        Self
    }

    /// 计算吸附后的坐标。
    ///
    /// 参数：
    ///  - x, y: 当前 Mascot 左上角坐标
    ///  - screen_w, screen_h: 屏幕宽高
    ///  - mascot_size: Mascot 尺寸（宽高相同）
    ///
    /// 返回：(new_x, new_y)
    ///  - 若距左边缘 ≤ 50px：吸附到 x = 20
    ///  - 若距右边缘 ≤ 50px：吸附到 x = screen_w - mascot_size - 20
    ///  - 否则：保持原 x
    ///  - y 始终保持不变
    pub fn snap_to_edge(
        &self,
        x: i32,
        y: i32,
        screen_w: i32,
        screen_h: i32,
        mascot_size: i32,
    ) -> (i32, i32) {
        let _ = screen_h; // 屏幕高度当前未参与计算，保留参数以备扩展

        // 距左边缘的距离
        let dist_left = x;
        // 距右边缘的距离（mascot 右边到屏幕右边的距离）
        let dist_right = screen_w - (x + mascot_size);

        // 同时靠近两边（屏幕极窄）时，选择更近的一边
        if dist_left <= SNAP_THRESHOLD && dist_right <= SNAP_THRESHOLD {
            if dist_left <= dist_right {
                return (SNAP_MARGIN, y);
            } else {
                return (screen_w - mascot_size - SNAP_MARGIN, y);
            }
        }

        // 仅靠近左边缘
        if dist_left <= SNAP_THRESHOLD {
            return (SNAP_MARGIN, y);
        }

        // 仅靠近右边缘
        if dist_right <= SNAP_THRESHOLD {
            return (screen_w - mascot_size - SNAP_MARGIN, y);
        }

        // 不在吸附范围
        (x, y)
    }
}

impl Default for EdgeSnap {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试辅助：屏幕 1920x1080，mascot 64x64
    const SCREEN_W: i32 = 1920;
    const SCREEN_H: i32 = 1080;
    const MASCOT_SIZE: i32 = 64;

    #[test]
    fn test_snap_to_left_edge() {
        let snap = EdgeSnap::new();
        // x=10：距左边缘 10px，在 50px 阈值内
        let (new_x, new_y) = snap.snap_to_edge(10, 100, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, 20);
        assert_eq!(new_y, 100); // y 保持不变
    }

    #[test]
    fn test_snap_to_right_edge() {
        let snap = EdgeSnap::new();
        // mascot 右边距屏幕右边 10px：x = 1920 - 64 - 10 = 1846
        let x = SCREEN_W - MASCOT_SIZE - 10;
        let (new_x, new_y) = snap.snap_to_edge(x, 200, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, SCREEN_W - MASCOT_SIZE - 20);
        assert_eq!(new_y, 200);
    }

    #[test]
    fn test_no_snap_when_in_middle() {
        let snap = EdgeSnap::new();
        // x=960：屏幕中间，不在吸附范围
        let (new_x, new_y) = snap.snap_to_edge(960, 500, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, 960);
        assert_eq!(new_y, 500);
    }

    #[test]
    fn test_snap_boundary_exactly_50px() {
        let snap = EdgeSnap::new();
        // 恰好 50px：在阈值内（<=50），应吸附
        let (new_x, _) = snap.snap_to_edge(50, 100, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, 20);

        // 右边恰好 50px：x = 1920 - 64 - 50 = 1806
        let x = SCREEN_W - MASCOT_SIZE - 50;
        let (new_x, _) = snap.snap_to_edge(x, 100, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, SCREEN_W - MASCOT_SIZE - 20);
    }

    #[test]
    fn test_no_snap_just_outside_threshold() {
        let snap = EdgeSnap::new();
        // 距左边缘 51px：超出阈值，不吸附
        let (new_x, _) = snap.snap_to_edge(51, 100, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, 51);

        // 距右边缘 51px：x = 1920 - 64 - 51 = 1805
        let x = SCREEN_W - MASCOT_SIZE - 51;
        let (new_x, _) = snap.snap_to_edge(x, 100, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, x);
    }

    #[test]
    fn test_y_always_preserved() {
        let snap = EdgeSnap::new();
        // 各种 x 位置，y 都应保持不变
        let test_cases = vec![0, 10, 100, 960, 1800, 1900];
        for &x in &test_cases {
            let (_, new_y) = snap.snap_to_edge(x, 42, SCREEN_W, SCREEN_H, MASCOT_SIZE);
            assert_eq!(new_y, 42, "y 应保持不变（x={}）", x);
        }
    }

    #[test]
    fn test_negative_x_snaps_to_left() {
        let snap = EdgeSnap::new();
        // 拖出屏幕左边（负数）：应吸附到左边
        let (new_x, _) = snap.snap_to_edge(-30, 100, SCREEN_W, SCREEN_H, MASCOT_SIZE);
        assert_eq!(new_x, 20);
    }

    #[test]
    fn test_narrow_screen_both_edges_close() {
        let snap = EdgeSnap::new();
        // 极窄屏幕：宽 100，mascot 64，左右都在 50px 内
        // x=10：距左 10，距右 = 100 - 10 - 64 = 26
        // 距左更近，吸附到左边
        let (new_x, _) = snap.snap_to_edge(10, 100, 100, 800, 64);
        assert_eq!(new_x, 20);

        // x=20：距左 20，距右 = 100 - 20 - 64 = 16
        // 距右更近，吸附到右边
        let (new_x, _) = snap.snap_to_edge(20, 100, 100, 800, 64);
        assert_eq!(new_x, 100 - 64 - 20);
    }
}
