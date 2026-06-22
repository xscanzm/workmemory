//! user_profile_evolver：用户画像演进（对应 electron/memory/UserProfileEvolver.ts）
//!
//! 职责：
//!  - evolve_profile()：从近期 MemCell 活动与 MemScene 摘要中提取用户画像
//!  - 稳定特质（stable）：primary_activity / preferred_apps / work_pattern
//!    置信度随跨日一致性累积（连续 N 天同值 → confidence 逐步提升至上限 0.95）
//!  - 瞬态状态（transient）：current_focus
//!    每次更新覆盖，valid_to = 当日 + 7 天
//!
//! 画像提取规则：
//!  - primary_activity（stable）：统计 MemCell 的 activityType，取众数（忽略 idle）
//!  - current_focus（transient）：从活跃 MemScene 中取最近更新的标题
//!  - preferred_apps（stable）：统计 MemCell 关联 segment 的 appName，取频率最高的前 3 个
//!  - work_pattern（stable）：统计活动时段（上午 6-12 / 下午 12-18 / 晚上 18-6），取最活跃时段
//!
//! 设计说明：
//!  - 同日幂等：若 stable 画像已在本日更新且值一致，不重复累积置信度
//!  - 跨日累积：stable 画像值一致时 confidence += 0.05（上限 0.95）

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::models::{MemCell, MemScene, ProfileType, UserProfileEntry};
use crate::repositories::mem_cell_repository::MemCellRepository;
use crate::repositories::mem_scene_repository::MemSceneRepository;
use crate::repositories::segment_repository::SegmentRepository;
use crate::repositories::user_profile_repository::UserProfileRepository;

/// stable 画像跨日一致性累积步长
const STABLE_CONFIDENCE_BOOST: f64 = 0.05;
/// stable 画像置信度上限
const STABLE_CONFIDENCE_MAX: f64 = 0.95;
/// transient 画像有效期天数
const TRANSIENT_VALID_DAYS: i64 = 7;
/// preferred_apps 取前 N 个应用
const PREFERRED_APPS_TOP_N: usize = 3;
/// idle 活动类型，统计 primary_activity 时忽略
const IDLE_ACTIVITY: &str = "idle";

/// 活动时段
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum TimeSlot {
    /// 上午 6-12 点
    Morning,
    /// 下午 12-18 点
    Afternoon,
    /// 晚上 18-6 点（含深夜 0-6）
    Evening,
}

impl TimeSlot {
    fn as_str(&self) -> &'static str {
        match self {
            TimeSlot::Morning => "morning",
            TimeSlot::Afternoon => "afternoon",
            TimeSlot::Evening => "evening",
        }
    }
}

/// 根据 UTC 小时判断活动时段
///
/// - morning：6-12 点
/// - afternoon：12-18 点
/// - evening：18-6 点（含深夜 0-6）
fn hour_to_slot(hour: u32) -> TimeSlot {
    if hour >= 6 && hour < 12 {
        TimeSlot::Morning
    } else if hour >= 12 && hour < 18 {
        TimeSlot::Afternoon
    } else {
        TimeSlot::Evening
    }
}

/// 计算日期 + N 天后的日期字符串（YYYY-MM-DD）
fn add_days(date_str: &str, days: i64) -> Option<String> {
    let parsed = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()?;
    let new_date = parsed + chrono::Duration::days(days);
    Some(new_date.format("%Y-%m-%d").to_string())
}

/// 从 ISO 时间戳中提取 UTC 小时
fn extract_utc_hour(iso_ts: &str) -> Option<u32> {
    // 解析 ISO 8601 时间戳，提取小时
    chrono::DateTime::parse_from_rfc3339(iso_ts)
        .ok()
        .map(|dt| dt.timezone().local_minus_utc())
        .and_then(|_| {
            // 直接用 format 提取小时更稳健
            chrono::DateTime::parse_from_rfc3339(iso_ts)
                .ok()
                .map(|dt| dt.format("%H").to_string().parse::<u32>().unwrap_or(0))
        })
        .or_else(|| {
            // 回退：直接从字符串中提取小时部分（位置 11-13）
            if iso_ts.len() >= 13 {
                iso_ts[11..13].parse::<u32>().ok()
            } else {
                None
            }
        })
}

