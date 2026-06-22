//! FeedbackLoop：反馈回流引擎（对应 electron/ai/FeedbackLoop.ts）
//!
//! 在反思与进化 Sprint 中，记录用户对系统输出的反馈（重命名 Episode、拒绝 Wiki 条目、
//! 编辑日报），分析反馈模式，调整系统行为（关键词权重表）。
//!
//! 职责：
//!  - record_feedback(event)：记录单条反馈事件，写入 feedback_events 表（applied=0）
//!  - apply_feedback()：扫描所有未应用反馈事件，按 type 分组分析：
//!    - 在 before 中但不在 after 中的词视为"被拒绝词"，累计拒绝次数
//!    - 对拒绝次数 >= REJECTION_THRESHOLD 的词，按 WEIGHT_DECAY_FACTOR 衰减权重
//!  - 调整内存中的 keyword_weights（初始权重 1.0，频繁被拒绝的词权重衰减）
//!  - 标记已处理的 feedback_events 为 applied=1
//!
//! 与 TypeScript 版本的差异：
//!  - Rust FeedbackEvent 字段为 event_type（非 type）
//!  - keyword_weights 使用 Mutex<HashMap> 保证线程安全

use std::sync::{Mutex, OnceLock};

use anyhow::Result;

use crate::models::{FeedbackEvent, FeedbackEventType};
use crate::repositories::feedback_event_repository::FeedbackEventRepository;

/// 初始权重（未在 keyword_weights 中记录的词的默认值）
const INITIAL_WEIGHT: f64 = 1.0;
/// 权重下限，避免衰减到 0 失去区分度
const MIN_WEIGHT: f64 = 0.1;
/// 每次拒绝的权重衰减系数（乘法）：每次拒绝后权重 *= 0.7
const WEIGHT_DECAY_FACTOR: f64 = 0.7;
/// 触发权重调整的最小拒绝次数（"频繁修改"阈值）
const REJECTION_THRESHOLD: u32 = 3;

/// 全局关键词权重表（线程安全）
static KEYWORD_WEIGHTS: OnceLock<Mutex<std::collections::HashMap<String, f64>>> = OnceLock::new();

/// 获取全局关键词权重表
fn keyword_weights() -> &'static Mutex<std::collections::HashMap<String, f64>> {
    KEYWORD_WEIGHTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 将文本分词为关键词集合（中文双字 bigram + 英文单词）。
///
/// 与 EpisodeBuilder.extractKeywords 的分词策略保持一致，确保反馈分析的关键词
/// 与标题生成时的关键词处于同一粒度。仅返回去重后的集合，不排序。
fn tokenize(text: &str) -> std::collections::HashSet<String> {
    let mut tokens = std::collections::HashSet::new();
    if text.is_empty() {
        return tokens;
    }

    // 中文双字 bigram：匹配连续的中文字符段
    let chinese_re = regex::Regex::new(r"[\u4e00-\u9fff]+").unwrap();
    for seg in chinese_re.find_iter(text) {
        let chars: Vec<char> = seg.as_str().chars().collect();
        for i in 0..chars.len().saturating_sub(1) {
            let bigram: String = chars[i..i + 2].iter().collect();
            tokens.insert(bigram);
        }
    }

    // 英文单词（长度 >= 2，小写化）
    let english_re = regex::Regex::new(r"[a-zA-Z]{2,}").unwrap();
    for w in english_re.find_iter(text) {
        tokens.insert(w.as_str().to_lowercase());
    }

    tokens
}

/// 获取关键词当前权重（未在表中记录的词返回 INITIAL_WEIGHT）。
pub fn get_keyword_weight(keyword: &str) -> f64 {
    let map = keyword_weights().lock().unwrap();
    *map.get(keyword).unwrap_or(&INITIAL_WEIGHT)
}

/// 重置关键词权重表（仅供测试使用）。
/// 清空所有已调整的权重，使所有词回到初始权重 1.0。
pub fn reset_keyword_weights() {
    let mut map = keyword_weights().lock().unwrap();
    map.clear();
}

/// FeedbackLoop：反馈回流引擎
pub struct FeedbackLoop;

impl FeedbackLoop {
    pub fn new() -> Self {
        FeedbackLoop
    }

    /// 记录用户反馈事件。
    ///
    /// 将反馈事件写入 feedback_events 表（applied=0），等待 apply_feedback 分析处理。
    /// id 由仓库内部生成（UUID），调用方无需提供。
    ///
    /// # 参数
    /// - `event_type`：反馈类型
    /// - `target_id`：被反馈对象的 ID（Episode ID / Wiki ID / Report ID）
    /// - `before`：修改前的内容
    /// - `after`：修改后的内容
    /// - `timestamp`：ISO 时间戳
    pub fn record_feedback(
        &self,
        event_type: FeedbackEventType,
        target_id: &str,
        before: &str,
        after: &str,
        timestamp: &str,
    ) -> Result<()> {
        FeedbackEventRepository::insert(event_type, target_id, before, after, timestamp)
    }

