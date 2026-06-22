//! Insights 模块：洞察与复盘
//!
//! 模块组织：
//!  - `insights_manager`：洞察编排层
//!  - `anomaly_detector`：异常检测器
//!  - `reminder_scheduler`：复盘建议调度器
//!  - `time_audit_engine`：时间审计统计引擎
//!  - `goal_alignment_analyzer`：目标对齐度分析器（F8.16）
//!  - `focus_state_detector`：实时专注状态检测器（F8.15）
//!  - `data_health_dashboard`：数据健康仪表盘（F8.19）
//!  - `weekly_report_scheduler`：周报调度器（F8.10）

pub mod anomaly_detector;
pub mod insights_manager;
pub mod reminder_scheduler;
pub mod time_audit_engine;
pub mod goal_alignment_analyzer;
pub mod focus_state_detector;
pub mod data_health_dashboard;
pub mod weekly_report_scheduler;
