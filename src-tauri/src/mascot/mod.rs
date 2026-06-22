//! mascot 模块：桌面伙伴（Mascot）窗口、托盘、通知与频率限制
//!
//! 对应 electron/mascot/ 下的 TypeScript 模块：
//!  - mascot_window：透明置顶窗口 + 边缘吸附
//!  - mascot_manager：编排层（状态/形象/气泡/导航）
//!  - mascot_notifier：通知接口 + 安全实现
//!  - frequency_limiter：气泡频率限制
//!  - tray_manager：系统托盘
//!  - mascot_emotion：情绪状态机（M13.4）
//!  - mascot_greetings：上下文感知问候（M13.5）
//!  - mascot_interaction：分层点击交互（M13.6）
//!  - smart_reminder：智能提醒分级（M13.7）
//!  - mascot_character：角色设计系统（M13.10）
//!  - mascot_edge_snap：边缘吸附（M13.12）
//!  - mascot_theme：深色模式适配（M13.13）
//!  - notification_center：通知中心（M13.14）
//!  - state_sync：与主窗口状态同步（M13.15）

pub mod mascot_window;
pub mod mascot_manager;
pub mod mascot_notifier;
pub mod frequency_limiter;
pub mod tray_manager;
pub mod mascot_emotion;
pub mod mascot_greetings;
pub mod mascot_interaction;
pub mod smart_reminder;
pub mod mascot_character;
pub mod mascot_edge_snap;
pub mod mascot_theme;
pub mod notification_center;
pub mod state_sync;
