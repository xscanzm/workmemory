/**
 * CausalChainRepository：跨 Episode 因果链数据访问层（Task H3）。
 *
 * causal_chains 表存储 CausalChainBuilder 产出的因果关系：
 *  - cause_cell_id / effect_cell_id：关联 memory_cells 表（外键）
 *  - relation：'leads_to' | 'blocks' | 'enables'
 *  - confidence：0-1 置信度
 *  - evidence：人类可读的证据描述
 *
 * 由 DailyDistillManager 完成后触发 buildChains 写入。
 */
import { randomUUID } from 'node:crypto'
import type { CausalChain } from '../../ai/CausalChainBuilder'
import { getDatabase } from '../database'

interface CausalChainRow {
  id: string
  cause_cell_id: string
  effect_cell_id: string
  relation: string
  confidence: number
  evidence: string
  created_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToCausalChain(row: CausalChainRow): CausalChain {
  return {
    id: row.id,
    causeCellId: row.cause_cell_id,
    effectCellId: row.effect_cell_id,
    relation: row.relation as CausalChain['relation'],
    confidence: row.confidence,
    evidence: row.evidence,
    createdAt: row.created_at
  }
}

export const CausalChainRepository = {
  /**
   * 插入一条因果链记录。
   * id 与 createdAt 为空时由仓库内部生成。
   * @param chain 因果链对象
   */
  insert(chain: CausalChain): void {
    const db = getDatabase()
    const id = chain.id || randomUUID()
    const createdAt = chain.createdAt || nowIso()
    db.prepare(
      `INSERT INTO causal_chains (
        id, cause_cell_id, effect_cell_id, relation, confidence, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      chain.causeCellId,
      chain.effectCellId,
      chain.relation,
      chain.confidence,
      chain.evidence,
      createdAt
    )
  },

  /**
   * 按日期查询因果链：通过 join memory_cells.created_at 落在指定日期的链。
   * 日期格式 YYYY-MM-DD，基于 cause_cell 的 created_at 前缀匹配。
   * @param date 日期字符串（YYYY-MM-DD）
   * @returns 因果链数组（按 created_at 升序）
   */
  getByDate(date: string): CausalChain[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT c.*
         FROM causal_chains c
         JOIN memory_cells m ON m.id = c.cause_cell_id
         WHERE substr(m.created_at, 1, 10) = ?
         ORDER BY c.created_at ASC`
      )
      .all(date) as CausalChainRow[]
    return rows.map(rowToCausalChain)
  },

  /**
   * 按日期范围查询因果链：通过 join memory_cells.created_at 落在 [startDate, endDate] 的链。
   * 日期格式 YYYY-MM-DD，基于 cause_cell 的 created_at 前缀匹配。
   * @param startDate 起始日期（YYYY-MM-DD，含）
   * @param endDate 结束日期（YYYY-MM-DD，含）
   * @returns 因果链数组（按 created_at 升序）
   */
  getByDateRange(startDate: string, endDate: string): CausalChain[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT c.*
         FROM causal_chains c
         JOIN memory_cells m ON m.id = c.cause_cell_id
         WHERE substr(m.created_at, 1, 10) >= ? AND substr(m.created_at, 1, 10) <= ?
         ORDER BY c.created_at ASC`
      )
      .all(startDate, endDate) as CausalChainRow[]
    return rows.map(rowToCausalChain)
  },

  /**
   * 按 cause_cell_id 查询因果链（作为原因的链）。
   * @param cellId MemCell ID
   * @returns 因果链数组（按 created_at 升序）
   */
  getByCauseCellId(cellId: string): CausalChain[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM causal_chains WHERE cause_cell_id = ? ORDER BY created_at ASC'
      )
      .all(cellId) as CausalChainRow[]
    return rows.map(rowToCausalChain)
  },

  /**
   * 按 effect_cell_id 查询因果链（作为结果的链）。
   * @param cellId MemCell ID
   * @returns 因果链数组（按 created_at 升序）
   */
  getByEffectCellId(cellId: string): CausalChain[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        'SELECT * FROM causal_chains WHERE effect_cell_id = ? ORDER BY created_at ASC'
      )
      .all(cellId) as CausalChainRow[]
    return rows.map(rowToCausalChain)
  }
}
