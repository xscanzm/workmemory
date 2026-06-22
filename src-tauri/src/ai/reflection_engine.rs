//! ReflectionEngine：周级反思引擎（对应 electron/ai/ReflectionEngine.ts）
//!
//! 在周级模式（WeeklyPatternDetector）+ 用户画像（UserProfileRepository）+ 因果链
//! （CausalChainRepository）基础上生成反思报告：
//!  - patterns：识别到的模式（碎片化时段/深度工作时段/频繁上下文切换/稳定工作模式）
//!  - suggestions：改进建议（针对 warning 模式给出可执行行动）
//!  - trends：趋势分析（deepWorkHours/switchCount/dominantActivity 较上周变化）
//!
//! 与 TypeScript 版本的差异：
//!  - Rust ReflectionReport 的 patterns/suggestions/trends 为 Vec<serde_json::Value>
//!  - Rust WeeklyPattern 无 type/evidence/metadata 字段，模式类型编码在 name 中
//!  - 通过解析 pattern.name 前缀识别 5 类模式

use anyhow::Result;

use crate::ai::openai_client::{ChatCompletionRequest, Message, OpenAIClient};
use crate::models::{
    CausalChain, ReflectionReport, UserProfileEntry, WeeklyPatternResult,
};
use crate::repositories::causal_chain_repository::CausalChainRepository;
use crate::repositories::reflection_report_repository::ReflectionReportRepository;
use crate::repositories::settings_store::SettingsStore;
use crate::repositories::user_profile_repository::UserProfileRepository;
use crate::repositories::weekly_pattern_repository::WeeklyPatternRepository;

/// 一周天数
const WEEK_DAYS: usize = 7;
/// 趋势判定阈值：deepWorkHours 变化幅度（小时）
const DEEP_WORK_TREND_THRESHOLD: f64 = 0.5;
/// 趋势判定阈值：switchCount 变化幅度（次）
const SWITCH_COUNT_TREND_THRESHOLD: f64 = 2.0;
/// 碎片化时段出现天数阈值（>=此值视为 warning）
const FRAGMENTED_WARNING_DAYS: u32 = 3;
/// 频繁上下文切换阈值（日均切换次数）
const HIGH_SWITCH_THRESHOLD: f64 = 15.0;
/// 稳定工作模式判定：deep_work_time 出现天数阈值
const STABLE_DEEP_WORK_DAYS: u32 = 4;

/// 获取当前 ISO 时间戳
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
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

/// 计算周内日均切换次数（switch_count_trend 求和 / 7）
fn avg_switch_count(weekly: &WeeklyPatternResult) -> f64 {
    if weekly.trend.switch_count_trend.is_empty() {
        return 0.0;
    }
    let sum: i32 = weekly.trend.switch_count_trend.iter().sum();
    sum as f64 / WEEK_DAYS as f64
}

/// 计算周内总深度工作时长（deep_work_hours_trend 求和）
fn total_deep_work_hours(weekly: &WeeklyPatternResult) -> f64 {
    weekly.trend.deep_work_hours_trend.iter().sum()
}

