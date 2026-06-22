//! WikiIngestManager：Wiki Ingest 编排层（对应 electron/wiki/WikiIngestManager.ts）
//!
//! 整合 HighValueSignalDetector + WikiExtractor + WikiRepository + WikiLinkEngine。
//!
//! 职责：
//!  - ingest_episode(episode)：对 CleanEpisode 调用 WikiExtractor.extract_from_episode
//!    → 草稿加入 Review Queue（via WikiRepository.add_to_review_queue）
//!  - get_review_queue()：返回 Review Queue 中的 WikiPage 列表
//!  - confirm_review(id)：用户确认 → confirmReview → update_backlinks
//!  - reject_review(id)：用户忽略 → 从 Review Queue 删除

use crate::models::{CleanEpisode, WikiPage, WikiStatus};
use crate::repositories::clean_episode_repository::CleanEpisodeRepository;
use crate::repositories::wiki_repository::WikiRepository;
use crate::wiki::wiki_extractor::WikiExtractor;
use crate::wiki::wiki_link_engine::WikiLinkEngine;

/// 自动沉淀阈值
const AUTO_UPSERT_CONFIDENCE_THRESHOLD: f64 = 0.82;
/// Review Queue 阈值
const REVIEW_CONFIDENCE_THRESHOLD: f64 = 0.5;
/// Review Queue 项的元数据键前缀（存入 WikiPage 的 sources 中前缀标记）
const REVIEW_META_PREFIX: &str = "__candidate__:";

/// WikiIngestManager：Wiki Ingest 编排层。
pub struct WikiIngestManager {
    extractor: WikiExtractor,
    link_engine: WikiLinkEngine,
}

impl WikiIngestManager {
    /// 创建实例
    pub fn new() -> Self {
        WikiIngestManager {
            extractor: WikiExtractor::new(),
            link_engine: WikiLinkEngine::new(),
        }
    }

    /// 摄入单个 CleanEpisode：
    ///  1. 调用 WikiExtractor.extract_from_episode 生成草稿
    ///  2. 根据 confidence 决定自动沉淀 or 加入 Review Queue
    ///  3. 返回生成的 WikiPage id 列表（Review Queue 项 id 或自动沉淀页 id）
    pub fn ingest_episode(&self, episode: &CleanEpisode) -> anyhow::Result<Vec<String>> {
        // 检查标题是否具体
        if !self.has_concrete_wiki_title(episode) {
            self.mark_episode_status(&episode.id, WikiStatus::Rejected)?;
            return Ok(Vec::new());
        }

        let drafts = self.extractor.extract_from_episode(episode)?;
        let mut result_ids: Vec<String> = Vec::new();

        for draft in drafts {
            if episode.confidence >= AUTO_UPSERT_CONFIDENCE_THRESHOLD {
                // 自动沉淀：upsert 到正式 wiki_pages
                let existing = WikiRepository::get_by_title(&draft.title)?;
                if let Some(existing_page) = existing {
                    let mut patch = existing_page.clone();
                    patch.content = self.merge_wiki_content(&existing_page.content, &draft.content);
                    // 合并 sources
                    let mut sources = std::collections::HashSet::new();
                    for s in &existing_page.sources {
                        sources.insert(s.clone());
                    }
                    for s in self.draft_sources(episode) {
                        sources.insert(s);
                    }
                    patch.sources = sources.into_iter().collect();
                    patch.confidence = existing_page.confidence.max(episode.confidence);
                    patch.review_status = crate::models::WikiReviewStatus::Reviewed;
                    let updated = WikiRepository::update(&existing_page.id, patch)?;
                    if let Some(page) = updated {
                        self.link_engine.update_backlinks(&page.id)?;
                        result_ids.push(page.id);
                    }
                } else {
                    let ts = chrono::Utc::now().to_rfc3339();
                    let new_page = WikiPage {
                        id: String::new(),
                        wiki_type: draft.wiki_type,
                        title: draft.title.clone(),
                        aliases: episode.topics.iter().take(5).cloned().collect(),
                        content: draft.content.clone(),
                        sources: self.draft_sources(episode),
                        backlinks: Vec::new(),
                        confidence: episode.confidence,
                        review_status: crate::models::WikiReviewStatus::Reviewed,
                        created_at: ts.clone(),
                        updated_at: ts,
                    };
                    let saved = WikiRepository::insert(new_page)?;
                    self.link_engine.update_backlinks(&saved.id)?;
                    result_ids.push(saved.id);
                }
                self.mark_episode_status(&episode.id, WikiStatus::AutoUpserted)?;
            } else if episode.confidence >= REVIEW_CONFIDENCE_THRESHOLD {
                // 加入 Review Queue
                let mut sources = vec![format!("{}{}", REVIEW_META_PREFIX, episode.id)];
                sources.extend(self.draft_sources(episode));
                let page = WikiRepository::add_to_review_queue(
                    draft.wiki_type,
                    draft.title.clone(),
                    episode.topics.iter().take(5).cloned().collect(),
                    draft.content.clone(),
                    sources,
                    episode.confidence,
                )?;
                result_ids.push(page.id);
                self.mark_episode_status(&episode.id, WikiStatus::NeedsReview)?;
            }
        }
        Ok(result_ids)
    }

    /// 获取 Review Queue（转发 WikiRepository）
    pub fn get_review_queue(&self) -> anyhow::Result<Vec<WikiPage>> {
        WikiRepository::get_review_queue()
    }

    /// 确认 Ingest：用户确认 → confirmReview 写入正式 wiki_pages → 重建反链。
    pub fn confirm_review(&self, id: &str) -> anyhow::Result<Option<WikiPage>> {
        let existing = match WikiRepository::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };

