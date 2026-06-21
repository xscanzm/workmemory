/**
 * WeeklyPatternDetector 周级模式发现测试（Task H2）
 *
 * 测试内容：
 *  - H2.6 验证：构造 7 天 daily_distills（含 14:00 碎片化），确认模式含"每日 14:00 碎片化"
 *  - 深度工作时段（deep_work_time）：从 themes.hours 统计最常见的连续深度工作时段
 *  - 碎片化时段（fragmented_time）：从 patterns.fragmentedPeriods 统计最常见的碎片化时段
 *  - 常用应用组合（app_combination）：从 themes.titles 找出共现最多的主题对
 *  - 效率趋势（efficiency_trend）：基于 deepWorkHours 趋势判断上升/下降/稳定
 *  - 注意力热点（attention_hotspot）：按 deepWorkHours 加权找出注意力峰值小时
 *  - 趋势数据：deepWorkHoursTrend/switchCountTrend/dominantActivityTrend 各 7 个元素
 *  - 持久化：detectPatterns 结果写入 weekly_patterns 表，getByWeekStart 可读回
 *  - 空数据：7 天都没有 daily_distill 时返回空 patterns
 *  - 部分缺失：某天没有 daily_distill 时跳过该天，不影响其他天的模式检测
 *
 * 运行方式：npx vitest run electron/ai/__tests__/WeeklyPatternDetector.test.ts
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

// Mock SettingsStore（避免 safeStorage / 文件系统依赖）
vi.mock('../../db/SettingsStore', () => ({
  SettingsStore: {
    get: vi.fn().mockReturnValue({
      apiBaseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      aiAutoDistillEnabled: true,
      aiAutoDistillFirstConsentAt: '2026-06-21T00:00:00.000Z',
      aiDistillLastRunAt: '',
      aiDistillSchedule: 'hourly',
      aiDistillSendScreenshots: false,
      autoStart: false,
      screenshotRetentionDays: 0,
      ocrModel: 'tiny',
      apiKeyMasked: 'sk-****test',
      mascotStyle: 'note',
      saveScreenshots: false,
      allowFullScreenshotFallback: true
    }),
    getApiKey: vi.fn().mockReturnValue('test-api-key'),
    set: vi.fn()
  }
}))

import { SCHEMA_SQL } from '../../db/schema'
import { runMigrations } from '../../db/migrations'
import { setDatabaseInstance, resetDatabaseInstance } from '../../db/database'
import { DailyDistillRepository } from '../../db/repositories/DailyDistillRepository'
import { WeeklyPatternRepository } from '../../db/repositories/WeeklyPatternRepository'
import { detectPatterns } from '../WeeklyPatternDetector'
import type { DayDistillResult } from '../DailyDistillManager'

/** 创建内存数据库并运行迁移，返回 Database 实例 */
function createInMemoryDb(): DatabaseType {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  return db as unknown as DatabaseType
}

/** 在日期字符串（YYYY-MM-DD）上加减天数，返回新的日期字符串 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 构造日级理解结果（用于测试） */
function makeDistill(
  date: string,
  options: {
    deepWorkHours?: number
    fragmentedPeriods?: { start: string; end: string }[]
    switchCount?: number
    dominantActivity?: string
    themes?: { title: string; hours: number[] }[]
  }
): DayDistillResult {
  const themes = options.themes ?? []
  const allHours = Array.from(
    new Set(themes.flatMap((t) => t.hours))
  ).sort((a, b) => a - b)
  return {
    date,
    summary: `${date} 工作摘要`,
    themes: themes.map((t) => ({
      title: t.title,
      description: `${t.title} 主题描述`,
      memcellIds: [],
      hours: t.hours
    })),
    patterns: {
      deepWorkHours: options.deepWorkHours ?? 0,
      fragmentedPeriods: options.fragmentedPeriods ?? [],
      switchCount: options.switchCount ?? 0,
      activeHours: allHours.length,
      dominantActivity: options.dominantActivity ?? 'coding'
    },
    memcellIds: []
  }
}