/// 计算活动列表的众数（出现最多的活动）
fn top_activity(activities: &[String]) -> Option<String> {
    if activities.is_empty() {
        return None;
    }
    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for a in activities {
        *counts.entry(a.clone()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(_, c)| *c)
        .map(|(a, _)| a)
}

/// 识别反思模式：基于 weekly_patterns 中的 5 类模式映射为 ReflectionPattern（JSON）。
///
/// 模式类型编码在 pattern.name 前缀中：
///  - fragmented_time（出现天数 >= 阈值）→ warning
///  - deep_work_time（出现天数 >= 阈值）→ positive
///  - efficiency_trend（declining）→ warning；（rising）→ positive；（stable）→ neutral
///  - attention_hotspot → positive
///  - app_combination → neutral
///
/// 额外识别：
///  - 频繁上下文切换（日均切换 >= 阈值）→ warning
///  - 稳定工作模式（deep_work_time 出现天数 >= 阈值且日均切换低）→ positive
fn identify_patterns(
    weekly: &WeeklyPatternResult,
    profile: &[UserProfileEntry],
) -> Vec<serde_json::Value> {
    let mut patterns: Vec<serde_json::Value> = Vec::new();

    for wp in &weekly.patterns {
        let name = wp.name.as_str();
        if name.starts_with("fragmented_time") {
            // 碎片化时段：从 description 提取天数信息
            // 简化版：无 metadata，依据 description 中的"X/7 天"推断
            let days = extract_days_from_description(&wp.description);
            let severity = if days >= FRAGMENTED_WARNING_DAYS {
                "warning"
            } else {
                "neutral"
            };
            patterns.push(serde_json::json!({
                "description": wp.description,
                "severity": severity,
                "evidence": [],
            }));
        } else if name.starts_with("deep_work_time") {
            let days = extract_days_from_description(&wp.description);
            patterns.push(serde_json::json!({
                "description": wp.description,
                "severity": "positive",
                "evidence": [],
            }));
            let _ = days; // days 仅用于判断稳定工作模式
        } else if name.starts_with("efficiency_trend") {
            // 从 description 推断趋势方向
            let trend = if wp.description.contains("下降") {
                "declining"
            } else if wp.description.contains("上升") {
                "rising"
            } else {
                "stable"
            };
            let severity = if trend == "declining" {
                "warning"
            } else if trend == "rising" {
                "positive"
            } else {
                "neutral"
            };
            patterns.push(serde_json::json!({
                "description": wp.description,
                "severity": severity,
                "evidence": [],
            }));
        } else if name.starts_with("attention_hotspot") {
            patterns.push(serde_json::json!({
                "description": wp.description,
                "severity": "positive",
                "evidence": [],
            }));
        } else if name.starts_with("app_combination") {
            patterns.push(serde_json::json!({
                "description": wp.description,
                "severity": "neutral",
                "evidence": [],
            }));
        }
    }

    // 额外识别：频繁上下文切换
    let avg_switch = avg_switch_count(weekly);
    if avg_switch >= HIGH_SWITCH_THRESHOLD {
        let evidence: Vec<String> = weekly
            .trend
            .switch_count_trend
            .iter()
            .enumerate()
            .filter(|(_, c)| **c > 0)
            .map(|(i, c)| format!("{}: {} 次", add_days(&weekly.week_start, i as i64), c))
            .collect();
        patterns.push(serde_json::json!({
            "description": format!("频繁上下文切换（日均 {:.1} 次）", avg_switch),
            "severity": "warning",
            "evidence": evidence,
        }));
    }

    // 额外识别：稳定工作模式（深度工作时段稳定 + 切换次数低 + 画像含 work_pattern）
    let deep_work_pattern = weekly
        .patterns
        .iter()
        .find(|p| p.name.starts_with("deep_work_time"));
    let has_work_pattern_profile = profile
        .iter()
        .any(|p| p.key == "work_pattern" && p.confidence >= 0.5);
    if let Some(deep_work) = deep_work_pattern {
        let days = extract_days_from_description(&deep_work.description);
        if days >= STABLE_DEEP_WORK_DAYS
            && avg_switch < HIGH_SWITCH_THRESHOLD
            && has_work_pattern_profile
        {
            patterns.push(serde_json::json!({
                "description": "稳定的工作模式（深度工作时段规律 + 上下文切换可控）",
                "severity": "positive",
                "evidence": [
                    format!("深度工作时段出现 {}/{} 天", days, WEEK_DAYS),
                    format!("日均切换 {:.1} 次", avg_switch),
                    "用户画像 work_pattern 已建立".to_string(),
                ],
            }));
        }
    }

    patterns
}

/// 从 description 中提取"X/7 天"中的 X
fn extract_days_from_description(description: &str) -> u32 {
    // 匹配 "3/7 天" 或 "3 / 7 天"
    if let Some(start) = description.find('/') {
        let before: String = description[..start]
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_digit())
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if let Ok(n) = before.parse::<u32>() {
            return n;
        }
    }
    0
}

