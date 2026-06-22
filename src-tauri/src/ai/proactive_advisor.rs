//! ProactiveAdvisor：主动建议引擎（对应 electron/ai/ProactiveAdvisor.ts）
//!
//! 在反思与进化 Sprint 中，基于用户画像、技能卡和历史模式，主动给用户提建议：
//!  - skill_reference：当前活动匹配已有技能卡 → "要参考之前的经验吗"
//!  - rest_reminder：当前连续活动 >2h 且历史模式显示该时段效率低 → "建议休息"
//!  - focus_suggestion：检测到与昨日相同的碎片化模式 → "今天又在频繁切换，要试试专注模式吗"
//!
//! 与 TypeScript 版本的差异：
//!  - 不依赖桌面伙伴推送（mascotNotifyAdvice），仅返回建议对象
//!  - 节流 Map 使用 Mutex<HashMap> 保证线程安全
//!  - 简化为 generate_advice(context: &str) 接口

use std::sync::{Mutex, OnceLock};
use std::collections::HashMap;

use anyhow::Result;
use uuid::Uuid;

use crate::models::{DayDistillResult, Skill, WeeklyPatternResult};
use crate::repositories::daily_distill_repository::DailyDistillRepository;
use crate::repositories::segment_repository::SegmentRepository;
use crate::repositories::skill_repository::SkillRepository;
use crate::repositories::weekly_pattern_repository::WeeklyPatternRepository;

/// 建议类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AdviceType {
    /// 技能卡参考
    SkillReference,
    /// 休息提醒
    RestReminder,
    /// 专注模式建议
    FocusSuggestion,
}

impl AdviceType {
    pub fn as_str(&self) -> &'static str {
        match self {
            AdviceType::SkillReference => "skill_reference",
            AdviceType::RestReminder => "rest_reminder",
            AdviceType::FocusSuggestion => "focus_suggestion",
        }
    }
}

/// 主动建议
#[derive(Debug, Clone)]
pub struct Advice {
    /// 建议 ID（UUID）
    pub id: String,
    /// 建议类型
    pub advice_type: AdviceType,
    /// 建议标题
    pub title: String,
    /// 建议内容
    pub message: String,
    /// 可选的行动建议
    pub action: Option<String>,
    /// 关联的技能卡 ID（skill_reference 类型适用）
    pub skill_id: Option<String>,
    /// 置信度 0-1
    pub confidence: f64,
    /// ISO 创建时间戳
    pub created_at: String,
}

/// 节流窗口：4 小时（毫秒）
const THROTTLE_MS: i64 = 4 * 60 * 60 * 1000;
/// 技能卡匹配阈值
const SKILL_MATCH_THRESHOLD: f64 = 0.5;
/// 连续活动休息提醒阈值：2 小时（毫秒）
const REST_THRESHOLD_MS: i64 = 2 * 60 * 60 * 1000;
/// 高切换次数阈值（日均）
const HIGH_SWITCH_THRESHOLD: i32 = 15;
/// 碎片化时段判定：fragmented_periods 非空即视为碎片化
const FRAGMENTED_PERIODS_MIN: usize = 1;

/// 节流 Map：advice_type → 上次展示时间戳（毫秒）
static ADVICE_THROTTLE: OnceLock<Mutex<HashMap<AdviceType, i64>>> = OnceLock::new();

/// 获取节流 Map
fn advice_throttle() -> &'static Mutex<HashMap<AdviceType, i64>> {
    ADVICE_THROTTLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 获取当前 ISO 时间戳
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 获取当前时间戳（毫秒）
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 获取今天的日期字符串（YYYY-MM-DD）
fn today_string() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// 在日期字符串（YYYY-MM-DD）上加减天数，返回新的日期字符串
fn add_days(date_str: &str, days: i64) -> String {
    use chrono::NaiveDate;
    match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        Ok(d) => {
            let new_date = d + chrono::Duration::days(days);
            new_date.format("%Y-%m-%d").to_string()
        }
        Err(_) => date_str.to_string(),
    }
}

