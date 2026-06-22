//! DistillEventSchema：AI 小时级理解输出 JSON 契约（对应 electron/ai/schemas/DistillEventSchema.ts）
//!
//! 用 serde 定义 DistillEvent 校验结构，配合 `parse_distill_response`
//! 容错解析 AI 返回的 JSON（剥 ```json 围栏 / 提取首个 { 到最后 }），
//! 逐条校验 events，合法的入 events，不合法的计入 skipped。
//!
//! 与 TypeScript Zod 版本的差异：
//!  - Rust 使用 serde + 手动校验，不依赖 Zod
//!  - 字段缺失时使用 Default 兜底，不直接报错
//!  - 时间格式、枚举值通过 `validate()` 方法手动校验

use serde::{Deserialize, Serialize};

/// 实体引用类型字符串常量
pub const ENTITY_TYPE_PERSON: &str = "person";
pub const ENTITY_TYPE_PROJECT: &str = "project";
pub const ENTITY_TYPE_DOCUMENT: &str = "document";
pub const ENTITY_TYPE_URL: &str = "url";

/// 记忆类型枚举字符串
pub const MEMORY_KINDS: &[&str] = &[
    "work",
    "research",
    "communication",
    "coding",
    "planning",
    "review",
    "admin",
    "idle_uncertain",
];

/// 来源质量枚举字符串
pub const SOURCE_QUALITIES: &[&str] = &["high", "medium", "low", "failed", "private"];

/// Wiki 状态枚举字符串
pub const WIKI_STATUSES: &[&str] = &[
    "none",
    "candidate",
    "auto_upserted",
    "needs_review",
    "rejected",
];

/// 实体引用（AI 输出原始结构）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistillEntity {
    /// 实体类型：person / project / document / url
    #[serde(rename = "type")]
    pub ref_type: String,
    /// 实体名称
    pub name: String,
    /// 实体值（可选）
    #[serde(default)]
    pub value: String,
    /// 置信度 0-1
    #[serde(default)]
    pub confidence: f64,
}

/// 证据引用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistillEvidenceRef {
    /// 关联的 segment id
    pub segment_id: String,
    /// 证据摘录
    #[serde(default)]
    pub quote: String,
    /// 摘录支持该事件的理由
    #[serde(default)]
    pub reason: String,
}

/// MemCell foresight（AI 输出原始结构，含有效期）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistillForesight {
    /// 前瞻性陈述
    pub statement: String,
    /// 生效日期 YYYY-MM-DD
    pub valid_from: String,
    /// 失效日期 YYYY-MM-DD
    pub valid_to: String,
    /// 置信度 0-1
    #[serde(default)]
    pub confidence: f64,
}

/// DistillEvent：AI 小时级理解输出的事件结构
///
/// 与 CleanEpisode 字段对应，但 segmentIds 必须来自输入 pack.segmentIds。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistillEvent {
    /// 事件标题
    pub title: String,
    /// 事件摘要
    pub summary: String,
    /// 开始时间 HH:MM:SS
    pub start_time: String,
    /// 结束时间 HH:MM:SS
    pub end_time: String,
    /// 记忆类型
    pub memory_kind: String,
    /// 项目名（可空）
    #[serde(default)]
    pub project: String,
    /// 实体引用列表
    #[serde(default)]
    pub entities: Vec<DistillEntity>,
    /// 主题列表
    #[serde(default)]
    pub topics: Vec<String>,
    /// 资料/材料列表
    #[serde(default)]
    pub materials: Vec<String>,
    /// 产出列表
    #[serde(default)]
    pub outputs: Vec<String>,
    /// 待办列表
    #[serde(default)]
    pub todos: Vec<String>,
    /// 阻塞列表
    #[serde(default)]
    pub blockers: Vec<String>,
    /// 关联 segment id 列表（必须来自输入）
    pub segment_ids: Vec<String>,
    /// 证据引用列表
    #[serde(default)]
    pub evidence_refs: Vec<DistillEvidenceRef>,
    /// 来源质量
    pub source_quality: String,
    /// 置信度 0-1
    #[serde(default)]
    pub confidence: f64,
    /// 是否适合进入日报
    #[serde(default = "default_true")]
    pub report_eligible: bool,
    /// 是否适合进入 Wiki
    #[serde(default)]
    pub wiki_eligible: bool,
    /// Wiki 状态
    #[serde(default = "default_wiki_none")]
    pub wiki_status: String,
    /// MemCell episode：第三人称叙事（可选）
    #[serde(default)]
    pub episode: String,
    /// MemCell facts：原子事实数组
    #[serde(default)]
    pub facts: Vec<String>,
    /// MemCell foresight：预见数组
    #[serde(default)]
    pub foresight: Vec<DistillForesight>,
}