/// 基于反思模式生成改进建议。
///
/// 规则：
///  - 碎片化时段（warning）→ "在 XX 时段设置专注模式，关闭通知"
///  - 深度工作时段（positive）→ "保持 XX 时段的深度工作习惯"
///  - 频繁上下文切换（warning）→ "尝试批量处理同类任务"
///  - 效率趋势下降（warning）→ "复盘下降原因，调整工作节奏"
///  - 稳定工作模式（positive）→ "继续保持当前工作节奏"
fn generate_suggestions(
    reflection_patterns: &[serde_json::Value],
    weekly: &WeeklyPatternResult,
) -> Vec<serde_json::Value> {
    let mut suggestions: Vec<serde_json::Value> = Vec::new();

    // 碎片化时段建议
    let fragmented = weekly
        .patterns
        .iter()
        .find(|p| p.name.starts_with("fragmented_time"));
    if let Some(frag) = fragmented {
        let days = extract_days_from_description(&frag.description);
        if days >= FRAGMENTED_WARNING_DAYS {
            suggestions.push(serde_json::json!({
                "title": "在碎片化时段设置专注模式",
                "rationale": format!(
                    "本周 {}/{} 天出现碎片化，上下文频繁切换会显著降低深度工作时长。",
                    days, WEEK_DAYS
                ),
                "action": "在碎片化时段关闭即时通讯通知，使用番茄钟（25min 工作 + 5min 休息），将碎片化任务集中到该时段末尾统一处理。"
            }));
        }
    }

    // 频繁上下文切换建议
    let avg_switch = avg_switch_count(weekly);
    if avg_switch >= HIGH_SWITCH_THRESHOLD {
        suggestions.push(serde_json::json!({
            "title": "尝试批量处理同类任务",
            "rationale": format!("本周日均上下文切换 {:.1} 次，频繁切换会带来注意力残余成本。", avg_switch),
            "action": "将同类任务（如邮件回复、代码审查、文档阅读）集中到固定时段批量处理，减少在不同活动类型间的来回切换。"
        }));
    }

    // 效率趋势下降建议
    let efficiency_trend = weekly
        .patterns
        .iter()
        .find(|p| p.name.starts_with("efficiency_trend"));
    if let Some(eff) = efficiency_trend {
        if eff.description.contains("下降") {
            suggestions.push(serde_json::json!({
                "title": "复盘深度工作时长下降原因",
                "rationale": eff.description,
                "action": "回顾下半周的工作安排，识别打断深度工作的因素（会议、临时需求、疲劳等），在下周计划中预留保护性的深度工作时段。"
            }));
        }
    }

    // 深度工作时段保持建议（positive）
    let deep_work = weekly
        .patterns
        .iter()
        .find(|p| p.name.starts_with("deep_work_time"));
    if let Some(dw) = deep_work {
        let days = extract_days_from_description(&dw.description);
        if days >= STABLE_DEEP_WORK_DAYS {
            suggestions.push(serde_json::json!({
                "title": "保持深度工作时段习惯",
                "rationale": format!(
                    "本周 {}/{} 天进入深度工作，稳定的深度工作节奏是高效产出的基础。",
                    days, WEEK_DAYS
                ),
                "action": "继续保护深度工作时段，提前准备所需资料，减少切换成本。"
            }));
        }
    }

    // 稳定工作模式保持建议
    let stable_pattern = reflection_patterns.iter().find(|p| {
        p.get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.starts_with("稳定的工作模式"))
            .unwrap_or(false)
    });
    if let Some(stable) = stable_pattern {
        let evidence = stable
            .get("evidence")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
                    .join("；")
            })
            .unwrap_or_default();
        suggestions.push(serde_json::json!({
            "title": "继续保持当前工作节奏",
            "rationale": evidence,
            "action": "当前工作模式稳定高效，可在下周尝试在此基础上小幅扩展深度工作时段，或引入新的主题学习以保持成长。"
        }));
    }

    suggestions
}

