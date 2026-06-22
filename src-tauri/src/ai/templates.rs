//! templates：日报模板系统（对应 electron/ai/templates.ts）
//!
//! 预置 5 种模板：汇报优化版 / 简洁客观版 / OKR 对齐版 / 结构化分区版 / 站会版（F10.1 新增）。
//! 模板使用 `{{timeline}}` / `{{user_notes}}` / `{{project_tags}}` / `{{date}}` 占位符拼接提示词。
//!
//! 所有模板的 system_prompt 包含"内容真实不虚构"强约束。
//! standup 模板按 Yesterday / Today / Blockers 三段输出纯文本。

use crate::models::ReportTemplate;

/// 模板渲染参数
#[derive(Debug, Clone)]
pub struct TemplateParams {
    /// 时间线文本（已构建好的 Episode 摘要）
    pub timeline: String,
    /// 用户备注
    pub user_notes: String,
    /// 项目标签数组（已格式化为可读字符串）
    pub project_tags: String,
    /// 日期 YYYY-MM-DD
    pub date: String,
    /// 待办列表（standup 模板使用）
    pub todos: Vec<String>,
    /// 阻塞列表（standup 模板使用）
    pub blockers: Vec<String>,
}

impl Default for TemplateParams {
    fn default() -> Self {
        TemplateParams {
            timeline: String::new(),
            user_notes: String::new(),
            project_tags: String::new(),
            date: String::new(),
            todos: Vec::new(),
            blockers: Vec::new(),
        }
    }
}

/// 模板定义
#[derive(Debug, Clone)]
pub struct TemplateDef {
    /// 模板名称（中文）
    pub name: String,
    /// 模板描述
    pub description: String,
    /// 系统提示词：定义 AI 角色与硬约束
    pub system_prompt: String,
    /// 用户提示词模板：含占位符
    pub user_template: String,
}

/// 通用系统提示词：内容真实不虚构硬约束
const COMMON_SYSTEM_PROMPT: &str = "你是一名专业的工作汇报撰写助手。请严格遵守以下规则：\n\
1. 你只能基于以下用户勾选的真实工作片段进行归纳和表达增强，严禁虚构任何未发生的事项、未提及的项目或未列出的产出。如果信息不足，宁可简短也不要编造。\n\
2. 不得编造时间、数据、人名或项目名。\n\
3. 若片段信息不足以支撑某部分内容，则省略该部分，不要补充臆测。\n\
4. 输出纯 Markdown 格式，结构清晰，语言专业。\n\
5. 尊重用户备注（user_notes），如有特殊要求优先满足。\n\
6. 只输出最终答案，不要输出思考过程、推理过程、reasoning、analysis、解释说明或额外前后缀。";

/// 占位符替换：支持 `{{timeline}}` / `{{user_notes}}` / `{{project_tags}}` / `{{date}}`
fn render_template(template: &str, vars: &TemplateParams) -> String {
    template
        .replace("{{timeline}}", if vars.timeline.is_empty() { "（无片段）" } else { &vars.timeline })
        .replace("{{user_notes}}", if vars.user_notes.is_empty() { "（无备注）" } else { &vars.user_notes })
        .replace("{{project_tags}}", if vars.project_tags.is_empty() { "（无项目标签）" } else { &vars.project_tags })
        .replace("{{date}}", &vars.date)
}

