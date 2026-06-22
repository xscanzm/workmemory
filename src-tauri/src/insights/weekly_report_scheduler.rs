//! WeeklyReportScheduler：周报调度器（F8.10）
//!
//! 功能：
//!  - 默认每周五 17:30 触发，推送 Mascot 气泡"本周报告已就绪，点击查看"
//!  - set_schedule(day, hour, minute)：自定义触发时间
//!  - set_export_format(format)：设置导出格式（Markdown/Clipboard/Json）
//!  - 使用 tokio::time 进行周期检查
//!  - 通过 EventBus 发布提醒事件

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::events::bus::{AppEvent, EventBus};

/// 导出格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    /// Markdown 文件
    Markdown,
    /// 复制到剪贴板
    Clipboard,
    /// JSON 文件
    Json,
}

impl Default for ExportFormat {
    fn default() -> Self {
        ExportFormat::Markdown
    }
}

/// 调度配置
#[derive(Debug, Clone)]
pub struct ScheduleConfig {
    /// 触发星期（0=周日, 1=周一, ..., 5=周五, 6=周六）
    pub day: u32,
    /// 触发小时（0-23）
    pub hour: u32,
    /// 触发分钟（0-59）
    pub minute: u32,
    /// 检查间隔（秒，默认 60 秒）
    pub check_interval_sec: u64,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        // 默认周五 17:30
        ScheduleConfig {
            day: 5,
            hour: 17,
            minute: 30,
            check_interval_sec: 60,
        }
    }
}

/// WeeklyReportScheduler：周报调度器
pub struct WeeklyReportScheduler {
    /// 调度配置
    config: Arc<Mutex<ScheduleConfig>>,
    /// 导出格式
    export_format: Arc<Mutex<ExportFormat>>,
    /// 后台任务句柄
    task_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    /// 停止信号
    stop_notify: Arc<Notify>,
    /// 已启动标记
    running: Arc<Mutex<bool>>,
    /// 上次触发时间戳（防重复，Unix 毫秒）
    last_fired_ms: Arc<Mutex<i64>>,
}

impl WeeklyReportScheduler {
    /// 创建实例（默认周五 17:30）
    pub fn new() -> Self {
        WeeklyReportScheduler {
            config: Arc::new(Mutex::new(ScheduleConfig::default())),
            export_format: Arc::new(Mutex::new(ExportFormat::default())),
            task_handle: Arc::new(Mutex::new(None)),
            stop_notify: Arc::new(Notify::new()),
            running: Arc::new(Mutex::new(false)),
            last_fired_ms: Arc::new(Mutex::new(0)),
        }
    }

    /// 启动调度器。
    ///
    /// 启动一个 tokio 任务，按 check_interval_sec 间隔检查：
    ///  - 当前星期/小时/分钟匹配配置 → 触发周报就绪提醒
    ///  - 同一分钟内只触发一次（防重复）
    pub fn start(&self) -> anyhow::Result<()> {
        let mut running = self.running.lock().unwrap();
        if *running {
            return Ok(());
        }
        *running = true;

        let config = Arc::clone(&self.config);
        let export_format = Arc::clone(&self.export_format);
        let stop_notify = Arc::clone(&self.stop_notify);
        let running_clone = Arc::clone(&self.running);
        let last_fired_ms = Arc::clone(&self.last_fired_ms);

        let handle = tokio::spawn(async move {
            loop {
                // 计算下次检查等待时间
                let wait_dur = {
                    let cfg = config.lock().unwrap();
                    std::time::Duration::from_secs(cfg.check_interval_sec.max(1))
                };

                tokio::select! {
                    _ = stop_notify.notified() => {
                        break;
                    }
                    _ = tokio::time::sleep(wait_dur) => {}
                }

                if !*running_clone.lock().unwrap() {
                    break;
                }

                // 检查是否匹配调度时间
                let now = chrono::Local::now();
                let cfg = config.lock().unwrap();
                let day_matches = now.weekday().num_days_from_sunday() == cfg.day;
                let time_matches = now.hour() == cfg.hour && now.minute() == cfg.minute;
                drop(cfg);

                if day_matches && time_matches {
                    // 防重复：同一分钟内只触发一次
                    let now_ms = now.timestamp_millis();
                    let mut last = last_fired_ms.lock().unwrap();
                    // 60 秒内不重复触发
                    if now_ms - *last < 60_000 {
                        continue;
                    }
                    *last = now_ms;
                    drop(last);

                    let format = *export_format.lock().unwrap();
                    Self::fire_reminder(format);
                }
            }
        });

        *self.task_handle.lock().unwrap() = Some(handle);
        Ok(())
    }

    /// 停止调度器
    pub fn stop(&self) {
        {
            let mut running = self.running.lock().unwrap();
            *running = false;
        }
        self.stop_notify.notify_waiters();
        if let Some(handle) = self.task_handle.lock().unwrap().take() {
            handle.abort();
        }
    }

