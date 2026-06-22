//! DailyDistillManager：日级理解（对应 electron/ai/DailyDistillManager.ts）
//!
//! 在小时级 MemCell 基础上构建日级理解，发现跨小时主题和当日工作模式。
//!
//! 职责：
//!  - distill_day(date)：聚合当日所有 MemCell + MemScene + 用户画像，
//!    产出日级摘要 + 跨小时主题 + 当日模式（深度工作时长/碎片化时段/切换次数）
//!  - 跨小时主题：按 MemScene 分组，每个 MemScene 对应一个主题
//!  - 当日模式：基于 MemCell 时间分布计算（Rust 版本 metadata 无 activity_type，
//!    使用 segment activity_type 兜底）
//!  - 摘要生成：调用 AI（传入 MemCell episodes + MemScene titles + patterns），
//!    AI 不可用时降级为基于规则的摘要
//!
//! 与 TypeScript 版本的差异：
//!  - Rust MemCellMetadata 无 activity_type/content_type，模式计算简化
//!  - Rust DayTheme 字段为 name/summary/cell_ids（无 hours）
//!  - Rust DayPattern 字段与 TS 一致

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;

use crate::ai::openai_client::{ChatCompletionRequest, Message, OpenAIClient};
use crate::models::{
    DayDistillResult, DayPattern, DayTheme, MemCell, MemCellMetadata, MemScene, TimeRange,
    UserProfileEntry,
};
use crate::repositories::daily_distill_repository::DailyDistillRepository;
use crate::repositories::mem_cell_repository::MemCellRepository;
use crate::repositories::mem_scene_repository::MemSceneRepository;
use crate::repositories::settings_store::SettingsStore;
use crate::repositories::user_profile_repository::UserProfileRepository;

/// 摘要最大字符数（降级摘要截断）
const SUMMARY_MAX_CHARS: usize = 500;
/// 碎片化时段阈值：单小时内切换次数 ≥3 视为碎片化
const FRAGMENTED_SWITCH_THRESHOLD: i32 = 3;

/// 获取当前 ISO 时间戳
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 将日期字符串转为当日起止 ISO 时间戳
fn day_range(date: &str) -> (String, String) {
    (
        format!("{}T00:00:00.000Z", date),
        format!("{}T23:59:59.999Z", date),
    )
}

/// 从 ISO 时间戳提取 UTC 小时（0-23）
fn hour_of(iso: &str) -> u32 {
    // ISO 格式：2026-06-22T10:30:00.000Z
    // 提取 T 后两位小时
    if let Some(t_pos) = iso.find('T') {
        let hour_str = &iso[t_pos + 1..t_pos + 3.min(iso.len())];
        hour_str.parse::<u32>().unwrap_or(0)
    } else {
        0
    }
}

/// 将小时数格式化为 "HH:00"
fn format_hour(hour: u32) -> String {
    format!("{:02}:00", hour)
}

/// 计算当日活跃小时数（有 MemCell 的小时去重计数）
fn compute_active_hours(mem_cells: &[MemCell]) -> u32 {
    let mut hours = std::collections::HashSet::new();
    for cell in mem_cells {
        hours.insert(hour_of(&cell.created_at));
    }
    hours.len() as u32
}

/// 计算碎片化时段：单小时内 MemCell 数量 ≥2 且时间跨度大视为碎片化
///
/// 简化版：由于 Rust MemCellMetadata 无 activity_type，按小时分组，
/// 单小时 MemCell 数量 ≥3 视为碎片化时段
fn compute_fragmented_periods(mem_cells: &[MemCell]) -> Vec<TimeRange> {
    let mut by_hour: std::collections::HashMap<u32, Vec<&MemCell>> =
        std::collections::HashMap::new();
    for cell in mem_cells {
        let h = hour_of(&cell.created_at);
        by_hour.entry(h).or_default().push(cell);
    }

    let mut periods: Vec<TimeRange> = Vec::new();
    let mut sorted_hours: Vec<u32> = by_hour.keys().cloned().collect();
    sorted_hours.sort();

    for h in sorted_hours {
        let cells = &by_hour[&h];
        // 单小时 MemCell 数量 ≥3 视为碎片化
        if cells.len() as i32 >= FRAGMENTED_SWITCH_THRESHOLD {
            periods.push(TimeRange {
                start: format_hour(h),
                end: format_hour((h + 1) % 24),
            });
        }
    }
    periods
}

