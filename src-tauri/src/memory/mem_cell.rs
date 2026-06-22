//! mem_cell：结构化记忆单元（对应 electron/memory/MemCell.ts）
//!
//! 借鉴 EverOS MemCell 概念，将记忆从"存储信息"升级为"结构化记忆单元"。
//! 包含 episode（第三人称叙事）、facts（原子事实数组）、foresight（带有效期的预见）三部分。
//!
//! MemCell 结构体复用 `crate::models::MemCell`，本模块仅提供构造器与辅助方法。

use crate::models::{Foresight, MemCell, MemCellMetadata};

/// MemCellBuilder：用于流式构造 MemCell 实例
///
/// 使用方式：
/// ```rust,ignore
/// let cell = MemCellBuilder::new()
///     .clean_episode_id("ep-1")
///     .episode("用户在 VS Code 中实现了 API Key 加密功能")
///     .fact("使用了 safeStorage API")
///     .fact("密钥存储在 userData 目录")
///     .build();
/// ```
#[derive(Debug, Clone, Default)]
pub struct MemCellBuilder {
    id: String,
    clean_episode_id: String,
    episode: String,
    facts: Vec<String>,
    foresight: Vec<Foresight>,
    metadata: MemCellMetadata,
    created_at: String,
}

impl MemCellBuilder {
    /// 创建一个空的 builder
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置 MemCell ID（留空则由 build() 自动生成 UUID）
    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    /// 设置关联的 CleanEpisode ID
    pub fn clean_episode_id(mut self, id: impl Into<String>) -> Self {
        self.clean_episode_id = id.into();
        self
    }

    /// 设置第三人称叙事
    pub fn episode(mut self, episode: impl Into<String>) -> Self {
        self.episode = episode.into();
        self
    }

    /// 追加一条原子事实
    pub fn fact(mut self, fact: impl Into<String>) -> Self {
        self.facts.push(fact.into());
        self
    }

    /// 一次性设置全部原子事实（覆盖已有值）
    pub fn facts(mut self, facts: Vec<String>) -> Self {
        self.facts = facts;
        self
    }

    /// 追加一条预见
    pub fn foresight(mut self, f: Foresight) -> Self {
        self.foresight.push(f);
        self
    }

    /// 一次性设置全部预见（覆盖已有值）
    pub fn foresights(mut self, foresight: Vec<Foresight>) -> Self {
        self.foresight = foresight;
        self
    }

    /// 设置元数据
    pub fn metadata(mut self, metadata: MemCellMetadata) -> Self {
        self.metadata = metadata;
        self
    }

    /// 设置创建时间（留空则由 build() 自动生成当前 ISO 时间戳）
    pub fn created_at(mut self, ts: impl Into<String>) -> Self {
        self.created_at = ts.into();
        self
    }

    /// 构造 MemCell 实例
    ///
    /// - id 为空时自动生成 UUID v4
    /// - created_at 为空时自动生成当前 UTC ISO 8601 时间戳
    pub fn build(self) -> MemCell {
        MemCell {
            id: if self.id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                self.id
            },
            clean_episode_id: self.clean_episode_id,
            episode: self.episode,
            facts: self.facts,
            foresight: self.foresight,
            metadata: self.metadata,
            created_at: if self.created_at.is_empty() {
                chrono::Utc::now().to_rfc3339()
            } else {
                self.created_at
            },
        }
    }
}

/// MemCell 辅助方法
impl MemCell {
    /// 构造 embedding 输入文本
    ///
    /// 规则：
    ///  - facts 非空：`episode + ' ' + facts.join(' ')`
    ///  - facts 为空：仅 `episode`（避免尾部多余空格）
    pub fn build_embedding_text(&self) -> String {
        if self.facts.is_empty() {
            return self.episode.clone();
        }
        let mut text = self.episode.clone();
        for fact in &self.facts {
            text.push(' ');
            text.push_str(fact);
        }
        text
    }

    /// 追加一条原子事实（不重复添加）
    pub fn push_fact(&mut self, fact: impl Into<String>) {
        let f = fact.into();
        if !self.facts.iter().any(|x| x == &f) {
            self.facts.push(f);
        }
    }

    /// 追加一条预见
    pub fn push_foresight(&mut self, f: Foresight) {
        self.foresight.push(f);
    }

    /// 是否包含指定原子事实
    pub fn has_fact(&self, fact: &str) -> bool {
        self.facts.iter().any(|x| x == fact)
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builder_full_fields() {
        let cell = MemCellBuilder::new()
            .id("cell-1")
            .clean_episode_id("ep-1")
            .episode("用户在 VS Code 中实现了 API Key 加密功能")
            .fact("使用了 safeStorage API")
            .fact("密钥存储在 userData 目录")
            .created_at("2026-06-22T10:00:00Z")
            .build();

        assert_eq!(cell.id, "cell-1");
        assert_eq!(cell.clean_episode_id, "ep-1");
        assert_eq!(cell.episode, "用户在 VS Code 中实现了 API Key 加密功能");
        assert_eq!(cell.facts.len(), 2);
        assert_eq!(cell.facts[0], "使用了 safeStorage API");
        assert_eq!(cell.facts[1], "密钥存储在 userData 目录");
        assert_eq!(cell.created_at, "2026-06-22T10:00:00Z");
    }

    #[test]
    fn test_builder_auto_generate_id_and_timestamp() {
        let cell = MemCellBuilder::new()
            .clean_episode_id("ep-2")
            .episode("测试自动生成")
            .build();
        // ID 与时间戳应自动生成
        assert!(!cell.id.is_empty());
        assert!(!cell.created_at.is_empty());
        assert_ne!(cell.id, "");
    }

    #[test]
    fn test_build_embedding_text_with_facts() {
        let cell = MemCellBuilder::new()
            .episode("用户实现了加密功能")
            .fact("使用了 safeStorage API")
            .fact("密钥存储在 userData 目录")
            .build();
        let text = cell.build_embedding_text();
        assert_eq!(
            text,
            "用户实现了加密功能 使用了 safeStorage API 密钥存储在 userData 目录"
        );
    }

    #[test]
    fn test_build_embedding_text_without_facts() {
        let cell = MemCellBuilder::new()
            .episode("用户实现了加密功能")
            .build();
        let text = cell.build_embedding_text();
        // 无 facts 时仅返回 episode，无尾部空格
        assert_eq!(text, "用户实现了加密功能");
    }

    #[test]
    fn test_push_fact_dedup() {
        let mut cell = MemCellBuilder::new()
            .episode("测试")
            .fact("事实A")
            .build();
        // 重复添加不应增加
        cell.push_fact("事实A");
        assert_eq!(cell.facts.len(), 1);
        // 新事实应被添加
        cell.push_fact("事实B");
        assert_eq!(cell.facts.len(), 2);
        assert!(cell.has_fact("事实A"));
        assert!(cell.has_fact("事实B"));
        assert!(!cell.has_fact("事实C"));
    }
}
