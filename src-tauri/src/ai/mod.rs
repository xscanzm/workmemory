//! AI 模块：OpenAI-compatible 客户端及相关 AI 能力
//!
//! 模块组织：
//!  - `openai_client`：OpenAI-compatible API 客户端
//!  - `distill_prompt`：小时级蒸馏提示词构建
//!  - `templates`：日报模板系统
//!  - `sensitive_masker`：敏感信息脱敏
//!  - `hour_context_pack_builder`：小时级上下文包构建
//!  - `distill_manager`：小时级蒸馏管理器
//!  - `daily_distill_manager`：日级蒸馏管理器
//!  - `weekly_pattern_detector`：周级模式检测器
//!  - `reflection_engine`：周级反思引擎
//!  - `skill_evolver`：技能进化引擎
//!  - `report_generator`：日报生成器
//!  - `report_exporter`：报告导出器
//!  - `html_exporter`：Markdown → HTML 转换器
//!  - `feedback_loop`：反馈回流引擎
//!  - `proactive_advisor`：主动建议引擎
//!  - `ai_manager`：AI 编排层
//!  - `schemas`：AI 输出 JSON 契约子模块
//!  - `report_comparator`：报告历史对比器（F8.11）

pub mod ai_manager;
pub mod daily_distill_manager;
pub mod distill_manager;
pub mod distill_prompt;
pub mod feedback_loop;
pub mod html_exporter;
pub mod hour_context_pack_builder;
pub mod openai_client;
pub mod proactive_advisor;
pub mod reflection_engine;
pub mod report_comparator;
pub mod report_exporter;
pub mod report_generator;
pub mod schemas;
pub mod sensitive_masker;
pub mod skill_evolver;
pub mod templates;
pub mod weekly_pattern_detector;