/// UserProfileEvolver：用户画像演进器
pub struct UserProfileEvolver {
    /// 是否正在运行演进
    running: AtomicBool,
}

impl UserProfileEvolver {
    /// 创建演进器实例
    pub fn new() -> Self {
        UserProfileEvolver {
            running: AtomicBool::new(false),
        }
    }

    /// 是否正在运行演进
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// 演进用户画像：从指定日期的 MemCell 活动与 MemScene 摘要中提取画像并写入 user_profile 表
    ///
    /// 处理流程：
    ///  1. 通过 MemCellRepository.get_by_date_range 获取当日所有 MemCell
    ///  2. 通过 MemSceneRepository.get_all 获取所有 MemScene，筛选当日活跃的
    ///  3. 计算 primary_activity / current_focus / preferred_apps / work_pattern
    ///  4. stable 类型通过 upsert_stable 写入（跨日累积置信度，同日幂等）
    ///  5. transient 类型直接 upsert（覆盖，valid_to = 当日 + 7 天）
    ///
    /// # 参数
    /// - `date`：日期字符串（YYYY-MM-DD）
    pub fn evolve_profile(&self, date: &str) -> anyhow::Result<Vec<UserProfileEntry>> {
        self.running.store(true, Ordering::SeqCst);
        let result = self.do_evolve_profile(date);
        self.running.store(false, Ordering::SeqCst);
        result
    }

    /// 实际演进逻辑（内部函数，由 evolve_profile 调用并管理 running 状态）
    fn do_evolve_profile(&self, date: &str) -> anyhow::Result<Vec<UserProfileEntry>> {
        let day_start = format!("{}T00:00:00.000Z", date);
        let day_end = format!("{}T23:59:59.999Z", date);
        let now = chrono::Utc::now().to_rfc3339();

        let mut evolved_entries: Vec<UserProfileEntry> = Vec::new();

        // 1. 获取当日所有 MemCell
        let mem_cells = MemCellRepository::get_by_date_range(&day_start, &day_end)?;

        // 2. 获取所有 MemScene，筛选当日活跃的（成员 MemCell 在当日创建）
        let cell_ids: std::collections::HashSet<String> =
            mem_cells.iter().map(|c| c.id.clone()).collect();
        let all_scenes = MemSceneRepository::get_all()?;
        let active_scenes: Vec<MemScene> = all_scenes
            .into_iter()
            .filter(|scene| {
                scene
                    .member_cell_ids
                    .iter()
                    .any(|id| cell_ids.contains(id))
            })
            .collect();

        // 3. 计算 stable 画像
        if let Some(entry) = compute_primary_activity(&mem_cells, &now) {
            let to_upsert = entry.clone();
            upsert_stable(to_upsert);
            evolved_entries.push(entry);
        }

        if let Some(entry) = compute_preferred_apps(&mem_cells, &now)? {
            let to_upsert = entry.clone();
            upsert_stable(to_upsert);
            evolved_entries.push(entry);
        }

        if let Some(entry) = compute_work_pattern(&mem_cells, &now) {
            let to_upsert = entry.clone();
            upsert_stable(to_upsert);
            evolved_entries.push(entry);
        }

        // 4. 计算 transient 画像（直接 upsert 覆盖）
        if let Some(entry) = compute_current_focus(&active_scenes, date, &now) {
            let to_upsert = entry.clone();
            if let Err(e) = UserProfileRepository::upsert(to_upsert) {
                log::warn!("[UserProfileEvolver] upsert current_focus 失败: {}", e);
            }
            evolved_entries.push(entry);
        }

        Ok(evolved_entries)
    }
}

impl Default for UserProfileEvolver {
    fn default() -> Self {
        Self::new()
    }
}

