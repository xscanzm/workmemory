//! WikiExtractor：Wiki 自动提取器（对应 electron/wiki/WikiExtractor.ts）
//!
//! 基于 CleanEpisode 的 OCR 文本，提炼 Markdown Wiki 内容。
//!
//! 提取结构化内容：
//!  - oneLineSummary：基于高频动作词 + 对象
//!  - currentProgress：检测"已完成"、"进行中"、"待办"等状态词
//!  - keyFacts：提取陈述句（含"是"、"为"、"使用"、"采用"等动词），去重 top 5
//!  - pendingQuestions：提取疑问句（含"?"、"？"、"是否"、"怎么"、"如何"）
//!  - extractedLinks：提取其他已知 WikiPage 标题在文本中的出现，生成 [[link]]
//!
//! 纯规则提取，不调用外部 AI（本地优先）。

use regex::Regex;

use crate::models::{CleanEpisode, WikiType};
use crate::repositories::segment_repository::SegmentRepository;
use crate::repositories::wiki_repository::WikiRepository;

/// Wiki 提取草稿：从单个 CleanEpisode 提取出的 Wiki 页草稿
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiPageDraft {
    /// 标题
    pub title: String,
    /// Markdown 正文
    pub content: String,
    /// Wiki 类型
    pub wiki_type: WikiType,
    /// 来源 Episode id
    pub source_episode_id: String,
}

/// 动作词映射（用于 oneLineSummary 生成）
const ACTION_VERBS: &[(&str, &str)] = &[
    (r"编写|实现|开发|编码|coding|implement", "编写"),
    (r"修改|更新|调整|优化|重构|fix|update|modify|refactor", "修改"),
    (r"撰写|起草|draft|write", "撰写"),
    (r"编辑|修订|审阅|edit|revise|review", "编辑"),
    (r"测试|调试|test|debug", "测试"),
    (r"部署|发布|上线|deploy|release|publish", "部署"),
    (r"设计|规划|架构|design|plan|architect", "设计"),
    (r"搜索|查询|检索|search|query|find", "搜索"),
    (r"沟通|讨论|交流|会议|chat|discuss|meeting", "沟通"),
    (r"配置|设置|config|setting", "配置"),
    (r"创建|新建|添加|create|add|new", "创建"),
];

/// 状态词模式（用于 currentProgress 检测）
const PROGRESS_PATTERNS: &[(&str, &str)] = &[
    (r"已完成|done|completed|finished|完成", "已完成"),
    (r"进行中|ongoing|in progress|processing|推进中", "进行中"),
    (r"待办|todo|pending|待处理|未开始|planned", "待办"),
    (r"阻塞|blocked|卡住|stuck|暂停|paused", "阻塞"),
];

/// keyFacts 最大数量
const KEY_FACTS_MAX: usize = 5;
/// pendingQuestions 最大数量
const PENDING_QUESTIONS_MAX: usize = 5;
/// currentProgress 最大数量
const CURRENT_PROGRESS_MAX: usize = 4;

/// 陈述句动词模式（用于 keyFacts 提取）
fn declarative_verb_regex() -> &'static Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"(是|为|使用|采用|基于|属于|包含|涉及|需要|要求|支持|提供|实现|通过|利用|借助|依赖)").unwrap());
    &RE
}

/// 疑问句标记
fn question_regex() -> &'static Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[?？]").unwrap());
    &RE
}

fn question_marker_regex() -> &'static Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(是否|怎么|如何|为什么|为何|哪儿|哪里|哪个|哪些|什么|怎样|能否|可以吗|吗|呢)").unwrap()
    });
    &RE
}

/// 句子分割正则（中英文标点）
fn sentence_split_regex() -> &'static Regex {
    use once_cell::sync::Lazy;
    static RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[。！？!?\n；;]+").unwrap());
    &RE
}

/// WikiExtractor：Wiki 自动提取器。
pub struct WikiExtractor;

impl WikiExtractor {
    /// 创建实例
    pub fn new() -> Self {
        WikiExtractor
    }