describe('WeeklyPatternDetector', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== H2.6 验证：每日 14:00 碎片化 =====================

  describe('H2.6 每日 14:00 碎片化', () => {
    it('构造 7 天含 14:00 碎片化的 daily_distills，确认模式含"每日 14:00 碎片化"', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3 + i * 0.5,
          fragmentedPeriods: [{ start: '14:00', end: '15:00' }],
          themes: [
            { title: 'VS Code 编码', hours: [9, 10, 11] },
            { title: 'Chrome 文档查阅', hours: [14, 15] }
          ]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)

      // 应包含碎片化时段模式
      const fragmented = patterns.find((p) => p.type === 'fragmented_time')
      expect(fragmented).toBeDefined()
      expect(fragmented!.description).toContain('14:00')
      expect(fragmented!.description).toContain('碎片化')
      expect(fragmented!.confidence).toBeCloseTo(1.0, 1) // 7/7 天
      expect(fragmented!.evidence).toHaveLength(7)
    })
  })

  // ===================== 深度工作时段 =====================

  describe('deep_work_time 深度工作时段', () => {
    it('从 themes.hours 统计最常见的连续深度工作时段', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 4,
          themes: [
            { title: 'VS Code 编码', hours: [9, 10, 11] }
          ]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const deepWork = patterns.find((p) => p.type === 'deep_work_time')
      expect(deepWork).toBeDefined()
      expect(deepWork!.description).toContain('09:00')
      expect(deepWork!.confidence).toBeCloseTo(1.0, 1) // 7/7 天
      expect(deepWork!.metadata?.startHour).toBe(9)
      expect(deepWork!.metadata?.endHour).toBe(11)
    })

    it('无 themes 数据时不产生 deep_work_time 模式', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3,
          themes: []
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const deepWork = patterns.find((p) => p.type === 'deep_work_time')
      expect(deepWork).toBeUndefined()
    })
  })

  // ===================== 碎片化时段 =====================

  describe('fragmented_time 碎片化时段', () => {
    it('找出最常见的碎片化时段', async () => {
      const weekStart = '2026-06-15'
      // 5 天有 14:00 碎片化，2 天有 16:00 碎片化
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const fragmentedPeriods =
          i < 5
            ? [{ start: '14:00', end: '15:00' }]
            : [{ start: '16:00', end: '17:00' }]
        const distill = makeDistill(date, {
          deepWorkHours: 3,
          fragmentedPeriods,
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const fragmented = patterns.find((p) => p.type === 'fragmented_time')
      expect(fragmented).toBeDefined()
      expect(fragmented!.description).toContain('14:00')
      expect(fragmented!.confidence).toBeCloseTo(5 / 7, 1)
      expect(fragmented!.evidence).toHaveLength(5)
    })

    it('无碎片化数据时不产生 fragmented_time 模式', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3,
          fragmentedPeriods: [],
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const fragmented = patterns.find((p) => p.type === 'fragmented_time')
      expect(fragmented).toBeUndefined()
    })
  })

  // ===================== 常用应用组合 =====================

  describe('app_combination 常用应用组合', () => {
    it('找出共现天数最多的主题对', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3,
          themes: [
            { title: 'VS Code 编码', hours: [9, 10] },
            { title: 'Chrome 文档查阅', hours: [14, 15] }
          ]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const appCombo = patterns.find((p) => p.type === 'app_combination')
      expect(appCombo).toBeDefined()
      expect(appCombo!.description).toContain('VS Code 编码')
      expect(appCombo!.description).toContain('Chrome 文档查阅')
      expect(appCombo!.confidence).toBeCloseTo(1.0, 1) // 7/7 天共现
    })

    it('无共现主题对时降级为最常出现的单个主题', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        // 每天只有一个主题，无共现对
        const distill = makeDistill(date, {
          deepWorkHours: 3,
          themes: [{ title: `独立主题-${i}`, hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const appCombo = patterns.find((p) => p.type === 'app_combination')
      // 每个主题只出现 1 天，不满足共现 >= 2 天，降级为单主题
      expect(appCombo).toBeDefined()
      expect(appCombo!.description).toContain('常用应用')
    })
  })

  // ===================== 效率趋势 =====================

  describe('efficiency_trend 效率趋势', () => {
    it('deepWorkHours 递增时识别为上升', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 2 + i * 1, // 2,3,4,5,6,7,8 递增
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const trend = patterns.find((p) => p.type === 'efficiency_trend')
      expect(trend).toBeDefined()
      expect(trend!.description).toContain('上升')
      expect(trend!.metadata?.trend).toBe('rising')
    })

    it('deepWorkHours 递减时识别为下降', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 8 - i * 1, // 8,7,6,5,4,3,2 递减
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const trend = patterns.find((p) => p.type === 'efficiency_trend')
      expect(trend).toBeDefined()
      expect(trend!.description).toContain('下降')
      expect(trend!.metadata?.trend).toBe('declining')
    })

    it('deepWorkHours 稳定时识别为稳定', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 4, // 稳定
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const trend = patterns.find((p) => p.type === 'efficiency_trend')
      expect(trend).toBeDefined()
      expect(trend!.description).toContain('稳定')
      expect(trend!.metadata?.trend).toBe('stable')
    })
  })

  // ===================== 注意力热点 =====================

  describe('attention_hotspot 注意力热点', () => {
    it('按 deepWorkHours 加权找出注意力峰值小时', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 4,
          themes: [
            { title: '编码', hours: [9, 10, 11] },
            { title: '会议', hours: [14] }
          ]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const hotspot = patterns.find((p) => p.type === 'attention_hotspot')
      expect(hotspot).toBeDefined()
      expect(hotspot!.description).toContain('09:00')
      expect(hotspot!.confidence).toBeCloseTo(1.0, 1) // 7/7 天
      expect(hotspot!.metadata?.hour).toBe(9)
    })
  })

  // ===================== 趋势数据 =====================

  describe('趋势数据 trend', () => {
    it('deepWorkHoursTrend/switchCountTrend/dominantActivityTrend 各 7 个元素', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3 + i,
          switchCount: 10 + i,
          dominantActivity: i % 2 === 0 ? 'coding' : 'reading',
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      await detectPatterns(weekStart)

      const stored = WeeklyPatternRepository.getByWeekStart(weekStart)
      expect(stored).not.toBeNull()
      expect(stored!.trend.deepWorkHoursTrend).toEqual([3, 4, 5, 6, 7, 8, 9])
      expect(stored!.trend.switchCountTrend).toEqual([10, 11, 12, 13, 14, 15, 16])
      expect(stored!.trend.dominantActivityTrend).toEqual([
        'coding',
        'reading',
        'coding',
        'reading',
        'coding',
        'reading',
        'coding'
      ])
    })

    it('缺失天补 0/空串', async () => {
      const weekStart = '2026-06-15'
      // 仅插入第 0 天和第 3 天
      DailyDistillRepository.upsert(
        makeDistill(addDays(weekStart, 0), {
          deepWorkHours: 3,
          switchCount: 5,
          dominantActivity: 'coding',
          themes: [{ title: '编码', hours: [9] }]
        })
      )
      DailyDistillRepository.upsert(
        makeDistill(addDays(weekStart, 3), {
          deepWorkHours: 6,
          switchCount: 8,
          dominantActivity: 'reading',
          themes: [{ title: '阅读', hours: [10] }]
        })
      )

      await detectPatterns(weekStart)

      const stored = WeeklyPatternRepository.getByWeekStart(weekStart)
      expect(stored).not.toBeNull()
      expect(stored!.trend.deepWorkHoursTrend).toEqual([3, 0, 0, 6, 0, 0, 0])
      expect(stored!.trend.switchCountTrend).toEqual([5, 0, 0, 8, 0, 0, 0])
      expect(stored!.trend.dominantActivityTrend).toEqual([
        'coding',
        '',
        '',
        'reading',
        '',
        '',
        ''
      ])
    })
  })

  // ===================== 持久化 =====================

  describe('持久化到 weekly_patterns 表', () => {
    it('detectPatterns 结果写入 weekly_patterns，getByWeekStart 可读回', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3,
          fragmentedPeriods: [{ start: '14:00', end: '15:00' }],
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)

      const stored = WeeklyPatternRepository.getByWeekStart(weekStart)
      expect(stored).not.toBeNull()
      expect(stored!.weekStart).toBe(weekStart)
      expect(stored!.patterns).toHaveLength(patterns.length)
      // 验证 patterns 内容一致
      const storedFragmented = stored!.patterns.find(
        (p) => p.type === 'fragmented_time'
      )
      expect(storedFragmented).toBeDefined()
      expect(storedFragmented!.description).toContain('14:00')
    })

    it('upsert 同一 weekStart 时更新已有记录', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        DailyDistillRepository.upsert(
          makeDistill(date, {
            deepWorkHours: 3,
            themes: [{ title: '编码', hours: [9, 10] }]
          })
        )
      }

      await detectPatterns(weekStart)
      const first = WeeklyPatternRepository.getByWeekStart(weekStart)
      expect(first).not.toBeNull()

      // 再次调用，应更新而非插入
      await detectPatterns(weekStart)
      const second = WeeklyPatternRepository.getByWeekStart(weekStart)
      expect(second).not.toBeNull()
      expect(second!.patterns).toHaveLength(first!.patterns.length)
    })

    it('getByWeekStart 查询不存在返回 null', () => {
      expect(WeeklyPatternRepository.getByWeekStart('2099-01-01')).toBeNull()
    })
  })

  // ===================== 空数据 =====================

  describe('空数据', () => {
    it('7 天都没有 daily_distill 时返回空 patterns', async () => {
      const weekStart = '2026-06-15'
      const patterns = await detectPatterns(weekStart)
      expect(patterns).toEqual([])
    })

    it('7 天都没有 daily_distill 时仍持久化空结果（含 trend）', async () => {
      const weekStart = '2026-06-15'
      await detectPatterns(weekStart)

      const stored = WeeklyPatternRepository.getByWeekStart(weekStart)
      expect(stored).not.toBeNull()
      expect(stored!.patterns).toEqual([])
      expect(stored!.trend.deepWorkHoursTrend).toEqual([0, 0, 0, 0, 0, 0, 0])
      expect(stored!.trend.switchCountTrend).toEqual([0, 0, 0, 0, 0, 0, 0])
      expect(stored!.trend.dominantActivityTrend).toEqual([
        '',
        '',
        '',
        '',
        '',
        '',
        ''
      ])
    })
  })

  // ===================== 部分缺失 =====================

  describe('部分缺失', () => {
    it('某天没有 daily_distill 时跳过该天，不影响其他天的模式检测', async () => {
      const weekStart = '2026-06-15'
      // 仅插入 5 天（跳过第 5、6 天）
      for (let i = 0; i < 5; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3,
          fragmentedPeriods: [{ start: '14:00', end: '15:00' }],
          themes: [{ title: '编码', hours: [9, 10] }]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)

      // 碎片化时段仍应检测到，confidence = 5/7
      const fragmented = patterns.find((p) => p.type === 'fragmented_time')
      expect(fragmented).toBeDefined()
      expect(fragmented!.description).toContain('14:00')
      expect(fragmented!.confidence).toBeCloseTo(5 / 7, 1)
      expect(fragmented!.evidence).toHaveLength(5)
    })
  })

  // ===================== 模式完整性 =====================

  describe('模式完整性', () => {
    it('完整 7 天数据时检测到全部 5 类模式', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3 + i * 0.5,
          fragmentedPeriods: [{ start: '14:00', end: '15:00' }],
          switchCount: 10,
          dominantActivity: 'coding',
          themes: [
            { title: 'VS Code 编码', hours: [9, 10, 11] },
            { title: 'Chrome 文档查阅', hours: [14, 15] }
          ]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      const types = patterns.map((p) => p.type)
      expect(types).toContain('deep_work_time')
      expect(types).toContain('fragmented_time')
      expect(types).toContain('app_combination')
      expect(types).toContain('efficiency_trend')
      expect(types).toContain('attention_hotspot')
    })

    it('所有模式的 confidence 在 0-1 范围内', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        const distill = makeDistill(date, {
          deepWorkHours: 3 + i * 0.5,
          fragmentedPeriods: [{ start: '14:00', end: '15:00' }],
          themes: [
            { title: 'VS Code 编码', hours: [9, 10, 11] },
            { title: 'Chrome 文档查阅', hours: [14, 15] }
          ]
        })
        DailyDistillRepository.upsert(distill)
      }

      const patterns = await detectPatterns(weekStart)
      for (const p of patterns) {
        expect(p.confidence).toBeGreaterThanOrEqual(0)
        expect(p.confidence).toBeLessThanOrEqual(1)
        expect(p.description.length).toBeGreaterThan(0)
        expect(p.evidence.length).toBeGreaterThan(0)
      }
    })
  })
})