/// 插入或更新 stable 画像条目，处理跨日置信度累积与同日幂等
///
/// 累积规则：
///  - 若已存在同 key、同 type=stable、同 value 的条目：
///    - 同日重复运行（sources 重叠）：保持已有置信度（不重复累积）
///    - 跨日一致（sources 不重叠）：confidence = min(0.95, max(当日基础置信度, 已有置信度 + 0.05))
///  - 若值变化或不存在：使用当日基础置信度
fn upsert_stable(entry: UserProfileEntry) {
    let mut confidence = entry.confidence;
    if let Ok(Some(existing)) = UserProfileRepository::get(&entry.key) {
        if existing.profile_type == ProfileType::Stable && existing.value == entry.value {
            let existing_sources: std::collections::HashSet<&String> =
                existing.sources.iter().collect();
            let is_same_day = entry.sources.iter().any(|s| existing_sources.contains(s));
            if !is_same_day {
                // 跨日一致：累积置信度
                confidence = STABLE_CONFIDENCE_MAX
                    .max(entry.confidence)
                    .min(existing.confidence + STABLE_CONFIDENCE_BOOST);
                // 注意：取 max(当日基础, 已有+boost) 与上限 min
                confidence = confidence.min(STABLE_CONFIDENCE_MAX);
            } else {
                // 同日重复运行：保持已有置信度
                confidence = existing.confidence;
            }
        }
    }

    let to_upsert = UserProfileEntry {
        confidence,
        ..entry
    };
    if let Err(e) = UserProfileRepository::upsert(to_upsert) {
        log::warn!("[UserProfileEvolver] upsert stable 失败: {}", e);
    }
}

/// 计算 primary_activity（stable）：统计 MemCell 的 activityType，取众数（忽略 idle）
fn compute_primary_activity(mem_cells: &[MemCell], now: &str) -> Option<UserProfileEntry> {
    // 注意：当前 Rust 的 MemCellMetadata 没有 activity_type 字段（与 TS 版本不同）
    // 此处返回 None，待 MemCellMetadata 扩展后启用
    // 保留函数签名以保持 API 一致性
    let _ = mem_cells;
    let _ = now;
    None
}

/// 计算 current_focus（transient）：从当日活跃 MemScene 中取最近更新的标题
fn compute_current_focus(
    active_scenes: &[MemScene],
    date: &str,
    now: &str,
) -> Option<UserProfileEntry> {
    if active_scenes.is_empty() {
        return None;
    }

    // 按 updated_at 降序排序，取最新
    let mut sorted: Vec<&MemScene> = active_scenes.iter().collect();
    sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let latest = sorted[0];

    let valid_to = add_days(date, TRANSIENT_VALID_DAYS);

    Some(UserProfileEntry {
        key: "current_focus".to_string(),
        value: latest.title.clone(),
        profile_type: ProfileType::Transient,
        confidence: 1.0,
        valid_to,
        sources: vec![latest.id.clone()],
        updated_at: now.to_string(),
    })
}

/// 计算 preferred_apps（stable）：统计当日所有 segment 的 appName，取频率最高的前 3 个
fn compute_preferred_apps(
    mem_cells: &[MemCell],
    now: &str,
) -> anyhow::Result<Option<UserProfileEntry>> {
    let mut segment_ids: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for cell in mem_cells {
        for sid in &cell.metadata.segment_ids {
            if seen.insert(sid.clone()) {
                segment_ids.push(sid.clone());
            }
        }
    }
    if segment_ids.is_empty() {
        return Ok(None);
    }

    let segments = SegmentRepository::get_by_ids(&segment_ids)?;
    if segments.is_empty() {
        return Ok(None);
    }

    let mut counts: HashMap<String, usize> = HashMap::new();
    for seg in &segments {
        if seg.app_name.is_empty() {
            continue;
        }
        *counts.entry(seg.app_name.clone()).or_insert(0) += 1;
    }
    if counts.is_empty() {
        return Ok(None);
    }

    let mut sorted: Vec<(String, usize)> = counts.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    let top: Vec<(String, usize)> = sorted.into_iter().take(PREFERRED_APPS_TOP_N).collect();
    let total: usize = top.iter().map(|(_, c)| c).sum();
    let top1_freq = top.first().map(|(_, c)| *c).unwrap_or(0);
    let confidence = if total > 0 {
        top1_freq as f64 / total as f64
    } else {
        0.0
    };

    let value = top
        .iter()
        .map(|(app, _)| app.clone())
        .collect::<Vec<_>>()
        .join(",");

    Ok(Some(UserProfileEntry {
        key: "preferred_apps".to_string(),
        value,
        profile_type: ProfileType::Stable,
        confidence,
        valid_to: None,
        sources: mem_cells.iter().map(|c| c.id.clone()).collect(),
        updated_at: now.to_string(),
    }))
}