    /// 从单个 CleanEpisode 提取 Wiki 页草稿。
    ///
    /// 流程：
    ///  1. 聚合 sourceIds 对应 Segments 的 OCR 文本
    ///  2. 提取结构化内容（oneLineSummary / currentProgress / keyFacts / pendingQuestions）
    ///  3. 提取双链标签（已知 WikiPage 标题在文本中的出现）
    ///  4. 生成 Markdown（含 YAML front matter）
    pub fn extract_from_episode(
        &self,
        episode: &CleanEpisode,
    ) -> anyhow::Result<Vec<WikiPageDraft>> {
        // 1. 聚合 OCR 文本
        let aggregated_text = self.aggregate_ocr_text(episode);
        let titles_and_summaries = format!("{}\n{}", episode.title, episode.summary);
        let full_text = format!("{}\n{}", aggregated_text, titles_and_summaries);

        // 2. 提取结构化内容
        let one_line_summary = self.extract_one_line_summary(&full_text, episode);
        let current_progress = self.extract_current_progress(&full_text);
        let key_facts = self.extract_key_facts(&full_text);
        let pending_questions = self.extract_pending_questions(&full_text);

        // 3. 提取双链标签
        let extracted_links = self.extract_wiki_links(&full_text);

        // 4. 推断标题与类型
        let title = self.infer_title(episode);
        let wiki_type = self.infer_wiki_type(episode);

        // 5. 生成 Markdown
        let content = self.generate_markdown(
            &title,
            &wiki_type,
            &one_line_summary,
            &current_progress,
            &key_facts,
            &pending_questions,
            &extracted_links,
            episode,
        );

        // 单个 episode 通常生成一个草稿
        Ok(vec![WikiPageDraft {
            title,
            content,
            wiki_type,
            source_episode_id: episode.id.clone(),
        }])
    }

    // ===================== 结构化内容提取 =====================

    /// 提取一句话总结：高频动作词 + 对象
    fn extract_one_line_summary(&self, text: &str, episode: &CleanEpisode) -> String {
        // 提取动作词（按出现顺序去重）
        let mut actions: Vec<&str> = Vec::new();
        for (pattern, verb) in ACTION_VERBS {
            if let Ok(re) = Regex::new(pattern) {
                if re.is_match(text) && !actions.contains(verb) {
                    actions.push(verb);
                }
            }
        }

        // 提取主题对象（top 关键词）
        let keywords = extract_keywords(text);
        let top_keywords: String = keywords.iter().take(3).cloned().collect();

        // 组合一句话
        let segment_count = episode.segment_ids.len().max(1);
        if !actions.is_empty() && !top_keywords.is_empty() {
            let action_str = actions.iter().take(2).copied().collect::<Vec<_>>().join("并");
            return format!("{}{}，共涉及 {} 个工作片段", action_str, top_keywords, segment_count);
        }
        if !actions.is_empty() {
            return format!("{}相关内容，共涉及 {} 个工作片段", actions[0], segment_count);
        }
        if !top_keywords.is_empty() {
            return format!("推进{}，共涉及 {} 个工作片段", top_keywords, segment_count);
        }
        // 降级：使用候选标题
        format!("{}：基于 {} 个工作片段整理", episode.title, segment_count)
    }

    /// 提取当前进展：检测状态词，返回相关句子
    fn extract_current_progress(&self, text: &str) -> Vec<String> {
        let sentences = self.split_sentences(text);
        let mut progress: Vec<String> = Vec::new();
        let mut seen_labels: std::collections::HashSet<&str> = std::collections::HashSet::new();

        for sentence in &sentences {
            for (pattern, label) in PROGRESS_PATTERNS {
                if let Ok(re) = Regex::new(pattern) {
                    if re.is_match(sentence) && !seen_labels.contains(label) {
                        seen_labels.insert(label);
                        progress.push(format!("[{}] {}", label, sentence.trim()));
                        break;
                    }
                }
            }
            if progress.len() >= CURRENT_PROGRESS_MAX {
                break;
            }
        }
        progress
    }

