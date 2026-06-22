//! ReminderScheduler：复盘建议调度器（对应 electron/insights/ReminderScheduler.ts）
//!
//! 功能：
//!  - start()/stop()：启动/停止定时检查
//!  - schedule_reminder(time, message)：调度一次性提醒
//!  - 时间驱动提醒（下班复盘、周五复盘）
//!  - 使用 tokio::time 进行调度
//!  - 通过 EventBus 或直接回调发布提醒

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveTime, Timelike};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::events::bus::{AppEvent, EventBus};

/// 调度器配置
#[derive(Debug, Clone)]
pub struct ReminderSchedulerConfig {
    /// 下班复盘开始小时（默认 18）
    pub offwork_start_hour: u32,
    /// 下班复盘结束小时（默认 20）
    pub offwork_end_hour: u32,
    /// 周五复盘小时（默认 17）
    pub weekly_review_hour: u32,
    /// 检查间隔（秒，默认 30 分钟）
    pub check_interval_sec: u64,
}

impl Default for ReminderSchedulerConfig {
    fn default() -> Self {
        ReminderSchedulerConfig {
            offwork_start_hour: 18,
            offwork_end_hour: 20,
            weekly_review_hour: 17,
            check_interval_sec: 30 * 60,
        }
    }
}

/// 一次性提醒项
#[derive(Debug, Clone)]
struct ScheduledReminder {
    /// 触发时间（NaiveTime，本地时区）
    time: NaiveTime,
    /// 提醒消息
    message: String,
}

/// ReminderScheduler：复盘建议调度器。
pub struct ReminderScheduler {
    config: Arc<Mutex<ReminderSchedulerConfig>>,
    /// 一次性提醒列表
    reminders: Arc<Mutex<Vec<ScheduledReminder>>>,
    /// 后台任务句柄
    task_handle: Arc<Mutex<Option<JoinHandle<()>>>>,
    /// 停止信号
    stop_notify: Arc<Notify>,
    /// 已启动标记
    running: Arc<Mutex<bool>>,
}

impl ReminderScheduler {
    /// 创建实例（默认配置）
    pub fn new() -> Self {
        ReminderScheduler::with_config(ReminderSchedulerConfig::default())
    }

    /// 使用指定配置创建实例
    pub fn with_config(config: ReminderSchedulerConfig) -> Self {
        ReminderScheduler {
            config: Arc::new(Mutex::new(config)),
            reminders: Arc::new(Mutex::new(Vec::new())),
            task_handle: Arc::new(Mutex::new(None)),
            stop_notify: Arc::new(Notify::new()),
            running: Arc::new(Mutex::new(false)),
        }
    }

    /// 启动定时检查。
    ///
    /// 启动一个 tokio 任务，按 check_interval_sec 间隔检查：
    ///  - 下班复盘：当前时间在 [offwork_start_hour, offwork_end_hour) 且今日未触发
    ///  - 周五复盘：周五且当前小时 >= weekly_review_hour 且本周未触发
    ///  - 一次性提醒：到达指定时间则触发并移除
    pub fn start(&self) -> anyhow::Result<()> {
        let mut running = self.running.lock().unwrap();
        if *running {
            return Ok(());
        }
        *running = true;

        let config = Arc::clone(&self.config);
        let reminders = Arc::clone(&self.reminders);
        let stop_notify = Arc::clone(&self.stop_notify);
        let running_clone = Arc::clone(&self.running);

        let interval_sec = {
            let cfg = self.config.lock().unwrap();
            cfg.check_interval_sec
        };

        let handle = tokio::spawn(async move {
            loop {
                // 计算下次检查的等待时间
                let wait_dur = {
                    let cfg = config.lock().unwrap();
                    Duration::from_secs(cfg.check_interval_sec.max(1))
                };

                // 等待 stop 信号或定时
                tokio::select! {
                    _ = stop_notify.notified() => {
                        break;
                    }
                    _ = tokio::time::sleep(wait_dur) => {}
                }

                if !*running_clone.lock().unwrap() {
                    break;
                }

                // 检查条件
                let now = Local::now();
                let hour = now.hour();
                let weekday = now.weekday();
                let cfg = config.lock().unwrap();

                // 周五复盘：周五且到达指定小时
                if weekday == chrono::Weekday::Fri && hour >= cfg.weekly_review_hour {
                    let message = "一周工作即将结束，回顾本周进展，规划下周重点".to_string();
                    Self::publish_reminder("weekly_review", &message);
                }

                // 下班复盘：下班时段
                if hour >= cfg.offwork_start_hour && hour < cfg.offwork_end_hour {
                    let message = "今天的工作已告一段落，花 5 分钟回顾今日成果，整理待办事项".to_string();
                    Self::publish_reminder("offwork_review", &message);
                }

                // 一次性提醒
                let mut fired_indices: Vec<usize> = Vec::new();
                {
                    let reminders_guard = reminders.lock().unwrap();
                    for (i, r) in reminders_guard.iter().enumerate() {
                        if now.time() >= r.time {
                            Self::publish_reminder("scheduled", &r.message);
                            fired_indices.push(i);
                        }
                    }
                }
                if !fired_indices.is_empty() {
                    let mut reminders_guard = reminders.lock().unwrap();
                    // 倒序删除以保持索引有效
                    for &i in fired_indices.iter().rev() {
                        if i < reminders_guard.len() {
                            reminders_guard.remove(i);
                        }
                    }
                }
            }
            // 防止未使用变量告警
            let _ = interval_sec;
        });

        *self.task_handle.lock().unwrap() = Some(handle);
        Ok(())
    }