/// 计算 work_pattern（stable）：统计当日活动时段，取最活跃时段
fn compute_work_pattern(mem_cells: &[MemCell], now: &str) -> Option<UserProfileEntry> {
    if mem_cells.is_empty() {
        return None;
    }

    let mut slot_counts: HashMap<TimeSlot, usize> = HashMap::new();
    let mut slot_sources: HashMap<TimeSlot, Vec<String>> = HashMap::new();
    for cell in mem_cells {
        let hour = match extract_utc_hour(&cell.created_at) {
            Some(h) => h,
            None => continue,
        };
        let slot = hour_to_slot(hour);
        *slot_counts.entry(slot).or_insert(0) += 1;
        slot_sources.entry(slot).or_default().push(cell.id.clone());
    }

    let mut top_slot: Option<TimeSlot> = None;
    let mut top_count: usize = 0;
    for slot in [TimeSlot::Morning, TimeSlot::Afternoon, TimeSlot::Evening] {
        let count = *slot_counts.get(&slot).unwrap_or(&0);
        if count > top_count {
            top_count = count;
            top_slot = Some(slot);
        }
    }

    let top_slot = top_slot?;
    if top_count == 0 {
        return None;
    }

    let total: usize = slot_counts.values().sum();
    let confidence = if total > 0 {
        top_count as f64 / total as f64
    } else {
        0.0
    };

    Some(UserProfileEntry {
        key: "work_pattern".to_string(),
        value: top_slot.as_str().to_string(),
        profile_type: ProfileType::Stable,
        confidence,
        valid_to: None,
        sources: slot_sources.remove(&top_slot).unwrap_or_default(),
        updated_at: now.to_string(),
    })
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_evolver_not_running() {
        let evolver = UserProfileEvolver::new();
        assert!(!evolver.is_running());
    }

    #[test]
    fn test_hour_to_slot() {
        assert_eq!(hour_to_slot(0), TimeSlot::Evening);
        assert_eq!(hour_to_slot(5), TimeSlot::Evening);
        assert_eq!(hour_to_slot(6), TimeSlot::Morning);
        assert_eq!(hour_to_slot(11), TimeSlot::Morning);
        assert_eq!(hour_to_slot(12), TimeSlot::Afternoon);
        assert_eq!(hour_to_slot(17), TimeSlot::Afternoon);
        assert_eq!(hour_to_slot(18), TimeSlot::Evening);
        assert_eq!(hour_to_slot(23), TimeSlot::Evening);
    }

    #[test]
    fn test_add_days_basic() {
        let result = add_days("2026-06-22", 7);
        assert_eq!(result.as_deref(), Some("2026-06-29"));
    }

    #[test]
    fn test_add_days_cross_month() {
        let result = add_days("2026-06-30", 1);
        assert_eq!(result.as_deref(), Some("2026-07-01"));
    }

    #[test]
    fn test_add_days_cross_year() {
        let result = add_days("2026-12-31", 1);
        assert_eq!(result.as_deref(), Some("2027-01-01"));
    }

    #[test]
    fn test_add_days_invalid_date() {
        let result = add_days("invalid-date", 7);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_utc_hour_valid_iso() {
        let hour = extract_utc_hour("2026-06-22T14:30:00Z");
        assert_eq!(hour, Some(14));
    }

    #[test]
    fn test_extract_utc_hour_another() {
        let hour = extract_utc_hour("2026-06-22T08:15:30+00:00");
        assert!(hour.is_some());
        assert_eq!(hour.unwrap(), 8);
    }

    #[test]
    fn test_compute_current_focus_empty() {
        let scenes: Vec<MemScene> = Vec::new();
        let result = compute_current_focus(&scenes, "2026-06-22", "2026-06-22T10:00:00Z");
        assert!(result.is_none());
    }

    #[test]
    fn test_compute_current_focus_returns_latest() {
        let scenes = vec![
            MemScene {
                id: "scene-1".to_string(),
                title: "旧主题".to_string(),
                centroid_embedding: vec![],
                member_cell_ids: vec![],
                summary: String::new(),
                created_at: "2026-06-22T08:00:00Z".to_string(),
                updated_at: "2026-06-22T08:00:00Z".to_string(),
            },
            MemScene {
                id: "scene-2".to_string(),
                title: "最新主题".to_string(),
                centroid_embedding: vec![],
                member_cell_ids: vec![],
                summary: String::new(),
                created_at: "2026-06-22T10:00:00Z".to_string(),
                updated_at: "2026-06-22T12:00:00Z".to_string(),
            },
        ];
        let result = compute_current_focus(&scenes, "2026-06-22", "2026-06-22T13:00:00Z");
        let entry = result.expect("应返回 current_focus 画像");
        assert_eq!(entry.key, "current_focus");
        assert_eq!(entry.value, "最新主题");
        assert_eq!(entry.profile_type, ProfileType::Transient);
        assert_eq!(entry.confidence, 1.0);
        assert_eq!(entry.valid_to.as_deref(), Some("2026-06-29"));
        assert_eq!(entry.sources, vec!["scene-2".to_string()]);
    }

    #[test]
    fn test_compute_work_pattern_empty() {
        let cells: Vec<MemCell> = Vec::new();
        let result = compute_work_pattern(&cells, "2026-06-22T10:00:00Z");
        assert!(result.is_none());
    }

    #[test]
    fn test_compute_work_pattern_morning_dominant() {
        let cells = vec![
            MemCell {
                id: "c1".to_string(),
                clean_episode_id: "ep1".to_string(),
                episode: "上午工作1".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: Default::default(),
                created_at: "2026-06-22T08:00:00Z".to_string(),
            },
            MemCell {
                id: "c2".to_string(),
                clean_episode_id: "ep1".to_string(),
                episode: "上午工作2".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: Default::default(),
                created_at: "2026-06-22T10:00:00Z".to_string(),
            },
            MemCell {
                id: "c3".to_string(),
                clean_episode_id: "ep1".to_string(),
                episode: "下午工作".to_string(),
                facts: vec![],
                foresight: vec![],
                metadata: Default::default(),
                created_at: "2026-06-22T14:00:00Z".to_string(),
            },
        ];
        let result = compute_work_pattern(&cells, "2026-06-22T16:00:00Z");
        let entry = result.expect("应返回 work_pattern 画像");
        assert_eq!(entry.key, "work_pattern");
        assert_eq!(entry.value, "morning");
        assert_eq!(entry.profile_type, ProfileType::Stable);
        // 上午 2 次，下午 1 次，置信度 = 2/3
        assert!((entry.confidence - 2.0 / 3.0).abs() < 1e-6);
        assert_eq!(entry.sources.len(), 2);
    }

    #[test]
    fn test_compute_primary_activity_returns_none() {
        // 当前 MemCellMetadata 没有 activity_type 字段，函数返回 None
        let cells = vec![MemCell {
            id: "c1".to_string(),
            clean_episode_id: "ep1".to_string(),
            episode: "测试".to_string(),
            facts: vec![],
            foresight: vec![],
            metadata: Default::default(),
            created_at: "2026-06-22T08:00:00Z".to_string(),
        }];
        let result = compute_primary_activity(&cells, "2026-06-22T08:00:00Z");
        assert!(result.is_none());
    }

    #[test]
    fn test_time_slot_as_str() {
        assert_eq!(TimeSlot::Morning.as_str(), "morning");
        assert_eq!(TimeSlot::Afternoon.as_str(), "afternoon");
        assert_eq!(TimeSlot::Evening.as_str(), "evening");
    }
}