    /// 设置调度时间
    ///
    /// # 参数
    /// - `day`：星期（0=周日, 1=周一, ..., 5=周五, 6=周六）
    /// - `hour`：小时（0-23）
    /// - `minute`：分钟（0-59）
    pub fn set_schedule(&self, day: u32, hour: u32, minute: u32) {
        let mut cfg = self.config.lock().unwrap();
        cfg.day = day.min(6);
        cfg.hour = hour.min(23);
        cfg.minute = minute.min(59);
    }

    /// 设置导出格式
    pub fn set_export_format(&self, format: ExportFormat) {
        let mut fmt = self.export_format.lock().unwrap();
        *fmt = format;
    }

    /// 获取当前是否运行中
    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }

    /// 获取当前调度配置
    pub fn get_config(&self) -> ScheduleConfig {
        self.config.lock().unwrap().clone()
    }

    /// 获取当前导出格式
    pub fn get_export_format(&self) -> ExportFormat {
        *self.export_format.lock().unwrap()
    }

    /// 触发周报就绪提醒（公开供测试调用）
    pub fn fire_reminder(format: ExportFormat) {
        // 通过 EventBus 发布提醒（复用 StateChange 携带提醒信息）
        let payload = format!(
            "weekly_report_ready:{}:{}",
            match format {
                ExportFormat::Markdown => "markdown",
                ExportFormat::Clipboard => "clipboard",
                ExportFormat::Json => "json",
            },
            "本周报告已就绪，点击查看"
        );
        EventBus::publish(AppEvent::StateChange { state: payload });
    }

    /// 生成提醒消息文本
    pub fn reminder_message() -> &'static str {
        "本周报告已就绪，点击查看"
    }
}

impl Default for WeeklyReportScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for WeeklyReportScheduler {
    fn drop(&mut self) {
        self.stop();
    }
}

// 引入 chrono::Datelike / Timelike trait
use chrono::{Datelike, Timelike};

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::Duration;

    #[test]
    fn test_default_config_friday_17_30() {
        let scheduler = WeeklyReportScheduler::new();
        let cfg = scheduler.get_config();
        assert_eq!(cfg.day, 5); // 周五
        assert_eq!(cfg.hour, 17);
        assert_eq!(cfg.minute, 30);
    }

    #[test]
    fn test_default_export_format_markdown() {
        let scheduler = WeeklyReportScheduler::new();
        assert_eq!(scheduler.get_export_format(), ExportFormat::Markdown);
    }

    #[test]
    fn test_set_schedule() {
        let scheduler = WeeklyReportScheduler::new();
        scheduler.set_schedule(1, 9, 0); // 周一 09:00
        let cfg = scheduler.get_config();
        assert_eq!(cfg.day, 1);
        assert_eq!(cfg.hour, 9);
        assert_eq!(cfg.minute, 0);
    }

    #[test]
    fn test_set_schedule_clamps_invalid_values() {
        let scheduler = WeeklyReportScheduler::new();
        scheduler.set_schedule(99, 25, 70);
        let cfg = scheduler.get_config();
        assert_eq!(cfg.day, 6); // 被限制到 6
        assert_eq!(cfg.hour, 23); // 被限制到 23
        assert_eq!(cfg.minute, 59); // 被限制到 59
    }

    #[test]
    fn test_set_export_format() {
        let scheduler = WeeklyReportScheduler::new();
        scheduler.set_export_format(ExportFormat::Clipboard);
        assert_eq!(scheduler.get_export_format(), ExportFormat::Clipboard);

        scheduler.set_export_format(ExportFormat::Json);
        assert_eq!(scheduler.get_export_format(), ExportFormat::Json);
    }

    #[test]
    fn test_reminder_message() {
        assert_eq!(WeeklyReportScheduler::reminder_message(), "本周报告已就绪，点击查看");
    }

    #[tokio::test]
    async fn test_start_stop_lifecycle() {
        let scheduler = WeeklyReportScheduler::new();
        assert!(!scheduler.is_running());
        scheduler.start().unwrap();
        assert!(scheduler.is_running());
        tokio::time::sleep(Duration::from_millis(100)).await;
        scheduler.stop();
        assert!(!scheduler.is_running());
    }

    #[tokio::test]
    async fn test_fire_reminder_publishes_event() {
        // 订阅事件
        let mut rx = EventBus::subscribe();
        // 触发提醒
        WeeklyReportScheduler::fire_reminder(ExportFormat::Markdown);
        // 验证收到事件
        let event = tokio::time::timeout(Duration::from_millis(500), rx.recv())
            .await
            .expect("超时")
            .expect("接收失败");
        match event {
            AppEvent::StateChange { state } => {
                assert!(state.starts_with("weekly_report_ready:"));
                assert!(state.contains("本周报告已就绪"));
            }
            _ => panic!("期望 StateChange 事件"),
        }
    }

    #[test]
    fn test_export_format_serialization() {
        let json = serde_json::to_string(&ExportFormat::Clipboard).unwrap();
        assert!(json.contains("clipboard"));
        let parsed: ExportFormat = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, ExportFormat::Clipboard);
    }
}
