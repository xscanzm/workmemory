//! ManualEpisodeCreator：手动 Episode 创建器（F8.5）
//!
//! 功能：
//!  - create(title, tags, project, text)：用户手动创建 Episode
//!  - 创建的 Episode 标记 source='manual'（通过 topics 包含 "manual" 标识）
//!  - report_eligible=true（自动纳入报告）
//!  - 不触发 OCR，不依赖截图
//!  - 通过 EpisodeRepository 持久化
//!  - 返回新创建的 Episode ID
//!
//! 用于"补录"场景：用户事后补充未自动捕获的工作事件。

use crate::models::{Episode, EntityRef, EntityRefType};
use crate::repositories::episode_repository::EpisodeRepository;

/// 手动 Episode 的标识 tag（写入 topics 标记来源）
pub const MANUAL_SOURCE_TAG: &str = "manual";

/// ManualEpisodeCreator：手动 Episode 创建器
pub struct ManualEpisodeCreator;

impl ManualEpisodeCreator {
    /// 创建实例
    pub fn new() -> Self {
        ManualEpisodeCreator
    }

    /// 手动创建 Episode。
    ///
    /// # 参数
    /// - `title`：Episode 标题
    /// - `tags`：用户标签（写入 topics）
    /// - `project`：关联项目（可选，写入 entities + topics）
    /// - `text`：一句话总结 / 详细描述
    ///
    /// # 返回
    /// 新创建的 Episode ID
    pub fn create(
        &self,
        title: String,
        tags: Vec<String>,
        project: Option<String>,
        text: String,
    ) -> anyhow::Result<String> {
        let episode = self.build_episode(title, tags, project, text);
        let saved = EpisodeRepository::insert(episode)?;
        Ok(saved.id)
    }

    /// 构建 Episode 实例（公开供测试调用，不写库）
    pub fn build_episode(
        &self,
        title: String,
        tags: Vec<String>,
        project: Option<String>,
        text: String,
    ) -> Episode {
        let now = chrono::Local::now();
        let date = now.format("%Y-%m-%d").to_string();
        let time = now.format("%H:%M:%S").to_string();

        // 聚合 topics：用户 tags + manual 标识 + 项目名
        let mut topics: Vec<String> = Vec::new();
        topics.push(MANUAL_SOURCE_TAG.to_string());
        for tag in &tags {
            if !tag.is_empty() && !topics.contains(tag) {
                topics.push(tag.clone());
            }
        }
        if let Some(p) = &project {
            if !p.is_empty() && !topics.contains(p) {
                topics.push(p.clone());
            }
        }

        // 构建 entities：项目作为 Project 实体
        let mut entities: Vec<EntityRef> = Vec::new();
        if let Some(p) = &project {
            if !p.is_empty() {
                entities.push(EntityRef {
                    ref_type: EntityRefType::Project,
                    name: p.clone(),
                    value: None,
                    confidence: 1.0,
                    user_confirmed: true,
                });
            }
        }

        // 一句话总结：优先使用 text，否则回退到 title
        let one_line_summary = if text.trim().is_empty() {
            title.clone()
        } else {
            text.clone()
        };

        Episode {
            id: String::new(), // 由 Repository 生成 UUID
            date,
            start_time: time.clone(),
            end_time: time,
            title,
            one_line_summary,
            segment_ids: Vec::new(), // 手动 Episode 不关联 segment
            entities,
            topics,
            user_edited: true, // 手动创建视为用户编辑
            report_eligible: true, // 按 spec 要求
            wiki_eligible: true,  // 允许后续 Wiki 沉淀
            dominant_activity_type: None,
        }
    }
}

impl Default for ManualEpisodeCreator {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_episode_basic() {
        let creator = ManualEpisodeCreator::new();
        let episode = creator.build_episode(
            "编写周报".to_string(),
            vec!["周报".to_string()],
            Some("WorkMemory".to_string()),
            "本周完成了 Phase 8 模块".to_string(),
        );
        assert_eq!(episode.title, "编写周报");
        assert_eq!(episode.one_line_summary, "本周完成了 Phase 8 模块");
        assert!(episode.topics.contains(&MANUAL_SOURCE_TAG.to_string()));
        assert!(episode.topics.contains(&"周报".to_string()));
        assert!(episode.topics.contains(&"WorkMemory".to_string()));
        assert!(episode.report_eligible);
        assert!(episode.wiki_eligible);
        assert!(episode.user_edited);
        assert!(episode.segment_ids.is_empty());
    }

    #[test]
    fn test_build_episode_without_project() {
        let creator = ManualEpisodeCreator::new();
        let episode = creator.build_episode(
            "阅读文档".to_string(),
            vec![],
            None,
            String::new(),
        );
        assert_eq!(episode.title, "阅读文档");
        // text 为空时回退到 title
        assert_eq!(episode.one_line_summary, "阅读文档");
        assert!(episode.entities.is_empty());
        assert!(episode.topics.contains(&MANUAL_SOURCE_TAG.to_string()));
    }

    #[test]
    fn test_build_episode_includes_project_entity() {
        let creator = ManualEpisodeCreator::new();
        let episode = creator.build_episode(
            "开发功能".to_string(),
            vec![],
            Some("ProjectA".to_string()),
            "描述".to_string(),
        );
        assert_eq!(episode.entities.len(), 1);
        let entity = &episode.entities[0];
        assert_eq!(entity.ref_type, EntityRefType::Project);
        assert_eq!(entity.name, "ProjectA");
        assert!(entity.user_confirmed);
    }

    #[test]
    fn test_build_episode_deduplicates_tags() {
        let creator = ManualEpisodeCreator::new();
        let episode = creator.build_episode(
            "测试".to_string(),
            vec!["manual".to_string(), "重复".to_string(), "重复".to_string()],
            Some("重复".to_string()),
            "描述".to_string(),
        );
        // manual tag 不应重复
        let manual_count = episode.topics.iter().filter(|t| *t == MANUAL_SOURCE_TAG).count();
        assert_eq!(manual_count, 1);
        // "重复" 不应重复
        let dup_count = episode.topics.iter().filter(|t| *t == "重复").count();
        assert_eq!(dup_count, 1);
    }

    #[test]
    fn test_build_episode_date_time_format() {
        let creator = ManualEpisodeCreator::new();
        let episode = creator.build_episode(
            "测试".to_string(),
            vec![],
            None,
            "描述".to_string(),
        );
        // date 应为 YYYY-MM-DD
        assert_eq!(episode.date.len(), 10);
        assert_eq!(episode.date.chars().nth(4), Some('-'));
        assert_eq!(episode.date.chars().nth(7), Some('-'));
        // start_time / end_time 应为 HH:MM:SS
        assert_eq!(episode.start_time.len(), 8);
        assert_eq!(episode.end_time.len(), 8);
        assert_eq!(episode.start_time, episode.end_time);
    }

    #[test]
    fn test_build_episode_empty_project_ignored() {
        let creator = ManualEpisodeCreator::new();
        let episode = creator.build_episode(
            "测试".to_string(),
            vec![],
            Some(String::new()),
            "描述".to_string(),
        );
        // 空项目字符串应被忽略
        assert!(episode.entities.is_empty());
        assert!(!episode.topics.contains(&String::new()));
    }
}
