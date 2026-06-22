/**
 * WorkMemory Tauri 主入口
 *
 * Phase 1：Tauri 壳搭建 — 配置双窗口（main + mascot）、注册基础插件
 * Phase 2：数据库持久层 — init_database 在 setup 中调用
 * Phase 4：IPC 层迁移 — 注册全部 #[tauri::command] 命令（对应 electron/main/ipc.ts）
 * T4.7：Bootstrap — 在 setup 钩子中按序初始化全部单例管理器
 */
use tauri::Manager;

mod ai;
mod capture;
mod db;
mod events;
mod insights;
mod ipc;
mod mascot;
mod memory;
mod models;
mod ocr;
mod repositories;
mod search;
mod wiki;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            // ===================== Segment 命令 =====================
            ipc::commands::get_segments,
            ipc::commands::get_segment_by_id,
            ipc::commands::update_segment,
            ipc::commands::delete_segment,
            ipc::commands::set_segment_important,
            ipc::commands::set_segment_selected_for_report,
            // ===================== Episode 命令 =====================
            ipc::commands::get_episodes,
            ipc::commands::rebuild_episodes,
            ipc::commands::update_episode,
            ipc::commands::delete_episode,
            ipc::commands::confirm_entity,
            ipc::commands::correct_entity,
            ipc::commands::ignore_entity,
            ipc::commands::create_manual_episode,
            // ===================== CleanEpisode 命令 =====================
            ipc::commands::get_clean_episodes,
            // ===================== Search 命令 =====================
            ipc::commands::search,
            ipc::commands::semantic_search,
            ipc::commands::search_by_entity,
            // ===================== Report 命令 =====================
            ipc::commands::generate_report,
            ipc::commands::get_reports,
            ipc::commands::get_report_by_id,
            ipc::commands::export_report,
            ipc::commands::set_report_status,
            // ===================== Wiki 命令 =====================
            ipc::commands::get_wiki_pages,
            ipc::commands::get_wiki_page_by_id,
            ipc::commands::create_wiki_page,
            ipc::commands::update_wiki_page,
            ipc::commands::delete_wiki_page,
            ipc::commands::get_wiki_review_queue,
            ipc::commands::confirm_wiki_review,
            ipc::commands::reject_wiki_review,
            ipc::commands::get_wiki_backlinks,
            // ===================== Settings 命令 =====================
            ipc::commands::get_settings,
            ipc::commands::update_settings,
            ipc::commands::reset_settings,
            ipc::commands::set_api_key,
            ipc::commands::clear_api_key,
            ipc::commands::has_api_key,
            // ===================== OCR 命令 =====================
            ipc::commands::get_ocr_status,
            ipc::commands::set_ocr_model,
            ipc::commands::reprocess_ocr,
            ipc::commands::recognize_image,
            // ===================== Capture 命令 =====================
            ipc::commands::start_capture,
            ipc::commands::stop_capture,
            ipc::commands::pause_capture,
            ipc::commands::resume_capture,
            ipc::commands::get_capture_state,
            // ===================== Mascot 命令 =====================
            ipc::commands::show_mascot,
            ipc::commands::hide_mascot,
            ipc::commands::set_mascot_state,
            ipc::commands::set_mascot_style,
            ipc::commands::show_mascot_bubble,
            ipc::commands::hide_mascot_bubble,
            ipc::commands::navigate_to,
            // ===================== Insights 命令 =====================
            ipc::commands::get_insights_status,
            ipc::commands::audit_day,
            ipc::commands::detect_anomalies,
            // ===================== Memory 命令 =====================
            ipc::commands::get_mem_cells,
            ipc::commands::get_mem_scenes,
            ipc::commands::get_user_profile,
            // ===================== 数据管理命令 =====================
            ipc::commands::get_data_stats,
            ipc::commands::cleanup_data,
            ipc::commands::clear_day_data,
            ipc::commands::clear_all_data,
        ])
        .setup(|app| {
            // ===== T4.7 Bootstrap：按序初始化全部单例管理器 =====

            // 1. 初始化数据库
            let app_data_dir = app.path().app_data_dir()?;
            if let Err(e) = db::database::init_database(&app_data_dir) {
                log::error!("[Bootstrap] 数据库初始化失败: {}", e);
                return Err(e.into());
            }
            log::info!("[Bootstrap] 1/9 数据库初始化完成: {:?}", app_data_dir);

            // 2. 初始化 SettingsStore（传入 app_data_dir 用于定位 settings.json）
            repositories::settings_store::init_settings_store(app_data_dir.clone());
            log::info!("[Bootstrap] 2/9 SettingsStore 初始化完成");

            // 3. 初始化 OcrManager（默认 Tiny 模型）
            {
                let ocr_model = models::OcrModel::Tiny;
                if let Err(e) = ocr::ocr_manager::get_ocr_manager()
                    .lock()
                    .unwrap()
                    .initialize(ocr_model)
                {
                    log::warn!("[Bootstrap] 3/9 OcrManager 初始化异常: {}", e);
                } else {
                    log::info!("[Bootstrap] 3/9 OcrManager 初始化完成");
                }
            }

            // 4. 初始化 AiManager
            {
                if let Err(e) = ai::ai_manager::get_ai_manager()
                    .lock()
                    .unwrap()
                    .initialize()
                {
                    log::warn!("[Bootstrap] 4/9 AiManager 初始化异常: {}", e);
                } else {
                    log::info!("[Bootstrap] 4/9 AiManager 初始化完成");
                }
            }

            // 5. 初始化 InsightsManager
            {
                if let Err(e) = insights::insights_manager::get_insights_manager()
                    .lock()
                    .unwrap()
                    .initialize()
                {
                    log::warn!("[Bootstrap] 5/9 InsightsManager 初始化异常: {}", e);
                } else {
                    log::info!("[Bootstrap] 5/9 InsightsManager 初始化完成");
                }
            }

            // 6. 启动 CaptureManager（先 init 单例，再 start_capture）
            {
                // 初始化 CaptureManager + EpisodeManager 单例
                ipc::commands::init_managers();
                let guard = capture::capture_manager::get_capture_manager()
                    .lock()
                    .unwrap();
                if let Some(manager) = guard.as_ref() {
                    manager.start_capture();
                    log::info!("[Bootstrap] 6/9 CaptureManager 已启动");
                } else {
                    log::warn!("[Bootstrap] 6/9 CaptureManager 初始化失败");
                }
            }

            // 7. 初始化 TrayManager（创建系统托盘）
            {
                let app_handle = app.handle().clone();
                mascot::tray_manager::TrayManager::new(&app_handle).setup();
                log::info!("[Bootstrap] 7/9 TrayManager 初始化完成");
            }

            // 8. 显示 MascotWindow（桌面伙伴窗口）
            {
                let app_handle = app.handle().clone();
                // 初始化 MascotManager 单例（供 IPC 命令使用）
                mascot::mascot_manager::init_mascot_manager(&app_handle);
                mascot::mascot_window::MascotWindow::new(&app_handle).show();
                log::info!("[Bootstrap] 8/9 MascotWindow 已显示");
            }

            // 9. 启动完成日志
            log::info!("[Bootstrap] 9/9 WorkMemory 启动完成");

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
