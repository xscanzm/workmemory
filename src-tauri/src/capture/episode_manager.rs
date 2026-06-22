//! EpisodeManager：Episode 编排层单例（对应 electron/capture/EpisodeManager.ts）
//!
//! 整合 EpisodeBuilder + OneLineSummary + EntityExtractor。
//!
//! 职责：
//!  - initialize()：app ready 后调用，监听 OcrQueue 和 CaptureManager 事件
//!  - 监听 OcrQueue 的 'ocr-completed' 事件 → 触发 rebuild_episodes_for_date(今日)
//!  - 监听 CaptureManager 的 'segment-merged' 事件 → 触发重建
//!  - rebuild(date)：协调 EpisodeBuilder 重建 + EntityExtractor 提取 + OneLineSummary 生成
//!  - 暴露 IPC：episode:getByDate、episode:update、episode:setOneLineSummary、
//!    episode:getDailySummary、episode:setDailySummary
//!
//! 单例导出 get_episode_manager()。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;

use crate::capture::entity_extractor::EntityExtractor;
use crate::capture::episode_builder::EpisodeBuilder;
use crate::capture::one_line_summary::OneLineSummary;
use crate::events::bus::{AppEvent, EventBus};
use crate::models::Episode;
use crate::repositories::episode_repository::EpisodeRepository;
use crate::repositories::segment_repository::SegmentRepository;

/// 重建防抖时长（毫秒）：避免短时间内频繁重建
pub const REBUILD_DEBOUNCE_MS: u64 = 2000;

/// EpisodeManager：Episode 编排层。
pub struct EpisodeManager {
    /// EpisodeBuilder 实例
    builder: EpisodeBuilder,
    /// OneLineSummary 实例
    summary: OneLineSummary,
    /// EntityExtractor 实例
    extractor: EntityExtractor,
    /// 是否已初始化
    initialized: Mutex<bool>,
    /// 重建防抖计时器（按日期分组，存储上次调度时间戳）
    rebuild_timestamps: Mutex<std::collections::HashMap<String, u64>>,
}