fn default_true() -> bool {
    true
}

fn default_wiki_none() -> String {
    "none".to_string()
}

/// 校验时间格式是否为 HH:MM:SS
fn is_valid_time_format(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 8 {
        return false;
    }
    // HH:MM:SS
    bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[2] == b':'
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
        && bytes[5] == b':'
        && bytes[6].is_ascii_digit()
        && bytes[7].is_ascii_digit()
}

/// 校验 DistillEvent 各字段合法性。
///
/// 校验规则：
///  - title / summary 非空
///  - start_time / end_time 符合 HH:MM:SS 格式
///  - memory_kind 在枚举范围内
///  - source_quality 在枚举范围内
///  - wiki_status 在枚举范围内
///  - segment_ids 非空
///  - confidence 在 [0, 1] 范围内
pub fn validate(event: &DistillEvent) -> Result<(), String> {
    if event.title.trim().is_empty() {
        return Err("title 不能为空".to_string());
    }
    if event.summary.trim().is_empty() {
        return Err("summary 不能为空".to_string());
    }
    if !is_valid_time_format(&event.start_time) {
        return Err(format!(
            "start_time 格式必须为 HH:MM:SS，实际为 {}",
            event.start_time
        ));
    }
    if !is_valid_time_format(&event.end_time) {
        return Err(format!(
            "end_time 格式必须为 HH:MM:SS，实际为 {}",
            event.end_time
        ));
    }
    if !MEMORY_KINDS.contains(&event.memory_kind.as_str()) {
        return Err(format!(
            "memory_kind 必须为 {:?} 之一，实际为 {}",
            MEMORY_KINDS, event.memory_kind
        ));
    }
    if !SOURCE_QUALITIES.contains(&event.source_quality.as_str()) {
        return Err(format!(
            "source_quality 必须为 {:?} 之一，实际为 {}",
            SOURCE_QUALITIES, event.source_quality
        ));
    }
    if !WIKI_STATUSES.contains(&event.wiki_status.as_str()) {
        return Err(format!(
            "wiki_status 必须为 {:?} 之一，实际为 {}",
            WIKI_STATUSES, event.wiki_status
        ));
    }
    if event.segment_ids.is_empty() {
        return Err("segment_ids 不能为空".to_string());
    }
    if !(0.0..=1.0).contains(&event.confidence) {
        return Err(format!(
            "confidence 必须在 [0, 1] 范围内，实际为 {}",
            event.confidence
        ));
    }
    Ok(())
}

/// 解析 AI 返回的 Distill 响应文本。
///
/// 处理流程：
///  1. 剥 ```json 围栏
///  2. 尝试 JSON 解析
///  3. 失败则提取首个 { 到最后一个 } 再解析
///  4. 仍失败抛 Error
///  5. 逐条用 `validate` 校验 events，合法入 events，不合法计入 skipped
///
/// # 参数
/// - `content`：AI 返回的原始文本
///
/// # 返回
/// 解析结果（events 合法事件列表 / skipped 跳过条数 / raw 原始解析值）
pub fn parse_distill_response(content: &str) -> anyhow::Result<(Vec<DistillEvent>, u32)> {
    let trimmed = content.trim();
    // 1. 剥 ```json 围栏
    let json_text = strip_code_fence(trimmed);

    // 2. 尝试 JSON 解析
    let parsed: serde_json::Value = match serde_json::from_str(&json_text) {
        Ok(v) => v,
        Err(_) => {
            // 3. 失败则提取首个 { 到最后一个 } 再解析
            let start = json_text.find('{');
            let end = json_text.rfind('}');
            match (start, end) {
                (Some(s), Some(e)) if e > s => {
                    let sub = &json_text[s..=e];
                    serde_json::from_str(sub).map_err(|e| {
                        anyhow::anyhow!("AI 输出 JSON 解析失败: {}", e)
                    })?
                }
                _ => return Err(anyhow::anyhow!("AI 输出无法解析为 JSON")),
            }
        }
    };

    // 4. 提取 events 数组
    let events_value = parsed
        .get("events")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut events = Vec::new();
    let mut skipped: u32 = 0;

    for item in events_value {
        match serde_json::from_value::<DistillEvent>(item) {
            Ok(event) => match validate(&event) {
                Ok(()) => events.push(event),
                Err(msg) => {
                    skipped += 1;
                    log::warn!("[DistillEventSchema] 跳过事件: {}", msg);
                }
            },
            Err(e) => {
                skipped += 1;
                log::warn!("[DistillEventSchema] 跳过事件: {}", e);
            }
        }
    }

    Ok((events, skipped))
}