    /// 应用反馈：分析未应用的反馈事件，调整关键词权重表，标记为已应用。
    ///
    /// 处理流程：
    ///  1. 获取所有 applied=0 的事件
    ///  2. 对每条事件，提取 before 中的关键词集合与 after 中的关键词集合
    ///  3. 在 before 中但不在 after 中的词视为"被拒绝词"，累计拒绝次数
    ///  4. 对拒绝次数 >= REJECTION_THRESHOLD 的词，按 WEIGHT_DECAY_FACTOR 衰减权重：
    ///     new_weight = max(MIN_WEIGHT, INITIAL_WEIGHT * WEIGHT_DECAY_FACTOR^reject_count)
    ///     - 仅衰减，不回升（若新权重 >= 当前权重则不更新）
    ///  5. 标记所有已处理事件为 applied=1
    ///
    /// 无未应用事件时直接返回，不抛出错误。
    pub fn apply_feedback(&self) -> Result<()> {
        let unapplied = FeedbackEventRepository::get_unapplied()?;
        if unapplied.is_empty() {
            return Ok(());
        }

        // 累计每个关键词被拒绝的次数（在 before 中出现但在 after 中消失）
        let mut rejection_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        for event in &unapplied {
            let before_tokens = tokenize(&event.before);
            let after_tokens = tokenize(&event.after);
            for token in &before_tokens {
                if !after_tokens.contains(token) {
                    *rejection_counts.entry(token.clone()).or_insert(0) += 1;
                }
            }
        }

        // 对频繁被拒绝的词衰减权重
        let mut map = keyword_weights().lock().unwrap();
        for (keyword, reject_count) in &rejection_counts {
            if *reject_count < REJECTION_THRESHOLD {
                continue;
            }
            let current_weight = *map.get(keyword).unwrap_or(&INITIAL_WEIGHT);
            let decayed_weight = (INITIAL_WEIGHT * WEIGHT_DECAY_FACTOR.powi(*reject_count as i32))
                .max(MIN_WEIGHT);
            // 仅衰减，不回升
            if decayed_weight < current_weight {
                map.insert(keyword.clone(), decayed_weight);
            }
        }
        drop(map);

        // 标记所有已处理事件为 applied=1
        let ids: Vec<String> = unapplied.iter().map(|e| e.id.clone()).collect();
        FeedbackEventRepository::mark_applied(&ids)?;

        Ok(())
    }
}

impl Default for FeedbackLoop {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 tokenize：中文 bigram
    #[test]
    fn test_tokenize_chinese() {
        let tokens = tokenize("数据库迁移");
        // 中文双字 bigram：应包含 "数据"、"据库"、"库迁"、"迁移"
        assert!(tokens.contains("数据"));
        assert!(tokens.contains("据库"));
        assert!(tokens.contains("库迁"));
        assert!(tokens.contains("迁移"));
    }

    /// 测试 tokenize：英文单词
    #[test]
    fn test_tokenize_english() {
        let tokens = tokenize("hello world API");
        assert!(tokens.contains("hello"));
        assert!(tokens.contains("world"));
        assert!(tokens.contains("api")); // 小写化
    }

    /// 测试 tokenize：空字符串
    #[test]
    fn test_tokenize_empty() {
        let tokens = tokenize("");
        assert!(tokens.is_empty());
    }

    /// 测试 get_keyword_weight：默认权重
    #[test]
    fn test_get_keyword_weight_default() {
        reset_keyword_weights();
        let weight = get_keyword_weight("不存在的词");
        assert!((weight - INITIAL_WEIGHT).abs() < 0.001);
    }

    /// 测试 reset_keyword_weights
    #[test]
    fn test_reset_keyword_weights() {
        {
            let mut map = keyword_weights().lock().unwrap();
            map.insert("测试词".to_string(), 0.5);
        }
        // 重置前应能读到 0.5
        assert!((get_keyword_weight("测试词") - 0.5).abs() < 0.001);
        reset_keyword_weights();
        // 重置后应回到默认值
        assert!((get_keyword_weight("测试词") - INITIAL_WEIGHT).abs() < 0.001);
    }

    /// 测试 FeedbackLoop 创建
    #[test]
    fn test_feedback_loop_new() {
        let _loop = FeedbackLoop::new();
    }

    /// 测试权重衰减计算（模拟 apply_feedback 的核心逻辑）
    #[test]
    fn test_weight_decay_logic() {
        reset_keyword_weights();
        let reject_count: u32 = 3;
        let expected_weight =
            (INITIAL_WEIGHT * WEIGHT_DECAY_FACTOR.powi(reject_count as i32)).max(MIN_WEIGHT);
        // 1.0 * 0.7^3 = 0.343
        assert!((expected_weight - 0.343).abs() < 0.01);

        let reject_count: u32 = 10;
        let expected_weight =
            (INITIAL_WEIGHT * WEIGHT_DECAY_FACTOR.powi(reject_count as i32)).max(MIN_WEIGHT);
        // 应被限制在 MIN_WEIGHT
        assert!((expected_weight - MIN_WEIGHT).abs() < 0.001);
    }
}
