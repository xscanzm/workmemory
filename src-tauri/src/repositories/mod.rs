//! WorkMemory 数据访问层（对应 electron/db/repositories/）
//!
//! 所有 Repository 通过 `db::database::get_database()` 获取连接，
//! 使用参数化查询防注入；数组字段入库 JSON 序列化，出库 JSON 反序列化。

pub mod causal_chain_repository;
pub mod clean_episode_repository;
pub mod daily_distill_repository;
pub mod data_manager;
pub mod embedding_repository;
pub mod episode_repository;
pub mod feedback_event_repository;
pub mod mem_cell_repository;
pub mod mem_scene_repository;
pub mod privacy_rule_repository;
pub mod reflection_report_repository;
pub mod report_repository;
pub mod search_repository;
pub mod semantic_search_repository;
pub mod segment_repository;
pub mod settings_store;
pub mod skill_repository;
pub mod user_profile_repository;
pub mod weekly_pattern_repository;
pub mod wiki_repository;
