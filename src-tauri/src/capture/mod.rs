/**
 * capture 模块：窗口监听、截图、捕获决策、隐私守卫等
 *
 * Phase 2：
 *  - window_watcher：前台窗口轮询与事件检测
 *  - screenshot（Phase 2 T2.4）
 *  - capture_decision / privacy_guard / episode_builder（Phase 4）
 */

pub mod screenshot;
pub mod window_watcher;
