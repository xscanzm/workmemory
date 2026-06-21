/**
 * EpisodeRepository：工作事件数据访问层
 * 含 userEdited 保护逻辑：若 user_edited=1 则 setOneLineSummary 拒绝覆盖并返回 false。
 */
import { randomUUID } from 'node:crypto'
import type { Episode, EntityRef } from '@/types'
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

interface EpisodeRow {
  id: string
  date: string
  start_time: string
  end_time: string
  title: string
  one_line_summary: string
  segment_ids: string
  entities: string
  topics: string
  user_edited: number
  report_eligible: number
  wiki_eligible: number
}

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    title: row.title,
    oneLineSummary: row.one_line_summary,
    segmentIds: parseJsonArray<string>(row.segment_ids),
    entities: parseJsonArray<EntityRef>(row.entities),
    topics: parseJsonArray<string>(row.topics),
    userEdited: row.user_edited === 1,
    reportEligible: row.report_eligible === 1,
    wikiEligible: row.wiki_eligible === 1
  }
}

interface EpisodeParams {
  id: string
  date: string
  start_time: string
  end_time: string
  title: string
  one_line_summary: string
  segment_ids: string
  entities: string
  topics: string
  user_edited: number
  report_eligible: number
  wiki_eligible: number
}

function episodeToParams(episode: Episode): EpisodeParams {
  return {
    id: episode.id,
    date: episode.date,
    start_time: episode.startTime,
    end_time: episode.endTime,
    title: episode.title,
    one_line_summary: episode.oneLineSummary,
    segment_ids: stringifyJsonArray(episode.segmentIds),
    entities: stringifyJsonArray(episode.entities),
    topics: stringifyJsonArray(episode.topics),
    user_edited: episode.userEdited ? 1 : 0,
    report_eligible: episode.reportEligible ? 1 : 0,
    wiki_eligible: episode.wikiEligible ? 1 : 0
  }
}

export const EpisodeRepository = {
  insert(episode: Episode): Episode {
    const db = getDatabase()
    const id = episode.id || randomUUID()
    const params = episodeToParams({ ...episode, id })
    db.prepare(
      `INSERT INTO episodes (
        id, date, start_time, end_time, title, one_line_summary,
        segment_ids, entities, topics, user_edited, report_eligible, wiki_eligible
      ) VALUES (
        @id, @date, @start_time, @end_time, @title, @one_line_summary,
        @segment_ids, @entities, @topics, @user_edited, @report_eligible, @wiki_eligible
      )`
    ).run(params)
    const created = this.getById(id)
    if (!created) throw new Error(`Episode insert failed for id=${id}`)
    return created
  },

  update(id: string, patch: Partial<Episode>): Episode | null {
    const existing = this.getById(id)
    if (!existing) return null
    const merged: Episode = { ...existing, ...patch, id }
    const params = episodeToParams(merged)
    const db = getDatabase()
    db.prepare(
      `UPDATE episodes SET
        date = @date, start_time = @start_time, end_time = @end_time, title = @title,
        one_line_summary = @one_line_summary, segment_ids = @segment_ids, entities = @entities,
        topics = @topics, user_edited = @user_edited, report_eligible = @report_eligible,
        wiki_eligible = @wiki_eligible
      WHERE id = @id`
    ).run(params)
    return this.getById(id)
  },

  getById(id: string): Episode | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined
    return row ? rowToEpisode(row) : null
  },

  getByDate(date: string): Episode[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM episodes WHERE date = ? ORDER BY start_time ASC')
      .all(date) as EpisodeRow[]
    return rows.map(rowToEpisode)
  },

  /** 按日期范围 [startDate, endDate] 查询 Episodes（含两端） */
  getByDateRange(startDate: string, endDate: string): Episode[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM episodes WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC`
      )
      .all(startDate, endDate) as EpisodeRow[]
    return rows.map(rowToEpisode)
  },

  /** 获取最近 N 天的 Episodes（含今日） */
  getRecent(days: number): Episode[] {
    const end = new Date()
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
    const fmt = (d: Date): string => {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }
    return this.getByDateRange(fmt(start), fmt(end))
  },

  /** 获取全库所有 Episodes（按日期升序） */
  getAll(): Episode[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM episodes ORDER BY date ASC, start_time ASC')
      .all() as EpisodeRow[]
    return rows.map(rowToEpisode)
  },

  /**
   * 设置一句话总结。若 user_edited=1 则拒绝覆盖并返回 false（保护用户手动编辑）。
   * 当用户手动改写时，应通过 update(id, { oneLineSummary, userEdited: true }) 调用。
   */
  setOneLineSummary(id: string, summary: string): boolean {
    const db = getDatabase()
    const existing = this.getById(id)
    if (!existing) return false
    if (existing.userEdited) return false
    const result = db
      .prepare('UPDATE episodes SET one_line_summary = ? WHERE id = ? AND user_edited = 0')
      .run(summary, id)
    return result.changes > 0
  },

  setReportEligible(id: string, eligible: boolean): boolean {
    const db = getDatabase()
    const result = db
      .prepare('UPDATE episodes SET report_eligible = ? WHERE id = ?')
      .run(eligible ? 1 : 0, id)
    return result.changes > 0
  },

  setWikiEligible(id: string, eligible: boolean): boolean {
    const db = getDatabase()
    const result = db
      .prepare('UPDATE episodes SET wiki_eligible = ? WHERE id = ?')
      .run(eligible ? 1 : 0, id)
    return result.changes > 0
  },

  /**
   * 确认实体：标记 userConfirmed=true，使其不再被低置信过滤。
   * 按 type+name 匹配实体。返回更新后的 Episode，未找到返回 null。
   */
  confirmEntity(id: string, entityType: EntityRef['type'], entityName: string): Episode | null {
    const existing = this.getById(id)
    if (!existing) return null
    let found = false
    const entities = existing.entities.map((e) => {
      if (e.type === entityType && e.name === entityName) {
        found = true
        return { ...e, userConfirmed: true }
      }
      return e
    })
    if (!found) return null
    return this.update(id, { entities })
  },

  /**
   * 修正实体名：更新 name 并标记 userConfirmed=true。
   * 按 type+旧 name 匹配实体。返回更新后的 Episode，未找到返回 null。
   */
  correctEntity(
    id: string,
    entityType: EntityRef['type'],
    entityName: string,
    newName: string
  ): Episode | null {
    const existing = this.getById(id)
    if (!existing) return null
    let found = false
    const entities = existing.entities.map((e) => {
      if (e.type === entityType && e.name === entityName) {
        found = true
        return { ...e, name: newName, userConfirmed: true }
      }
      return e
    })
    if (!found) return null
    return this.update(id, { entities })
  },

  /**
   * 忽略实体：从 episode.entities 中移除匹配的实体。
   * 返回更新后的 Episode，未找到返回 null。
   */
  ignoreEntity(id: string, entityType: EntityRef['type'], entityName: string): Episode | null {
    const existing = this.getById(id)
    if (!existing) return null
    const before = existing.entities.length
    const entities = existing.entities.filter(
      (e) => !(e.type === entityType && e.name === entityName)
    )
    if (entities.length === before) return null
    return this.update(id, { entities })
  },

  hardDelete(id: string): boolean {
    const db = getDatabase()
    const result = db.prepare('DELETE FROM episodes WHERE id = ?').run(id)
    return result.changes > 0
  }
}