    /// 提取关键事实：含陈述动词的句子，去重 top 5
    fn extract_key_facts(&self, text: &str) -> Vec<String> {
        let sentences = self.split_sentences(text);
        let mut facts: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let decl_re = declarative_verb_regex();
        let q_re = question_regex();
        let qm_re = question_marker_regex();

        for sentence in &sentences {
            let trimmed = sentence.trim();
            let len = trimmed.chars().count();
            if len < 5 || len > 200 {
                continue;
            }
            // 必须含陈述动词
            if !decl_re.is_match(trimmed) {
                continue;
            }
            // 排除疑问句
            if q_re.is_match(trimmed) || qm_re.is_match(trimmed) {
                continue;
            }
            // 去重（按前 30 字）
            let dedup_key: String = trimmed.chars().take(30).collect();
            if seen.contains(&dedup_key) {
                continue;
            }
            seen.insert(dedup_key);
            facts.push(trimmed.to_string());
            if facts.len() >= KEY_FACTS_MAX {
                break;
            }
        }
        facts
    }

    /// 提取待确认问题：疑问句
    fn extract_pending_questions(&self, text: &str) -> Vec<String> {
        let sentences = self.split_sentences(text);
        let mut questions: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let q_re = question_regex();
        let qm_re = question_marker_regex();

        for sentence in &sentences {
            let trimmed = sentence.trim();
            let len = trimmed.chars().count();
            if len < 3 || len > 200 {
                continue;
            }
            // 必须是疑问句
            let is_question = q_re.is_match(trimmed) || qm_re.is_match(trimmed);
            if !is_question {
                continue;
            }
            // 去重
            let dedup_key: String = trimmed.chars().take(30).collect();
            if seen.contains(&dedup_key) {
                continue;
            }
            seen.insert(dedup_key.clone());
            // 确保以 ? 或 ？ 结尾
            let normalized = if q_re.is_match(trimmed) {
                trimmed.to_string()
            } else {
                format!("{}？", trimmed)
            };
            questions.push(normalized);
            if questions.len() >= PENDING_QUESTIONS_MAX {
                break;
            }
        }
        questions
    }

    /// 提取双链标签：已知 WikiPage 标题在文本中的出现
    fn extract_wiki_links(&self, text: &str) -> Vec<String> {
        let all_pages = match WikiRepository::get_all() {
            Ok(pages) => pages,
            Err(_) => return Vec::new(),
        };
        if all_pages.is_empty() {
            return Vec::new();
        }

        let mut links: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        for page in &all_pages {
            // 检查 title 在文本中出现
            if page.title.chars().count() >= 2 && text.contains(&page.title) {
                if !seen.contains(&page.title) {
                    seen.insert(page.title.clone());
                    links.push(page.title.clone());
                }
                continue;
            }
            // 检查 aliases 在文本中出现
            for alias in &page.aliases {
                let trimmed = alias.trim();
                if trimmed.chars().count() >= 2 && text.contains(trimmed) {
                    if !seen.contains(&page.title) {
                        seen.insert(page.title.clone());
                        links.push(page.title.clone());
                    }
                    break;
                }
            }
        }
        links
    }

    // ===================== Markdown 生成 =====================

