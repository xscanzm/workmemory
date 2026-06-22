//! DistillManager：整点低频 AI 理解批处理（对应 electron/ai/DistillManager.ts）
//!
//! 把一小时内的屏幕 OCR 文本证据整理为可长期复用的工作记忆事件（MemCell）。
//!
//! 处理流程：
//!  1. HourContextPackBuilder 构建上下文包
//!  2. DistillPrompt 构建 system / user 提示词
//!  3. SensitiveMasker 脱敏 user 提示词
//!  4. OpenAIClient 调用 AI（temperature=0.2，max_tokens=4096）
//!  5. parse_distill_response 解析 AI 返回 JSON
//!  6. 构造 CleanEpisode + MemCell，写入数据库
//!  7. 发布 MemCellCreated 事件（EventBus）
//!
//! 与 TypeScript 版本的差异：
//!  - Rust 版本简化为 `distill_segments` 接口，直接接收 segments 列表
//!  - 不维护 distill_runs 表（由调用方管理运行状态）
//!  - MemCell.metadata 仅含 segment_ids/timestamp/confidence（无 activity_type/content_type）

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;
use uuid::Uuid;

use crate::ai::distill_prompt::build_distill_prompt;
use crate::ai::hour_context_pack_builder::HourContextPackBuilder;
use crate::ai::openai_client::{ChatCompletionRequest, Message, OpenAIClient};
use crate::ai::sensitive_masker::mask_sensitive;
use crate::ai::schemas::distill_event_schema::{parse_distill_response, DistillEvent};
use crate::events::bus::{AppEvent, EventBus};
use crate::models::{
    CleanEpisode, EntityRef, EntityRefType, EvidenceRef, Foresight, MemCell, MemCellMetadata,
    MemoryKind, SourceQuality, WikiStatus, WorkSegment,
};
use crate::repositories::clean_episode_repository::CleanEpisodeRepository;
use crate::repositories::mem_cell_repository::MemCellRepository;
use crate::repositories::settings_store::SettingsStore;

/// 蒸馏结果
#[derive(Debug, Clone)]
pub struct DistillResult {
    /// 创建的 MemCell 数量
    pub created: usize,
    /// 是否跳过
    pub skipped: bool,
    /// 结果消息
    pub message: String,
}

/// 将置信度限制在 [0, 1] 范围内，保留两位小数
fn clamp_confidence(value: f64) -> f64 {
    let clamped = value.max(0.0).min(1.0);
    (clamped * 100.0).round() / 100.0
}

/// 从 ISO 时间戳获取当前时间
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 从 DistillEvent 构造 CleanEpisode
///
/// 校验：title/summary 非空，segment_ids 必须来自输入的 allowed_segment_ids
fn normalize_event(
    raw: &DistillEvent,
    date: &str,
    hour_bucket: &str,
    allowed_segment_ids: &std::collections::HashSet<String>,
    model_name: &str,
) -> Option<CleanEpisode> {
    let title = raw.title.trim();
    let summary = raw.summary.trim();
    if title.is_empty() || summary.is_empty() {
        return None;
    }

    // 过滤 segment_ids：仅保留输入中存在的
    let segment_ids: Vec<String> = raw
        .segment_ids
        .iter()
        .filter(|id| allowed_segment_ids.contains(*id))
        .cloned()
        .collect();
    if segment_ids.is_empty() {
        return None;
    }

    // 规范化 entities
    let entities: Vec<EntityRef> = raw
        .entities
        .iter()
        .filter_map(|e| {
            let name = e.name.trim();
            if name.is_empty() {
                return None;
            }
            Some(EntityRef {
                ref_type: parse_entity_type(&e.ref_type),
                name: name.to_string(),
                value: if e.value.is_empty() {
                    None
                } else {
                    Some(e.value.clone())
                },
                confidence: clamp_confidence(e.confidence),
                user_confirmed: false,
            })
        })
        .collect();

    // 规范化 evidence_refs
    let evidence_refs: Vec<EvidenceRef> = raw
        .evidence_refs
        .iter()
        .filter_map(|er| {
            if !allowed_segment_ids.contains(&er.segment_id) {
                return None;
            }
            Some(EvidenceRef {
                segment_id: er.segment_id.clone(),
                quote: er.quote.chars().take(300).collect(),
                reason: er.reason.chars().take(160).collect(),
            })
        })
        .collect();

    let ts = now_iso();
    Some(CleanEpisode {
        id: Uuid::new_v4().to_string(),
        date: date.to_string(),
        hour_bucket: hour_bucket.to_string(),
        start_time: raw.start_time.clone(),
        end_time: raw.end_time.clone(),
        title: title.to_string(),
        summary: summary.to_string(),
        memory_kind: parse_memory_kind(&raw.memory_kind),
        project: raw.project.trim().to_string(),
        entities,
        topics: raw.topics.iter().take(12).cloned().collect(),
        materials: raw.materials.iter().take(12).cloned().collect(),
        outputs: raw.outputs.iter().take(12).cloned().collect(),
        todos: raw.todos.iter().take(12).cloned().collect(),
        blockers: raw.blockers.iter().take(8).cloned().collect(),
        segment_ids,
        evidence_refs,
        source_quality: parse_source_quality(&raw.source_quality),
        confidence: clamp_confidence(raw.confidence),
        report_eligible: raw.report_eligible,
        wiki_eligible: raw.wiki_eligible,
        wiki_status: parse_wiki_status(&raw.wiki_status),
        created_at: ts.clone(),
        updated_at: ts,
        model_name: model_name.to_string(),
        distill_version: crate::ai::distill_prompt::DISTILL_VERSION.to_string(),
    })
}

