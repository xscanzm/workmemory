//! SkillEvolver：技能进化引擎（对应 electron/ai/SkillEvolver.ts）
//!
//! 在反思与进化 Sprint 中，从重复出现的 MemScene 主题中提炼技能卡（SOP 步骤、陷阱、洞察），
//! 实现"自我进化"。
//!
//! 职责：
//!  - evolve_skills()：扫描所有 MemScene，筛选成员 ≥3 的主题（重复工作信号）
//!  - 对每个符合条件的 MemScene：
//!    - 获取所有成员 MemCell（episode + facts + foresight）
//!    - 调用 AI 提炼 SOP 步骤、陷阱、洞察
//!    - AI 不可用时降级为基于规则的技能提炼：
//!      - steps：从 MemCell.episode 中提取动作序列（按时间排序，提取动词开头的句子）
//!      - traps：从 MemCell.facts 中提取含"错误"/"失败"/"注意"关键词的事实
//!      - insights：从 MemCell.foresight 中提取 text
//!    - 构造 Skill 对象，存入 skills 表（按 title 去重）
//!  - 返回新生成的 Skill 列表
//!
//! 与 TypeScript 版本的差异：
//!  - Rust Foresight 字段为 text（非 statement），insights 提取自 foresight.text
//!  - Rust MemScene 字段为 member_cell_ids（非 memberCellIds）

use anyhow::Result;
use uuid::Uuid;

use crate::ai::openai_client::{ChatCompletionRequest, Message, OpenAIClient};
use crate::models::{MemCell, MemScene, Skill};
use crate::repositories::mem_cell_repository::MemCellRepository;
use crate::repositories::mem_scene_repository::MemSceneRepository;
use crate::repositories::settings_store::SettingsStore;
use crate::repositories::skill_repository::SkillRepository;

/// 触发技能进化的最小 MemScene 成员数（重复工作信号阈值）
const MIN_MEMBER_CELL_IDS: usize = 3;
/// 陷阱关键词：facts 含以下任一关键词时视为陷阱
const TRAP_KEYWORDS: &[&str] = &[
    "错误", "失败", "注意", "陷阱", "坑", "问题", "bug", "异常", "风险",
];
/// 步骤最大数量（避免 AI 返回过长列表）
const MAX_STEPS: usize = 12;
/// 陷阱最大数量
const MAX_TRAPS: usize = 10;
/// 洞察最大数量
const MAX_INSIGHTS: usize = 10;
/// 单条步骤/陷阱/洞察最大字符数
const MAX_ITEM_CHARS: usize = 300;

/// 动作关键词列表（用于规则提炼 steps）
const ACTION_KEYWORDS: &[&str] = &[
    "实现", "编写", "修改", "添加", "删除", "创建", "测试", "运行", "执行", "分析", "设计", "重构",
    "部署", "修复", "配置", "安装", "更新", "迁移", "检查", "验证", "调试", "提交", "合并", "启动",
    "停止", "加载", "保存", "读取", "写入", "调用", "处理", "转换", "生成", "构建", "编译", "打包",
];

/// 获取当前 ISO 时间戳
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 将置信度限制在 [0, 1] 范围内，保留两位小数
fn clamp_confidence(value: f64) -> f64 {
    let clamped = value.max(0.0).min(1.0);
    (clamped * 100.0).round() / 100.0
}

/// 限制数组长度并截断每项字符数
fn cap_items(items: Vec<String>, max_count: usize) -> Vec<String> {
    items
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(max_count)
        .map(|s| s.chars().take(MAX_ITEM_CHARS).collect())
        .collect()
}