/// 获取指定日期所在周的周一日期（YYYY-MM-DD）
fn get_week_start(date_str: &str) -> String {
    use chrono::NaiveDate;
    match NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        Ok(d) => {
            // chrono Weekday: Mon=1, Sun=7
            let weekday = d.weekday();
            let days_since_monday = weekday.num_days_from_monday() as i64;
            let monday = d - chrono::Duration::days(days_since_monday);
            monday.format("%Y-%m-%d").to_string()
        }
        Err(_) => date_str.to_string(),
    }
}

/// 将置信度限制在 [0, 1] 范围内，保留两位小数
fn clamp_confidence(value: f64) -> f64 {
    let clamped = value.max(0.0).min(1.0);
    (clamped * 100.0).round() / 100.0
}

/// 判断指定类型的建议是否被节流（4 小时内已展示）
fn is_throttled(advice_type: AdviceType) -> bool {
    let map = advice_throttle().lock().unwrap();
    if let Some(&last_shown) = map.get(&advice_type) {
        now_ms() - last_shown < THROTTLE_MS
    } else {
        false
    }
}

/// 标记指定类型的建议已展示（更新节流时间戳）
fn mark_shown(advice_type: AdviceType) {
    let mut map = advice_throttle().lock().unwrap();
    map.insert(advice_type, now_ms());
}

/// 重置节流 Map（仅供测试使用）
pub fn reset_throttle() {
    let mut map = advice_throttle().lock().unwrap();
    map.clear();
}

/// 从文本中提取关键词集合。
///
/// 中文 token：提取 2 字符 bigram，token 长度 ≤3 时也整体作为一个关键词。
/// 英文 token：长度 ≥3 时整体作为一个关键词（小写）。
fn extract_keywords(text: &str) -> std::collections::HashSet<String> {
    let mut keywords = std::collections::HashSet::new();
    if text.is_empty() {
        return keywords;
    }
    let lower = text.to_lowercase();
    // 按非字母数字字符分词
    let tokens: Vec<&str> = lower
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    ',' | '，' | '。' | '.' | ';' | '；' | ':' | '：' | '!' | '！' | '?'
                        | '？' | '(' | ')' | '（' | '）' | '[' | ']' | '【' | '】' | '"'
                        | '\'' | '`' | '/' | '\\' | '_' | '-'
                )
        })
        .filter(|t| !t.is_empty())
        .collect();

    for token in tokens {
        let has_chinese = token.chars().any(|c| ('\u{4e00}'..='\u{9fa5}').contains(&c));
        if has_chinese {
            // 中文 token：提取 2 字符 bigram
            let chars: Vec<char> = token.chars().collect();
            for i in 0..chars.len().saturating_sub(1) {
                let bigram: String = chars[i..i + 2].iter().collect();
                keywords.insert(bigram);
            }
            // 短 token（≤3 字符）整体也作为关键词
            if chars.len() <= 3 {
                keywords.insert(token.to_string());
            }
        } else {
            // 英文/其他：长度 ≥3 时作为关键词
            if token.len() >= 3 {
                keywords.insert(token.to_string());
            }
        }
    }
    keywords
}

/// 计算两个关键词集合的重叠系数（overlap coefficient）。
/// overlap = |intersection| / min(|a|, |b|)
fn overlap_coefficient(
    a: &std::collections::HashSet<String>,
    b: &std::collections::HashSet<String>,
) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (smaller, larger) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let intersection = smaller.intersection(larger).count();
    intersection as f64 / smaller.len() as f64
}

/// 从技能卡提取关键词集合（title + steps）。
fn extract_skill_keywords(skill: &Skill) -> std::collections::HashSet<String> {
    let mut keywords = std::collections::HashSet::new();
    for kw in extract_keywords(&skill.title) {
        keywords.insert(kw);
    }
    for step in &skill.steps {
        // 去除步骤序号前缀（如 "1. "）后再提取
        let cleaned = regex::Regex::new(r"^\d+\.\s*")
            .unwrap()
            .replace_all(step, "")
            .to_string();
        for kw in extract_keywords(&cleaned) {
            keywords.insert(kw);
        }
    }
    keywords
}

