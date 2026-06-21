/**
 * PrivacyRuleRepository：隐私规则数据访问层 + 规则匹配引擎
 * 匹配动作由规则类型决定：
 *   - app_name / process_name 命中 → skip（完全跳过，不截图不 OCR）
 *   - window_title / url 命中 → placeholder（占位符，记录隐私窗口被保护）
 *   - 未命中 → allow
 */
import { randomUUID } from 'node:crypto'
import type { PrivacyRule, PrivacyRuleType, PrivacyMatchMode, PrivacyMatchResult } from '@/types'
import { getDatabase } from '../database'

interface PrivacyRuleRow {
  id: string
  type: string
  pattern: string
  match_mode: string
  enabled: number
}

function rowToRule(row: PrivacyRuleRow): PrivacyRule {
  return {
    id: row.id,
    type: row.type as PrivacyRuleType,
    pattern: row.pattern,
    matchMode: row.match_mode as PrivacyMatchMode,
    enabled: row.enabled === 1
  }
}

interface RuleParams {
  id: string
  type: string
  pattern: string
  match_mode: string
  enabled: number
}

function ruleToParams(rule: PrivacyRule): RuleParams {
  return {
    id: rule.id,
    type: rule.type,
    pattern: rule.pattern,
    match_mode: rule.matchMode,
    enabled: rule.enabled ? 1 : 0
  }
}

/** 单条规则对单个目标值的匹配判定 */
function matchValue(value: string, pattern: string, mode: PrivacyMatchMode): boolean {
  if (!pattern) return false
  const v = value || ''
  switch (mode) {
    case 'contains':
      return v.toLowerCase().includes(pattern.toLowerCase())
    case 'equals':
      return v.toLowerCase() === pattern.toLowerCase()
    case 'regex': {
      try {
        return new RegExp(pattern, 'i').test(v)
      } catch {
        return false
      }
    }
    default:
      return false
  }
}

/** 根据规则类型决定过滤动作 */
function actionForType(type: PrivacyRuleType): 'skip' | 'placeholder' {
  return type === 'app_name' || type === 'process_name' ? 'skip' : 'placeholder'
}

export const PrivacyRuleRepository = {
  insert(rule: Omit<PrivacyRule, 'id'>): PrivacyRule {
    const db = getDatabase()
    const id = randomUUID()
    const params = ruleToParams({ ...rule, id })
    db.prepare(
      `INSERT INTO privacy_rules (id, type, pattern, match_mode, enabled)
       VALUES (@id, @type, @pattern, @match_mode, @enabled)`
    ).run(params)
    const created = this.getAll().find(r => r.id === id)
    if (!created) throw new Error(`PrivacyRule insert failed for id=${id}`)
    return created
  },

  update(id: string, patch: Partial<PrivacyRule>): PrivacyRule | null {
    const existing = this.getAll().find(r => r.id === id)
    if (!existing) return null
    const merged: PrivacyRule = { ...existing, ...patch, id }
    const params = ruleToParams(merged)
    const db = getDatabase()
    db.prepare(
      `UPDATE privacy_rules SET type = @type, pattern = @pattern, match_mode = @match_mode, enabled = @enabled WHERE id = @id`
    ).run(params)
    return this.getAll().find(r => r.id === id) ?? null
  },

  delete(id: string): boolean {
    const db = getDatabase()
    const result = db.prepare('DELETE FROM privacy_rules WHERE id = ?').run(id)
    return result.changes > 0
  },

  getAll(): PrivacyRule[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM privacy_rules ORDER BY rowid ASC')
      .all() as PrivacyRuleRow[]
    return rows.map(rowToRule)
  },

  getEnabled(): PrivacyRule[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM privacy_rules WHERE enabled = 1 ORDER BY rowid ASC')
      .all() as PrivacyRuleRow[]
    return rows.map(rowToRule)
  },

  /**
   * 规则匹配引擎：依次用启用的规则匹配传入的应用/进程/窗口标题/URL。
   * 优先级：app_name/process_name（skip）先于 window_title/url（placeholder）。
   * 返回首个命中规则对应的动作；未命中返回 allow。
   */
  matchRule(
    appName: string,
    processName: string,
    windowTitle: string,
    url: string
  ): PrivacyMatchResult {
    const rules = this.getEnabled()
    // 第一轮：检查 skip 类规则（app_name / process_name）
    for (const rule of rules) {
      if (rule.type === 'app_name') {
        if (matchValue(appName, rule.pattern, rule.matchMode)) {
          return { action: 'skip', matchedRule: rule }
        }
      } else if (rule.type === 'process_name') {
        if (matchValue(processName, rule.pattern, rule.matchMode)) {
          return { action: 'skip', matchedRule: rule }
        }
      }
    }
    // 第二轮：检查 placeholder 类规则（window_title / url）
    for (const rule of rules) {
      if (rule.type === 'window_title') {
        if (matchValue(windowTitle, rule.pattern, rule.matchMode)) {
          return { action: 'placeholder', matchedRule: rule }
        }
      } else if (rule.type === 'url') {
        if (matchValue(url, rule.pattern, rule.matchMode)) {
          return { action: 'placeholder', matchedRule: rule }
        }
      }
    }
    return { action: 'allow', matchedRule: null }
  }
}

export { matchValue, actionForType }
