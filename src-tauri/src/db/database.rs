/** 数据库初始化与连接管理（对应 electron/db/database.ts）
 *
 * 单例连接 + PRAGMA 设置 + FTS 函数注册 + 迁移执行。
 */

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use rusqlite::Connection;

use super::fts_tokenizer::register_fts_functions;
use super::migrations::run_migrations;

/// 全局数据库连接单例（线程安全）
static DB_INSTANCE: OnceLock<Mutex<Connection>> = OnceLock::new();

/// 初始化数据库：打开连接 → 设置 PRAGMA → 注册 FTS 函数 → 执行迁移。
///
/// 数据库路径：`app_data_dir/workmemory.db`
pub fn init_database(app_data_dir: &Path) -> anyhow::Result<()> {
    let db_path = app_data_dir.join("workmemory.db");

    // 确保父目录存在
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let conn = Connection::open(&db_path)?;

    // PRAGMA 设置（顺序重要）
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    // 注册 FTS 自定义函数（必须在任何 memory_cells 写入前注册）
    register_fts_functions(&conn)?;

    // 执行迁移
    run_migrations(&conn)?;

    // 将连接存入全局单例
    let mutex = Mutex::new(conn);
    DB_INSTANCE
        .set(mutex)
        .map_err(|_| anyhow::anyhow!("数据库已初始化，不可重复调用 init_database"))?;

    Ok(())
}

/// 获取数据库连接的 Mutex guard。
///
/// 未初始化时返回错误。
pub fn get_database() -> anyhow::Result<std::sync::MutexGuard<'static, Connection>> {
    let mutex = DB_INSTANCE
        .get()
        .ok_or_else(|| anyhow::anyhow!("数据库未初始化，请先调用 init_database"))?;
    Ok(mutex.lock().map_err(|e| anyhow::anyhow!("数据库锁中毒: {}", e))?)
}

/// 关闭数据库连接（应用退出前调用）。
///
/// 执行 WAL checkpoint（TRUNCATE 模式）后丢弃连接。
pub fn close_database() {
    // OnceLock 无法 unset，但可以取出连接并显式 close
    // 由于 OnceLock 不支持 take，我们通过获取锁后执行 checkpoint 来清理
    if let Some(mutex) = DB_INSTANCE.get() {
        if let Ok(conn) = mutex.lock() {
            // 尝试 WAL checkpoint（TRUNCATE 模式截断 WAL 文件）
            let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
        }
    }
    // 连接会在进程退出时自动关闭
}

/// 执行 WAL checkpoint。
///
/// 定时任务（每 6 小时）和 before-quit 事件中调用，防止 WAL 文件无限增长。
pub fn wal_checkpoint() -> anyhow::Result<()> {
    let conn = get_database()?;
    conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
    Ok(())
}

/// 创建内存数据库（仅供测试使用）。
#[cfg(test)]
pub fn create_in_memory_db() -> anyhow::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    register_fts_functions(&conn)?;
    run_migrations(&conn)?;
    Ok(conn)
}
