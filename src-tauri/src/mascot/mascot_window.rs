//! MascotWindow：桌面伙伴独立窗口管理（对应 electron/mascot/MascotWindow.ts）
//!
//! 创建透明无边框置顶窗口，加载 mascot 渲染页面（#/mascot 路由）。
//! 功能：
//!  - 通过 Tauri WebviewWindow API 控制 show/hide/set_position
//!  - 初始位置：屏幕右下角（留 20px 边距）
//!  - 拖拽与边缘吸附：松开后检测靠近边缘（<50px），自动吸附
//!  - 鼠标悬停恢复透明度，拖拽时半透明
//!
//! 沙箱降级：Linux 环境下 transparent 可能不完美，启动时 try-catch 降级。

use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

/// Mascot 窗口宽度
const MASCOT_WIDTH: i32 = 340;
/// Mascot 窗口高度
const MASCOT_HEIGHT: i32 = 146;
/// 边缘吸附阈值（像素）
const EDGE_SNAP_THRESHOLD: i32 = 50;
/// 边缘吸附后的透明度
const EDGE_OPACITY: f64 = 0.5;
/// 拖拽时的透明度
const DRAG_OPACITY: f64 = 0.8;
/// 正常透明度
const NORMAL_OPACITY: f64 = 1.0;

/// 屏幕工作区（用于边缘吸附计算）
#[derive(Debug, Clone, Copy)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// MascotWindow：桌面伙伴窗口管理器。
///
/// 通过 Tauri `WebviewWindow` API 控制透明置顶窗口。
pub struct MascotWindow {
    app: AppHandle,
    /// 当前是否已吸附到边缘
    snapped_to_edge: bool,
    /// 拖拽起始光标位置
    drag_start_cursor: (i32, i32),
    /// 拖拽起始窗口位置
    drag_start_window: (i32, i32),
}

impl MascotWindow {
    /// 创建 MascotWindow 实例（窗口本身由 tauri.conf.json 静态声明）
    pub fn new(app: &AppHandle) -> Self {
        Self {
            app: app.clone(),
            snapped_to_edge: false,
            drag_start_cursor: (0, 0),
            drag_start_window: (0, 0),
        }
    }

    /// 获取 mascot WebviewWindow（可能不存在）
    pub fn get_window(&self) -> Option<WebviewWindow> {
        self.app.get_webview_window("mascot")
    }

    /// 显示窗口
    pub fn show(&self) {
        if let Some(window) = self.get_window() {
            let _ = window.show();
            let _ = self.app.emit("mascot-opacity", NORMAL_OPACITY);
        }
    }

    /// 隐藏窗口
    pub fn hide(&self) {
        if let Some(window) = self.get_window() {
            let _ = window.hide();
        }
    }

    /// 窗口是否可见
    pub fn is_visible(&self) -> bool {
        self.get_window()
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false)
    }

    /// 设置窗口位置
    pub fn set_position(&self, x: i32, y: i32) {
        if let Some(window) = self.get_window() {
            let _ = window.set_position(PhysicalPosition::new(x, y));
        }
    }

    /// 获取窗口位置，窗口不存在时返回 (0, 0)
    pub fn get_position(&self) -> (i32, i32) {
        if let Some(window) = self.get_window() {
            if let Ok(pos) = window.outer_position() {
                return (pos.x, pos.y);
            }
        }
        (0, 0)
    }

    /// 设置透明度（通过事件通知前端调整 CSS opacity）
    pub fn set_opacity(&self, opacity: f64) {
        let _ = self.app.emit("mascot-opacity", opacity);
    }

    /// 开始拖拽：记录起始位置
    pub fn drag_start(&mut self) {
        self.drag_start_cursor = self.get_cursor_position();
        self.drag_start_window = self.get_position();
        self.snapped_to_edge = false;
        self.set_opacity(DRAG_OPACITY);
    }

    /// 结束拖拽：检测边缘吸附，返回最终窗口位置
    pub fn drag_end(&mut self) -> (i32, i32) {
        self.check_edge_snap();
        self.get_position()
    }

    /// 检测边缘吸附：靠近边缘（<50px）则吸附并半透明
    pub fn check_edge_snap(&mut self) {
        let window = match self.get_window() {
            Some(w) => w,
            None => return,
        };

        let work_area = match self.get_work_area() {
            Some(a) => a,
            None => return,
        };

        let bounds = match window.outer_position() {
            Ok(pos) => pos,
            Err(_) => return,
        };
        let size = match window.outer_size() {
            Ok(s) => s,
            Err(_) => return,
        };

        let win_x = bounds.x;
        let win_y = bounds.y;
        let win_w = size.width as i32;
        let win_h = size.height as i32;

        let near_left = win_x <= work_area.x + EDGE_SNAP_THRESHOLD;
        let near_right = win_x + win_w >= work_area.x + work_area.width - EDGE_SNAP_THRESHOLD;
        let near_top = win_y <= work_area.y + EDGE_SNAP_THRESHOLD;
        let near_bottom = win_y + win_h >= work_area.y + work_area.height - EDGE_SNAP_THRESHOLD;

        if near_left || near_right || near_top || near_bottom {
            // 吸附到最近的边缘
            let mut snap_x = win_x;
            let mut snap_y = win_y;

            if near_left {
                snap_x = work_area.x;
            } else if near_right {
                snap_x = work_area.x + work_area.width - win_w;
            }

            if near_top {
                snap_y = work_area.y;
            } else if near_bottom {
                snap_y = work_area.y + work_area.height - win_h;
            }

            let _ = window.set_position(PhysicalPosition::new(snap_x, snap_y));
            self.snapped_to_edge = true;
            let _ = self.app.emit("mascot-opacity", EDGE_OPACITY);
        } else {
            self.snapped_to_edge = false;
            let _ = self.app.emit("mascot-opacity", NORMAL_OPACITY);
        }
    }

    /// 鼠标进入：吸附状态下恢复透明度
    pub fn on_mouse_enter(&self) {
        if self.snapped_to_edge {
            self.set_opacity(NORMAL_OPACITY);
        }
    }

    /// 鼠标离开：吸附状态下恢复半透明
    pub fn on_mouse_leave(&self) {
        if self.snapped_to_edge {
            self.set_opacity(EDGE_OPACITY);
        }
    }

    /// 计算初始位置：屏幕右下角，留 20px 边距
    pub fn get_initial_position(&self) -> (i32, i32) {
        if let Some(area) = self.get_work_area() {
            return (
                area.width - MASCOT_WIDTH - 20,
                area.height - MASCOT_HEIGHT - 20,
            );
        }
        (800, 600)
    }

    /// 获取屏幕工作区（主屏幕）
    fn get_work_area(&self) -> Option<WorkArea> {
        let window = self.get_window()?;
        let monitor = window.current_monitor().ok().flatten()?;
        let size = monitor.size();
        let pos = monitor.position();
        Some(WorkArea {
            x: pos.x,
            y: pos.y,
            width: size.width as i32,
            height: size.height as i32,
        })
    }

    /// 获取当前光标位置（Tauri 不直接提供，使用窗口位置近似）
    /// 真实场景下由前端通过 IPC 推送光标位置；此处返回 (0,0) 作为占位
    fn get_cursor_position(&self) -> (i32, i32) {
        (0, 0)
    }

    /// 当前是否已吸附到边缘
    pub fn is_snapped(&self) -> bool {
        self.snapped_to_edge
    }

    /// 获取窗口尺寸（逻辑像素）
    pub fn get_size(&self) -> Option<(u32, u32)> {
        let window = self.get_window()?;
        window
            .outer_size()
            .ok()
            .map(|s| (s.width, s.height))
            .or_else(|| {
                let logical: LogicalSize<u32> = LogicalSize::new(MASCOT_WIDTH as u32, MASCOT_HEIGHT as u32);
                Some((logical.width, logical.height))
            })
    }
}