/// 分析趋势：基于本周 trend 与上周 trend 对比生成 ReflectionTrend（JSON）。
///
/// 指标：
///  - deepWorkHours：本周总深度工作时长 vs 上周，方向 up/down/stable
///  - switchCount：本周日均切换次数 vs 上周，方向 up/down/stable
///  - dominantActivity：本周主导活动是否变化
///
/// 无上周数据时，仅基于本周数据给出绝对值描述（direction 为 stable）。
fn analyze_trends(
    this_week: &WeeklyPatternResult,
    last_week: Option<&WeeklyPatternResult>,
) -> Vec<serde_json::Value> {
    let mut trends: Vec<serde_json::Value> = Vec::new();

    // deepWorkHours 趋势
    let this_deep = total_deep_work_hours(this_week);
    if let Some(last) = last_week {
        let last_deep = total_deep_work_hours(last);
        let delta = this_deep - last_deep;
        let (direction, comparison) = if delta > DEEP_WORK_TREND_THRESHOLD {
            let pct = if last_deep > 0.0 {
                ((delta / last_deep) * 100.0).round() as i32
            } else {
                100
            };
            (
                "up",
                format!("较上周提升 {}%（+{:.1}h）", pct, delta),
            )
        } else if delta < -DEEP_WORK_TREND_THRESHOLD {
            let pct = if last_deep > 0.0 {
                (((-delta) / last_deep) * 100.0).round() as i32
            } else {
                0
            };
            (
                "down",
                format!("较上周下降 {}%（{:.1}h）", pct, delta),
            )
        } else {
            (
                "stable",
                format!(
                    "与上周基本持平（{:.1}h vs {:.1}h）",
                    this_deep, last_deep
                ),
            )
        };
        trends.push(serde_json::json!({
            "metric": "deepWorkHours",
            "direction": direction,
            "comparison": comparison,
        }));
    } else {
        trends.push(serde_json::json!({
            "metric": "deepWorkHours",
            "direction": "stable",
            "comparison": format!("本周累计 {:.1}h 深度工作（无上周数据对比）", this_deep),
        }));
    }

    // switchCount 趋势
    let this_switch = avg_switch_count(this_week);
    if let Some(last) = last_week {
        let last_switch = avg_switch_count(last);
        let delta = this_switch - last_switch;
        let (direction, comparison) = if delta > SWITCH_COUNT_TREND_THRESHOLD {
            (
                "up",
                format!(
                    "较上周增加 {:.1} 次/天（{:.1}→{:.1}）",
                    delta, last_switch, this_switch
                ),
            )
        } else if delta < -SWITCH_COUNT_TREND_THRESHOLD {
            (
                "down",
                format!(
                    "较上周减少 {:.1} 次/天（{:.1}→{:.1}）",
                    -delta, last_switch, this_switch
                ),
            )
        } else {
            (
                "stable",
                format!("与上周基本持平（{:.1} 次/天）", this_switch),
            )
        };
        trends.push(serde_json::json!({
            "metric": "switchCount",
            "direction": direction,
            "comparison": comparison,
        }));
    } else {
        trends.push(serde_json::json!({
            "metric": "switchCount",
            "direction": "stable",
            "comparison": format!("本周日均 {:.1} 次切换（无上周数据对比）", this_switch),
        }));
    }

    // dominantActivity 变化
    let this_dominant: Vec<String> = this_week
        .trend
        .dominant_activity_trend
        .iter()
        .filter(|a| !a.is_empty())
        .cloned()
        .collect();
    let this_top = top_activity(&this_dominant);
    if let Some(last) = last_week {
        let last_dominant: Vec<String> = last
            .trend
            .dominant_activity_trend
            .iter()
            .filter(|a| !a.is_empty())
            .cloned()
            .collect();
        let last_top = top_activity(&last_dominant);
        if let (Some(this_act), Some(last_act)) = (&this_top, &last_top) {
            if this_act != last_act {
                trends.push(serde_json::json!({
                    "metric": "dominantActivity",
                    "direction": "up",
                    "comparison": format!("主导活动从 {} 转向 {}", last_act, this_act),
                }));
            } else {
                trends.push(serde_json::json!({
                    "metric": "dominantActivity",
                    "direction": "stable",
                    "comparison": format!("主导活动保持为 {}", this_act),
                }));
            }
        }
    } else if let Some(this_act) = &this_top {
        trends.push(serde_json::json!({
            "metric": "dominantActivity",
            "direction": "stable",
            "comparison": format!("本周主导活动为 {}（无上周数据对比）", this_act),
        }));
    }

    trends
}

