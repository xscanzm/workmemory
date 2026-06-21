/**
 * UserProfileRepository：用户画像数据访问层。
 *
 * user_profile 表存储用户画像条目（UserProfileEntry），由 UserProfileEvolver 从
 * MemScene 摘要与 MemCell 活动中提取。画像分两类：
 *  - stable（稳定特质）：primary_activity / preferred_apps / work_pattern，置信度随一致性累积
 *  - transient（瞬态状态）：current_focus，每次更新覆盖，带 valid_to 失效日期
 *
 * sources 字段为 JSON 数组，存储来源 MemScene ID 或 MemCell ID 列表。
 */
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

/** 画像类型：稳定特质 vs 瞬态状态 */
export type ProfileType = 'stable' | 'transient'

/** UserProfileEntry：用户画像条目 */
export interface UserProfileEntry {
  /** 画像键，如 'primary_activity'、'current_focus'、'preferred_apps'、'work_pattern' */
  key: string
  /** 画像值，如 'coding'、'数据库迁移工作'、'VS Code,Chrome' */
  value: string
  /** 稳定特质 vs 瞬态状态 */
  type: ProfileType
  /** 置信度 0-1 */
  confidence: number
  /** ISO 日期，失效日期（transient 类型适用） */
  validTo?: string
  /** 来源 MemScene ID 或 MemCell ID 列表 */
  sources: string[]
  /** ISO 时间戳 */
  updatedAt: string
}

interface UserProfileRow {
  key: string
  value: string
  type: string
  confidence: number
  valid_to: string | null
  sources: string
  updated_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToEntry(row: UserProfileRow): UserProfileEntry {
  return {
    key: row.key,
    value: row.value,
    type: row.type as ProfileType,
    confidence: row.confidence,
    validTo: row.valid_to ?? undefined,
    sources: parseJsonArray<string>(row.sources),
    updatedAt: row.updated_at
  }
}

export const UserProfileRepository = {
  /**
   * 插入或更新画像条目（按 key 主键冲突时更新全部字段）。
   * @param entry 画像条目（updatedAt 为空时自动生成）
   */
  upsert(entry: UserProfileEntry): void {
    const db = getDatabase()
    const updatedAt = entry.updatedAt || nowIso()
    db.prepare(
      `INSERT INTO user_profile (key, value, type, confidence, valid_to, sources, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         type = excluded.type,
         confidence = excluded.confidence,
         valid_to = excluded.valid_to,
         sources = excluded.sources,
         updated_at = excluded.updated_at`
    ).run(
      entry.key,
      entry.value,
      entry.type,
      entry.confidence,
      entry.validTo ?? null,
      stringifyJsonArray(entry.sources),
      updatedAt
    )
  },

  /**
   * 按 key 查询画像条目。
   * @returns 画像条目；不存在返回 null
   */
  get(key: string): UserProfileEntry | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM user_profile WHERE key = ?')
      .get(key) as UserProfileRow | undefined
    return row ? rowToEntry(row) : null
  },

  /**
   * 获取所有 stable 类型画像条目（按 updated_at 降序）。
   * @returns stable 画像条目数组
   */
  getStable(): UserProfileEntry[] {
    const db = getDatabase()
    const rows = db
      .prepare("SELECT * FROM user_profile WHERE type = 'stable' ORDER BY updated_at DESC")
      .all() as UserProfileRow[]
    return rows.map(rowToEntry)
  },

  /**
   * 获取所有 transient 类型画像条目（按 updated_at 降序）。
   * @returns transient 画像条目数组
   */
  getTransient(): UserProfileEntry[] {
    const db = getDatabase()
    const rows = db
      .prepare("SELECT * FROM user_profile WHERE type = 'transient' ORDER BY updated_at DESC")
      .all() as UserProfileRow[]
    return rows.map(rowToEntry)
  },

  /**
   * 获取全部画像条目（按 updated_at 降序）。
   * @returns 全部画像条目数组
   */
  getAll(): UserProfileEntry[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM user_profile ORDER BY updated_at DESC')
      .all() as UserProfileRow[]
    return rows.map(rowToEntry)
  }
}
