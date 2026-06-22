/**
 * WorkMemory Tauri 主入口
 *
 * Phase 1：Tauri 壳搭建 — 配置双窗口（main + mascot）、注册基础插件
 * Phase 2：数据库持久层 — init_database 在 setup 中调用
 */
use tauri::Manager;

mod capture;
mod db;
mod events;
mod models;
mod repositories;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // 初始化数据库
            let app_data_dir = app.path().app_data_dir()?;
            if let Err(e) = db::database::init_database(&app_data_dir) {
                log::error!("数据库初始化失败: {}", e);
                return Err(e.into());
            }
            log::info!("数据库初始化完成: {:?}", app_data_dir);

            // 主窗口就绪后展示，避免白屏闪烁
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // before-quit 时关闭数据库（执行 WAL checkpoint）
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    db::database::close_database();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running WorkMemory Tauri application");
}
