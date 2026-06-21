/**
 * ProactiveAdvisor 主动建议引擎测试（Task R4）
 *
 * 测试内容：
 *  - R4.5 验证：构造当前活动匹配 skill 的场景，确认推送建议
 *  - 节流：同一 type 的建议 4 小时内不重复
 *  - rest_reminder：连续活动 >2h 且历史模式显示该时段效率低
 *  - focus_suggestion：今日与昨日均呈现高切换/碎片化模式
 *  - 无匹配/无数据时返回 null
 *
 * 运行方式：npx vitest run electron/ai/__tests__/ProactiveAdvisor.test.ts
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
      apiKeyMasked: '',
      mascotStyle: 'note',
      saveScreenshots: false,
      allowFullScreenshotFallback: true
    }),
    getApiKey: vi.fn().mockReturnValue(''),
    set: vi.fn()
  }
}))

// Mock MascotNotifier（验证 notifyAdvice 调用，避免实际推送）
vi.mock('../../mascot/MascotNotifier', () => ({
  notifyAdvice: vi.fn().mockReturnValue(true),
  getMascotNotifier: vi.fn(),
  setMascotNotifier: vi.fn()
}))

import { SCHEMA_SQL } from '../../db/schema'
import { runMigrations } from '../../db/migrations'
import { setDatabaseInstance, resetDatabaseInstance } from '../../db/database'
import { SkillRepository } from '../../db/repositories/SkillRepository'
import { DailyDistillRepository } from '../../db/repositories/DailyDistillRepository'
import { WeeklyPatternRepository } from '../../db/repositories/WeeklyPatternRepository'
import { checkAndAdvise, resetThrottle } from '../ProactiveAdvisor'
import type { Advice, CurrentActivity } from '../ProactiveAdvisor'
import type { Skill } from '../SkillEvolver'
import type { DayDistillResult } from '../DailyDistillManager'
import type { WeeklyPatternResult } from '../WeeklyPatternDetector'
import { notifyAdvice as mockedNotifyAdvice } from '../../mascot/MascotNotifier'

/** 创建内存数据库并运行迁移，返回 Database 实例 */
function createInMemoryDb(): DatabaseType {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  return db as unknown as DatabaseType
}