/// 计算当日模式（DayPattern）
///
/// 简化版：由于 Rust MemCellMetadata 无 activity_type，
/// - deep_work_hours：基于 MemCell 数量估算（每个 MemCell 约 5 分钟）
/// - switch_count：相邻 MemCell 的小时变化次数
/// - dominant_activity：空字符串（无 activity_type 数据）
fn compute_patterns(mem_cells: &[MemCell]) -> DayPattern {
    let active_hours = compute_active_hours(mem_cells);
    let fragmented_periods = compute_fragmented_periods(mem_cells);

    // deep_work_hours：每个 MemCell 约 5 分钟，转换为小时
    let deep_work_hours = (mem_cells.len() as f64 * 5.0 / 60.0).round_ties_even() / 10.0;

    // switch_count：相邻 MemCell 的小时变化次数
    let mut sorted = mem_cells.to_vec();
    sorted.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut switch_count: i32 = 0;
    for i in 1..sorted.len() {
        let prev_hour = hour_of(&sorted[i - 1].created_at);
        let curr_hour = hour_of(&sorted[i].created_at);
        if prev_hour != curr_hour {
            switch_count += 1;
        }
    }

    DayPattern {
        deep_work_hours,
        fragmented_periods,
        switch_count,
        active_hours: active_hours as f64,
        dominant_activity: String::new(),
    }
}

/// 提取跨小时主题：按当日活跃 MemScene 分组
fn extract_themes(mem_cells: &[MemCell], scenes: &[MemScene]) -> Vec<DayTheme> {
    let cell_by_id: std::collections::HashMap<String, &MemCell> =
        mem_cells.iter().map(|c| (c.id.clone(), c)).collect();

    let mut themes: Vec<DayTheme> = Vec::new();
    for scene in scenes {
        let day_member_ids: Vec<String> = scene
            .member_cell_ids
            .iter()
            .filter(|id| cell_by_id.contains_key(*id))
            .cloned()
            .collect();
        if day_member_ids.is_empty() {
            continue;
        }

        let summary = if scene.summary.trim().is_empty() {
            // 无 summary 时由成员 episode 拼接（取前 3 条）
            day_member_ids
                .iter()
                .filter_map(|id| cell_by_id.get(id).map(|c| c.episode.clone()))
                .filter(|e| !e.is_empty())
                .take(3)
                .collect::<Vec<_>>()
                .join("；")
        } else {
            scene.summary.clone()
        };

        themes.push(DayTheme {
            name: scene.title.clone(),
            summary,
            cell_ids: day_member_ids,
        });
    }
    themes
}

/// 构建发送给 AI 的用户提示词
fn build_ai_user_prompt(
    date: &str,
    mem_cells: &[MemCell],
    themes: &[DayTheme],
    patterns: &DayPattern,
    profile: &[UserProfileEntry],
) -> String {
    let episodes: String = mem_cells
        .iter()
        .map(|c| format!("- [{}] {}", c.created_at, c.episode))
        .collect::<Vec<_>>()
        .join("\n");
    let episodes = episodes.chars().take(4000).collect::<String>();

    let theme_titles: String = themes
        .iter()
        .map(|t| format!("- {}", t.name))
        .collect::<Vec<_>>()
        .join("\n");

    let profile_lines: String = profile
        .iter()
        .map(|p| format!("- {}: {} (置信度 {:.2})", p.key, p.value, p.confidence))
        .collect::<Vec<_>>()
        .join("\n");

    let fragmented_periods_str = patterns
        .fragmented_periods
        .iter()
        .map(|p| format!("{}-{}", p.start, p.end))
        .collect::<Vec<_>>()
        .join("、");

    format!(
        "日期：{}\n\n## 当日工作记忆事件（共 {} 条）\n{}\n\n## 跨小时主题（共 {} 个）\n{}\n\n## 当日模式\n- 深度工作时长：{} 小时\n- 上下文切换次数：{}\n- 活跃小时数：{}\n- 主要活动：{}\n- 碎片化时段：{}\n\n## 用户画像\n{}\n\n请基于以上信息，生成 2-3 句中文日级摘要，概括当日工作主线、跨小时主题与工作模式特征。",
        date,
        mem_cells.len(),
        if episodes.is_empty() { "（无）".to_string() } else { episodes },
        themes.len(),
        if theme_titles.is_empty() { "（无）".to_string() } else { theme_titles },
        patterns.deep_work_hours,
        patterns.switch_count,
        patterns.active_hours,
        if patterns.dominant_activity.is_empty() { "（无）".to_string() } else { patterns.dominant_activity.clone() },
        if fragmented_periods_str.is_empty() { "无".to_string() } else { fragmented_periods_str },
        if profile_lines.is_empty() { "（无）".to_string() } else { profile_lines },
    )
}