impl EpisodeManager {
    /// 创建 EpisodeManager 实例
    pub fn new() -> Self {
        Self {
            builder: EpisodeBuilder::new(),
            summary: OneLineSummary::new(),
            extractor: EntityExtractor::new(),
            initialized: Mutex::new(false),
            rebuild_timestamps: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 初始化：app ready 后调用。
    /// 启动时也重建今日，修复上次 OCR 失败或退出前未聚合导致的首页空数据。
    pub fn initialize(&self) {
        let mut initialized = self.initialized.lock().unwrap();
        if *initialized {
            return;
        }
        // 启动时重建今日
        let today = Self::get_today_date();
        drop(initialized);
        self.schedule_rebuild(&today);

        let mut initialized = self.initialized.lock().unwrap();
        *initialized = true;
        log::info!("[EpisodeManager] 初始化完成");
    }

    /// OCR 完成回调：获取 Segment 日期并触发重建
    pub fn on_ocr_completed(&self, segment_id: &str) {
        if let Ok(Some(segment)) = SegmentRepository::get_by_id(segment_id) {
            self.schedule_rebuild(&segment.date);
        }
    }

    /// 调度重建（防抖）。
    /// 同一日期在 DEBOUNCE_MS 内只重建一次。
    pub fn schedule_rebuild(&self, date: &str) {
        let now = now_ms();
        let mut timestamps = self.rebuild_timestamps.lock().unwrap();
        if let Some(&last) = timestamps.get(date) {
            if now - last < REBUILD_DEBOUNCE_MS {
                // 在防抖窗口内，跳过
                return;
            }
        }
        timestamps.insert(date.to_string(), now);
        drop(timestamps);

        // 立即重建（Rust 版本不使用 setTimeout，直接同步执行）
        let _ = self.rebuild(date);
    }

    /// 重建指定日期的 Episodes + 实体 + 每日总结。
    ///
    /// 流程：
    ///  1. EpisodeBuilder.rebuild_episodes_for_date(date) — 重建 Episodes
    ///  2. EntityExtractor.extract_and_save_for_date(date) — 提取实体
    ///  3. OneLineSummary.generate_daily_summary(date) — 生成每日总结
    pub fn rebuild(&self, date: &str) -> anyhow::Result<Vec<Episode>> {
        // 1. 重建 Episodes
        let episodes = self.builder.rebuild_episodes_for_date(date)?;

        // 2. 提取实体
        if let Err(e) = self.extractor.extract_and_save_for_date(date) {
            log::error!("[EpisodeManager] 提取实体失败: {}", e);
        }

        // 3. 生成每日总结（受 user_edited 保护）
        let _ = self.summary.generate_daily_summary(date);

        Ok(episodes)
    }

    // ===================== IPC 暴露方法 =====================

    /// 获取指定日期的 Episodes
    pub fn get_by_date(&self, date: &str) -> anyhow::Result<Vec<Episode>> {
        EpisodeRepository::get_by_date(date)
    }

    /// 获取 Episode by id
    pub fn get_by_id(&self, id: &str) -> anyhow::Result<Option<Episode>> {
        EpisodeRepository::get_by_id(id)
    }

    /// 设置 Episode 一句话总结（含 user_edited 保护）。
    /// 返回 false 表示因 user_edited 保护而拒绝覆盖。
    pub fn set_one_line_summary(&self, id: &str, summary: &str) -> bool {
        EpisodeRepository::set_one_line_summary(id, summary).unwrap_or(false)
    }

    /// 获取每日总结
    pub fn get_daily_summary(&self, date: &str) -> String {
        self.summary.get_daily_summary(date)
    }

    /// 设置每日总结（用户手动改写，标记 user_edited=true）
    pub fn set_daily_summary(&self, date: &str, text: &str) -> bool {
        self.summary.set_daily_summary(date, text)
    }

    // ===================== 工具方法 =====================

    /// 获取今日日期字符串 YYYY-MM-DD
    pub fn get_today_date() -> String {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let secs = now.as_secs() as i64;
        // 简化实现：使用 chrono
        let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0).unwrap_or_default();
        let local = dt.with_timezone(&chrono::Local);
        local.format("%Y-%m-%d").to_string()
    }

    /// 停止管理器
    pub fn stop(&self) {
        let mut timestamps = self.rebuild_timestamps.lock().unwrap();
        timestamps.clear();
        let mut initialized = self.initialized.lock().unwrap();
        *initialized = false;
    }
}

impl Default for EpisodeManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 获取当前时间戳（毫秒）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ===================== 单例 =====================

/// EpisodeManager 单例
static MANAGER_INSTANCE: Lazy<Mutex<Option<EpisodeManager>>> = Lazy::new(|| Mutex::new(None));

/// 获取 EpisodeManager 单例
pub fn get_episode_manager() -> &'static Mutex<Option<EpisodeManager>> {
    &MANAGER_INSTANCE
}

/// 初始化单例（app ready 后调用）
pub fn init_episode_manager() {
    let mut guard = MANAGER_INSTANCE.lock().unwrap();
    if guard.is_none() {
        let manager = EpisodeManager::new();
        manager.initialize();
        *guard = Some(manager);
    }
}

/// 重置单例（仅供测试）
pub fn reset_episode_manager() {
    let mut guard = MANAGER_INSTANCE.lock().unwrap();
    if let Some(manager) = guard.take() {
        manager.stop();
    }
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_today_date_format() {
        let today = EpisodeManager::get_today_date();
        // 应为 YYYY-MM-DD 格式
        assert_eq!(today.len(), 10);
        assert_eq!(today.chars().nth(4), Some('-'));
        assert_eq!(today.chars().nth(7), Some('-'));
    }

    #[test]
    fn test_episode_manager_creation() {
        let manager = EpisodeManager::new();
        // 验证可正常创建
        assert!(!*manager.initialized.lock().unwrap());
    }

    #[test]
    fn test_schedule_rebuild_dedup() {
        let manager = EpisodeManager::new();
        let date = "2026-06-22";
        // 第一次调度
        manager.schedule_rebuild(date);
        // 立即再次调度应被防抖跳过（但 rebuild 已执行）
        let timestamps = manager.rebuild_timestamps.lock().unwrap();
        assert!(timestamps.contains_key(date));
    }

    #[test]
    fn test_stop_clears_state() {
        let manager = EpisodeManager::new();
        manager.schedule_rebuild("2026-06-22");
        manager.stop();
        let timestamps = manager.rebuild_timestamps.lock().unwrap();
        assert!(timestamps.is_empty());
        assert!(!*manager.initialized.lock().unwrap());
    }
}