/// 规则 1：技能卡参考建议。
///
/// 将当前活动文本与所有技能卡的 title+steps 关键词匹配，
/// 若重叠系数 > 阈值，返回 skill_reference 建议（附 skill_id）。
fn check_skill_reference(activity_text: &str) -> Option<Advice> {
    let skills = SkillRepository::get_all().ok()?;
    if skills.is_empty() {
        return None;
    }

    if activity_text.is_empty() {
        return None;
    }
    let activity_keywords = extract_keywords(activity_text);
    if activity_keywords.is_empty() {
        return None;
    }

    let mut best_skill: Option<&Skill> = None;
    let mut best_score = 0.0_f64;
    for skill in &skills {
        let skill_keywords = extract_skill_keywords(skill);
        if skill_keywords.is_empty() {
            continue;
        }
        let score = overlap_coefficient(&activity_keywords, &skill_keywords);
        if score > best_score {
            best_score = score;
            best_skill = Some(skill);
        }
    }

    let best_skill = best_skill?;
    if best_score <= SKILL_MATCH_THRESHOLD {
        return None;
    }

    Some(Advice {
        id: Uuid::new_v4().to_string(),
        advice_type: AdviceType::SkillReference,
        title: "要参考之前的经验吗".to_string(),
        message: format!(
            "检测到你正在进行的任务与技能卡「{}」相关（匹配度 {}%），要参考之前的经验吗？",
            best_skill.title,
            (best_score * 100.0) as u32
        ),
        action: Some("查看技能卡".to_string()),
        skill_id: Some(best_skill.id.clone()),
        confidence: clamp_confidence(best_score),
        created_at: now_iso(),
    })
}

/// 规则 2：休息提醒建议。
///
/// 当前连续活动时长（从最近 segment 的 startTime 到现在）>2h，
/// 且历史模式（weekly_patterns）显示该时段效率低，
/// 返回 rest_reminder 建议。
fn check_rest_reminder(elapsed_ms: i64, weekly: Option<&WeeklyPatternResult>) -> Option<Advice> {
    if elapsed_ms <= REST_THRESHOLD_MS {
        return None;
    }

    let weekly = weekly?;
    let current_hour = chrono::Utc::now().format("%H").to_string().parse::<u32>().unwrap_or(0);
    let mut low_efficiency = false;

    // 检查是否存在覆盖当前小时的 fragmented_time 模式
    for pattern in &weekly.patterns {
        if !pattern.name.starts_with("fragmented_time") {
            continue;
        }
        // 从 description 提取小时信息（简化版：检查是否包含当前小时）
        let hour_str = format!("{:02}", current_hour);
        if pattern.description.contains(&hour_str) {
            low_efficiency = true;
            break;
        }
    }

    // 若无碎片化时段覆盖，检查深度工作时长是否偏低（日均 <1h）
    if !low_efficiency && !weekly.trend.deep_work_hours_trend.is_empty() {
        let avg_deep_work: f64 = weekly
            .trend
            .deep_work_hours_trend
            .iter()
            .sum::<f64>()
            / weekly.trend.deep_work_hours_trend.len() as f64;
        if avg_deep_work < 1.0 {
            low_efficiency = true;
        }
    }

    if !low_efficiency {
        return None;
    }

    let hours = elapsed_ms / (60 * 60 * 1000);
    Some(Advice {
        id: Uuid::new_v4().to_string(),
        advice_type: AdviceType::RestReminder,
        title: "建议休息".to_string(),
        message: format!(
            "你已连续工作 {} 小时，该时段历史效率较低，建议休息一下，活动身体或闭目养神。",
            hours
        ),
        action: Some("休息 5 分钟".to_string()),
        skill_id: None,
        confidence: 0.7,
        created_at: now_iso(),
    })
}