/// 构建 AI 用户提示词：包含 weekly_patterns、用户画像、causal_chains 概览。
fn build_ai_user_prompt(
    week_start: &str,
    weekly: Option<&WeeklyPatternResult>,
    profile: &[UserProfileEntry],
    causal_chains: &[CausalChain],
) -> String {
    let pattern_lines = if let Some(w) = weekly {
        w.patterns
            .iter()
            .map(|p| {
                format!(
                    "- [{}] {}（置信度 {:.2}）",
                    p.name, p.description, p.confidence
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        "（无周级模式数据）".to_string()
    };
    let trend_line = if let Some(w) = weekly {
        format!(
            "deepWorkHoursTrend: [{}]\nswitchCountTrend: [{}]\ndominantActivityTrend: [{}]",
            w.trend
                .deep_work_hours_trend
                .iter()
                .map(|x| format!("{:.1}", x))
                .collect::<Vec<_>>()
                .join(", "),
            w.trend
                .switch_count_trend
                .iter()
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
                .join(", "),
            w.trend
                .dominant_activity_trend
                .iter()
                .map(|a| if a.is_empty() { "—".to_string() } else { a.clone() })
                .collect::<Vec<_>>()
                .join(", ")
        )
    } else {
        "（无趋势数据）".to_string()
    };
    let profile_lines = if profile.is_empty() {
        "（无画像数据）".to_string()
    } else {
        profile
            .iter()
            .map(|p| format!("- {}: {} (置信度 {:.2})", p.key, p.value, p.confidence))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let chain_lines = if causal_chains.is_empty() {
        "（无因果链数据）".to_string()
    } else {
        causal_chains
            .iter()
            .take(20)
            .map(|c| format!("- [{}] {}（置信度 {:.2}）", c.relation, c.evidence, c.confidence))
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        "周起始日期：{}\n\n## 周级模式（weekly_patterns）\n{}\n\n## 趋势数据（trend）\n{}\n\n## 用户画像（user_profile）\n{}\n\n## 因果链（causal_chains，共 {} 条，仅展示前 20 条）\n{}\n\n请基于以上信息，生成 JSON 对象，包含三个字段：\n- patterns: 识别到的模式数组，每项含 description（描述）、severity（positive/neutral/warning）、evidence（证据字符串数组）\n- suggestions: 改进建议数组，每项含 title（标题）、rationale（理由）、action（具体行动）\n- trends: 趋势分析数组，每项含 metric（指标名）、direction（up/down/stable）、comparison（对比描述）\n\n输出格式：{{\"patterns\": [...], \"suggestions\": [...], \"trends\": [...]}}\n只返回 JSON 对象，第一个字符必须是 {{，不要 Markdown、不要额外解释。",
        week_start,
        pattern_lines,
        trend_line,
        profile_lines,
        causal_chains.len(),
        chain_lines
    )
}

/// 解析 AI 返回的 JSON 为 AiReflectionBody。
/// 返回 None 表示响应不可解析（非 JSON 或结构不符），调用方应降级为规则反思。
fn parse_ai_response(content: &str) -> Option<serde_json::Value> {
    let trimmed = content.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(trimmed).ok()
}

/// 校验并规范化 AI 返回的模式项。
fn normalize_ai_pattern(raw: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = raw.as_object()?;
    let description = obj
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if description.is_empty() {
        return None;
    }
    let severity = obj
        .get("severity")
        .and_then(|v| v.as_str())
        .filter(|s| matches!(*s, "positive" | "neutral" | "warning"))
        .unwrap_or("neutral");
    let evidence: Vec<String> = obj
        .get("evidence")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Some(serde_json::json!({
        "description": description,
        "severity": severity,
        "evidence": evidence,
    }))
}

/// 校验并规范化 AI 返回的建议项。
fn normalize_ai_suggestion(raw: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = raw.as_object()?;
    let title = obj
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let rationale = obj
        .get("rationale")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let action = obj
        .get("action")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if title.is_empty() || rationale.is_empty() || action.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "title": title,
        "rationale": rationale,
        "action": action,
    }))
}

/// 校验并规范化 AI 返回的趋势项。
fn normalize_ai_trend(raw: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = raw.as_object()?;
    let metric = obj
        .get("metric")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let direction = obj
        .get("direction")
        .and_then(|v| v.as_str())
        .filter(|s| matches!(*s, "up" | "down" | "stable"))
        .unwrap_or("stable");
    let comparison = obj
        .get("comparison")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if metric.is_empty() || comparison.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "metric": metric,
        "direction": direction,
        "comparison": comparison,
    }))
}

