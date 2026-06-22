/**
 * capture 模块：窗口监听、截图、捕获决策、隐私守卫等
 *
 * Phase 2：
 *  - window_watcher：前台窗口轮询与事件检测
 *  - screenshot（Phase 2 T2.4）
 *  - capture_decision / privacy_guard / episode_builder（Phase 4）
 *
 * Phase 4（从 TypeScript 迁移）：
 *  - capture_decision：截图决策核心
 *  - privacy_guard：隐私防护中心
 *  - incognito_detector：无痕模式检测器
 *  - activity_classifier：活动类型识别器
 *  - content_classifier：内容类型分类器
 *  - browser_context_collector：浏览器上下文采集器
 *  - layout_analyzer：UI 布局分析器
 *  - action_flow_inferrer：操作流推断器
 *  - one_line_summary：今日一句话总结生成器
 *  - entity_extractor：实体提取器
 *  - episode_builder：Episode 语义合并引擎
 *  - episode_manager：Episode 编排层单例
 *  - capture_manager：捕获全链路编排单例
 */

pub mod screenshot;
pub mod window_watcher;

pub mod capture_decision;
pub mod privacy_guard;
pub mod incognito_detector;
pub mod activity_classifier;
pub mod content_classifier;
pub mod browser_context_collector;
pub mod layout_analyzer;
pub mod action_flow_inferrer;
pub mod one_line_summary;
pub mod entity_extractor;
pub mod episode_builder;
pub mod episode_manager;
pub mod capture_manager;
pub mod focus_streak_tracker;
pub mod cross_day_linker;
pub mod todo_extractor;
pub mod manual_episode_creator;
pub mod today_timeline;