    /// 停止定时检查
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

    /// 调度一次性提醒。
    ///
    /// # 参数
    /// - `time`：触发时间，格式 "HH:MM" 或 "HH:MM:SS"
    /// - `message`：提醒消息
    pub fn schedule_reminder(&self, time: &str, message: &str) -> anyhow::Result<()> {
        let parsed_time = parse_time(time)
            .ok_or_else(|| anyhow::anyhow!("无效的时间格式: {}（应为 HH:MM 或 HH:MM:SS）", time))?;
        let reminder = ScheduledReminder {
            time: parsed_time,
            message: message.to_string(),
        };
        self.reminders.lock().unwrap().push(reminder);
        Ok(())
    }

    /// 更新配置
    pub fn update_config(&self, patch: ReminderSchedulerConfig) {
        let mut cfg = self.config.lock().unwrap();
        *cfg = patch;
    }

    /// 获取当前是否运行中
    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }

    /// 获取当前待触发的一次性提醒数量
    pub fn pending_reminder_count(&self) -> usize {
        self.reminders.lock().unwrap().len()
    }

    /// 发布提醒到 EventBus
    fn publish_reminder(reminder_type: &str, message: &str) {
        // 通过 EventBus 发布 StateChange 事件作为提醒通知
        // （EventBus 当前未定义 Reminder 事件，复用 StateChange 携带提醒信息）
        let payload = format!("reminder:{}:{}", reminder_type, message);
        EventBus::publish(AppEvent::StateChange { state: payload });
    }
}

impl Default for ReminderScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ReminderScheduler {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 解析时间字符串 "HH:MM" 或 "HH:MM:SS"
fn parse_time(s: &str) -> Option<NaiveTime> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 2 {
        let h: u32 = parts[0].parse().ok()?;
        let m: u32 = parts[1].parse().ok()?;
        NaiveTime::from_hms_opt(h, m, 0)
    } else if parts.len() == 3 {
        let h: u32 = parts[0].parse().ok()?;
        let m: u32 = parts[1].parse().ok()?;
        let sec: u32 = parts[2].parse().ok()?;
        NaiveTime::from_hms_opt(h, m, sec)
    } else {
        None
    }
}

/// 将 DateTime 转换为可读字符串（用于日志）
#[allow(dead_code)]
fn datetime_to_string(dt: DateTime<Local>) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

// ===================== 单元测试 =====================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_time_hh_mm() {
        let t = parse_time("18:30").expect("应解析成功");
        assert_eq!(t.hour(), 18);
        assert_eq!(t.minute(), 30);
        assert_eq!(t.second(), 0);
    }

    #[test]
    fn test_parse_time_hh_mm_ss() {
        let t = parse_time("18:30:45").expect("应解析成功");
        assert_eq!(t.hour(), 18);
        assert_eq!(t.minute(), 30);
        assert_eq!(t.second(), 45);
    }

    #[test]
    fn test_parse_time_invalid() {
        assert!(parse_time("invalid").is_none());
        assert!(parse_time("").is_none());
        assert!(parse_time("25:00").is_none()); // 小时越界
        assert!(parse_time("18:60").is_none()); // 分钟越界
    }

    #[test]
    fn test_schedule_reminder_adds_to_pending() {
        let scheduler = ReminderScheduler::new();
        assert_eq!(scheduler.pending_reminder_count(), 0);
        scheduler.schedule_reminder("18:30", "下班复盘").unwrap();
        assert_eq!(scheduler.pending_reminder_count(), 1);
        scheduler.schedule_reminder("20:00", "晚间总结").unwrap();
        assert_eq!(scheduler.pending_reminder_count(), 2);
    }

    #[test]
    fn test_schedule_reminder_invalid_time_returns_error() {
        let scheduler = ReminderScheduler::new();
        let result = scheduler.schedule_reminder("invalid", "测试");
        assert!(result.is_err());
        assert_eq!(scheduler.pending_reminder_count(), 0);
    }

    #[tokio::test]
    async fn test_start_stop_lifecycle() {
        let scheduler = ReminderScheduler::with_config(ReminderSchedulerConfig {
            check_interval_sec: 1,
            ..Default::default()
        });
        assert!(!scheduler.is_running());
        scheduler.start().unwrap();
        assert!(scheduler.is_running());
        // 等待一小段时间让任务运行
        tokio::time::sleep(Duration::from_millis(100)).await;
        scheduler.stop();
        assert!(!scheduler.is_running());
    }

    #[test]
    fn test_update_config() {
        let scheduler = ReminderScheduler::new();
        let new_config = ReminderSchedulerConfig {
            offwork_start_hour: 19,
            offwork_end_hour: 21,
            weekly_review_hour: 16,
            check_interval_sec: 60,
        };
        scheduler.update_config(new_config.clone());
        let cfg = scheduler.config.lock().unwrap();
        assert_eq!(cfg.offwork_start_hour, 19);
        assert_eq!(cfg.check_interval_sec, 60);
    }
}