    /// 生成完整 Markdown（含 YAML front matter）
    fn generate_markdown(
        &self,
        title: &str,
        wiki_type: &WikiType,
        one_line_summary: &str,
        current_progress: &[String],
        key_facts: &[String],
        pending_questions: &[String],
        extracted_links: &[String],
        episode: &CleanEpisode,
    ) -> String {
        // YAML front matter
        let sources_json = serde_json::to_string(&episode.segment_ids).unwrap_or_else(|_| "[]".to_string());
        let yaml = format!(
            "---\ntitle: \"{}\"\ntype: \"{}\"\naliases: []\nsources: {}\nconfidence: {}\n---",
            escape_yaml(title),
            wiki_type.as_str(),
            sources_json,
            episode.confidence
        );

        // 正文
        let mut sections: Vec<String> = Vec::new();
        sections.push(format!("# {}", title));
        sections.push(String::new());

        // 一句话总结
        sections.push("## 一句话总结".to_string());
        sections.push(one_line_summary.to_string());
        sections.push(String::new());

        // 当前进展
        sections.push("## 当前进展".to_string());
        if !current_progress.is_empty() {
            for p in current_progress {
                sections.push(format!("- {}", p));
            }
        } else {
            sections.push("- （暂未检测到明确进展状态）".to_string());
        }
        sections.push(String::new());

        // 关键事实
        sections.push("## 关键事实".to_string());
        if !key_facts.is_empty() {
            for f in key_facts {
                sections.push(format!("- {}", f));
            }
        } else {
            sections.push("- （暂未提取到关键事实）".to_string());
        }
        sections.push(String::new());

        // 待确认
        sections.push("## 待确认".to_string());
        if !pending_questions.is_empty() {
            for q in pending_questions {
                sections.push(format!("- {}", q));
            }
        } else {
            sections.push("- （暂无疑问）".to_string());
        }
        sections.push(String::new());

        // 相关链接（双链）
        sections.push("## 相关链接".to_string());
        if !extracted_links.is_empty() {
            for l in extracted_links {
                sections.push(format!("- [[{}]]", l));
            }
        } else {
            sections.push("- （暂无关联 Wiki 页）".to_string());
        }
        sections.push(String::new());

        // 来源片段
        sections.push("## 来源片段".to_string());
        sections.push(format!("- [{}] {}", episode.date, episode.title));

        format!("{}\n\n{}", yaml, sections.join("\n"))
    }

    // ===================== 内部工具 =====================