/// 调用 AI 增强反思报告。
/// 返回 None 表示 AI 不可用或失败，调用方应使用规则反思。
async fn reflect_by_ai(
    week_start: &str,
    weekly: Option<&WeeklyPatternResult>,
    profile: &[UserProfileEntry],
    causal_chains: &[CausalChain],
) -> Option<(Vec<serde_json::Value>, Vec<serde_json::Value>, Vec<serde_json::Value>)> {
    let api_key = SettingsStore::get_api_key();
    if api_key.is_empty() {
        return None;
    }
    let model = SettingsStore::get().model_name;
    let user_prompt = build_ai_user_prompt(week_start, weekly, profile, causal_chains);

    let req = ChatCompletionRequest::new(
        model,
        vec![
            Message::new(
                "system",
                "你是一个工作记忆周级反思引擎。根据给定的周级模式、用户画像与因果链，生成结构化的反思报告：识别模式、提出改进建议、分析趋势。只返回 JSON 对象，不要 Markdown、不要额外解释。",
            ),
            Message::new("user", user_prompt),
        ],
    );

    let client = OpenAIClient::new();
    let result = client.chat_completion(req).await.ok()?;
    let body = parse_ai_response(&result.content)?;
    let patterns: Vec<serde_json::Value> = body
        .get("patterns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(normalize_ai_pattern)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let suggestions: Vec<serde_json::Value> = body
        .get("suggestions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(normalize_ai_suggestion)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let trends: Vec<serde_json::Value> = body
        .get("trends")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(normalize_ai_trend)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some((patterns, suggestions, trends))
}

/// ReflectionEngine：周级反思引擎
pub struct ReflectionEngine;

impl ReflectionEngine {
    pub fn new() -> Self {
        ReflectionEngine
    }

    /// 周级反思：基于 weekly_patterns + user_profile + causal_chains 生成反思报告。
    ///
    /// 处理流程：
    ///  1. 获取本周周级模式、用户画像、因果链、上周模式（趋势对比）
    ///  2. 基于规则生成 patterns / suggestions / trends
    ///  3. AI 增强：如果 AI 可用，让 AI 基于数据生成更深入的反思和建议（覆盖规则结果）
    ///  4. 持久化到 ReflectionReportRepository
    ///
    /// # 参数
    /// - `week_start`：周一日期字符串（YYYY-MM-DD）
    ///
    /// # 返回
    /// 反思报告
    pub async fn reflect(&self, week_start: &str) -> Result<ReflectionReport> {
        // 1. 获取本周周级模式
        let weekly = WeeklyPatternRepository::get_by_week_start(week_start).ok().flatten();

        // 2. 获取用户画像（stable + transient）
        let mut profile = Vec::new();
        if let Ok(stable) = UserProfileRepository::get_stable() {
            profile.extend(stable);
        }
        if let Ok(transient) = UserProfileRepository::get_transient() {
            profile.extend(transient);
        }

        // 3. 获取周内因果链
        let week_end = add_days(week_start, (WEEK_DAYS - 1) as i64);
        let causal_chains = CausalChainRepository::get_by_date_range(week_start, &week_end)
            .unwrap_or_default();

        // 4. 获取上周模式（用于趋势对比）
        let last_week_start = add_days(week_start, -(WEEK_DAYS as i64));
        let last_week = WeeklyPatternRepository::get_by_week_start(&last_week_start)
            .ok()
            .flatten();

        // 5-7. 基于规则生成 patterns / suggestions / trends
        let weekly_for_analysis: WeeklyPatternResult = weekly.clone().unwrap_or_else(|| {
            WeeklyPatternResult {
                week_start: week_start.to_string(),
                patterns: Vec::new(),
                trend: Default::default(),
                created_at: now_iso(),
            }
        });

        let mut patterns = identify_patterns(&weekly_for_analysis, &profile);
        let mut suggestions = generate_suggestions(&patterns, &weekly_for_analysis);
        let mut trends = analyze_trends(&weekly_for_analysis, last_week.as_ref());

        // 8. AI 增强：如果 AI 可用，让 AI 基于数据生成更深入的反思和建议
        //    AI 返回合法结果时覆盖规则结果；AI 不可用或失败时保留规则结果
        if let Some((ai_patterns, ai_suggestions, ai_trends)) =
            reflect_by_ai(week_start, weekly.as_ref(), &profile, &causal_chains).await
        {
            if !ai_patterns.is_empty() {
                patterns = ai_patterns;
            }
            if !ai_suggestions.is_empty() {
                suggestions = ai_suggestions;
            }
            if !ai_trends.is_empty() {
                trends = ai_trends;
            }
        }

        let report = ReflectionReport {
            week_start: week_start.to_string(),
            patterns,
            suggestions,
            trends,
            created_at: now_iso(),
        };

        // 9. 持久化
        if let Err(e) = ReflectionReportRepository::upsert(report.clone()) {
            log::error!("[ReflectionEngine] 反思报告持久化失败: {}", e);
        }

        Ok(report)
    }
}

impl Default for ReflectionEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{WeeklyPattern, WeeklyPatternTrend};

    /// 测试 add_days
    #[test]
    fn test_add_days() {
        assert_eq!(add_days("2026-06-22", 0), "2026-06-22");
        assert_eq!(add_days("2026-06-22", 7), "2026-06-29");
        assert_eq!(add_days("2026-06-22", -7), "2026-06-15");
    }

    /// 测试 extract_days_from_description
    #[test]
    fn test_extract_days_from_description() {
        assert_eq!(extract_days_from_description("每日 14:00 起碎片化时段（出现 3/7 天）"), 3);
        assert_eq!(extract_days_from_description("深度工作时段（5/7 天稳定）"), 5);
        assert_eq!(extract_days_from_description("无天数信息"), 0);
    }

    /// 测试 top_activity
    #[test]
    fn test_top_activity() {
        assert_eq!(top_activity(&[]), None);
        let activities = vec![
            "coding".to_string(),
            "coding".to_string(),
            "writing".to_string(),
        ];
        assert_eq!(top_activity(&activities), Some("coding".to_string()));
    }

    /// 测试 identify_patterns：碎片化时段
    #[test]
    fn test_identify_patterns_fragmented() {
        let weekly = WeeklyPatternResult {
            week_start: "2026-06-22".to_string(),
            patterns: vec![WeeklyPattern {
                name: "fragmented_time".to_string(),
                description: "每日 14:00 起碎片化时段（出现 4/7 天）".to_string(),
                confidence: 0.6,
            }],
            trend: WeeklyPatternTrend::default(),
            created_at: now_iso(),
        };
        let patterns = identify_patterns(&weekly, &[]);
        assert_eq!(patterns.len(), 1);
        assert_eq!(
            patterns[0].get("severity").and_then(|v| v.as_str()),
            Some("warning")
        );
    }

    /// 测试 identify_patterns：频繁上下文切换
    #[test]
    fn test_identify_patterns_high_switch() {
        let weekly = WeeklyPatternResult {
            week_start: "2026-06-22".to_string(),
            patterns: vec![],
            trend: WeeklyPatternTrend {
                deep_work_hours_trend: vec![2.0; 7],
                switch_count_trend: vec![20; 7],
                dominant_activity_trend: vec!["coding".to_string(); 7],
            },
            created_at: now_iso(),
        };
        let patterns = identify_patterns(&weekly, &[]);
        // 应识别出频繁上下文切换
        assert!(patterns.iter().any(|p| {
            p.get("description")
                .and_then(|v| v.as_str())
                .map(|s| s.contains("频繁上下文切换"))
                .unwrap_or(false)
        }));
    }

    /// 测试 analyze_trends：无上周数据
    #[test]
    fn test_analyze_trends_no_last_week() {
        let weekly = WeeklyPatternResult {
            week_start: "2026-06-22".to_string(),
            patterns: vec![],
            trend: WeeklyPatternTrend {
                deep_work_hours_trend: vec![2.0; 7],
                switch_count_trend: vec![10; 7],
                dominant_activity_trend: vec!["coding".to_string(); 7],
            },
            created_at: now_iso(),
        };
        let trends = analyze_trends(&weekly, None);
        // 应有 deepWorkHours、switchCount、dominantActivity 三条
        assert_eq!(trends.len(), 3);
        assert!(trends.iter().all(|t| {
            t.get("direction").and_then(|v| v.as_str()) == Some("stable")
        }));
    }

    /// 测试 analyze_trends：有上周数据，深度工作上升
    #[test]
    fn test_analyze_trends_with_last_week() {
        let this_week = WeeklyPatternResult {
            week_start: "2026-06-22".to_string(),
            patterns: vec![],
            trend: WeeklyPatternTrend {
                deep_work_hours_trend: vec![4.0; 7],
                switch_count_trend: vec![10; 7],
                dominant_activity_trend: vec!["coding".to_string(); 7],
            },
            created_at: now_iso(),
        };
        let last_week = WeeklyPatternResult {
            week_start: "2026-06-15".to_string(),
            patterns: vec![],
            trend: WeeklyPatternTrend {
                deep_work_hours_trend: vec![2.0; 7],
                switch_count_trend: vec![10; 7],
                dominant_activity_trend: vec!["writing".to_string(); 7],
            },
            created_at: now_iso(),
        };
        let trends = analyze_trends(&this_week, Some(&last_week));
        // deepWorkHours 应为 up
        let deep_trend = trends
            .iter()
            .find(|t| t.get("metric").and_then(|v| v.as_str()) == Some("deepWorkHours"));
        assert!(deep_trend.is_some());
        assert_eq!(
            deep_trend.unwrap().get("direction").and_then(|v| v.as_str()),
            Some("up")
        );
        // dominantActivity 应为 up（coding vs writing）
        let dom_trend = trends
            .iter()
            .find(|t| t.get("metric").and_then(|v| v.as_str()) == Some("dominantActivity"));
        assert!(dom_trend.is_some());
        assert_eq!(
            dom_trend.unwrap().get("direction").and_then(|v| v.as_str()),
            Some("up")
        );
    }

    /// 测试 ReflectionEngine 创建
    #[test]
    fn test_reflection_engine_new() {
        let _engine = ReflectionEngine::new();
    }

    /// 测试 parse_ai_response
    #[test]
    fn test_parse_ai_response() {
        assert!(parse_ai_response("not json").is_none());
        assert!(parse_ai_response("{invalid}").is_none());
        let valid = parse_ai_response(r#"{"patterns": [], "suggestions": [], "trends": []}"#);
        assert!(valid.is_some());
    }
}