        // 确认审核（review_status → reviewed）
        let confirmed = match WikiRepository::confirm_review(id)? {
            Some(c) => c,
            None => return Ok(None),
        };

        // 清理 sources 中的候选元数据标记
        let clean_sources: Vec<String> = confirmed
            .sources
            .iter()
            .filter(|s| !s.starts_with(REVIEW_META_PREFIX))
            .cloned()
            .collect();
        let mut patch = confirmed.clone();
        patch.sources = clean_sources;
        let cleaned = WikiRepository::update(id, patch)?;

        // 重建反链（本页 + 本页引用的其他页）
        self.link_engine.update_backlinks(id)?;

        // 防止未使用变量告警
        let _ = existing;
        Ok(cleaned.or(Some(confirmed)))
    }

    /// 拒绝 Ingest：用户忽略 → 从 Review Queue 删除。
    pub fn reject_review(&self, id: &str) -> anyhow::Result<bool> {
        WikiRepository::reject_review(id)
    }

    // ===================== 内部工具 =====================

    /// 检查 CleanEpisode 是否有具体的 Wiki 标题
    fn has_concrete_wiki_title(&self, episode: &CleanEpisode) -> bool {
        let title = if !episode.project.is_empty() {
            episode.project.clone()
        } else if let Some(m) = episode.materials.first() {
            m.clone()
        } else if let Some(e) = episode.entities.first() {
            e.name.clone()
        } else {
            episode.title.clone()
        };
        let normalized: String = title.chars().filter(|c| !c.is_whitespace()).collect();
        if normalized.chars().count() < 2 {
            return false;
        }
        // 排除过于通用的标题
        let generic = ["推进", "梳理", "配置", "笔记", "工作推进", "工作片段"];
        !generic.contains(&normalized.as_str())
    }

    /// 标记 CleanEpisode 的 wiki_status
    fn mark_episode_status(
        &self,
        id: &str,
        status: WikiStatus,
    ) -> anyhow::Result<Option<CleanEpisode>> {
        let existing = match CleanEpisodeRepository::get_by_id(id)? {
            Some(e) => e,
            None => return Ok(None),
        };
        let mut patch = existing;
        patch.wiki_status = status;
        CleanEpisodeRepository::update(id, patch)
    }

    /// 构造草稿的 sources（episode id + segment ids）
    fn draft_sources(&self, episode: &CleanEpisode) -> Vec<String> {
        let mut sources = vec![episode.id.clone()];
        sources.extend(episode.segment_ids.iter().cloned());
        sources
    }

    /// 合并 Wiki 内容
    fn merge_wiki_content(&self, existing: &str, next: &str) -> String {
        format!("{}\n\n---\n\n{}", existing, next)
    }
}

impl Default for WikiIngestManager {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CleanEpisode, EntityRef, EntityRefType, MemoryKind, SourceQuality, WikiStatus,
    };

    fn make_episode(title: &str, project: &str, confidence: f64) -> CleanEpisode {
        CleanEpisode {
            id: "ep-test-1".to_string(),
            date: "2026-06-22".to_string(),
            hour_bucket: "10".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: title.to_string(),
            summary: format!("{}的总结", title),
            memory_kind: MemoryKind::Work,
            project: project.to_string(),
            entities: vec![EntityRef {
                ref_type: EntityRefType::Project,
                name: project.to_string(),
                value: None,
                confidence: 0.9,
                user_confirmed: false,
            }],
            topics: vec!["Tauri".to_string()],
            materials: vec![],
            outputs: vec![],
            todos: vec![],
            blockers: vec![],
            segment_ids: vec![],
            evidence_refs: vec![],
            source_quality: SourceQuality::High,
            confidence,
            report_eligible: true,
            wiki_eligible: true,
            wiki_status: WikiStatus::None,
            created_at: String::new(),
            updated_at: String::new(),
            model_name: String::new(),
            distill_version: String::new(),
        }
    }

    #[test]
    fn test_has_concrete_wiki_title_with_project() {
        let manager = WikiIngestManager::new();
        let episode = make_episode("Tauri 配置梳理", "Tauri 配置", 0.8);
        assert!(manager.has_concrete_wiki_title(&episode));
    }

    #[test]
    fn test_has_concrete_wiki_title_rejects_generic() {
        let manager = WikiIngestManager::new();
        let mut episode = make_episode("推进", "", 0.8);
        episode.project = String::new();
        episode.materials = vec![];
        episode.entities = vec![];
        assert!(!manager.has_concrete_wiki_title(&episode));
    }

    #[test]
    fn test_has_concrete_wiki_title_rejects_short() {
        let manager = WikiIngestManager::new();
        let mut episode = make_episode("Tauri 配置梳理", "T", 0.8);
        episode.project = "T".to_string();
        episode.materials = vec![];
        episode.entities = vec![];
        assert!(!manager.has_concrete_wiki_title(&episode));
    }

    #[test]
    fn test_draft_sources_includes_episode_and_segments() {
        let manager = WikiIngestManager::new();
        let mut episode = make_episode("Tauri", "Tauri", 0.8);
        episode.segment_ids = vec!["seg-1".to_string(), "seg-2".to_string()];
        let sources = manager.draft_sources(&episode);
        assert!(sources.contains(&"ep-test-1".to_string()));
        assert!(sources.contains(&"seg-1".to_string()));
        assert!(sources.contains(&"seg-2".to_string()));
    }

    #[test]
    fn test_merge_wiki_content_separates_with_divider() {
        let manager = WikiIngestManager::new();
        let merged = manager.merge_wiki_content("existing", "new content");
        assert!(merged.contains("existing"));
        assert!(merged.contains("new content"));
        assert!(merged.contains("---"));
    }
}
