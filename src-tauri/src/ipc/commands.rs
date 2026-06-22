//! IPC 命令实现（对应 electron/main/ipc.ts）
//!
//! 全部使用 `#[tauri::command]` 宏声明，由 Tauri `invoke_handler` 注册。
//! 错误统一转为 `String` 返回，业务逻辑委托给 repository / manager 层。

use crate::ai::ai_manager::get_ai_manager;
use crate::capture::capture_manager::{get_capture_manager, init_capture_manager};
use crate::capture::episode_manager::{get_episode_manager, init_episode_manager};
use crate::insights::anomaly_detector::Anomaly;
use crate::insights::insights_manager::get_insights_manager;
use crate::insights::time_audit_engine::TimeAudit;
use crate::ipc::schemas::{
    CaptureStateResponse, InsightsStatusResponse, OcrStatusResponse, SearchHit, SearchResponse,
    WikiSearchHit,
};
use crate::mascot::mascot_manager::{get_mascot_manager, init_mascot_manager};
use crate::models::{
    AppSettings, CleanEpisode, EntityRefType, Episode, MascotState, MascotStyle, MemCell, MemScene,
    OcrModel, Report, ReportStatus, ReportTemplate, UserProfileEntry, WikiPage, WorkSegment,
};
use crate::ocr::ocr_manager::get_ocr_manager;
use crate::repositories::clean_episode_repository::CleanEpisodeRepository;
use crate::repositories::data_manager::{DataManager, DataStats};
use crate::repositories::episode_repository::EpisodeRepository;
use crate::repositories::mem_cell_repository::MemCellRepository;
use crate::repositories::mem_scene_repository::MemSceneRepository;
use crate::repositories::report_repository::ReportRepository;
use crate::repositories::search_repository::SearchRepository;
use crate::repositories::semantic_search_repository::{
    HybridSearchOptions, SearchResult, SemanticSearchRepository,
};
use crate::repositories::settings_store::SettingsStore;
use crate::repositories::segment_repository::SegmentRepository;
use crate::repositories::user_profile_repository::UserProfileRepository;
use crate::repositories::wiki_repository::WikiRepository;

// ===================== Segment 命令 =====================

/// 按日期查询 Segments
#[tauri::command]
pub fn get_segments(date: String) -> Result<Vec<WorkSegment>, String> {
    SegmentRepository::get_by_date(&date).map_err(|e| e.to_string())
}

/// 按 ID 查询 Segment
#[tauri::command]
pub fn get_segment_by_id(id: String) -> Result<Option<WorkSegment>, String> {
    SegmentRepository::get_by_id(&id).map_err(|e| e.to_string())
}

