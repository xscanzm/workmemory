//! DistillPrompt：小时级蒸馏提示词构建器（对应 electron/ai/DistillPrompt.ts）
//!
//! 把一小时内的屏幕 OCR 文本证据整理为可长期复用的工作记忆事件，
//! 构建发送给 AI 的 system / user 提示词。
//!
//! 设计要点：
//!  - 强约束 AI 只输出严格 JSON，第一个字符必须是 `{`
//!  - 要求每个事件附带 MemCell 结构（episode / facts / foresight）
//!  - 不允许虚构，证据不足时使用 idle_uncertain 并降低 confidence

use crate::models::WorkSegment;

/// 蒸馏版本号（与 TypeScript 端保持一致）
pub const DISTILL_VERSION: &str = "hourly-v1";

/// 蒸馏提示词（system + user）
#[derive(Debug, Clone)]
pub struct DistillPrompt {
    /// 系统提示词：定义 AI 角色与硬约束
    pub system: String,
    /// 用户提示词：包含日期、小时与 HourContextPack 上下文
    pub user: String,
}

/// 构建蒸馏提示词。
///
/// # 参数
/// - `segments`：本小时内的工作片段
/// - `context`：附加上下文（通常为 HourContextPack 的 JSON 序列化文本）
pub fn build_distill_prompt(segments: &[WorkSegment], context: &str) -> DistillPrompt {
    // 系统提示词：定义角色与硬约束
    let system = [
        "你是 WorkMemory 的小时级工作理解器。",
        "你的任务是把一小时内的屏幕 OCR 文本证据，整理为可长期复用的工作记忆事件。",
        "不要虚构，不要写没有证据支持的项目名、人物、任务或结论。",
        "只输出严格 JSON，不要 Markdown，不要解释。",
        "只输出 JSON 对象，不要 Markdown 代码块，不要任何解释文字，第一个字符必须是 {",
        "如果证据不足，使用 idle_uncertain，并降低 confidence。",
        "Wiki 候选必须有明确标题，禁止\"推进\"\"梳理\"\"配置\"\"笔记\"这类空洞标题单独成页。",
        "",
        "除 events 外，每个事件还需输出 MemCell 结构化记忆单元，包含三部分：",
        "- episode：第三人称叙事，1-2 句客观描述用户做了什么，如 \"用户在 VS Code 中实现了 API Key 加密功能，使用了 Electron 的 safeStorage API\"。",
        "- facts：原子事实数组，3-5 条，每条一个独立事实，如 [\"使用了 safeStorage API\", \"密钥存储在 userData 目录\", \"加密失败时降级到明文\"]。",
        "- foresight：预见数组，0-2 条，每条带 statement（前瞻性陈述）、validFrom（生效日期 YYYY-MM-DD）、validTo（失效日期 YYYY-MM-DD）、confidence（0-1）。",
        "episode/facts/foresight 应基于本小时证据提炼，不要虚构；foresight 仅在有充分依据时输出，否则留空数组。",
    ]
    .join("\n");

    // 用户提示词：包含日期、小时与 HourContextPack 上下文
    let date = segments
        .first()
        .map(|s| s.date.as_str())
        .unwrap_or("")
        .to_string();
    let segment_count = segments.len();

    let user = format!(
        "日期：{date}\n\
         小时：本小时共 {segment_count} 个工作片段\n\
         请基于下面的 HourContextPack 输出 JSON：\n\
         \n\
         {context}\n\
         \n\
         输出格式：\n\
         {{\n  \"events\": [\n    {{\n      \"title\": \"清晰具体的事件标题\",\n      \"summary\": \"基于证据的简短总结\",\n      \"startTime\": \"HH:MM:SS\",\n      \"endTime\": \"HH:MM:SS\",\n      \"memoryKind\": \"work|research|communication|coding|planning|review|admin|idle_uncertain\",\n      \"project\": \"项目名，没有则空字符串\",\n      \"entities\": [{{\"type\":\"person|project|document|url\",\"name\":\"...\",\"value\":\"...\",\"confidence\":0.8}}],\n      \"topics\": [\"主题\"],\n      \"materials\": [\"看过/使用过的资料、网页、文档、代码、配置\"],\n      \"outputs\": [\"本小时可能产生的产出\"],\n      \"todos\": [\"明确待办\"],\n      \"blockers\": [\"明确阻塞\"],\n      \"segmentIds\": [\"必须来自输入\"],\n      \"evidenceRefs\": [{{\"segmentId\":\"必须来自输入\",\"quote\":\"证据摘录\",\"reason\":\"为什么支持该事件\"}}],\n      \"sourceQuality\": \"high|medium|low|failed\",\n      \"confidence\": 0.0,\n      \"reportEligible\": true,\n      \"wikiEligible\": false,\n      \"wikiStatus\": \"none|candidate\",\n      \"episode\": \"第三人称叙事，1-2 句客观描述用户做了什么\",\n      \"facts\": [\"原子事实1\", \"原子事实2\", \"原子事实3\"],\n      \"foresight\": [\n        {{\"statement\": \"前瞻性陈述\", \"validFrom\": \"YYYY-MM-DD\", \"validTo\": \"YYYY-MM-DD\", \"confidence\": 0.8}}\n      ]\n    }}\n  ]\n}}",
        date = date,
        segment_count = segment_count,
        context = context,
    );

    DistillPrompt { system, user }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::WorkSegment;

    /// 测试提示词包含关键约束
    #[test]
    fn test_build_distill_prompt_contains_constraints() {
        let mut seg = WorkSegment::default();
        seg.date = "2026-06-22".to_string();
        seg.start_time = "10:00:00".to_string();
        seg.end_time = "10:30:00".to_string();
        seg.app_name = "VS Code".to_string();
        seg.window_title = "main.rs".to_string();
        seg.ocr_text = "fn main() {}".to_string();

        let prompt = build_distill_prompt(&[seg], "{}");
        assert!(prompt.system.contains("小时级工作理解器"));
        assert!(prompt.system.contains("不要虚构"));
        assert!(prompt.system.contains("第一个字符必须是 {"));
        assert!(prompt.user.contains("2026-06-22"));
        assert!(prompt.user.contains("1 个工作片段"));
        assert!(prompt.user.contains("HourContextPack"));
    }

    /// 测试空 segments 也能构建提示词
    #[test]
    fn test_build_distill_prompt_empty_segments() {
        let prompt = build_distill_prompt(&[], "{}");
        assert!(!prompt.system.is_empty());
        assert!(prompt.user.contains("0 个工作片段"));
    }
}
