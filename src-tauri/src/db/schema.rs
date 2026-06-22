/** WorkMemory SQLite Schema（对应 electron/db/schema.ts）
 *
 * 14 张普通表 + 5 张 FTS5 虚拟表 + 全部触发器。
 * 全部使用 IF NOT EXISTS，支持幂等迁移。
 */

/// 完整 schema SQL（v18 终态），由 v1 迁移首次执行，后续迁移在此基础上 ALTER 扩展。
pub const SCHEMA_SQL: &str = include_str!("../../sql/schema.sql");

/// FTS5 虚拟表 + 触发器 SQL（fts_segments / fts_episodes / fts_wiki）
pub const FTS5_SCHEMA_SQL: &str = include_str!("../../sql/fts5.sql");

/// clean_episodes FTS5 虚拟表 + 触发器 SQL
pub const CLEAN_EPISODES_FTS_SQL: &str = include_str!("../../sql/fts5_clean_episodes.sql");