/// 调用 AI 生成日级摘要
async fn generate_summary_by_ai(
    date: &str,
    mem_cells: &[MemCell],
    themes: &[DayTheme],
    patterns: &DayPattern,
    profile: &[UserProfileEntry],
) -> String {
    let api_key = SettingsStore::get_api_key();
    if api_key.is_empty() {
        return String::new();
    }

    let model_name = SettingsStore::get().model_name;
    let user_prompt = build_ai_user_prompt(date, mem_cells, themes, patterns, profile);

    let client = OpenAIClient::new();
    let req = ChatCompletionRequest {
        model: model_name,
        messages: vec![
            Message::new(
                "system",
                "你是一个工作记忆日级摘要生成器。根据给定的一日工作记忆事件、跨小时主题与当日模式，生成 2-3 句中文摘要。只返回纯文本摘要，不要 Markdown 标题、不要列表、不要额外解释。",
            ),
            Message::new("user", &user_prompt),
        ],
        temperature: Some(0.3),
        max_tokens: Some(300),
        stream: None,
    };

    match client.chat_completion(req).await {
        Ok(resp) => resp.content.trim().to_string(),
        Err(e) => {
            log::warn!("[DailyDistillManager] AI 摘要生成失败，降级使用规则摘要: {}", e);
            String::new()
        }
    }
}

/// 基于规则的降级摘要
fn build_fallback_summary(
    date: &str,
    mem_cells: &[MemCell],
    themes: &[DayTheme],
    patterns: &DayPattern,
) -> String {
    if mem_cells.is_empty() {
        return format!("{} 当日无工作记忆事件。", date);
    }

    let theme_titles = themes
        .iter()
        .map(|t| t.name.clone())
        .collect::<Vec<_>>()
        .join("、");

    let mut parts: Vec<String> = Vec::new();
    parts.push(format!(
        "{} 共记录 {} 条工作记忆，主要活动为 {}",
        date,
        mem_cells.len(),
        if patterns.dominant_activity.is_empty() {
            "未知"
        } else {
            &patterns.dominant_activity
        }
    ));
    if !theme_titles.is_empty() {
        parts.push(format!("涉及主题：{}", theme_titles));
    }
    parts.push(format!(
        "深度工作 {} 小时，切换 {} 次，活跃 {} 小时",
        patterns.deep_work_hours, patterns.switch_count, patterns.active_hours
    ));

    let summary = parts.join("；");
    summary.chars().take(SUMMARY_MAX_CHARS).collect()
}

/// DailyDistillManager：日级蒸馏管理器
pub struct DailyDistillManager {
    running: AtomicBool,
}

impl DailyDistillManager {
    pub fn new() -> Self {
        DailyDistillManager {
            running: AtomicBool::new(false),
        }
    }

    /// 是否正在运行
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 日级蒸馏：聚合当日 MemCell + MemScene + 用户画像，产出日级理解结果。
    ///
    /// # 参数
    /// - `date`：日期 YYYY-MM-DD
    ///
    /// # 返回
    /// 日级理解结果（含摘要、主题、模式、MemCell ID 列表）
    pub async fn distill_day(&self, date: &str) -> Result<DayDistillResult> {
        self.running.store(true, Ordering::SeqCst);
        let result = self.do_distill_day(date).await;
        self.running.store(false, Ordering::SeqCst);
        result
    }