/** 获取今日日期字符串（YYYY-MM-DD，本地时区） */
function todayString(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 在日期字符串上加减天数 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 获取指定日期所在周的周一日期（YYYY-MM-DD，本地时区） */
function getWeekStart(date: Date = new Date()): string {
  const d = new Date(date)
  const day = d.getDay() // 0 = Sunday, 1 = Monday
  const diff = day === 0 ? -6 : 1 - day
  d.setDate(d.getDate() + diff)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** 构造并插入一个技能卡 */
function seedSkill(
  id: string,
  title: string,
  steps: string[],
  options: { confidence?: number } = {}
): Skill {
  const skill: Skill = {
    id,
    title,
    steps,
    traps: [],
    insights: [],
    sourceCellIds: [],
    confidence: options.confidence ?? 0.8,
    evolvedAt: '2026-06-20T00:00:00.000Z'
  }
  SkillRepository.insert(skill)
  return skill
}

/** 构造并插入一个日级理解结果 */
function seedDistill(
  date: string,
  options: {
    deepWorkHours?: number
    fragmentedPeriods?: { start: string; end: string }[]
    switchCount?: number
    dominantActivity?: string
  }
): DayDistillResult {
  const result: DayDistillResult = {
    date,
    summary: `${date} 工作摘要`,
    themes: [],
    patterns: {
      deepWorkHours: options.deepWorkHours ?? 2,
      fragmentedPeriods: options.fragmentedPeriods ?? [],
      switchCount: options.switchCount ?? 5,
      activeHours: 4,
      dominantActivity: options.dominantActivity ?? 'coding'
    },
    memcellIds: []
  }
  DailyDistillRepository.upsert(result)
  return result
}

/** 构造并插入一个周级模式结果 */
function seedWeeklyPattern(
  weekStart: string,
  options: {
    fragmentedHour?: number
    deepWorkHoursTrend?: number[]
  } = {}
): WeeklyPatternResult {
  const currentHour = new Date().getHours()
  const fragmentedHour = options.fragmentedHour ?? currentHour
  const result: WeeklyPatternResult = {
    weekStart,
    patterns: [
      {
        type: 'fragmented_time',
        description: `${fragmentedHour}:00-${fragmentedHour + 1}:00 频繁碎片化`,
        evidence: [weekStart],
        confidence: 0.8,
        metadata: {
          startHour: fragmentedHour,
          endHour: fragmentedHour,
          days: 4
        }
      }
    ],
    trend: {
      deepWorkHoursTrend: options.deepWorkHoursTrend ?? [2, 2, 2, 2, 2, 2, 2],
      switchCountTrend: [10, 10, 10, 10, 10, 10, 10],
      dominantActivityTrend: ['coding', 'coding', 'coding', 'coding', 'coding', 'coding', 'coding']
    },
    createdAt: '2026-06-20T00:00:00.000Z'
  }
  WeeklyPatternRepository.upsert(result)
  return result
}

/** 构造一个 3 小时前的 ISO 时间戳 */
function threeHoursAgoIso(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
}

describe('ProactiveAdvisor', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    resetThrottle()
    vi.mocked(mockedNotifyAdvice).mockClear()
    vi.mocked(mockedNotifyAdvice).mockReturnValue(true)
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== R4.5 验证：当前活动匹配 skill 推送建议 =====================

  describe('R4.5 当前活动匹配 skill 推送建议', () => {
    it('当前活动 ocrText 含技能卡关键词时返回 skill_reference 建议', async () => {
      const skill = seedSkill('skill-migration', '数据库迁移工作流', [
        '1. 分析现有 schema',
        '2. 编写迁移脚本',
        '3. 测试迁移脚本'
      ])

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写数据库迁移脚本，测试迁移流程',
        appName: 'VS Code',
        windowTitle: 'migration.sql - VS Code'
      }

      const advice = await checkAndAdvise(activity)

      expect(advice).not.toBeNull()
      expect(advice!.type).toBe('skill_reference')
      expect(advice!.title).toBe('要参考之前的经验吗')
      expect(advice!.skillId).toBe(skill.id)
      expect(advice!.confidence).toBeGreaterThan(0.5)
      expect(advice!.message).toContain(skill.title)
      expect(advice!.action).toBeTruthy()
      expect(advice!.id).toBeTruthy()
      expect(advice!.createdAt).toBeTruthy()
    })

    it('建议通过 MascotNotifier.notifyAdvice 推送', async () => {
      seedSkill('skill-migration', '数据库迁移工作流', [
        '1. 编写迁移脚本',
        '2. 测试迁移脚本'
      ])

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写数据库迁移脚本'
      }

      await checkAndAdvise(activity)

      expect(mockedNotifyAdvice).toHaveBeenCalledTimes(1)
      const pushedAdvice = vi.mocked(mockedNotifyAdvice).mock.calls[0][0] as Advice
      expect(pushedAdvice.type).toBe('skill_reference')
    })

    it('当前活动与技能卡不匹配时返回 null', async () => {
      seedSkill('skill-migration', '数据库迁移工作流', [
        '1. 分析现有 schema',
        '2. 编写迁移脚本'
      ])

      const activity: CurrentActivity = {
        activityType: 'browsing',
        ocrText: '正在浏览新闻网站，查看今日头条',
        appName: 'Chrome'
      }

      const advice = await checkAndAdvise(activity)
      expect(advice).toBeNull()
    })

    it('无技能卡时返回 null', async () => {
      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写数据库迁移脚本'
      }

      const advice = await checkAndAdvise(activity)
      expect(advice).toBeNull()
    })
  })

  // ===================== R4.4 节流：同一建议 4 小时内不重复 =====================

  describe('R4.4 节流：同一 type 4 小时内不重复', () => {
    it('首次调用返回建议，4 小时内再次调用返回 null', async () => {
      seedSkill('skill-migration', '数据库迁移工作流', [
        '1. 编写迁移脚本',
        '2. 测试迁移脚本'
      ])

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写数据库迁移脚本'
      }

      const first = await checkAndAdvise(activity)
      expect(first).not.toBeNull()
      expect(first!.type).toBe('skill_reference')

      // 第二次调用：同 type 被节流
      const second = await checkAndAdvise(activity)
      expect(second).toBeNull()
    })

    it('不同 type 的建议不互相节流', async () => {
      // 准备 skill_reference 场景
      seedSkill('skill-migration', '数据库迁移工作流', [
        '1. 编写迁移脚本'
      ])
      // 准备 focus_suggestion 场景（今日与昨日均高切换）
      const today = todayString()
      const yesterday = addDays(today, -1)
      seedDistill(today, { switchCount: 20, fragmentedPeriods: [{ start: '14:00', end: '15:00' }] })
      seedDistill(yesterday, { switchCount: 18, fragmentedPeriods: [{ start: '14:00', end: '15:00' }] })

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写数据库迁移脚本'
      }

      // 首次调用：skill_reference 优先级最高
      const first = await checkAndAdvise(activity)
      expect(first).not.toBeNull()
      expect(first!.type).toBe('skill_reference')

      // 第二次调用：skill_reference 被节流，但 focus_suggestion 未被节流
      // 注意：rest_reminder 不会触发（无 weekly_patterns 数据）
      const second = await checkAndAdvise(activity)
      expect(second).not.toBeNull()
      expect(second!.type).toBe('focus_suggestion')
    })

    it('resetThrottle 后可再次返回同 type 建议', async () => {
      seedSkill('skill-migration', '数据库迁移工作流', [
        '1. 编写迁移脚本'
      ])

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写数据库迁移脚本'
      }

      const first = await checkAndAdvise(activity)
      expect(first).not.toBeNull()

      const second = await checkAndAdvise(activity)
      expect(second).toBeNull()

      // 重置节流后可再次返回
      resetThrottle()
      const third = await checkAndAdvise(activity)
      expect(third).not.toBeNull()
      expect(third!.type).toBe('skill_reference')
    })
  })

  // ===================== rest_reminder：连续活动 >2h 且时段效率低 =====================

  describe('rest_reminder 连续活动 >2h 且时段效率低', () => {
    it('连续活动 >2h 且 weekly_patterns 显示当前时段碎片化时返回建议', async () => {
      // 插入本周周级模式（当前时段碎片化）
      const weekStart = getWeekStart()
      seedWeeklyPattern(weekStart)

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写代码',
        startTime: threeHoursAgoIso()
      }

      const advice = await checkAndAdvise(activity)
      expect(advice).not.toBeNull()
      expect(advice!.type).toBe('rest_reminder')
      expect(advice!.title).toBe('建议休息')
      expect(advice!.message).toContain('休息')
      expect(advice!.action).toBeTruthy()
    })

    it('连续活动 <2h 时不返回 rest_reminder', async () => {
      const weekStart = getWeekStart()
      seedWeeklyPattern(weekStart)

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写代码',
        startTime: new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30 分钟前
      }

      const advice = await checkAndAdvise(activity)
      // 不应触发 rest_reminder（时长不足）；无 skill 匹配也无 focus_suggestion 数据
      expect(advice).toBeNull()
    })

    it('无 weekly_patterns 数据时不返回 rest_reminder', async () => {
      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写代码',
        startTime: threeHoursAgoIso()
      }

      const advice = await checkAndAdvise(activity)
      expect(advice).toBeNull()
    })
  })

  // ===================== focus_suggestion：与昨日相似碎片化模式 =====================

  describe('focus_suggestion 与昨日相似碎片化模式', () => {
    it('今日与昨日均高切换时返回 focus_suggestion 建议', async () => {
      const today = todayString()
      const yesterday = addDays(today, -1)
      seedDistill(today, { switchCount: 20, fragmentedPeriods: [{ start: '14:00', end: '15:00' }] })
      seedDistill(yesterday, { switchCount: 18, fragmentedPeriods: [{ start: '14:00', end: '15:00' }] })

      const advice = await checkAndAdvise()
      expect(advice).not.toBeNull()
      expect(advice!.type).toBe('focus_suggestion')
      expect(advice!.title).toBe('今天又在频繁切换，要试试专注模式吗')
      expect(advice!.message).toContain('切换')
      expect(advice!.action).toBeTruthy()
    })

    it('仅今日高切换、昨日正常时不返回 focus_suggestion', async () => {
      const today = todayString()
      const yesterday = addDays(today, -1)
      seedDistill(today, { switchCount: 20 })
      seedDistill(yesterday, { switchCount: 5 })

      const advice = await checkAndAdvise()
      expect(advice).toBeNull()
    })

    it('无昨日 daily_distill 时不返回 focus_suggestion', async () => {
      const today = todayString()
      seedDistill(today, { switchCount: 20 })

      const advice = await checkAndAdvise()
      expect(advice).toBeNull()
    })
  })

  // ===================== 综合场景 =====================

  describe('综合场景', () => {
    it('无任何数据时返回 null', async () => {
      const advice = await checkAndAdvise()
      expect(advice).toBeNull()
    })

    it('建议优先级：skill_reference > rest_reminder > focus_suggestion', async () => {
      // 同时满足三条规则
      seedSkill('skill-migration', '数据库迁移工作流', [
        '1. 编写迁移脚本'
      ])

      const weekStart = getWeekStart()
      seedWeeklyPattern(weekStart)

      const today = todayString()
      const yesterday = addDays(today, -1)
      seedDistill(today, { switchCount: 20, fragmentedPeriods: [{ start: '14:00', end: '15:00' }] })
      seedDistill(yesterday, { switchCount: 18, fragmentedPeriods: [{ start: '14:00', end: '15:00' }] })

      const activity: CurrentActivity = {
        activityType: 'coding',
        ocrText: '正在编写数据库迁移脚本',
        startTime: threeHoursAgoIso()
      }

      const advice = await checkAndAdvise(activity)
      expect(advice).not.toBeNull()
      expect(advice!.type).toBe('skill_reference')
    })
  })
})
