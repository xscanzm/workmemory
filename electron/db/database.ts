/**
 * SQLite 数据库单例管理
 * better-sqlite3 仅在主进程（Node 环境）使用，渲染进程通过 IPC 访问。
 * 数据库文件位于 app.getPath('userData')/workmemory.db
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import { runMigrations } from './migrations'

let dbInstance: Database.Database | null = null

/**
 * 初始化数据库连接并执行迁移。必须在 app ready 之后调用。
 * 返回单例 Database 实例。
 */
export function initDatabase(): Database.Database {
  if (dbInstance) return dbInstance

  const dbPath = path.join(app.getPath('userData'), 'workmemory.db')
  dbInstance = new Database(dbPath)

  // 性能与完整性优化
  dbInstance.pragma('journal_mode = WAL')
  dbInstance.pragma('foreign_keys = ON')
  dbInstance.pragma('synchronous = NORMAL')

  runMigrations(dbInstance)

  return dbInstance
}

/**
 * 获取已初始化的数据库单例。若未初始化则抛出错误。
 */
export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDatabase() after app ready first.')
  }
  return dbInstance
}

/**
 * 关闭数据库连接。在 app 退出前调用。
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}

/** 仅供测试/重置使用 */
export function resetDatabaseInstance(): void {
  dbInstance = null
}