/// 构建 AI 用户提示词：包含 MemScene 标题与所有成员 MemCell 的 episode + facts + foresight。
fn build_ai_user_prompt(scene: &MemScene, cells: &[MemCell]) -> String {
    let cell_lines = cells
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let facts = if c.facts.is_empty() {
                "  （无）".to_string()
            } else {
                c.facts
                    .iter()
                    .map(|f| format!("  - {}", f))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let foresight = if c.foresight.is_empty() {
                "  （无）".to_string()
            } else {
                c.foresight
                    .iter()
                    .map(|f| format!("  - {}", f.text))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            format!(
                "### MemCell {}（id={}, createdAt={}）\nepisode: {}\nfacts:\n{}\nforesight:\n{}",
                i + 1,
                c.id,
                c.created_at,
                c.episode,
                facts,
                foresight
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    format!(
        "主题（MemScene）：{}\n成员 MemCell 数：{}\n\n## 成员 MemCell 列表\n{}\n\n请基于以上同主题的 MemCell，提炼一份技能卡，包含：\n- title：技能标题（简洁，如\"数据库迁移工作流\"，可沿用主题标题或更精确化）\n- steps：SOP 步骤数组（按时间顺序的可执行步骤，每项以\"1. \"\"2. \"序号开头）\n- traps：陷阱数组（重复工作中容易踩的坑、易错点）\n- insights：洞察数组（从多次实践中得出的可复用经验、最佳实践）\n- confidence：置信度 0-1（成员越多、信息越完整则越高）\n\n输出格式：{{\"title\": \"...\", \"steps\": [...], \"traps\": [...], \"insights\": [...], \"confidence\": 0.x}}\n只返回 JSON 对象，第一个字符必须是 {{，不要 Markdown、不要额外解释。",
        scene.title,
        cells.len(),
        cell_lines
    )
}

/// 解析 AI 返回的 JSON 为 Value。
/// 返回 None 表示响应不可解析，调用方应降级为规则提炼。
fn parse_ai_response(content: &str) -> Option<serde_json::Value> {
    let trimmed = content.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(trimmed).ok()
}

/// 校验并规范化 AI 返回的字符串数组字段
fn normalize_ai_string_array(raw: &serde_json::Value) -> Vec<String> {
    raw.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// 调用 AI 提炼技能卡。
/// 返回 None 表示 AI 不可用或失败，调用方应使用规则提炼。
async fn evolve_by_ai(scene: &MemScene, cells: &[MemCell]) -> Option<serde_json::Value> {
    let api_key = SettingsStore::get_api_key();
    if api_key.is_empty() {
        return None;
    }
    let model = SettingsStore::get().model_name;
    let user_prompt = build_ai_user_prompt(scene, cells);

    let req = ChatCompletionRequest::new(
        model,
        vec![
            Message::new(
                "system",
                "你是一个工作记忆技能进化引擎。根据给定的同主题 MemCell（episode/facts/foresight），提炼一份结构化的技能卡：SOP 步骤、陷阱、洞察。只返回 JSON 对象，不要 Markdown、不要额外解释。",
            ),
            Message::new("user", user_prompt),
        ],
    );

    let client = OpenAIClient::new();
    let result = client.chat_completion(req).await.ok()?;
    parse_ai_response(&result.content)
}

/// 规则提炼 steps：从 MemCell.episode 中提取动作序列。
///
/// 规则：
///  - 按 createdAt 升序排列 MemCell
///  - 将每个 episode 按中文/英文标点切分为句子
///  - 提取含动作关键词的句子
///  - 去重并按出现顺序编号（"1. xxx"）
fn extract_steps_by_rules(cells: &[MemCell]) -> Vec<String> {
    let mut sorted: Vec<&MemCell> = cells.iter().collect();
    sorted.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let mut sentences: Vec<String> = Vec::new();
    for cell in sorted {
        let parts: Vec<String> = cell
            .episode
            .split(|c| matches!(c, '。' | '.' | ';' | '；' | '\n' | '!' | '！' | '?' | '？'))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if parts.is_empty() {
            continue;
        }
        // 优先提取含动作关键词的句子
        let action_parts: Vec<String> = parts
            .iter()
            .filter(|p| ACTION_KEYWORDS.iter().any(|kw| p.contains(kw)))
            .cloned()
            .collect();
        let picked: Vec<String> = if !action_parts.is_empty() {
            action_parts
        } else {
            vec![parts[0].clone()]
        };
        for p in picked {
            if !sentences.contains(&p) {
                sentences.push(p);
            }
        }
    }

    let numbered: Vec<String> = sentences
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {}", i + 1, s))
        .collect();
    cap_items(numbered, MAX_STEPS)
}

/// 规则提炼 traps：从 MemCell.facts 中提取含陷阱关键词的事实。
fn extract_traps_by_rules(cells: &[MemCell]) -> Vec<String> {
    let mut traps: Vec<String> = Vec::new();
    for cell in cells {
        for fact in &cell.facts {
            let trimmed = fact.trim();
            if trimmed.is_empty() {
                continue;
            }
            let lower = trimmed.to_lowercase();
            if TRAP_KEYWORDS.iter().any(|kw| lower.contains(&kw.to_lowercase())) {
                if !traps.contains(&trimmed.to_string()) {
                    traps.push(trimmed.to_string());
                }
            }
        }
    }
    cap_items(traps, MAX_TRAPS)
}

/// 规则提炼 insights：从 MemCell.foresight 中提取 text。
fn extract_insights_by_rules(cells: &[MemCell]) -> Vec<String> {
    let mut insights: Vec<String> = Vec::new();
    for cell in cells {
        for f in &cell.foresight {
            let text = f.text.trim();
            if text.is_empty() {
                continue;
            }
            if !insights.contains(&text.to_string()) {
                insights.push(text.to_string());
            }
        }
    }
    cap_items(insights, MAX_INSIGHTS)
}

/// 规则提炼置信度：基于成员数与提炼出的内容丰富度。
///  - 基础 0.3，每多一个成员 +0.1
///  - 有 steps +0.1，有 traps +0.1，有 insights +0.1
///  - 上限 0.9（规则提炼不超过 0.9，保留 AI 路径更高的置信度空间）
fn compute_fallback_confidence(
    member_count: usize,
    steps: &[String],
    traps: &[String],
    insights: &[String],
) -> f64 {
    let extra = (member_count.saturating_sub(MIN_MEMBER_CELL_IDS)).min(7) as f64;
    let mut confidence = 0.3 + extra * 0.1;
    if !steps.is_empty() {
        confidence += 0.1;
    }
    if !traps.is_empty() {
        confidence += 0.1;
    }
    if !insights.is_empty() {
        confidence += 0.1;
    }
    clamp_confidence(confidence.min(0.9))
}

/// 基于规则提炼技能卡（AI 不可用时的降级路径）。
fn build_skill_by_rules(scene: &MemScene, cells: &[MemCell]) -> Skill {
    let steps = extract_steps_by_rules(cells);
    let traps = extract_traps_by_rules(cells);
    let insights = extract_insights_by_rules(cells);
    let confidence = compute_fallback_confidence(cells.len(), &steps, &traps, &insights);
    Skill {
        id: Uuid::new_v4().to_string(),
        title: scene.title.clone(),
        steps,
        traps,
        insights,
        source_cell_ids: cells.iter().map(|c| c.id.clone()).collect(),
        confidence,
        evolved_at: now_iso(),
    }
}

/// 基于 AI 返回构造技能卡。
/// AI 返回字段缺失或非法时，回退到规则提炼对应字段。
fn build_skill_by_ai(scene: &MemScene, cells: &[MemCell], body: &serde_json::Value) -> Skill {
    let ai_title = body.get("title").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
    let title = ai_title.filter(|s| !s.is_empty()).unwrap_or_else(|| scene.title.clone());
    let steps = cap_items(
        normalize_ai_string_array(body.get("steps").unwrap_or(&serde_json::Value::Null)),
        MAX_STEPS,
    );
    let traps = cap_items(
        normalize_ai_string_array(body.get("traps").unwrap_or(&serde_json::Value::Null)),
        MAX_TRAPS,
    );
    let insights = cap_items(
        normalize_ai_string_array(body.get("insights").unwrap_or(&serde_json::Value::Null)),
        MAX_INSIGHTS,
    );
    let ai_confidence = body.get("confidence").and_then(|v| v.as_f64()).unwrap_or(-1.0);

    // AI 字段缺失时回退到规则提炼
    let fallback_steps = if !steps.is_empty() {
        steps
    } else {
        extract_steps_by_rules(cells)
    };
    let fallback_traps = if !traps.is_empty() {
        traps
    } else {
        extract_traps_by_rules(cells)
    };
    let fallback_insights = if !insights.is_empty() {
        insights
    } else {
        extract_insights_by_rules(cells)
    };

    // 置信度：AI 给出合法值则用 AI 值；否则基于成员数与内容丰富度计算
    let confidence = if ai_confidence >= 0.0 && ai_confidence <= 1.0 {
        clamp_confidence(ai_confidence)
    } else {
        compute_fallback_confidence(
            cells.len(),
            &fallback_steps,
            &fallback_traps,
            &fallback_insights,
        )
    };

    Skill {
        id: Uuid::new_v4().to_string(),
        title,
        steps: fallback_steps,
        traps: fallback_traps,
        insights: fallback_insights,
        source_cell_ids: cells.iter().map(|c| c.id.clone()).collect(),
        confidence,
        evolved_at: now_iso(),
    }
}

/// SkillEvolver：技能进化引擎
pub struct SkillEvolver;

impl SkillEvolver {
    pub fn new() -> Self {
        SkillEvolver
    }

    /// 技能进化：从重复出现的 MemScene 主题中提炼技能卡。
    ///
    /// 处理流程：
    ///  1. 获取所有 MemScene
    ///  2. 筛选 member_cell_ids.length >= 3 的 MemScene（重复工作信号）
    ///  3. 对每个符合条件的 MemScene：
    ///     - 获取所有成员 MemCell（跳过不存在的）
    ///     - 调用 AI 提炼技能卡；AI 不可用时降级为规则提炼
    ///     - 按 title 去重：同 title 已存在则跳过
    ///     - 持久化到 SkillRepository
    ///  4. 返回新生成的 Skill 列表
    ///
    /// # 返回
    /// 新生成的技能卡列表
    pub async fn evolve_skills(&self) -> Result<Vec<Skill>> {
        let scenes = MemSceneRepository::get_all()?;
        let mut generated: Vec<Skill> = Vec::new();

        for scene in &scenes {
            if scene.member_cell_ids.len() < MIN_MEMBER_CELL_IDS {
                continue;
            }

            // 获取所有成员 MemCell（跳过不存在的，避免脏数据导致整批失败）
            let mut cells: Vec<MemCell> = Vec::new();
            for cell_id in &scene.member_cell_ids {
                if let Ok(Some(cell)) = MemCellRepository::get_by_id(cell_id) {
                    cells.push(cell);
                }
            }
            if cells.len() < MIN_MEMBER_CELL_IDS {
                // 成员 MemCell 实际可用数不足，跳过
                continue;
            }

            // 按 title 去重：同 title 已存在则跳过
            if let Ok(Some(_)) = SkillRepository::get_by_title(&scene.title) {
                continue;
            }

            // AI 提炼（不可用时降级为规则提炼）
            let skill = if let Some(body) = evolve_by_ai(scene, &cells).await {
                build_skill_by_ai(scene, &cells, &body)
            } else {
                build_skill_by_rules(scene, &cells)
            };

            // 持久化（失败仅记录日志，不中断后续 MemScene 处理）
            match SkillRepository::insert(skill.clone()) {
                Ok(_) => generated.push(skill),
                Err(e) => {
                    log::error!("[SkillEvolver] 技能卡持久化失败: {}", e);
                }
            }
        }

        Ok(generated)
    }
}

impl Default for SkillEvolver {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Foresight, MemCell, MemCellMetadata};

    /// 构造测试用 MemCell
    fn make_cell(id: &str, episode: &str, facts: Vec<&str>, foresight: Vec<&str>) -> MemCell {
        MemCell {
            id: id.to_string(),
            clean_episode_id: "ep1".to_string(),
            episode: episode.to_string(),
            facts: facts.into_iter().map(String::from).collect(),
            foresight: foresight
                .into_iter()
                .map(|t| Foresight {
                    text: t.to_string(),
                    confidence: 0.8,
                })
                .collect(),
            metadata: MemCellMetadata::default(),
            created_at: "2026-06-22T10:00:00Z".to_string(),
        }
    }

    /// 测试 clamp_confidence
    #[test]
    fn test_clamp_confidence() {
        assert!((clamp_confidence(0.5) - 0.5).abs() < 0.001);
        assert!((clamp_confidence(-0.1) - 0.0).abs() < 0.001);
        assert!((clamp_confidence(1.5) - 1.0).abs() < 0.001);
    }

    /// 测试 cap_items
    #[test]
    fn test_cap_items() {
        let items = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let capped = cap_items(items, 2);
        assert_eq!(capped.len(), 2);
        assert_eq!(capped[0], "a");
    }

    /// 测试 extract_steps_by_rules：提取含动作关键词的句子
    #[test]
    fn test_extract_steps_by_rules() {
        let cells = vec![
            make_cell("1", "实现了登录功能。修复了 bug。", vec![], vec![]),
            make_cell("2", "测试了登录流程。", vec![], vec![]),
        ];
        let steps = extract_steps_by_rules(&cells);
        assert!(!steps.is_empty());
        // 应包含序号前缀
        assert!(steps[0].starts_with("1. "));
        // 应包含动作关键词
        assert!(steps.iter().any(|s| s.contains("实现")));
        assert!(steps.iter().any(|s| s.contains("测试")));
    }

    /// 测试 extract_traps_by_rules：提取含陷阱关键词的事实
    #[test]
    fn test_extract_traps_by_rules() {
        let cells = vec![make_cell(
            "1",
            "工作",
            vec!["遇到错误：空指针", "正常流程", "失败：连接超时"],
            vec![],
        )];
        let traps = extract_traps_by_rules(&cells);
        assert_eq!(traps.len(), 2);
        assert!(traps.iter().any(|t| t.contains("错误")));
        assert!(traps.iter().any(|t| t.contains("失败")));
    }

    /// 测试 extract_insights_by_rules：从 foresight.text 提取
    #[test]
    fn test_extract_insights_by_rules() {
        let cells = vec![make_cell(
            "1",
            "工作",
            vec![],
            vec!["使用 ALTER TABLE 更安全", "注意索引重建"],
        )];
        let insights = extract_insights_by_rules(&cells);
        assert_eq!(insights.len(), 2);
        assert!(insights.iter().any(|i| i.contains("ALTER TABLE")));
    }

    /// 测试 compute_fallback_confidence
    #[test]
    fn test_compute_fallback_confidence() {
        // 3 个成员 + 有 steps/traps/insights
        let steps = vec!["1. step".to_string()];
        let traps = vec!["trap".to_string()];
        let insights = vec!["insight".to_string()];
        let confidence = compute_fallback_confidence(3, &steps, &traps, &insights);
        // 0.3 + 0（3-3=0）+ 0.1 + 0.1 + 0.1 = 0.6
        assert!((confidence - 0.6).abs() < 0.001);

        // 10 个成员，上限 0.9
        let confidence = compute_fallback_confidence(10, &steps, &traps, &insights);
        // 0.3 + 0.7（min(7, 7)）+ 0.3 = 1.3 → 0.9
        assert!((confidence - 0.9).abs() < 0.001);
    }

    /// 测试 build_skill_by_rules
    #[test]
    fn test_build_skill_by_rules() {
        let scene = MemScene {
            id: "scene1".to_string(),
            title: "数据库迁移".to_string(),
            centroid_embedding: vec![],
            member_cell_ids: vec!["1".to_string(), "2".to_string(), "3".to_string()],
            summary: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let cells = vec![
            make_cell("1", "编写了迁移脚本。", vec!["遇到错误"], vec!["使用备份"]),
            make_cell("2", "测试了迁移。", vec![], vec![]),
            make_cell("3", "部署了迁移。", vec![], vec![]),
        ];
        let skill = build_skill_by_rules(&scene, &cells);
        assert_eq!(skill.title, "数据库迁移");
        assert!(!skill.steps.is_empty());
        assert!(!skill.id.is_empty());
        assert_eq!(skill.source_cell_ids.len(), 3);
    }

    /// 测试 build_skill_by_ai：AI 返回完整字段
    #[test]
    fn test_build_skill_by_ai_complete() {
        let scene = MemScene {
            id: "scene1".to_string(),
            title: "数据库迁移".to_string(),
            centroid_embedding: vec![],
            member_cell_ids: vec!["1".to_string()],
            summary: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let cells = vec![make_cell("1", "工作", vec![], vec![])];
        let body = serde_json::json!({
            "title": "数据库迁移工作流",
            "steps": ["1. 分析 schema", "2. 编写脚本"],
            "traps": ["忘记备份"],
            "insights": ["使用事务"],
            "confidence": 0.85
        });
        let skill = build_skill_by_ai(&scene, &cells, &body);
        assert_eq!(skill.title, "数据库迁移工作流");
        assert_eq!(skill.steps.len(), 2);
        assert_eq!(skill.traps.len(), 1);
        assert!((skill.confidence - 0.85).abs() < 0.001);
    }

    /// 测试 build_skill_by_ai：AI 字段缺失时回退到规则提炼
    #[test]
    fn test_build_skill_by_ai_fallback() {
        let scene = MemScene {
            id: "scene1".to_string(),
            title: "数据库迁移".to_string(),
            centroid_embedding: vec![],
            member_cell_ids: vec!["1".to_string()],
            summary: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let cells = vec![make_cell("1", "编写了脚本。", vec![], vec![])];
        let body = serde_json::json!({});
        let skill = build_skill_by_ai(&scene, &cells, &body);
        // AI 字段缺失，应回退到规则提炼
        assert_eq!(skill.title, "数据库迁移");
        assert!(!skill.steps.is_empty());
    }

    /// 测试 parse_ai_response
    #[test]
    fn test_parse_ai_response() {
        assert!(parse_ai_response("not json").is_none());
        assert!(parse_ai_response("{invalid}").is_none());
        let valid = parse_ai_response(r#"{"title": "test"}"#);
        assert!(valid.is_some());
    }

    /// 测试 SkillEvolver 创建
    #[test]
    fn test_skill_evolver_new() {
        let _evolver = SkillEvolver::new();
    }
}
