/**
 * DataManager：数据管理操作
 * - 一键瘦身：清理已删除 segments + 过期截图 + 孤立数据
 * - 一键清空当天数据
 * - 一键清空全部数据
 * 全部使用参数化 SQL，返回清理统计。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDatabase } from './database'
import { SettingsStore } from './SettingsStore'

export interface CleanupStats {
  deletedSegments: number
  deletedEpisodes: number
  deletedScreenshots: number
  orphanWikiSources: number
}

export interface ClearResult {
  segments: number
  episodes: number
}

/** 截图存储目录（userData/screenshots） */
function getScreenshotsDir(): string {
  return path.join(app.getPath('userData'), 'screenshots')
}

/** 列出截图目录下所有文件 */
function listScreenshotFiles(): string[] {
  const dir = getScreenshotsDir()
  try {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).map((f) => path.join(dir, f))
  } catch {
    return []
  }
}

/** 删除指定截图文件（若存在） */
function deleteScreenshotFile(filePath: string): boolean {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      return true
    }
  } catch {
    /* 静默处理 */
  }
  return false
}

export const DataManager = {
  /**
   * 一键瘦身：
   * 1. 物理删除已软删除的 segments 及其截图
   * 2. 删除过期截图（超过保留天数的）
   * 3. 删除孤立 episodes（segmentIds 全部不存在的）
   * 4. 清理 Wiki 中失效的 sources 引用
   */
  cleanup(): CleanupStats {
    const db = getDatabase()
    const stats: CleanupStats = {
      deletedSegments: 0,
      deletedEpisodes: 0,
      deletedScreenshots: 0,
      orphanWikiSources: 0
    }

    // 1. 物理删除已软删除的 segments 及其截图
    const softDeletedRows = db
      .prepare('SELECT screenshot_path FROM segments WHERE is_deleted = 1 AND screenshot_path != ?')
      .all('') as Array<{ screenshot_path: string }>
    for (const row of softDeletedRows) {
      if (deleteScreenshotFile(row.screenshot_path)) {
        stats.deletedScreenshots++
      }
    }
    const delSegResult = db.prepare('DELETE FROM segments WHERE is_deleted = 1').run()
    stats.deletedSegments = delSegResult.changes

    // 2. 删除过期截图（超过保留天数）
    const settings = SettingsStore.get()
    if (settings.saveScreenshots && settings.screenshotRetentionDays > 0) {
      const retentionMs = settings.screenshotRetentionDays * 24 * 60 * 60 * 1000
      const now = Date.now()
      const files = listScreenshotFiles()
      for (const f of files) {
        try {
          const stat = fs.statSync(f)
          if (now - stat.mtimeMs > retentionMs) {
            fs.unlinkSync(f)
            stats.deletedScreenshots++
          }
        } catch {
          /* 跳过无法访问的文件 */
        }
      }
    } else if (!settings.saveScreenshots) {
      // 不保存截图模式：清空整个截图目录
      const files = listScreenshotFiles()
      for (const f of files) {
        if (deleteScreenshotFile(f)) {
          stats.deletedScreenshots++
        }
      }
    }

    // 3. 删除孤立 episodes（segmentIds 全部不存在于 segments 表）
    const episodes = db
      .prepare('SELECT id, segment_ids FROM episodes')
      .all() as Array<{ id: string; segment_ids: string }>
    for (const ep of episodes) {
      let segIds: string[] = []
      try {
        const parsed = JSON.parse(ep.segment_ids)
        if (Array.isArray(parsed)) segIds = parsed as string[]
      } catch {
        /* 解析失败视为孤立 */
      }
      if (segIds.length === 0) continue
      // 检查是否所有 segmentId 都不存在
      const placeholders = segIds.map(() => '?').join(',')
      const existing = db
        .prepare(`SELECT COUNT(*) as cnt FROM segments WHERE id IN (${placeholders})`)
        .get(...segIds) as { cnt: number }
      if (existing.cnt === 0) {
        db.prepare('DELETE FROM episodes WHERE id = ?').run(ep.id)
        stats.deletedEpisodes++
      }
    }

    // 4. 清理 Wiki 中失效的 sources 引用（sources 中的 episode/segment id 已不存在）
    const wikiRows = db
      .prepare('SELECT id, sources FROM wiki_pages')
      .all() as Array<{ id: string; sources: string }>
    for (const row of wikiRows) {
      let srcIds: string[] = []
      try {
        const parsed = JSON.parse(row.sources)
        if (Array.isArray(parsed)) srcIds = parsed as string[]
      } catch {
        /* 解析失败跳过 */
      }
      if (srcIds.length === 0) continue
      const placeholders = srcIds.map(() => '?').join(',')
      const epExisting = db
        .prepare(`SELECT COUNT(*) as cnt FROM episodes WHERE id IN (${placeholders})`)
        .get(...srcIds) as { cnt: number }
      const segExisting = db
        .prepare(`SELECT COUNT(*) as cnt FROM segments WHERE id IN (${placeholders})`)
        .get(...srcIds) as { cnt: number }
      const validCount = epExisting.cnt + segExisting.cnt
      if (validCount < srcIds.length) {
        // 保留仍存在的引用
        const validIds = srcIds.filter((sid) => {
          const ep = db.prepare('SELECT 1 FROM episodes WHERE id = ?').get(sid)
          const seg = db.prepare('SELECT 1 FROM segments WHERE id = ?').get(sid)
          return ep !== undefined || seg !== undefined
        })
        db.prepare('UPDATE wiki_pages SET sources = ? WHERE id = ?').run(
          JSON.stringify(validIds),
          row.id
        )
        stats.orphanWikiSources += srcIds.length - validIds.length
      }
    }

    return stats
  },

  /** 一键清空指定日期的数据（segments + episodes） */
  clearDay(date: string): ClearResult {
    const db = getDatabase()
    // 先收集要删除的截图路径
    const segRows = db
      .prepare('SELECT screenshot_path FROM segments WHERE date = ? AND screenshot_path != ?')
      .all(date, '') as Array<{ screenshot_path: string }>
    for (const row of segRows) {
      deleteScreenshotFile(row.screenshot_path)
    }
    const segResult = db.prepare('DELETE FROM segments WHERE date = ?').run(date)
    const epResult = db.prepare('DELETE FROM episodes WHERE date = ?').run(date)
    return { segments: segResult.changes, episodes: epResult.changes }
  },

  /** 一键清空全部数据（segments + episodes + wiki_pages + reports，保留 privacy_rules） */
  clearAll(): ClearResult & { wikiPages: number; reports: number } {
    const db = getDatabase()
    // 删除所有截图
    const files = listScreenshotFiles()
    for (const f of files) {
      deleteScreenshotFile(f)
    }
    const segResult = db.prepare('DELETE FROM segments').run()
    const epResult = db.prepare('DELETE FROM episodes').run()
    const wikiResult = db.prepare('DELETE FROM wiki_pages').run()
    const reportResult = db.prepare('DELETE FROM reports').run()
    return {
      segments: segResult.changes,
      episodes: epResult.changes,
      wikiPages: wikiResult.changes,
      reports: reportResult.changes
    }
  },

  /** 获取数据统计（供设置页展示） */
  getStats(): {
    segmentCount: number
    episodeCount: number
    wikiCount: number
    reportCount: number
    screenshotCount: number
    dbSizeBytes: number
  } {
    const db = getDatabase()
    const segCount = (db.prepare('SELECT COUNT(*) as c FROM segments').get() as { c: number }).c
    const epCount = (db.prepare('SELECT COUNT(*) as c FROM episodes').get() as { c: number }).c
    const wikiCount = (db.prepare('SELECT COUNT(*) as c FROM wiki_pages').get() as { c: number }).c
    const reportCount = (db.prepare('SELECT COUNT(*) as c FROM reports').get() as { c: number }).c
    const screenshotFiles = listScreenshotFiles()
    let dbSizeBytes = 0
    try {
      const dbPath = path.join(app.getPath('userData'), 'workmemory.db')
      if (fs.existsSync(dbPath)) {
        dbSizeBytes = fs.statSync(dbPath).size
      }
    } catch {
      /* 静默 */
    }
    return {
      segmentCount: segCount,
      episodeCount: epCount,
      wikiCount,
      reportCount,
      screenshotCount: screenshotFiles.length,
      dbSizeBytes
    }
  }
}