/// 解析实体类型字符串
fn parse_entity_type(s: &str) -> EntityRefType {
    match s {
        "project" => EntityRefType::Project,
        "document" => EntityRefType::Document,
        "url" => EntityRefType::Url,
        _ => EntityRefType::Person,
    }
}

/// 解析记忆类型字符串
fn parse_memory_kind(s: &str) -> MemoryKind {
    MemoryKind::from_str(s)
}

/// 解析来源质量字符串
fn parse_source_quality(s: &str) -> SourceQuality {
    SourceQuality::from_str(s)
}

/// 解析 Wiki 状态字符串
fn parse_wiki_status(s: &str) -> WikiStatus {
    WikiStatus::from_str(s)
}

/// 从 DistillEvent + CleanEpisode 构造 MemCell
///
/// episode 取 event.episode，为空时回退到 clean_episode.summary
/// facts 取 event.facts（去空白、去空）
/// foresight 取 event.foresight（转 Foresight 结构，使用 statement 作为 text）
fn build_mem_cell(event: &DistillEvent, clean_episode: &CleanEpisode) -> MemCell {
    let episode = {
        let trimmed = event.episode.trim();
        if trimmed.is_empty() {
            clean_episode.summary.clone()
        } else {
            trimmed.to_string()
        }
    };

    let facts: Vec<String> = event
        .facts
        .iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .collect();

    // Rust Foresight 结构：text + confidence（无 valid_from/valid_to）
    let foresight: Vec<Foresight> = event
        .foresight
        .iter()
        .map(|f| Foresight {
            text: f.statement.trim().to_string(),
            confidence: clamp_confidence(f.confidence),
        })
        .filter(|f| !f.text.is_empty())
        .collect();

    let ts = now_iso();
    MemCell {
        id: Uuid::new_v4().to_string(),
        clean_episode_id: clean_episode.id.clone(),
        episode,
        facts,
        foresight,
        metadata: MemCellMetadata {
            segment_ids: clean_episode.segment_ids.clone(),
            timestamp: ts.clone(),
            confidence: clean_episode.confidence,
        },
        created_at: ts,
    }
}

/// DistillManager：小时级蒸馏管理器
pub struct DistillManager {
    builder: HourContextPackBuilder,
    running: AtomicBool,
}

impl DistillManager {
    pub fn new() -> Self {
        DistillManager {
            builder: HourContextPackBuilder::new(),
            running: AtomicBool::new(false),
        }
    }

    /// 是否正在运行蒸馏
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 蒸馏指定 segments，生成 MemCell 并发布事件。
    ///
    /// # 参数
    /// - `segments`：本小时内的工作片段
    ///
    /// # 返回
    /// 蒸馏结果（含创建的 MemCell 数量）；无 segments 或 AI 不可用时返回 skipped
    pub async fn distill_segments(&self, segments: &[WorkSegment]) -> Result<Option<MemCell>> {
        if segments.is_empty() {
            return Ok(None);
        }

        self.running.store(true, Ordering::SeqCst);
        let result = self.do_distill(segments).await;
        self.running.store(false, Ordering::SeqCst);
        result
    }

    /// 实际蒸馏逻辑
    async fn do_distill(&self, segments: &[WorkSegment]) -> Result<Option<MemCell>> {
        // 1. 构建上下文包
        let date = segments
            .first()
            .map(|s| s.date.clone())
            .unwrap_or_default();
        let hour = segments
            .first()
            .map(|s| {
                let parts: Vec<&str> = s.start_time.split(':').collect();
                parts.first().and_then(|h| h.parse::<u32>().ok()).unwrap_or(0)
            })
            .unwrap_or(0);

        let pack = self.builder.build_pack(&date, hour)?;
        if pack.segments.is_empty() {
            return Ok(None);
        }

        // 2. 检查 API 配置
        let api_key = SettingsStore::get_api_key();
        if api_key.is_empty() {
            return Ok(None);
        }
        let model_name = SettingsStore::get().model_name;

        // 3. 构建提示词
        let prompt = build_distill_prompt(&pack.segments, &pack.summary);
        let masked = mask_sensitive(&prompt.user);

        // 4. 调用 AI
        let client = OpenAIClient::new();
        let req = ChatCompletionRequest {
            model: model_name.clone(),
            messages: vec![
                Message::new("system", &prompt.system),
                Message::new("user", &masked.text),
            ],
            temperature: Some(0.2),
            max_tokens: Some(4096),
            stream: None,
        };

        let resp = client.chat_completion(req).await?;
        let (events, _skipped) = parse_distill_response(&resp.content)?;

        if events.is_empty() {
            return Ok(None);
        }

        // 5. 构造 CleanEpisode + MemCell
        let allowed_segment_ids: std::collections::HashSet<String> =
            pack.segments.iter().map(|s| s.id.clone()).collect();
        let hour_bucket = format!("{:02}:00", hour);

        // 清理旧 CleanEpisode（避免重复）
        let _ = CleanEpisodeRepository::delete_by_hour(&date, &hour_bucket);

        for event in &events {
            if let Some(clean_episode) =
                normalize_event(event, &date, &hour_bucket, &allowed_segment_ids, &model_name)
            {
                // 写入 CleanEpisode
                if let Err(e) = CleanEpisodeRepository::insert(clean_episode.clone()) {
                    log::error!("[DistillManager] CleanEpisode 写入失败: {}", e);
                    continue;
                }

                // 构造并写入 MemCell
                let mem_cell = build_mem_cell(event, &clean_episode);
                if let Err(e) = MemCellRepository::insert(mem_cell.clone()) {
                    log::error!("[DistillManager] MemCell 写入失败: {}", e);
                    continue;
                }

                // 发布 MemCellCreated 事件
                EventBus::publish(AppEvent::MemCellCreated {
                    mem_cell_id: mem_cell.id.clone(),
                });

                // 仅返回第一个成功的 MemCell（简化接口）
                return Ok(Some(mem_cell));
            }
        }

        Ok(None)
    }
}

