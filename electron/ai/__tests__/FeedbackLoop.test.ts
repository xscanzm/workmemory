/**
 * FeedbackLoop 反馈回流引擎测试（Task R3）
 *
 * 测试内容：
 *  - R3.6 验证：模拟用户 3 次将"推进文件编辑"改为其他标题，确认"推进"权重降低
 *  - recordFeedback：写入 feedback_events 表（applied=0）
 *  - applyFeedback：分析未应用事件，调整 keywordWeights，标记为 applied=1
 *  - FeedbackEventRepository：insert / getUnapplied / markApplied / getByType
 *  - 阈值过滤：拒绝次数 < 3 的词权重不变
 *  - 权重下限：权重不会衰减到 MIN_WEIGHT 以下
 *  - 仅衰减不回升：applyFeedback 不会提升权重
 *  - 幂等性：applyFeedback 重复调用不会重复衰减（已应用事件不再处理）
 *  - 多类型混合：episode_renamed / wiki_rejected / report_edited 同时分析
 *
 * 运行方式：npx vitest run electron/ai/__tests__/FeedbackLoop.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

// Mock electron 模块（database.ts 顶层 import { app } from 'electron'）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

import { SCHEMA_SQL } from '../../db/schema'
import { runMigrations } from '../../db/migrations'
import { setDatabaseInstance, resetDatabaseInstance } from '../../db/database'
import { FeedbackEventRepository } from '../../db/repositories/FeedbackEventRepository'
import {
  recordFeedback,
  applyFeedback,
  keywordWeights,
  getKeywordWeight,
  resetKeywordWeights
} from '../FeedbackLoop'
import type { FeedbackEvent } from '../FeedbackLoop'

/** 创建内存数据库并运行迁移，返回 Database 实例 */
function createInMemoryDb(): DatabaseType {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  return db as unknown as DatabaseType
}

/** 构造一条反馈事件（不含 id） */
function makeEvent(
  type: FeedbackEvent['type'],
  targetId: string,
  before: string,
  after: string,
  timestamp: string
): Omit<FeedbackEvent, 'id'> {
  return { type, targetId, before, after, timestamp }
}

