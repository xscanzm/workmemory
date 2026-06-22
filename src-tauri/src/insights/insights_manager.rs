//! InsightsManager：洞察编排层（对应 electron/insights/InsightsManager.ts）
//!
//! 整合 AnomalyDetector + ReminderScheduler + TimeAuditEngine。
//!
//! 职责：
//!  - initialize()：启动 ReminderScheduler
//!  - get_status()：返回当前运行状态
//!  - stop()：停止所有子模块

use std::sync::{Arc, Mutex};

use once_cell::sync::Lazy;

use crate::insights::anomaly_detector::AnomalyDetector;
use crate::insights::reminder_scheduler::ReminderScheduler;
use crate::insights::time_audit_engine::TimeAuditEngine;

/// Insights 运行状态
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsightsStatus {
    /// 是否运行中
    pub running: bool,
    /// 最近一次审计日期（YYYY-MM-DD），None 表示尚未审计
    pub last_audit: Option<String>,
}

/// InsightsManager：洞察编排层。
pub struct InsightsManager {
    anomaly_detector: AnomalyDetector,
    reminder_scheduler: Arc<ReminderScheduler>,
    audit_engine: TimeAuditEngine,
    /// 运行状态（线程安全）
    status: Arc<Mutex<InsightsStatus>>,
}

impl InsightsManager {
    /// 创建实例
    pub fn new() -> Self {
        InsightsManager {
            anomaly_detector: AnomalyDetector::new(),
            reminder_scheduler: Arc::new(ReminderScheduler::new()),
            audit_engine: TimeAuditEngine::new(),
            status: Arc::new(Mutex::new(InsightsStatus {
                running: false,
                last_audit: None,
            })),
        }
    }

    /// 初始化：启动 ReminderScheduler。
    ///
    /// 在 app ready 后调用。重复调用是幂等的。
    pub fn initialize(&self) -> anyhow::Result<()> {
        let mut status = self.status.lock().unwrap();
        if status.running {
            return Ok(());
        }
        self.reminder_scheduler.start()?;
        status.running = true;
        Ok(())
    }

    /// 获取当前运行状态
    pub fn get_status(&self) -> InsightsStatus {
        self.status.lock().unwrap().clone()
    }

    /// 停止管理器（停止 ReminderScheduler）。
    pub fn stop(&self) {
        self.reminder_scheduler.stop();
        let mut status = self.status.lock().unwrap();
        status.running = false;
    }

    /// 检测指定日期的异常（转发 AnomalyDetector）
    pub fn detect_anomalies(&self, date: &str) -> Vec<crate::insights::anomaly_detector::Anomaly> {
        self.anomaly_detector.detect_anomalies(date)
    }

    /// 审计指定日期的时间使用（转发 TimeAuditEngine）
    pub fn audit_day(&self, date: &str) -> anyhow::Result<crate::insights::time_audit_engine::TimeAudit> {
        let audit = self.audit_engine.audit_day(date)?;
        // 更新 last_audit
        let mut status = self.status.lock().unwrap();
        status.last_audit = Some(date.to_string());
        Ok(audit)
    }

    /// 调度一次性提醒（转发 ReminderScheduler）
    pub fn schedule_reminder(&self, time: &str, message: &str) -> anyhow::Result<()> {
        self.reminder_scheduler.schedule_reminder(time, message)
    }

    /// 获取 ReminderScheduler 引用（供外部监听事件或推送洞察）
    pub fn reminder_scheduler(&self) -> Arc<ReminderScheduler> {
        Arc::clone(&self.reminder_scheduler)
    }
}

impl Default for InsightsManager {
    fn default() -> Self {
        Self::new()
    }
}

// ===================== 单例 =====================

/// InsightsManager 全局单例
static INSIGHTS_MANAGER: Lazy<Mutex<InsightsManager>> =
    Lazy::new(|| Mutex::new(InsightsManager::new()));

/// 获取 InsightsManager 单例（Mutex 守卫）
pub fn get_insights_manager() -> &'static Mutex<InsightsManager> {
    &INSIGHTS_MANAGER
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_new_manager_not_running() {
        let manager = InsightsManager::new();
        let status = manager.get_status();
        assert!(!status.running);
        assert!(status.last_audit.is_none());
    }

    #[tokio::test]
    async fn test_initialize_sets_running() {
        let manager = InsightsManager::new();
        manager.initialize().unwrap();
        let status = manager.get_status();
        assert!(status.running);
        manager.stop();
        let status = manager.get_status();
        assert!(!status.running);
    }

    #[tokio::test]
    async fn test_initialize_is_idempotent() {
        let manager = InsightsManager::new();
        manager.initialize().unwrap();
        // 第二次调用不应报错且仍为 running
        manager.initialize().unwrap();
        assert!(manager.get_status().running);
        manager.stop();
    }

    #[tokio::test]
    async fn test_stop_clears_running() {
        let manager = InsightsManager::new();
        manager.initialize().unwrap();
        assert!(manager.get_status().running);
        manager.stop();
        assert!(!manager.get_status().running);
    }

    #[test]
    fn test_schedule_reminder_delegates_to_scheduler() {
        let manager = InsightsManager::new();
        let scheduler = manager.reminder_scheduler();
        assert_eq!(scheduler.pending_reminder_count(), 0);
        manager.schedule_reminder("18:30", "下班复盘").unwrap();
        assert_eq!(scheduler.pending_reminder_count(), 1);
    }

    #[test]
    fn test_insights_status_equality() {
        let s1 = InsightsStatus {
            running: false,
            last_audit: None,
        };
        let s2 = InsightsStatus {
            running: false,
            last_audit: None,
        };
        assert_eq!(s1, s2);
        let s3 = InsightsStatus {
            running: true,
            last_audit: Some("2026-06-22".to_string()),
        };
        assert_ne!(s1, s3);
    }
}