/// 规则 3：专注模式建议。
///
/// 获取今日与昨日的 daily_distill，若两者均呈现高切换次数（≥阈值）
/// 或碎片化时段（fragmented_periods 非空），返回 focus_suggestion 建议。
fn check_focus_suggestion() -> Option<Advice> {
    let today = today_string();
    let yesterday = add_days(&today, -1);

    let today_distill = DailyDistillRepository::get_by_date(&today).ok().flatten()?;
    let yesterday_distill = DailyDistillRepository::get_by_date(&yesterday).ok().flatten()?;

    let today_high_switch = today_distill.patterns.switch_count >= HIGH_SWITCH_THRESHOLD;
    let today_fragmented =
        today_distill.patterns.fragmented_periods.len() >= FRAGMENTED_PERIODS_MIN;
    let yesterday_high_switch = yesterday_distill.patterns.switch_count >= HIGH_SWITCH_THRESHOLD;
    let yesterday_fragmented =
        yesterday_distill.patterns.fragmented_periods.len() >= FRAGMENTED_PERIODS_MIN;

    // 今日与昨日均呈现高切换或碎片化 → 相似碎片化模式
    let today_chaotic = today_high_switch || today_fragmented;
    let yesterday_chaotic = yesterday_high_switch || yesterday_fragmented;
    if !today_chaotic || !yesterday_chaotic {
        return None;
    }

    let mut message = format!("今天已切换 {} 次", today_distill.patterns.switch_count);
    if today_fragmented {
        message.push_str(&format!(
            "，存在 {} 个碎片化时段",
            today_distill.patterns.fragmented_periods.len()
        ));
    }
    message.push_str("，与昨日模式相似。要试试专注模式吗？");

    Some(Advice {
        id: Uuid::new_v4().to_string(),
        advice_type: AdviceType::FocusSuggestion,
        title: "今天又在频繁切换，要试试专注模式吗".to_string(),
        message,
        action: Some("开启专注模式".to_string()),
        skill_id: None,
        confidence: 0.6,
        created_at: now_iso(),
    })
}

/// ProactiveAdvisor：主动建议引擎
pub struct ProactiveAdvisor;

impl ProactiveAdvisor {
    pub fn new() -> Self {
        ProactiveAdvisor
    }

    /// 生成主动建议：基于当前活动文本生成建议。
    ///
    /// 处理流程：
    ///  1. 尝试技能卡参考建议（基于 context 文本匹配技能卡）
    ///  2. 尝试休息提醒建议（基于本周周级模式判断效率低时段）
    ///  3. 尝试专注模式建议（基于今日与昨日的 daily_distill）
    ///  4. 按优先级返回首个未被节流的建议
    ///
    /// # 参数
    /// - `context`：当前活动文本（可包含应用名、窗口标题、OCR 文本等）
    ///
    /// # 返回
    /// 建议对象；无建议返回 None
    pub fn generate_advice(&self, context: &str) -> Result<Option<Advice>> {
        let mut candidates: Vec<Advice> = Vec::new();

        // 规则 1：技能卡参考
        if let Some(advice) = check_skill_reference(context) {
            candidates.push(advice);
        }

        // 规则 2：休息提醒（elapsed_ms 无法准确计算，使用 0 跳过该规则）
        // 实际使用时，调用方可通过其他方式计算 elapsed_ms 并调用 check_rest_reminder
        // 此处简化为不触发休息提醒（需要 segment 的 startTime 信息）

        // 规则 3：专注模式建议
        if let Some(advice) = check_focus_suggestion() {
            candidates.push(advice);
        }

        // 按优先级返回首个未被节流的建议
        for advice in candidates {
            if is_throttled(advice.advice_type) {
                continue;
            }
            mark_shown(advice.advice_type);
            return Ok(Some(advice));
        }

        Ok(None)
    }

    /// 生成主动建议（带完整上下文）：基于当前活动、技能卡、历史模式生成建议。
    ///
    /// # 参数
    /// - `context`：当前活动文本
    /// - `elapsed_ms`：当前活动已持续时长（毫秒）
    ///
    /// # 返回
    /// 建议对象；无建议返回 None
    pub fn generate_advice_with_context(
        &self,
        context: &str,
        elapsed_ms: i64,
    ) -> Result<Option<Advice>> {
        let mut candidates: Vec<Advice> = Vec::new();

        // 规则 1：技能卡参考
        if let Some(advice) = check_skill_reference(context) {
            candidates.push(advice);
        }

        // 规则 2：休息提醒
        let week_start = get_week_start(&today_string());
        let weekly = WeeklyPatternRepository::get_by_week_start(&week_start).ok().flatten();
        if let Some(advice) = check_rest_reminder(elapsed_ms, weekly.as_ref()) {
            candidates.push(advice);
        }

        // 规则 3：专注模式建议
        if let Some(advice) = check_focus_suggestion() {
            candidates.push(advice);
        }

        // 按优先级返回首个未被节流的建议
        for advice in candidates {
            if is_throttled(advice.advice_type) {
                continue;
            }
            mark_shown(advice.advice_type);
            return Ok(Some(advice));
        }

        Ok(None)
    }
}

