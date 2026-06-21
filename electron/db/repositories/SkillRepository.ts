/**
 * SkillRepository：技能卡数据访问层（Task R2）。
 *
 * skills 表存储 SkillEvolver 产出的技能卡：
 *  - title：技能标题（如"数据库迁移工作流"），用于 getByTitle 去重
 *  - steps/traps/insights/source_cell_ids：JSON 数组
 *  - confidence：0-1
 *  - evolved_at：ISO 时间戳
 *
 * Skill 类型由 SkillEvolver 定义并导出，避免循环依赖（与 ReflectionReportRepository 一致）。
 */
import { randomUUID } from 'node:crypto'
import type { Skill } from '../../ai/SkillEvolver'
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

interface SkillRow {
  id: string
  title: string
  steps: string
  traps: string
  insights: string
  source_cell_ids: string
  confidence: number
  evolved_at: string
}

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    title: row.title,
    steps: parseJsonArray<string>(row.steps),
    traps: parseJsonArray<string>(row.traps),
    insights: parseJsonArray<string>(row.insights),
    sourceCellIds: parseJsonArray<string>(row.source_cell_ids),
    confidence: row.confidence,
    evolvedAt: row.evolved_at
  }
}

export const SkillRepository = {
  /**
   * 插入技能卡。id/evolvedAt 为空时由仓库内部生成。
   * 同 title 已存在时不重复插入（用于去重），返回时静默跳过。
   * @param skill 技能卡对象
   */
  insert(skill: Skill): void {
    const db = getDatabase()
    const id = skill.id || randomUUID()
    const evolvedAt = skill.evolvedAt || new Date().toISOString()
    db.prepare(
      `INSERT INTO skills (
        id, title, steps, traps, insights, source_cell_ids, confidence, evolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      skill.title,
      stringifyJsonArray(skill.steps),
      stringifyJsonArray(skill.traps),
      stringifyJsonArray(skill.insights),
      stringifyJsonArray(skill.sourceCellIds),
      skill.confidence,
      evolvedAt
    )
  },

  /**
   * 按 ID 查询技能卡
   * @returns Skill 对象；不存在返回 null
   */
  getById(id: string): Skill | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM skills WHERE id = ?')
      .get(id) as SkillRow | undefined
    return row ? rowToSkill(row) : null
  },

  /**
   * 查询全部技能卡（按 evolved_at 升序）
   * @returns Skill 数组
   */
  getAll(): Skill[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM skills ORDER BY evolved_at ASC')
      .all() as SkillRow[]
    return rows.map(rowToSkill)
  },

  /**
   * 按 title 查询技能卡（用于去重：同 title 已存在则跳过新生成）
   * @param title 技能标题（精确匹配）
   * @returns Skill 对象；不存在返回 null
   */
  getByTitle(title: string): Skill | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM skills WHERE title = ?')
      .get(title) as SkillRow | undefined
    return row ? rowToSkill(row) : null
  }
}
