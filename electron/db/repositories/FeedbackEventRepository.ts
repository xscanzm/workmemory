/**
 * FeedbackEventRepository：用户反馈事件数据访问层（Task R3）。
 *
 * feedback_events 表存储 FeedbackLoop 记录的用户反馈事件：
 *  - type：反馈类型（'episode_renamed' | 'wiki_rejected' | 'report_edited'）
 *  - target_id：被反馈对象的 ID（Episode ID / Wiki ID / Report ID）
 *  - before / after：修改前后的内容（如原标题 / 新标题）
 *  - timestamp：ISO 时间戳
 *  - applied：0=未应用, 1=已应用（applyFeedback 处理后置 1）
 *
 * FeedbackEvent 类型由 FeedbackLoop 定义并导出，避免循环依赖（与
 * SkillRepository 引用 SkillEvolver 的 Skill 类型一致）。
 */
import { randomUUID } from 'node:crypto'
import type { FeedbackEvent, FeedbackEventType } from '../../ai/FeedbackLoop'
import { getDatabase } from '../database'

interface FeedbackEventRow {
  id: string
  type: string
  target_id: string
  before: string
  after: string
  timestamp: string
  applied: number
}

function rowToEvent(row: FeedbackEventRow): FeedbackEvent {
  return {
    id: row.id,
    type: row.type as FeedbackEventType,
    targetId: row.target_id,
    before: row.before,
    after: row.after,
    timestamp: row.timestamp
  }
}

export const FeedbackEventRepository = {
  /**
   * 插入反馈事件。id 由仓库内部生成（randomUUID），applied 默认为 0。
   * @param event 反馈事件（不含 id，由仓库内部生成）
   */
  insert(event: Omit<FeedbackEvent, 'id'>): void {
    const db = getDatabase()
    const id = randomUUID()
    db.prepare(
      `INSERT INTO feedback_events (id, type, target_id, before, after, timestamp, applied)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    ).run(
      id,
      event.type,
      event.targetId,
      event.before,
      event.after,
      event.timestamp
    )
  },

  /**
   * 查询所有未应用的反馈事件（applied = 0），按 timestamp 升序。
   * @returns 未应用的反馈事件数组
   */
  getUnapplied(): FeedbackEvent[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM feedback_events WHERE applied = 0 ORDER BY timestamp ASC`
      )
      .all() as FeedbackEventRow[]
    return rows.map(rowToEvent)
  },

  /**
   * 批量标记反馈事件为已应用（applied = 1）。
   * @param ids 反馈事件 ID 数组
   */
  markApplied(ids: string[]): void {
    if (ids.length === 0) return
    const db = getDatabase()
    const tx = db.transaction((idList: string[]) => {
      const stmt = db.prepare(
        `UPDATE feedback_events SET applied = 1 WHERE id = ?`
      )
      for (const id of idList) {
        stmt.run(id)
      }
    })
    tx(ids)
  },

  /**
   * 按 type 查询反馈事件（含已应用与未应用），按 timestamp 升序。
   * @param type 反馈类型
   * @returns 匹配类型的反馈事件数组
   */
  getByType(type: string): FeedbackEvent[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM feedback_events WHERE type = ? ORDER BY timestamp ASC`
      )
      .all(type) as FeedbackEventRow[]
    return rows.map(rowToEvent)
  }
}