// ===================== 边缘吸附纯函数（可单元测试） =====================

/// 计算给定窗口位置在工作区下的吸附目标位置。
///
/// 返回 `Some((x, y, snapped))` 表示应吸附到该位置；
/// 返回 `None` 表示未触发吸附（应保持原位置与正常透明度）。
pub fn compute_snap_position(
    win_x: i32,
    win_y: i32,
    win_w: i32,
    win_h: i32,
    area: WorkArea,
) -> Option<(i32, i32)> {
    let near_left = win_x <= area.x + EDGE_SNAP_THRESHOLD;
    let near_right = win_x + win_w >= area.x + area.width - EDGE_SNAP_THRESHOLD;
    let near_top = win_y <= area.y + EDGE_SNAP_THRESHOLD;
    let near_bottom = win_y + win_h >= area.y + area.height - EDGE_SNAP_THRESHOLD;

    if !near_left && !near_right && !near_top && !near_bottom {
        return None;
    }

    let mut snap_x = win_x;
    let mut snap_y = win_y;

    if near_left {
        snap_x = area.x;
    } else if near_right {
        snap_x = area.x + area.width - win_w;
    }

    if near_top {
        snap_y = area.y;
    } else if near_bottom {
        snap_y = area.y + area.height - win_h;
    }

    Some((snap_x, snap_y))
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    fn work_area() -> WorkArea {
        WorkArea {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        }
    }

    #[test]
    fn test_snap_to_left_edge() {
        // 窗口左上角接近左边缘（x=30 < 50）
        let result = compute_snap_position(30, 100, MASCOT_WIDTH, MASCOT_HEIGHT, work_area());
        assert_eq!(result, Some((0, 100)));
    }

    #[test]
    fn test_snap_to_right_edge() {
        // 窗口右边缘接近工作区右边缘
        let win_x = 1920 - MASCOT_WIDTH - 10; // 距离右边缘 10px
        let result = compute_snap_position(win_x, 100, MASCOT_WIDTH, MASCOT_HEIGHT, work_area());
        let expected_x = 1920 - MASCOT_WIDTH;
        assert_eq!(result, Some((expected_x, 100)));
    }

    #[test]
    fn test_no_snap_when_far_from_edge() {
        // 窗口位于屏幕中央，不应吸附
        let win_x = 800;
        let win_y = 400;
        let result = compute_snap_position(win_x, win_y, MASCOT_WIDTH, MASCOT_HEIGHT, work_area());
        assert!(result.is_none());
    }

    #[test]
    fn test_snap_to_bottom_edge() {
        // 窗口底边接近工作区底边
        let win_y = 1080 - MASCOT_HEIGHT - 20; // 距离底边 20px
        let result = compute_snap_position(800, win_y, MASCOT_WIDTH, MASCOT_HEIGHT, work_area());
        let expected_y = 1080 - MASCOT_HEIGHT;
        assert_eq!(result, Some((800, expected_y)));
    }

    #[test]
    fn test_snap_threshold_boundary() {
        // 恰好 50px 距离应触发吸附（<=）
        let win_x = 50;
        let result = compute_snap_position(win_x, 100, MASCOT_WIDTH, MASCOT_HEIGHT, work_area());
        assert_eq!(result, Some((0, 100)));

        // 51px 距离不应触发
        let win_x = 51;
        let result = compute_snap_position(win_x, 100, MASCOT_WIDTH, MASCOT_HEIGHT, work_area());
        assert!(result.is_none());
    }
}