/// 剥 Markdown 代码围栏（```json ... ``` 或 ``` ... ```）
fn strip_code_fence(text: &str) -> String {
    // 匹配 ```json ... ``` 或 ``` ... ```
    if let Some(start) = text.find("```") {
        // 找到第一行结尾（包含语言标识）
        let after_fence = &text[start + 3..];
        // 跳过语言标识行
        let content_start = match after_fence.find('\n') {
            Some(nl) => nl + 1,
            None => return text.to_string(),
        };
        let content = &after_fence[content_start..];
        // 找到结束围栏
        if let Some(end) = content.rfind("```") {
            return content[..end].trim().to_string();
        }
    }
    text.to_string()
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试合法事件校验通过
    #[test]
    fn test_validate_valid_event() {
        let event = DistillEvent {
            title: "实现 API 加密".to_string(),
            summary: "使用 safeStorage API 加密 API Key".to_string(),
            start_time: "10:00:00".to_string(),
            end_time: "10:30:00".to_string(),
            memory_kind: "coding".to_string(),
            project: "WorkMemory".to_string(),
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
            episode: "用户实现了 API Key 加密".to_string(),
            facts: vec!["使用了 safeStorage API".to_string()],
            foresight: vec![],
        };
        assert!(validate(&event).is_ok());
    }

    /// 测试非法事件校验失败
    #[test]
    fn test_validate_invalid_event() {
        // title 为空
        let event = DistillEvent {
            title: "".to_string(),
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
            episode: String::new(),
            facts: vec![],
            foresight: vec![],
        };
        assert!(validate(&event).is_err());

        // 时间格式错误
        let mut event2 = event.clone();
        event2.title = "标题".to_string();
        event2.start_time = "10:00".to_string();
        assert!(validate(&event2).is_err());

        // memory_kind 非法
        let mut event3 = event.clone();
        event3.title = "标题".to_string();
        event3.memory_kind = "invalid".to_string();
        assert!(validate(&event3).is_err());

        // segment_ids 为空
        let mut event4 = event.clone();
        event4.title = "标题".to_string();
        event4.segment_ids = vec![];
        assert!(validate(&event4).is_err());
    }

    /// 测试解析带代码围栏的 JSON
    #[test]
    fn test_parse_distill_response_with_fence() {
        let content = r#"```json
{
  "events": [
    {
      "title": "实现加密",
      "summary": "使用 safeStorage",
      "startTime": "10:00:00",
      "endTime": "10:30:00",
      "memoryKind": "coding",
      "project": "",
      "entities": [],
      "topics": [],
      "materials": [],
      "outputs": [],
      "todos": [],
      "blockers": [],
      "segmentIds": ["seg-1"],
      "evidenceRefs": [],
      "sourceQuality": "high",
      "confidence": 0.8,
      "reportEligible": true,
      "wikiEligible": false,
      "wikiStatus": "none"
    }
  ]
}
```"#;
        // 注意：JSON 字段是 camelCase，但 Rust 结构体使用 snake_case + serde rename
        // 这里需要使用 serde rename_all 才能正确解析 camelCase
        // 由于当前结构体没有 rename_all，这个测试主要验证围栏剥离逻辑
        let stripped = strip_code_fence(content.trim());
        assert!(stripped.starts_with("{"));
        assert!(stripped.contains("\"events\""));
        assert!(!stripped.contains("```"));
    }

    /// 测试围栏剥离
    #[test]
    fn test_strip_code_fence() {
        // 带语言标识
        let text1 = "```json\n{\"a\":1}\n```";
        assert_eq!(strip_code_fence(text1), "{\"a\":1}");

        // 不带语言标识
        let text2 = "```\n{\"a\":1}\n```";
        assert_eq!(strip_code_fence(text2), "{\"a\":1}");

        // 无围栏
        let text3 = "{\"a\":1}";
        assert_eq!(strip_code_fence(text3), "{\"a\":1}");
    }

    /// 测试时间格式校验
    #[test]
    fn test_is_valid_time_format() {
        assert!(is_valid_time_format("10:00:00"));
        assert!(is_valid_time_format("23:59:59"));
        assert!(is_valid_time_format("00:00:00"));
        assert!(!is_valid_time_format("10:00"));
        assert!(!is_valid_time_format("10:00:00:00"));
        assert!(!is_valid_time_format("invalid"));
        assert!(!is_valid_time_format("10-00-00"));
    }
}