impl Default for ProactiveAdvisor {
    fn default() -> Self {
        Self::new()
    }
}

// 引入 chrono Weekday trait
use chrono::{Datelike, Weekday};

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 extract_keywords：中文 bigram
    #[test]
    fn test_extract_keywords_chinese() {
        let keywords = extract_keywords("数据库迁移");
        // 中文双字 bigram：应包含 "数据"、"据库"、"库迁"、"迁移"
        assert!(keywords.contains("数据"));
        assert!(keywords.contains("据库"));
        assert!(keywords.contains("库迁"));
        assert!(keywords.contains("迁移"));
    }

    /// 测试 extract_keywords：英文单词
    #[test]
    fn test_extract_keywords_english() {
        let keywords = extract_keywords("hello world api");
        // 长度 >=3 的英文单词
        assert!(keywords.contains("hello"));
        assert!(keywords.contains("world"));
        assert!(keywords.contains("api"));
    }

    /// 测试 extract_keywords：空字符串
    #[test]
    fn test_extract_keywords_empty() {
        let keywords = extract_keywords("");
        assert!(keywords.is_empty());
    }

    /// 测试 overlap_coefficient
    #[test]
    fn test_overlap_coefficient() {
        let a: std::collections::HashSet<String> =
            ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let b: std::collections::HashSet<String> =
            ["b", "c", "d", "e"].iter().map(|s| s.to_string()).collect();
        // intersection = {b, c} = 2, min(3, 4) = 3 → 2/3
        let score = overlap_coefficient(&a, &b);
        assert!((score - 2.0 / 3.0).abs() < 0.001);

        // 空集合
        let empty: std::collections::HashSet<String> = std::collections::HashSet::new();
        assert!((overlap_coefficient(&a, &empty) - 0.0).abs() < 0.001);
    }

    /// 测试 clamp_confidence
    #[test]
    fn test_clamp_confidence() {
        assert!((clamp_confidence(0.5) - 0.5).abs() < 0.001);
        assert!((clamp_confidence(-0.1) - 0.0).abs() < 0.001);
        assert!((clamp_confidence(1.5) - 1.0).abs() < 0.001);
    }

    /// 测试 add_days
    #[test]
    fn test_add_days() {
        assert_eq!(add_days("2026-06-22", 0), "2026-06-22");
        assert_eq!(add_days("2026-06-22", 1), "2026-06-23");
        assert_eq!(add_days("2026-06-22", -1), "2026-06-21");
    }

    /// 测试 get_week_start
    #[test]
    fn test_get_week_start() {
        // 2026-06-22 是周一
        assert_eq!(get_week_start("2026-06-22"), "2026-06-22");
        // 2026-06-23 是周二，周一应为 2026-06-22
        assert_eq!(get_week_start("2026-06-23"), "2026-06-22");
        // 2026-06-28 是周日，周一应为 2026-06-22
        assert_eq!(get_week_start("2026-06-28"), "2026-06-22");
    }

    /// 测试 today_string 格式
    #[test]
    fn test_today_string() {
        let today = today_string();
        assert!(regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap().is_match(&today));
    }

    /// 测试节流逻辑
    #[test]
    fn test_throttle() {
        reset_throttle();
        assert!(!is_throttled(AdviceType::SkillReference));
        mark_shown(AdviceType::SkillReference);
        assert!(is_throttled(AdviceType::SkillReference));
        // 其他类型不受影响
        assert!(!is_throttled(AdviceType::RestReminder));
        reset_throttle();
        assert!(!is_throttled(AdviceType::SkillReference));
    }

    /// 测试 AdviceType as_str
    #[test]
    fn test_advice_type_as_str() {
        assert_eq!(AdviceType::SkillReference.as_str(), "skill_reference");
        assert_eq!(AdviceType::RestReminder.as_str(), "rest_reminder");
        assert_eq!(AdviceType::FocusSuggestion.as_str(), "focus_suggestion");
    }

    /// 测试 ProactiveAdvisor 创建
    #[test]
    fn test_proactive_advisor_new() {
        let _advisor = ProactiveAdvisor::new();
    }
}
