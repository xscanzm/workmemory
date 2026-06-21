/**
 * MemCellRepository：结构化记忆单元数据访问层。
 *
 * memory_cells 表存储 MemCell（episode/facts/foresight/metadata），
 * 通过 clean_episode_id 外键关联 clean_episodes 表。
 * 数组/对象字段（facts/foresight/metadata）入库 JSON.stringify，出库 JSON.parse。
 */
import { randomUUID } from 'node:crypto'
import type { Foresight, MemCell, MemCellMetadata } from '../../memory/MemCell'
import { getDatabase } from '../database'
import { parseJsonArray, parseJsonField, stringifyJsonArray } from '../json'

interface MemCellRow {
  id: string
  clean_episode_id: string
  episode: string
  facts: string
  foresight: string
  metadata: string
  created_at: string
}

interface MemCellInsertParams {
  id: string
  clean_episode_id: string
  episode: string
  facts: string
  foresight: string
  metadata: string
  created_at: string
}

const DEFAULT_METADATA: MemCellMetadata = {
  segmentIds: [],
  timestamp: '',
  confidence: 0
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToMemCell(row: MemCellRow): MemCell {
  return {
    id: row.id,
    cleanEpisodeId: row.clean_episode_id,
    episode: row.episode,
    facts: parseJsonArray<string>(row.facts),
    foresight: parseJsonArray<Foresight>(row.foresight),
    metadata: parseJsonField<MemCellMetadata>(row.metadata, DEFAULT_METADATA),
    createdAt: row.created_at
  }
}

function memCellToParams(memCell: MemCell): MemCellInsertParams {
  return {
    id: memCell.id,
    clean_episode_id: memCell.cleanEpisodeId,
    episode: memCell.episode,
    facts: stringifyJsonArray(memCell.facts),
    foresight: stringifyJsonArray(memCell.foresight),
    metadata: JSON.stringify(memCell.metadata),
    created_at: memCell.createdAt
  }
}

export const MemCellRepository = {
  /** 插入 MemCell，JSON 序列化 facts/foresight/metadata */
  insert(memCell: MemCell): void {
    const db = getDatabase()
    const id = memCell.id || randomUUID()
    const createdAt = memCell.createdAt || nowIso()
    const params = memCellToParams({ ...memCell, id, createdAt })
    db.prepare(
      `INSERT INTO memory_cells (
        id, clean_episode_id, episode, facts, foresight, metadata, created_at
      ) VALUES (
        @id, @clean_episode_id, @episode, @facts, @foresight, @metadata, @created_at
      )`
    ).run(params)
  },

  /** 按 ID 查询，JSON 反序列化 */
  getById(id: string): MemCell | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM memory_cells WHERE id = ?').get(id) as MemCellRow | undefined
    return row ? rowToMemCell(row) : null
  },

  /** 按关联 CleanEpisode 查询 */
  getByCleanEpisodeId(cleanEpisodeId: string): MemCell[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM memory_cells WHERE clean_episode_id = ? ORDER BY created_at ASC'
      )
      .all(cleanEpisodeId) as MemCellRow[]
    return rows.map(rowToMemCell)
  },

  /** 按创建时间范围查询（基于 created_at，含两端） */
  getByDateRange(startDate: string, endDate: string): MemCell[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM memory_cells
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC`
      )
      .all(startDate, endDate) as MemCellRow[]
    return rows.map(rowToMemCell)
  },

  /** 删除指定日期指定小时创建的 MemCell（用于重新蒸馏时清理旧数据）。
   *  date 格式 YYYY-MM-DD，hour 为 0-23，基于 created_at ISO 时间戳前缀匹配。 */
  deleteByHour(date: string, hour: number): number {
    const db = getDatabase()
    const hourStr = String(hour).padStart(2, '0')
    const result = db
      .prepare(
        `DELETE FROM memory_cells
         WHERE substr(created_at, 1, 10) = ?
           AND substr(created_at, 12, 2) = ?`
      )
      .run(date, hourStr)
    return result.changes
  }
}