describe('FeedbackLoop', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    resetKeywordWeights()
  })

  afterEach(() => {
    resetKeywordWeights()
    resetDatabaseInstance()
    db.close()
  })

  // ===================== R3.6 验证：3 次重命名降低"推进"权重 =====================

  describe('R3.6 验证：3 次将"推进文件编辑"改为其他标题，"推进"权重降低', () => {
    it('3 次重命名后"推进"权重从 1.0 降低到 < 0.5', () => {
      // 模拟用户 3 次将含"推进"的标题改为不含"推进"的标题
      recordFeedback(
        makeEvent(
          'episode_renamed',
          'ep-1',
          '推进文件编辑',
          '编写代码',
          '2026-06-21T09:00:00.000Z'
        )
      )
      recordFeedback(
        makeEvent(
          'episode_renamed',
          'ep-2',
          '推进文件编辑',
          '审查 PR',
          '2026-06-21T10:00:00.000Z'
        )
      )
      recordFeedback(
        makeEvent(
          'episode_renamed',
          'ep-3',
          '推进文件编辑',
          '调试问题',
          '2026-06-21T11:00:00.000Z'
        )
      )

      // 应用前"推进"权重为初始值 1.0
      expect(getKeywordWeight('推进')).toBe(1.0)

      applyFeedback()

      // 应用后"推进"权重应降低到 < 0.5（3 次拒绝 → 0.7^3 ≈ 0.343）
      const weight = getKeywordWeight('推进')
      expect(weight).toBeLessThan(0.5)
      expect(weight).toBeGreaterThanOrEqual(0.1)
    })

    it('3 次重命名后"推进"权重近似 0.3（0.7^3 ≈ 0.343）', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进文件编辑', '审查 PR', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-3', '推进文件编辑', '调试问题', '2026-06-21T11:00:00.000Z')
      )

      applyFeedback()

      // 0.7^3 = 0.343，接近 0.3
      expect(getKeywordWeight('推进')).toBeCloseTo(0.343, 2)
    })

    it('重命名后事件被标记为 applied=1，不再被重复处理', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进文件编辑', '审查 PR', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-3', '推进文件编辑', '调试问题', '2026-06-21T11:00:00.000Z')
      )

      applyFeedback()
      const weightAfterFirst = getKeywordWeight('推进')

      // 再次调用 applyFeedback：无未应用事件，权重不应变化
      applyFeedback()
      expect(getKeywordWeight('推进')).toBe(weightAfterFirst)

      // getUnapplied 应返回空数组
      expect(FeedbackEventRepository.getUnapplied()).toHaveLength(0)
    })
  })

  // ===================== recordFeedback 持久化 =====================

  describe('recordFeedback 持久化', () => {
    it('记录反馈事件后可通过 getUnapplied 读回', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )

      const unapplied = FeedbackEventRepository.getUnapplied()
      expect(unapplied).toHaveLength(1)
      expect(unapplied[0].type).toBe('episode_renamed')
      expect(unapplied[0].targetId).toBe('ep-1')
      expect(unapplied[0].before).toBe('推进文件编辑')
      expect(unapplied[0].after).toBe('编写代码')
      expect(unapplied[0].timestamp).toBe('2026-06-21T09:00:00.000Z')
      // id 应为非空字符串（由仓库内部生成）
      expect(typeof unapplied[0].id).toBe('string')
      expect(unapplied[0].id.length).toBeGreaterThan(0)
    })

    it('记录多条反馈事件后 getUnapplied 返回全部', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('wiki_rejected', 'wiki-1', '推进工作流', '', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('report_edited', 'report-1', '今日推进了文件编辑', '今日编写了代码', '2026-06-21T11:00:00.000Z')
      )

      const unapplied = FeedbackEventRepository.getUnapplied()
      expect(unapplied).toHaveLength(3)
    })

    it('无未应用事件时 getUnapplied 返回空数组', () => {
      expect(FeedbackEventRepository.getUnapplied()).toEqual([])
    })
  })

  // ===================== FeedbackEventRepository 方法 =====================

  describe('FeedbackEventRepository', () => {
    it('getByType 按 type 查询反馈事件', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('wiki_rejected', 'wiki-1', '推进工作流', '', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进任务', '完成任务', '2026-06-21T11:00:00.000Z')
      )

      const episodeEvents = FeedbackEventRepository.getByType('episode_renamed')
      expect(episodeEvents).toHaveLength(2)
      for (const e of episodeEvents) {
        expect(e.type).toBe('episode_renamed')
      }

      const wikiEvents = FeedbackEventRepository.getByType('wiki_rejected')
      expect(wikiEvents).toHaveLength(1)
      expect(wikiEvents[0].targetId).toBe('wiki-1')

      const reportEvents = FeedbackEventRepository.getByType('report_edited')
      expect(reportEvents).toHaveLength(0)
    })

    it('markApplied 批量标记事件为已应用', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进任务', '完成任务', '2026-06-21T10:00:00.000Z')
      )

      const unapplied = FeedbackEventRepository.getUnapplied()
      expect(unapplied).toHaveLength(2)

      FeedbackEventRepository.markApplied(unapplied.map((e) => e.id))

      expect(FeedbackEventRepository.getUnapplied()).toHaveLength(0)
      // getByType 仍可查到（含已应用）
      expect(FeedbackEventRepository.getByType('episode_renamed')).toHaveLength(2)
    })

    it('markApplied 空数组不报错', () => {
      expect(() => FeedbackEventRepository.markApplied([])).not.toThrow()
    })

    it('getByType 查询不存在的类型返回空数组', () => {
      expect(FeedbackEventRepository.getByType('non_existent_type')).toEqual([])
    })
  })

  // ===================== applyFeedback 阈值过滤 =====================

  describe('applyFeedback 阈值过滤', () => {
    it('拒绝次数 < 3 的词权重不变', () => {
      // 仅 2 次拒绝"推进"
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进文件编辑', '审查 PR', '2026-06-21T10:00:00.000Z')
      )

      applyFeedback()

      // 2 次 < 阈值 3，权重应保持 1.0
      expect(getKeywordWeight('推进')).toBe(1.0)
    })

    it('无未应用事件时 applyFeedback 不报错且不改变权重', () => {
      expect(() => applyFeedback()).not.toThrow()
      expect(getKeywordWeight('推进')).toBe(1.0)
    })
  })

  // ===================== applyFeedback 权重下限 =====================

  describe('applyFeedback 权重下限', () => {
    it('大量拒绝后权重不低于 MIN_WEIGHT（0.1）', () => {
      // 10 次拒绝"推进"，0.7^10 ≈ 0.028，应被 clamp 到 0.1
      for (let i = 0; i < 10; i++) {
        recordFeedback(
          makeEvent(
            'episode_renamed',
            `ep-${i}`,
            '推进文件编辑',
            `编写代码${i}`,
            `2026-06-21T${10 + i}:00:00.000Z`
          )
        )
      }

      applyFeedback()

      expect(getKeywordWeight('推进')).toBeGreaterThanOrEqual(0.1)
      expect(getKeywordWeight('推进')).toBeLessThanOrEqual(0.15)
    })
  })

  // ===================== applyFeedback 仅衰减不回升 =====================

  describe('applyFeedback 仅衰减不回升', () => {
    it('已衰减的权重不会被 applyFeedback 提升', () => {
      // 先 3 次拒绝，权重降到 0.343
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进文件编辑', '审查 PR', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-3', '推进文件编辑', '调试问题', '2026-06-21T11:00:00.000Z')
      )
      applyFeedback()
      const weightAfterFirst = getKeywordWeight('推进')
      expect(weightAfterFirst).toBeLessThan(1.0)

      // 再记录 1 次拒绝（总数 4，但前 3 已应用，本次仅 1 次未应用 < 阈值 3）
      recordFeedback(
        makeEvent('episode_renamed', 'ep-4', '推进文件编辑', '测试功能', '2026-06-21T12:00:00.000Z')
      )
      applyFeedback()

      // 权重不应回升到 1.0（仅衰减不回升），且因本次未达阈值也不应继续衰减
      expect(getKeywordWeight('推进')).toBe(weightAfterFirst)
    })
  })

  // ===================== 多类型混合分析 =====================

  describe('多类型混合分析', () => {
    it('episode_renamed + wiki_rejected + report_edited 同时分析', () => {
      // "推进"在三种类型中都被拒绝 1 次（共 3 次）
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('wiki_rejected', 'wiki-1', '推进工作流', '', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('report_edited', 'report-1', '今日推进了任务', '今日完成了任务', '2026-06-21T11:00:00.000Z')
      )

      applyFeedback()

      // "推进"在 3 条事件的 before 中出现，且均不在 after 中 → 拒绝 3 次 → 权重降低
      expect(getKeywordWeight('推进')).toBeLessThan(1.0)
    })

    it('wiki_rejected 的 before 词在空 after 中视为拒绝', () => {
      // 3 次拒绝含"梳理"的 Wiki 条目
      recordFeedback(
        makeEvent('wiki_rejected', 'wiki-1', '梳理工作流', '', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('wiki_rejected', 'wiki-2', '梳理任务', '', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('wiki_rejected', 'wiki-3', '梳理流程', '', '2026-06-21T11:00:00.000Z')
      )

      applyFeedback()

      // "梳理"被拒绝 3 次 → 权重降低
      expect(getKeywordWeight('梳理')).toBeLessThan(1.0)
    })

    it('report_edited 的 before 词在 after 中保留时不视为拒绝', () => {
      // "推进"在 before 和 after 中都出现 → 不视为拒绝
      recordFeedback(
        makeEvent('report_edited', 'r-1', '今日推进了文件编辑', '今日推进了代码编写', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('report_edited', 'r-2', '推进文件编辑完成', '推进代码编写完成', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('report_edited', 'r-3', '推进文件编辑任务', '推进代码编写任务', '2026-06-21T11:00:00.000Z')
      )

      applyFeedback()

      // "推进"在 after 中仍出现 → 不视为拒绝 → 权重不变
      expect(getKeywordWeight('推进')).toBe(1.0)
    })
  })

  // ===================== keywordWeights 导出 =====================

  describe('keywordWeights 导出', () => {
    it('keywordWeights 是 Map<string, number>', () => {
      expect(keywordWeights).toBeInstanceOf(Map)
    })

    it('初始状态 keywordWeights 为空（未记录的词权重为 1.0）', () => {
      expect(keywordWeights.size).toBe(0)
      expect(getKeywordWeight('任意词')).toBe(1.0)
    })

    it('applyFeedback 后 keywordWeights 包含被衰减的词', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进文件编辑', '审查 PR', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-3', '推进文件编辑', '调试问题', '2026-06-21T11:00:00.000Z')
      )

      applyFeedback()

      expect(keywordWeights.has('推进')).toBe(true)
      expect(keywordWeights.get('推进')).toBeLessThan(1.0)
    })

    it('resetKeywordWeights 清空权重表', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', '推进文件编辑', '编写代码', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', '推进文件编辑', '审查 PR', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-3', '推进文件编辑', '调试问题', '2026-06-21T11:00:00.000Z')
      )
      applyFeedback()
      expect(keywordWeights.size).toBeGreaterThan(0)

      resetKeywordWeights()
      expect(keywordWeights.size).toBe(0)
      expect(getKeywordWeight('推进')).toBe(1.0)
    })
  })

  // ===================== 英文关键词 =====================

  describe('英文关键词权重调整', () => {
    it('英文单词被频繁修改后权重降低', () => {
      recordFeedback(
        makeEvent('episode_renamed', 'ep-1', 'Refactor module', 'Rewrite module', '2026-06-21T09:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-2', 'Refactor module', 'Update module', '2026-06-21T10:00:00.000Z')
      )
      recordFeedback(
        makeEvent('episode_renamed', 'ep-3', 'Refactor module', 'Fix module', '2026-06-21T11:00:00.000Z')
      )

      applyFeedback()

      // "refactor" 在 before 中出现（小写化），在 after 中消失 → 拒绝 3 次 → 权重降低
      expect(getKeywordWeight('refactor')).toBeLessThan(1.0)
    })
  })
})