/// 根据模板类型获取模板定义。
///
/// # 参数
/// - `template`：报告模板枚举
///
/// # 返回
/// 模板定义（名称、描述、system_prompt、user_template）
pub fn get_template(template: &ReportTemplate) -> TemplateDef {
    match template {
        ReportTemplate::Enhanced => TemplateDef {
            name: "汇报优化版".to_string(),
            description: "将杂事改写为具商业价值的表达，突出产出与价值".to_string(),
            system_prompt: format!(
                "{}\n6. 采用\"汇报优化\"风格：将技术性描述转化为业务价值陈述，将琐碎操作改写为具商业价值与成果导向的表达。例如\"改了一上午Bug\"应改写为\"定位并修复订单状态机历史遗留异常流，大幅提升结算准确度\"。突出工作产出、推进进度与价值贡献，但不得夸大或虚构。",
                COMMON_SYSTEM_PROMPT
            ),
            user_template: "请根据以下今日工作片段，生成一份\"汇报优化版\"日报。\n\n## 今日工作片段（timeline）\n{{timeline}}\n\n## 涉及项目标签（project_tags）\n{{project_tags}}\n\n## 用户备注（user_notes）\n{{user_notes}}\n\n## 输出要求\n- 标题：# 今日工作日报（{{date}}）\n- 按\"核心产出 / 推进事项 / 协作沟通 / 其他\"分类组织\n- 每个事项用一句话概括价值与进展，附时间区间\n- 将技术性描述转化为业务价值陈述，突出产出与影响\n- 末尾附\"明日计划\"占位（仅当 user_notes 中有相关内容时填写）\n- 全文使用 Markdown，语言精炼专业\n- 只输出最终日报正文，不要附加解释".to_string(),
        },
        ReportTemplate::Concise => TemplateDef {
            name: "简洁客观版".to_string(),
            description: "项目/用时/产出列表，客观陈述事实".to_string(),
            system_prompt: format!(
                "{}\n6. 采用\"简洁客观\"风格：按项目分组，每项列出用时和关键产出，不加修饰，仅陈述事实。",
                COMMON_SYSTEM_PROMPT
            ),
            user_template: "请根据以下今日工作片段，生成一份\"简洁客观版\"日报。\n\n## 今日工作片段（timeline）\n{{timeline}}\n\n## 涉及项目标签（project_tags）\n{{project_tags}}\n\n## 用户备注（user_notes）\n{{user_notes}}\n\n## 输出要求\n- 标题：# 工作日报 {{date}}\n- 按项目分组，每组列出：项目名、总用时、产出事项（bullet 列表）\n- 每项产出仅陈述事实，不加价值修饰\n- 末尾汇总：总工作时长、项目数、片段数\n- 全文使用 Markdown，客观陈述，不加修饰\n- 只输出最终日报正文，不要附加解释".to_string(),
        },
        ReportTemplate::Okr => TemplateDef {
            name: "OKR 对齐版".to_string(),
            description: "按 OKR 进度归纳，对齐目标推进".to_string(),
            system_prompt: format!(
                "{}\n6. 采用\"OKR 对齐\"风格：识别工作对应的 OKR 项，标注进度推进。将工作事项归纳到目标（Objective）与关键结果（Key Result）维度。若无法从片段中识别明确的 OKR，则按主题归纳并标注\"待对齐目标\"。",
                COMMON_SYSTEM_PROMPT
            ),
            user_template: "请根据以下今日工作片段，生成一份\"OKR 对齐版\"日报。\n\n## 今日工作片段（timeline）\n{{timeline}}\n\n## 涉及项目标签（project_tags）\n{{project_tags}}\n\n## 用户备注（user_notes）\n{{user_notes}}\n\n## 输出要求\n- 标题：# OKR 对齐日报 {{date}}\n- 识别工作对应的 OKR 项，按目标（Objective）分组，每组下含关键结果（Key Result）与今日推进事项\n- 每个推进事项标注：用时、进展（基于片段推断，保守估计）\n- 若无法识别对应 OKR，归入\"待对齐目标\"分组\n- 末尾附\"风险与阻碍\"占位（仅当 user_notes 中有相关内容时填写）\n- 全文使用 Markdown，结构清晰\n- 只输出最终日报正文，不要附加解释".to_string(),
        },
        ReportTemplate::Structured => TemplateDef {
            name: "结构化分区版".to_string(),
            description: "按管家总结/今日做了什么/今日看了什么/主题归纳/时间线/分类要点/证据/建议分区输出".to_string(),
            system_prompt: format!(
                "{}\n6. 采用\"结构化分区\"风格：按指定的 sections 分区输出，每个分区有明确标题与要点。\n7. 输出 JSON 对象，字段对应分区。\n8. 严禁虚构：所有要点必须来源于提供的片段/记忆单元/因果链上下文。",
                COMMON_SYSTEM_PROMPT
            ),
            user_template: "请根据以下今日工作上下文，生成一份\"结构化分区版\"日报。\n\n## 日期\n{{date}}\n\n## 今日工作片段（timeline）\n{{timeline}}\n\n## 涉及项目标签（project_tags）\n{{project_tags}}\n\n## 用户备注（user_notes）\n{{user_notes}}\n\n## 输出要求\n- 输出 JSON 对象，包含以下字段：\n  - butlerSummary: string（管家总结，1-3 句话概括当日整体情况）\n  - whatIDid: string[]（今日做了什么，每条一句话）\n  - whatISaw: string[]（今日看了什么，每条一句话）\n  - themes: string[]（主题归纳，每条一个主题）\n  - timeline: Array<{{ time: string; title: string; detail?: string; quote?: string; evidence?: string }}>\n  - chatNotes/webNotes/forumNotes/videoNotes/productNotes: Array<{{ title: string; details: string[] }}>\n- evidence: string[]（证据片段，每条 ≤80 字）\n- suggestions: string[]（优化建议）\n- 严格基于上下文，禁止虚构\n- 如果某类内容没有对应片段，对应数组为空\n- 只输出 JSON 对象本身，不要 Markdown 代码块，不要解释，不要思考过程".to_string(),
        },
        // F10.1：站会模板，纯文本格式，Yesterday / Today / Blockers 三段
        ReportTemplate::Standup => TemplateDef {
            name: "站会版".to_string(),
            description: "站会汇报格式：Yesterday / Today / Blockers 三段，纯文本输出".to_string(),
            system_prompt: format!(
                "{}\n6. 采用\"站会汇报\"风格：按 Yesterday / Today / Blockers 三段输出纯文本，每段以 bullet 列表呈现，简洁直接，不夸大不虚构。",
                COMMON_SYSTEM_PROMPT
            ),
            user_template: "请根据以下今日工作片段与待办/阻塞信息，生成一份\"站会版\"日报。\n\n## 日期\n{{date}}\n\n## 今日工作片段（timeline）\n{{timeline}}\n\n## 涉及项目标签（project_tags）\n{{project_tags}}\n\n## 用户备注（user_notes）\n{{user_notes}}\n\n## 输出要求\n- 输出纯文本，按以下三段组织：\n  Yesterday：昨日完成的工作（基于 timeline 中昨日片段，无则填\"无\"）\n  Today：今日计划与已开始的工作（基于 timeline + 待办，每条一句话）\n  Blockers：当前阻塞（基于阻塞列表，无则填\"无\"）\n- 每段使用 \"- \" bullet 列表\n- 不输出 Markdown 标题，不输出额外解释\n- 严格基于上下文，禁止虚构".to_string(),
        },
    }
}