    /// 聚合 Episode 关联 Segments 的 OCR 文本
    fn aggregate_ocr_text(&self, episode: &CleanEpisode) -> String {
        if episode.segment_ids.is_empty() {
            return format!("{}\n{}", episode.title, episode.summary);
        }
        let segments = match SegmentRepository::get_by_ids(&episode.segment_ids) {
            Ok(s) => s,
            Err(_) => return format!("{}\n{}", episode.title, episode.summary),
        };
        let ocr_texts: Vec<&String> = segments.iter().map(|s| &s.ocr_text).filter(|t| !t.is_empty()).collect();
        if ocr_texts.is_empty() {
            return format!("{}\n{}", episode.title, episode.summary);
        }
        ocr_texts.into_iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// 分割句子（中英文标点）
    fn split_sentences(&self, text: &str) -> Vec<String> {
        if text.is_empty() {
            return Vec::new();
        }
        let re = sentence_split_regex();
        re.split(text)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// 推断 Wiki 标题
    fn infer_title(&self, episode: &CleanEpisode) -> String {
        if !episode.project.is_empty() {
            return episode.project.clone();
        }
        if let Some(material) = episode.materials.first() {
            if !material.is_empty() {
                return material.clone();
            }
        }
        if let Some(entity) = episode.entities.first() {
            if !entity.name.is_empty() {
                return entity.name.clone();
            }
        }
        episode.title.clone()
    }

    /// 推断 Wiki 类型
    fn infer_wiki_type(&self, episode: &CleanEpisode) -> WikiType {
        if episode.entities.iter().any(|e| e.ref_type == crate::models::EntityRefType::Person) {
            return WikiType::Person;
        }
        if !episode.project.is_empty()
            || episode
                .entities
                .iter()
                .any(|e| e.ref_type == crate::models::EntityRefType::Project)
        {
            return WikiType::Project;
        }
        if !episode.blockers.is_empty() {
            return WikiType::Issue;
        }
        if episode.memory_kind == crate::models::MemoryKind::Communication {
            return WikiType::Meeting;
        }
        WikiType::Topic
    }
}

impl Default for WikiExtractor {
    fn default() -> Self {
        Self::new()
    }
}

/// YAML 字符串转义
fn escape_yaml(s: &str) -> String {
    s.replace('"', "\\\"")
}

/// 简单关键词提取（中文双字 bigram + 英文单词）
fn extract_keywords(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    if text.is_empty() {
        return tokens;
    }

    // 中文双字 bigram
    if let Ok(re) = Regex::new(r"[\u4e00-\u9fff]+") {
        for seg in re.find_iter(text) {
            let chars: Vec<char> = seg.as_str().chars().collect();
            for i in 0..chars.len().saturating_sub(1) {
                let bigram: String = chars[i..i + 2].iter().collect();
                if seen.insert(bigram.clone()) {
                    tokens.push(bigram);
                }
            }
        }
    }

    // 英文单词（长度 >= 2，小写化）
    if let Ok(re) = Regex::new(r"[a-zA-Z]{2,}") {
        for w in re.find_iter(text) {
            let lower = w.as_str().to_lowercase();
            if seen.insert(lower.clone()) {
                tokens.push(lower);
            }
        }
    }
    tokens
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        CleanEpisode, EntityRef, EntityRefType, MemoryKind, SourceQuality, WikiStatus,
    };

    fn make_episode() -> CleanEpisode {
        CleanEpisode {
            id: "ep-1".to_string(),
            date: "2026-06-22".to_string(),
            hour_bucket: "10".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "11:00:00".to_string(),
            title: "Tauri 配置梳理".to_string(),
            summary: "编写 Tauri 配置文档，已完成基础部分。".to_string(),
            memory_kind: MemoryKind::Work,
            project: "Tauri 配置".to_string(),
            entities: vec![EntityRef {
                ref_type: EntityRefType::Project,
                name: "Tauri 配置".to_string(),
                value: None,
                confidence: 0.9,
                user_confirmed: false,
            }],
            topics: vec!["Tauri".to_string(), "配置".to_string()],
            materials: vec![],
            outputs: vec!["配置文档".to_string()],
            todos: vec![],
            blockers: vec![],
            segment_ids: vec![],
            evidence_refs: vec![],
            source_quality: SourceQuality::High,
            confidence: 0.85,
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
    fn test_extract_one_line_summary_with_action_and_keywords() {
        let extractor = WikiExtractor::new();
        let episode = make_episode();
        let summary = extractor.extract_one_line_summary(
            "编写 Tauri 配置文档，已完成基础部分。",
            &episode,
        );
        // 应包含动作词"编写"和关键词"Tauri"
        assert!(summary.contains("编写") || summary.contains("Tauri"), "summary={}", summary);
        assert!(summary.contains("工作片段"));
    }

    #[test]
    fn test_extract_key_facts_filters_questions() {
        let extractor = WikiExtractor::new();
        let text = "Tauri 是一个框架。如何配置？这是关键。使用 Rust 实现。";
        let facts = extractor.extract_key_facts(text);
        // "如何配置？" 是疑问句，应被排除
        assert!(!facts.iter().any(|f| f.contains("如何配置")));
        // "Tauri 是一个框架" 含"是"，应被保留
        assert!(facts.iter().any(|f| f.contains("Tauri 是一个框架")));
    }

    #[test]
    fn test_extract_pending_questions_detects_question_marks() {
        let extractor = WikiExtractor::new();
        let text = "如何配置 Tauri？是否需要 Rust？这是陈述句。";
        let questions = extractor.extract_pending_questions(text);
        assert!(questions.iter().any(|q| q.contains("如何配置")));
        assert!(questions.iter().any(|q| q.contains("是否需要")));
        // 陈述句不应出现在疑问列表
        assert!(!questions.iter().any(|q| q.contains("陈述句")));
    }

    #[test]
    fn test_infer_wiki_type_person() {
        let extractor = WikiExtractor::new();
        let mut episode = make_episode();
        episode.entities.push(EntityRef {
            ref_type: EntityRefType::Person,
            name: "张三".to_string(),
            value: None,
            confidence: 0.9,
            user_confirmed: false,
        });
        assert_eq!(extractor.infer_wiki_type(&episode), WikiType::Person);
    }

    #[test]
    fn test_split_sentences_chinese_punctuation() {
        let extractor = WikiExtractor::new();
        let sentences = extractor.split_sentences("第一句。第二句！第三句？第四句；");
        assert_eq!(sentences.len(), 4);
        assert_eq!(sentences[0], "第一句");
        assert_eq!(sentences[3], "第四句");
    }

    #[test]
    fn test_escape_yaml_quotes() {
        assert_eq!(escape_yaml(r#"hello "world""#), r#"hello \"world\""#);
    }
}