/// 更新 Segment（合并 patch）
#[tauri::command]
pub fn update_segment(id: String, patch: WorkSegment) -> Result<(), String> {
    SegmentRepository::update(&id, patch).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除 Segment（软删除）
#[tauri::command]
pub fn delete_segment(id: String) -> Result<(), String> {
    SegmentRepository::soft_delete(&id).map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置 Segment 重要标记
#[tauri::command]
pub fn set_segment_important(id: String, important: bool) -> Result<(), String> {
    SegmentRepository::set_important(&id, important).map_err(|e| e.to_string())?;
    Ok(())
}

/// 设置 Segment 是否选中进入报告
#[tauri::command]
pub fn set_segment_selected_for_report(id: String, selected: bool) -> Result<(), String> {
    SegmentRepository::set_selected_for_report(&id, selected).map_err(|e| e.to_string())?;
    Ok(())
}

// ===================== Episode 命令 =====================

/// 按日期查询 Episodes
#[tauri::command]
pub fn get_episodes(date: String) -> Result<Vec<Episode>, String> {
    EpisodeRepository::get_by_date(&date).map_err(|e| e.to_string())
}

/// 重建指定日期的 Episodes
#[tauri::command]
pub fn rebuild_episodes(date: String) -> Result<(), String> {
    let guard = get_episode_manager().lock().unwrap();
    if let Some(manager) = guard.as_ref() {
        manager.rebuild(&date).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("EpisodeManager 未初始化".to_string())
    }
}

/// 更新 Episode（合并 patch）
#[tauri::command]
pub fn update_episode(id: String, patch: Episode) -> Result<(), String> {
    EpisodeRepository::update(&id, patch).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除 Episode
#[tauri::command]
pub fn delete_episode(id: String) -> Result<(), String> {
    EpisodeRepository::hard_delete(&id).map_err(|e| e.to_string())?;
    Ok(())
}

/// 确认实体：标记 user_confirmed=true
#[tauri::command]
pub fn confirm_entity(episode_id: String, entity: String) -> Result<(), String> {
    // entity 参数为 "type:name" 格式或纯名称（默认 person 类型）
    let (entity_type, entity_name) = parse_entity_arg(&entity);
    EpisodeRepository::confirm_entity(&episode_id, entity_type, &entity_name)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 修正实体名：更新 name 并标记 user_confirmed=true
#[tauri::command]
pub fn correct_entity(episode_id: String, entity: String) -> Result<(), String> {
    // 简化实现：entity 参数为 "type:oldName:newName" 格式
    let parts: Vec<&str> = entity.splitn(3, ':').collect();
    if parts.len() < 3 {
        return Err("entity 参数格式应为 type:oldName:newName".to_string());
    }
    let entity_type = EntityRefType::from_str(parts[0]);
    EpisodeRepository::correct_entity(&episode_id, entity_type, parts[1], parts[2])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 忽略实体：从 episode.entities 中移除
#[tauri::command]
pub fn ignore_entity(episode_id: String, entity: String) -> Result<(), String> {
    let (entity_type, entity_name) = parse_entity_arg(&entity);
    EpisodeRepository::ignore_entity(&episode_id, entity_type, &entity_name)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 解析实体参数 "type:name" → (EntityRefType, name)
fn parse_entity_arg(entity: &str) -> (EntityRefType, String) {
    if let Some(colon_pos) = entity.find(':') {
        let type_str = &entity[..colon_pos];
        let name = entity[colon_pos + 1..].to_string();
        (EntityRefType::from_str(type_str), name)
    } else {
        (EntityRefType::Person, entity.to_string())
    }
}

// ===================== CleanEpisode 命令 =====================

/// 按日期查询 CleanEpisodes（工作记忆事件）
#[tauri::command]
pub fn get_clean_episodes(date: String) -> Result<Vec<CleanEpisode>, String> {
    CleanEpisodeRepository::get_by_date(&date).map_err(|e| e.to_string())
}

// ===================== Search 命令 =====================

/// FTS5 全文搜索
#[tauri::command]
pub fn search(
    query: String,
    filters: Option<crate::ipc::schemas::SearchFilters>,
) -> Result<SearchResponse, String> {
    let fts_result = SearchRepository::search(&query).map_err(|e| e.to_string())?;
    // 转换为 SearchResponse
    let mut response = SearchResponse::default();
    for m in fts_result.clean_episodes {
        response.clean_episodes.push(SearchHit {
            id: m.clean_episode_id,
            snippet: m.snippet,
            matched_field: m.matched_field,
        });
    }
    for m in fts_result.segments {
        response.segments.push(SearchHit {
            id: m.segment_id,
            snippet: m.snippet,
            matched_field: m.matched_field,
        });
    }
    for m in fts_result.episodes {
        response.episodes.push(SearchHit {
            id: m.episode_id,
            snippet: m.snippet,
            matched_field: m.matched_field,
        });
    }
    for m in fts_result.wikis {
        response.wikis.push(WikiSearchHit {
            id: m.wiki_id,
            title: m.title,
            snippet: m.snippet,
        });
    }
    // 应用 limit 过滤
    if let Some(f) = filters {
        if let Some(limit) = f.limit {
            let limit = limit as usize;
            response.clean_episodes.truncate(limit);
            response.segments.truncate(limit);
            response.episodes.truncate(limit);
            response.wikis.truncate(limit);
        }
    }
    Ok(response)
}

/// 语义搜索（混合检索：FTS5 + 语义向量）
#[tauri::command]
pub fn semantic_search(query: String, limit: Option<u32>) -> Result<Vec<SearchResult>, String> {
    let options = HybridSearchOptions {
        limit: limit.unwrap_or(20) as usize,
        ..Default::default()
    };
    // EmbeddingService 尚未实现，传入空语义匹配结果（退化为纯 FTS5）
    let semantic_matches = Vec::new();
    SemanticSearchRepository::hybrid_search(&query, options, semantic_matches)
        .map_err(|e| e.to_string())
}

/// 按实体名搜索 Episodes（spec F8.2）
#[tauri::command]
pub fn search_by_entity(name: String) -> Result<Vec<Episode>, String> {
    let all_episodes = EpisodeRepository::get_all().map_err(|e| e.to_string())?;
    // 过滤包含匹配实体名的 Episodes
    let result: Vec<Episode> = all_episodes
        .into_iter()
        .filter(|ep| {
            ep.entities
                .iter()
                .any(|e| e.name.to_lowercase().contains(&name.to_lowercase()))
        })
        .collect();
    Ok(result)
}

// ===================== Report 命令 =====================

/// 生成日报并保存到数据库
#[tauri::command]
pub async fn generate_report(date: String, template: String) -> Result<Report, String> {
    let template = ReportTemplate::from_str(&template);
    // ReportGenerator 是无状态单元结构体，可直接创建实例，
    // 避免在 async 命令中持有 std::sync::MutexGuard 跨 await（会导致 future 非 Send）。
    let generator = crate::ai::report_generator::ReportGenerator::new();
    generator
        .generate_and_save(&date, template, "")
        .await
        .map_err(|e| e.to_string())
}

/// 获取全部报告历史
#[tauri::command]
pub fn get_reports() -> Result<Vec<Report>, String> {
    ReportRepository::get_all_history().map_err(|e| e.to_string())
}

/// 按 ID 查询报告
#[tauri::command]
pub fn get_report_by_id(id: String) -> Result<Option<Report>, String> {
    ReportRepository::get_by_id(&id).map_err(|e| e.to_string())
}

/// 导出报告为指定格式（md / html / json）
#[tauri::command]
pub fn export_report(id: String, format: String) -> Result<String, String> {
    let report = ReportRepository::get_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("报告不存在: {}", id))?;
    match format.to_lowercase().as_str() {
        "md" | "markdown" => Ok(report.markdown_content),
        "json" => serde_json::to_string_pretty(&report).map_err(|e| e.to_string()),
        "html" => Ok(format!(
            "<html><head><meta charset='utf-8'><title>{}</title></head><body><pre>{}</pre></body></html>",
            report.template_name, report.markdown_content
        )),
        _ => Err(format!("不支持的导出格式: {}", format)),
    }
}

/// 设置报告状态
#[tauri::command]
pub fn set_report_status(id: String, status: String) -> Result<(), String> {
    let status = ReportStatus::from_str(&status);
    ReportRepository::set_status(&id, status).map_err(|e| e.to_string())?;
    Ok(())
}

// ===================== Wiki 命令 =====================

/// 获取全部 Wiki 页
#[tauri::command]
pub fn get_wiki_pages() -> Result<Vec<WikiPage>, String> {
    WikiRepository::get_all().map_err(|e| e.to_string())
}

/// 按 ID 查询 Wiki 页
#[tauri::command]
pub fn get_wiki_page_by_id(id: String) -> Result<Option<WikiPage>, String> {
    WikiRepository::get_by_id(&id).map_err(|e| e.to_string())
}

/// 创建 Wiki 页，返回新页 ID
#[tauri::command]
pub fn create_wiki_page(page: WikiPage) -> Result<String, String> {
    let inserted = WikiRepository::insert(page).map_err(|e| e.to_string())?;
    Ok(inserted.id)
}

/// 更新 Wiki 页（合并 patch）
#[tauri::command]
pub fn update_wiki_page(id: String, patch: WikiPage) -> Result<(), String> {
    WikiRepository::update(&id, patch).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除 Wiki 页
#[tauri::command]
pub fn delete_wiki_page(id: String) -> Result<(), String> {
    WikiRepository::delete(&id).map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取 Wiki 审核队列
#[tauri::command]
pub fn get_wiki_review_queue() -> Result<Vec<WikiPage>, String> {
    WikiRepository::get_review_queue().map_err(|e| e.to_string())
}

/// 确认 Wiki 审核
#[tauri::command]
pub fn confirm_wiki_review(id: String) -> Result<Option<WikiPage>, String> {
    WikiRepository::confirm_review(&id).map_err(|e| e.to_string())
}

/// 拒绝 Wiki 审核
#[tauri::command]
pub fn reject_wiki_review(id: String) -> Result<bool, String> {
    WikiRepository::reject_review(&id).map_err(|e| e.to_string())
}

/// 获取 Wiki 反向链接标题列表
#[tauri::command]
pub fn get_wiki_backlinks(id: String) -> Result<Vec<String>, String> {
    // 先按 ID 取页标题，再查反链
    let page = WikiRepository::get_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Wiki 页不存在: {}", id))?;
    let backlinks = WikiRepository::get_backlinks(&page.title).map_err(|e| e.to_string())?;
    Ok(backlinks.into_iter().map(|p| p.title).collect())
}

// ===================== Settings 命令 =====================

/// 获取应用设置
#[tauri::command]
pub fn get_settings() -> Result<AppSettings, String> {
    Ok(SettingsStore::get())
}

/// 更新应用设置（合并 patch）
#[tauri::command]
pub fn update_settings(patch: AppSettings) -> Result<(), String> {
    SettingsStore::set(patch);
    Ok(())
}

/// 重置为默认设置
#[tauri::command]
pub fn reset_settings() -> Result<(), String> {
    SettingsStore::reset();
    Ok(())
}

/// 设置 API Key（加密存储）
#[tauri::command]
pub fn set_api_key(key: String) -> Result<(), String> {
    SettingsStore::set_api_key(&key);
    Ok(())
}

/// 清空 API Key
#[tauri::command]
pub fn clear_api_key() -> Result<(), String> {
    SettingsStore::clear_api_key();
    Ok(())
}

/// 是否已配置 API Key
#[tauri::command]
pub fn has_api_key() -> Result<bool, String> {
    Ok(!SettingsStore::get_api_key().is_empty())
}

// ===================== OCR 命令 =====================

/// 获取 OCR 状态
#[tauri::command]
pub fn get_ocr_status() -> Result<OcrStatusResponse, String> {
    let manager = get_ocr_manager().lock().map_err(|e| e.to_string())?;
    let status = manager.get_status();
    Ok(OcrStatusResponse {
        backend: status.backend,
        model: status.model,
        loaded: status.loaded,
        queue_size: status.queue_size,
        running: status.running,
        configured: status.configured,
    })
}

/// 设置 OCR 模型
#[tauri::command]
pub fn set_ocr_model(model: String) -> Result<bool, String> {
    let ocr_model = OcrModel::from_str(&model);
    // 同步到设置
    let mut settings = SettingsStore::get();
    settings.ocr_model = ocr_model;
    SettingsStore::set(settings);
    let mut manager = get_ocr_manager().lock().map_err(|e| e.to_string())?;
    Ok(manager.set_model(ocr_model))
}

/// 重新处理指定 Segment 的 OCR
#[tauri::command]
pub fn reprocess_ocr(segment_id: String) -> Result<bool, String> {
    let manager = get_ocr_manager().lock().map_err(|e| e.to_string())?;
    Ok(manager.reprocess(&segment_id))
}

/// 识别指定图片路径的文本
#[tauri::command]
pub fn recognize_image(path: String) -> Result<String, String> {
    let mut manager = get_ocr_manager().lock().map_err(|e| e.to_string())?;
    manager.recognize_image_path(&path).map_err(|e| e.to_string())
}

// ===================== Capture 命令 =====================

/// 启动全链路捕获
#[tauri::command]
pub fn start_capture() -> Result<(), String> {
    let guard = get_capture_manager().lock().map_err(|e| e.to_string())?;
    if let Some(manager) = guard.as_ref() {
        manager.start_capture();
        Ok(())
    } else {
        Err("CaptureManager 未初始化".to_string())
    }
}

/// 停止捕获
#[tauri::command]
pub fn stop_capture() -> Result<(), String> {
    let guard = get_capture_manager().lock().map_err(|e| e.to_string())?;
    if let Some(manager) = guard.as_ref() {
        manager.stop_capture();
        Ok(())
    } else {
        Err("CaptureManager 未初始化".to_string())
    }
}

/// 暂停捕获
#[tauri::command]
pub fn pause_capture() -> Result<(), String> {
    let guard = get_capture_manager().lock().map_err(|e| e.to_string())?;
    if let Some(manager) = guard.as_ref() {
        manager.pause_capture();
        Ok(())
    } else {
        Err("CaptureManager 未初始化".to_string())
    }
}

/// 恢复捕获
#[tauri::command]
pub fn resume_capture() -> Result<(), String> {
    let guard = get_capture_manager().lock().map_err(|e| e.to_string())?;
    if let Some(manager) = guard.as_ref() {
        manager.resume_capture();
        Ok(())
    } else {
        Err("CaptureManager 未初始化".to_string())
    }
}

/// 获取捕获状态
#[tauri::command]
pub fn get_capture_state() -> Result<CaptureStateResponse, String> {
    let guard = get_capture_manager().lock().map_err(|e| e.to_string())?;
    if let Some(manager) = guard.as_ref() {
        let state = manager.get_recording_state();
        let state_str = match state {
            crate::models::RecordingState::Recording => "recording",
            crate::models::RecordingState::Paused => "paused",
            crate::models::RecordingState::Idle => "idle",
            crate::models::RecordingState::Privacy => "privacy",
        };
        Ok(CaptureStateResponse {
            state: state_str.to_string(),
        })
    } else {
        Err("CaptureManager 未初始化".to_string())
    }
}

// ===================== Mascot 命令 =====================

/// 显示 Mascot
#[tauri::command]
pub fn show_mascot() -> Result<(), String> {
    if let Some(guard) = get_mascot_manager() {
        if let Some(manager) = guard.as_ref() {
            manager.show();
            return Ok(());
        }
    }
    Err("MascotManager 未初始化".to_string())
}

/// 隐藏 Mascot
#[tauri::command]
pub fn hide_mascot() -> Result<(), String> {
    if let Some(guard) = get_mascot_manager() {
        if let Some(manager) = guard.as_ref() {
            manager.hide();
            return Ok(());
        }
    }
    Err("MascotManager 未初始化".to_string())
}

/// 设置 Mascot 状态
#[tauri::command]
pub fn set_mascot_state(state: String) -> Result<(), String> {
    let mascot_state = MascotState::from_str(&state);
    if let Some(guard) = get_mascot_manager() {
        if let Some(manager) = guard.as_ref() {
            manager.set_state(mascot_state);
            return Ok(());
        }
    }
    Err("MascotManager 未初始化".to_string())
}

/// 设置 Mascot 形象
#[tauri::command]
pub fn set_mascot_style(style: String) -> Result<(), String> {
    let mascot_style = MascotStyle::from_str(&style);
    if let Some(guard) = get_mascot_manager() {
        if let Some(manager) = guard.as_ref() {
            manager.set_style(mascot_style);
            return Ok(());
        }
    }
    Err("MascotManager 未初始化".to_string())
}

/// 显示 Mascot 气泡
#[tauri::command]
pub fn show_mascot_bubble(text: String) -> Result<(), String> {
    if let Some(guard) = get_mascot_manager() {
        if let Some(manager) = guard.as_ref() {
            manager.show_bubble(&text);
            return Ok(());
        }
    }
    Err("MascotManager 未初始化".to_string())
}

/// 隐藏 Mascot 气泡
#[tauri::command]
pub fn hide_mascot_bubble() -> Result<(), String> {
    if let Some(guard) = get_mascot_manager() {
        if let Some(manager) = guard.as_ref() {
            manager.hide_bubble();
            return Ok(());
        }
    }
    Err("MascotManager 未初始化".to_string())
}

/// 导航到主窗口指定页面
#[tauri::command]
pub fn navigate_to(page: String) -> Result<(), String> {
    if let Some(guard) = get_mascot_manager() {
        if let Some(manager) = guard.as_ref() {
            manager.navigate(&page);
            return Ok(());
        }
    }
    Err("MascotManager 未初始化".to_string())
}

// ===================== Insights 命令 =====================

/// 获取 Insights 运行状态
#[tauri::command]
pub fn get_insights_status() -> Result<InsightsStatusResponse, String> {
    let manager = get_insights_manager().lock().map_err(|e| e.to_string())?;
    let status = manager.get_status();
    Ok(InsightsStatusResponse {
        running: status.running,
        last_audit: status.last_audit,
    })
}

/// 审计指定日期的时间使用
#[tauri::command]
pub fn audit_day(date: String) -> Result<TimeAudit, String> {
    let manager = get_insights_manager().lock().map_err(|e| e.to_string())?;
    manager.audit_day(&date).map_err(|e| e.to_string())
}

/// 检测指定日期的异常
#[tauri::command]
pub fn detect_anomalies(date: String) -> Result<Vec<Anomaly>, String> {
    let manager = get_insights_manager().lock().map_err(|e| e.to_string())?;
    Ok(manager.detect_anomalies(&date))
}

// ===================== Memory 命令 =====================

/// 按日期查询 MemCells
#[tauri::command]
pub fn get_mem_cells(date: String) -> Result<Vec<MemCell>, String> {
    // date 作为日期范围查询的起始和结束（同一天）
    let start = format!("{}T00:00:00", date);
    let end = format!("{}T23:59:59", date);
    MemCellRepository::get_by_date_range(&start, &end).map_err(|e| e.to_string())
}

/// 获取全部 MemScenes
#[tauri::command]
pub fn get_mem_scenes() -> Result<Vec<MemScene>, String> {
    MemSceneRepository::get_all().map_err(|e| e.to_string())
}

/// 获取用户画像条目
#[tauri::command]
pub fn get_user_profile() -> Result<Vec<UserProfileEntry>, String> {
    UserProfileRepository::get_all().map_err(|e| e.to_string())
}

// ===================== 数据管理命令 =====================

/// 获取数据统计
#[tauri::command]
pub fn get_data_stats() -> Result<DataStats, String> {
    DataManager::get_stats().map_err(|e| e.to_string())
}

/// 一键瘦身（清理已删除 segments + 过期截图 + 孤立数据）
#[tauri::command]
pub fn cleanup_data() -> Result<(), String> {
    DataManager::cleanup().map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空指定日期的数据
#[tauri::command]
pub fn clear_day_data(date: String) -> Result<(), String> {
    DataManager::clear_day(&date).map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空全部数据
#[tauri::command]
pub fn clear_all_data() -> Result<(), String> {
    DataManager::clear_all().map_err(|e| e.to_string())?;
    Ok(())
}

// ===================== 手动创建 Episode（spec F5.5）=====================

/// 手动创建 Episode，返回新 Episode ID
#[tauri::command]
pub fn create_manual_episode(
    title: String,
    tags: Vec<String>,
    project: Option<String>,
    text: String,
) -> Result<String, String> {
    let now = chrono::Local::now();
    let date = now.format("%Y-%m-%d").to_string();
    let time = now.format("%H:%M:%S").to_string();
    let id = uuid::Uuid::new_v4().to_string();

    // 构建 entities（若提供 project 则加入 project 实体）
    let mut entities = Vec::new();
    if let Some(proj) = &project {
        if !proj.is_empty() {
            entities.push(crate::models::EntityRef {
                ref_type: EntityRefType::Project,
                name: proj.clone(),
                value: None,
                confidence: 1.0,
                user_confirmed: true,
            });
        }
    }

    let episode = Episode {
        id: id.clone(),
        date,
        start_time: time.clone(),
        end_time: time,
        title,
        one_line_summary: text,
        segment_ids: Vec::new(),
        entities,
        topics: tags,
        user_edited: true,
        report_eligible: true,
        wiki_eligible: false,
        dominant_activity_type: None,
    };

    let inserted = EpisodeRepository::insert(episode).map_err(|e| e.to_string())?;
    Ok(inserted.id)
}

// ===================== 初始化辅助函数（供 lib.rs bootstrap 调用）=====================

/// 初始化全部管理器单例（在 Tauri setup 钩子中调用）
pub fn init_managers() {
    init_capture_manager();
    init_episode_manager();
}