/// 渲染用户提示词（占位符替换）
pub fn render_user_prompt(template: &ReportTemplate, vars: &TemplateParams) -> String {
    let def = get_template(template);
    render_template(&def.user_template, vars)
}

/// 获取所有模板列表（id / name / description）
pub fn get_template_list() -> Vec<(ReportTemplate, String, String)> {
    let all = vec![
        ReportTemplate::Enhanced,
        ReportTemplate::Concise,
        ReportTemplate::Okr,
        ReportTemplate::Structured,
        ReportTemplate::Standup,
    ];
    all.into_iter()
        .map(|t| {
            let def = get_template(&t);
            (t, def.name, def.description)
        })
        .collect()
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试所有 5 种模板都能获取到定义
    #[test]
    fn test_get_template_all_variants() {
        let templates = vec![
            ReportTemplate::Enhanced,
            ReportTemplate::Concise,
            ReportTemplate::Okr,
            ReportTemplate::Structured,
            ReportTemplate::Standup,
        ];
        for t in &templates {
            let def = get_template(t);
            assert!(!def.name.is_empty());
            assert!(!def.description.is_empty());
            assert!(!def.system_prompt.is_empty());
            assert!(!def.user_template.is_empty());
            // 系统提示词必须包含"不虚构"硬约束
            assert!(def.system_prompt.contains("虚构"));
        }
    }

    /// 测试 standup 模板包含 Yesterday / Today / Blockers 三段
    #[test]
    fn test_standup_template_contains_three_sections() {
        let def = get_template(&ReportTemplate::Standup);
        assert!(def.user_template.contains("Yesterday"));
        assert!(def.user_template.contains("Today"));
        assert!(def.user_template.contains("Blockers"));
    }

    /// 测试占位符替换
    #[test]
    fn test_render_user_prompt_replaces_placeholders() {
        let vars = TemplateParams {
            timeline: "10:00-11:00 写代码".to_string(),
            user_notes: "今日专注".to_string(),
            project_tags: "WorkMemory".to_string(),
            date: "2026-06-22".to_string(),
            ..Default::default()
        };
        let rendered = render_user_prompt(&ReportTemplate::Enhanced, &vars);
        assert!(rendered.contains("10:00-11:00 写代码"));
        assert!(rendered.contains("今日专注"));
        assert!(rendered.contains("WorkMemory"));
        assert!(rendered.contains("2026-06-22"));
        // 不应再包含未替换的占位符
        assert!(!rendered.contains("{{"));
        assert!(!rendered.contains("}}"));
    }

    /// 测试空值占位符替换为兜底文本
    #[test]
    fn test_render_user_prompt_empty_placeholders() {
        let vars = TemplateParams::default();
        let rendered = render_user_prompt(&ReportTemplate::Concise, &vars);
        assert!(rendered.contains("（无片段）"));
        assert!(rendered.contains("（无备注）"));
        assert!(rendered.contains("（无项目标签）"));
    }

    /// 测试模板列表返回 5 项
    #[test]
    fn test_get_template_list() {
        let list = get_template_list();
        assert_eq!(list.len(), 5);
    }
}