impl Default for DistillManager {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 clamp_confidence
    #[test]
    fn test_clamp_confidence() {
        assert!((clamp_confidence(0.5) - 0.5).abs() < 0.001);
        assert!((clamp_confidence(-0.1) - 0.0).abs() < 0.001);
        assert!((clamp_confidence(1.5) - 1.0).abs() < 0.001);
        assert!((clamp_confidence(0.567) - 0.57).abs() < 0.001);
    }

    /// 测试 parse_entity_type
    #[test]
    fn test_parse_entity_type() {
        assert_eq!(parse_entity_type("person"), EntityRefType::Person);
        assert_eq!(parse_entity_type("project"), EntityRefType::Project);
        assert_eq!(parse_entity_type("document"), EntityRefType::Document);
        assert_eq!(parse_entity_type("url"), EntityRefType::Url);
        assert_eq!(parse_entity_type("invalid"), EntityRefType::Person);
    }

    /// 测试 parse_memory_kind
    #[test]
    fn test_parse_memory_kind() {
        assert_eq!(parse_memory_kind("coding"), MemoryKind::Coding);
        assert_eq!(parse_memory_kind("work"), MemoryKind::Work);
        assert_eq!(parse_memory_kind("invalid"), MemoryKind::IdleUncertain);
    }

    /// 测试 build_mem_cell：episode 为空时回退到 clean_episode.summary
    #[test]
    fn test_build_mem_cell_episode_fallback() {
        let event = DistillEvent {
            title: "标题".to_string(),
            summary: "摘要".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "10:30:00".to_string(),
            memory_kind: "coding".to_string(),
            project: String::new(),
            entities: vec![],
            topics: vec![],
            materials: vec![],
            outputs: vec![],
            todos: vec![],
            blockers: vec![],
            segment_ids: vec!["seg-1".to_string()],
            evidence_refs: vec![],
            source_quality: "high".to_string(),
            confidence: 0.8,
            report_eligible: true,
            wiki_eligible: false,
            wiki_status: "none".to_string(),
            episode: "".to_string(), // 空 episode
            facts: vec!["事实1".to_string()],
            foresight: vec![],
        };

        let clean_episode = CleanEpisode {
            id: "ce-1".to_string(),
            date: "2026-06-22".to_string(),
            hour_bucket: "10:00".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "10:30:00".to_string(),
            title: "标题".to_string(),
            summary: "CleanEpisode 摘要".to_string(),
            memory_kind: MemoryKind::Coding,
            project: String::new(),
            entities: vec![],
            topics: vec![],
            materials: vec![],
            outputs: vec![],
            todos: vec![],
            blockers: vec![],
            segment_ids: vec!["seg-1".to_string()],
            evidence_refs: vec![],
            source_quality: SourceQuality::High,
            confidence: 0.8,
            report_eligible: true,
            wiki_eligible: false,
            wiki_status: WikiStatus::None,
            created_at: "2026-06-22T10:00:00Z".to_string(),
            updated_at: "2026-06-22T10:00:00Z".to_string(),
            model_name: "gpt-4o-mini".to_string(),
            distill_version: "hourly-v1".to_string(),
        };

        let mem_cell = build_mem_cell(&event, &clean_episode);
        // episode 为空时回退到 clean_episode.summary
        assert_eq!(mem_cell.episode, "CleanEpisode 摘要");
        assert_eq!(mem_cell.facts, vec!["事实1".to_string()]);
        assert_eq!(mem_cell.clean_episode_id, "ce-1");
    }

    /// 测试 DistillManager 创建与状态
    #[test]
    fn test_distill_manager_new() {
        let manager = DistillManager::new();
        assert!(!manager.is_running());
    }
}