    async fn do_distill_day(&self, date: &str) -> Result<DayDistillResult> {
        let (start, end) = day_range(date);

        // 1. 获取当日所有 MemCell
        let mem_cells = MemCellRepository::get_by_date_range(&start, &end)?;
        let memcell_ids: Vec<String> = mem_cells.iter().map(|c| c.id.clone()).collect();

        // 2. 获取所有 MemScene，筛选当日活跃的
        let cell_id_set: std::collections::HashSet<String> = memcell_ids.iter().cloned().collect();
        let all_scenes = MemSceneRepository::get_all()?;
        let active_scenes: Vec<MemScene> = all_scenes
            .into_iter()
            .filter(|scene| scene.member_cell_ids.iter().any(|id| cell_id_set.contains(id)))
            .collect();

        // 3. 获取用户画像
        let profile = UserProfileRepository::get_all().unwrap_or_default();

        // 4. 计算当日模式
        let patterns = compute_patterns(&mem_cells);

        // 5. 提取跨小时主题
        let themes = extract_themes(&mem_cells, &active_scenes);

        // 6. 生成摘要（AI 优先，降级为规则摘要）
        let mut summary = String::new();
        if !mem_cells.is_empty() {
            summary = generate_summary_by_ai(date, &mem_cells, &themes, &patterns, &profile).await;
        }
        if summary.is_empty() {
            summary = build_fallback_summary(date, &mem_cells, &themes, &patterns);
        }

        let result = DayDistillResult {
            date: date.to_string(),
            summary,
            themes,
            patterns,
            memcell_ids,
        };

        // 7. 持久化
        if let Err(e) = DailyDistillRepository::upsert(result.clone()) {
            log::error!("[DailyDistillManager] 日级理解结果持久化失败: {}", e);
        }

        Ok(result)
    }
}

impl Default for DailyDistillManager {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 hour_of 从 ISO 时间戳提取小时
    #[test]
    fn test_hour_of() {
        assert_eq!(hour_of("2026-06-22T10:30:00.000Z"), 10);
        assert_eq!(hour_of("2026-06-22T00:00:00.000Z"), 0);
        assert_eq!(hour_of("2026-06-22T23:59:59.999Z"), 23);
        assert_eq!(hour_of("invalid"), 0);
    }

    /// 测试 format_hour
    #[test]
    fn test_format_hour() {
        assert_eq!(format_hour(0), "00:00");
        assert_eq!(format_hour(9), "09:00");
        assert_eq!(format_hour(23), "23:00");
    }

    /// 测试 compute_active_hours
    #[test]
    fn test_compute_active_hours() {
        let cells = vec![
            MemCell {
                id: "1".to_string(),
                clean_episode_id: "ce-1".to_string(),
                episode: "ep1".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: MemCellMetadata::default(),
                created_at: "2026-06-22T10:00:00.000Z".to_string(),
            },
            MemCell {
                id: "2".to_string(),
                clean_episode_id: "ce-1".to_string(),
                episode: "ep2".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: MemCellMetadata::default(),
                created_at: "2026-06-22T10:30:00.000Z".to_string(),
            },
            MemCell {
                id: "3".to_string(),
                clean_episode_id: "ce-1".to_string(),
                episode: "ep3".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: MemCellMetadata::default(),
                created_at: "2026-06-22T14:00:00.000Z".to_string(),
            },
        ];
        // 10 点 2 个，14 点 1 个 → 活跃小时数 2
        assert_eq!(compute_active_hours(&cells), 2);
    }

    /// 测试 compute_fragmented_periods
    #[test]
    fn test_compute_fragmented_periods() {
        // 10 点 3 个 MemCell → 碎片化
        let cells = vec![
            MemCell {
                id: "1".to_string(),
                clean_episode_id: "ce-1".to_string(),
                episode: "ep1".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: MemCellMetadata::default(),
                created_at: "2026-06-22T10:00:00.000Z".to_string(),
            },
            MemCell {
                id: "2".to_string(),
                clean_episode_id: "ce-1".to_string(),
                episode: "ep2".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: MemCellMetadata::default(),
                created_at: "2026-06-22T10:30:00.000Z".to_string(),
            },
            MemCell {
                id: "3".to_string(),
                clean_episode_id: "ce-1".to_string(),
                episode: "ep3".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: MemCellMetadata::default(),
                created_at: "2026-06-22T10:45:00.000Z".to_string(),
            },
        ];
        let periods = compute_fragmented_periods(&cells);
        assert_eq!(periods.len(), 1);
        assert_eq!(periods[0].start, "10:00");
        assert_eq!(periods[0].end, "11:00");
    }

    /// 测试 build_fallback_summary 无 MemCell
    #[test]
    fn test_build_fallback_summary_empty() {
        let patterns = DayPattern {
            deep_work_hours: 0.0,
            fragmented_periods: vec![],
            switch_count: 0,
            active_hours: 0.0,
            dominant_activity: String::new(),
        };
        let summary = build_fallback_summary("2026-06-22", &[], &[], &patterns);
        assert!(summary.contains("2026-06-22"));
        assert!(summary.contains("无工作记忆事件"));
    }

    /// 测试 DailyDistillManager 创建
    #[test]
    fn test_daily_distill_manager_new() {
        let manager = DailyDistillManager::new();
        assert!(!manager.is_running());
    }
}
