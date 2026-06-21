/**
 * DailyDistillManager 日级理解测试（Task H1）
 *
 * 测试内容：
 *  - H1.6 验证：构造 1 天多小时 MemCell，确认日级摘要含跨小时主题
 *  - 跨小时主题提取：按 MemScene 分组，含相关 MemCell 与涉及小时
 *  - 当日模式计算：deepWorkHours/fragmentedPeriods/switchCount/activeHours/dominantActivity
 *  - AI 摘要生成：mock OpenAIClient 返回摘要文本
 *  - AI 不可用降级：未配置 API Key 时降级为规则摘要
 *  - 持久化：distillDay 结果写入 daily_distills 表，getByDate 可读回
 *  - 空数据：当日无 MemCell 时返回空结果且不抛异常
 *
 * 运行方式：npx vitest run electron/ai/__tests__/DailyDistillManager.test.ts
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

// Mock OpenAIClient（控制 AI 返回内容）
vi.mock('../OpenAIClient', () => ({
  OpenAIClient: {
    chatCompletion: vi.fn()
  }
}))

import { SCHEMA_SQL } from '../../db/schema'
import { runMigrations } from '../../db/migrations'
import { setDatabaseInstance, resetDatabaseInstance } from '../../db/database'
import { MemCellRepository } from '../../db/repositories/MemCellRepository'
import { MemSceneRepository } from '../../db/repositories/MemSceneRepository'
import { DailyDistillRepository } from '../../db/repositories/DailyDistillRepository'
import { distillDay } from '../DailyDistillManager'
import { OpenAIClient } from '../OpenAIClient'
import { SettingsStore } from '../../db/SettingsStore'
import type { MemCell, MemCellMetadata } from '../../memory/MemCell'
import type { MemScene } from '../../memory/MemSceneClusterer'

/** 创建内存数据库并运行迁移，返回 Database 实例 */
function createInMemoryDb(): DatabaseType {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  return db as unknown as DatabaseType
}

/** 插入一条最小 clean_episodes 行（满足外键约束） */
function insertCleanEpisode(db: DatabaseType, id: string, date: string): void {
  db.prepare(
    `INSERT INTO clean_episodes (id, date, start_time, end_time) VALUES (?, ?, ?, ?)`
  ).run(id, date, '10:00:00', '11:00:00')
}

/** 构造并插入 MemCell（含 activityType 元数据） */
function insertMemCell(
  db: DatabaseType,
  id: string,
  cleanEpisodeId: string,
  createdAt: string,
  activityType: string,
  episode: string
): void {
  void db
  const metadata: MemCellMetadata = {
    segmentIds: [],
    timestamp: createdAt,
    confidence: 0.9,
    activityType,
    contentType: 'code'
  }
  const memCell: MemCell = {
    id,
    cleanEpisodeId,
    episode,
    facts: [],
    foresight: [],
    metadata,
    createdAt
  }
  MemCellRepository.insert(memCell)
}

/** 构造并插入 MemScene（含成员 MemCell ID） */
function insertMemScene(
  db: DatabaseType,
  id: string,
  title: string,
  memberCellIds: string[],
  summary = ''
): void {
  void db
  const now = new Date().toISOString()
  const scene: MemScene = {
    id,
    title,
    centroidEmbedding: new Float32Array(1).fill(0.5),
    memberCellIds,
    summary,
    createdAt: now,
    updatedAt: now
  }
  MemSceneRepository.insert(scene)
}

describe('DailyDistillManager', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    vi.mocked(OpenAIClient.chatCompletion).mockReset()
    // 默认返回 AI 摘要
    vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
      content: '当日主要围绕数据库迁移与代码审阅两条主线展开，深度工作集中在上下午两段。',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop'
    })
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== H1.6 验证：1 天多小时 MemCell =====================

  describe('日级摘要含跨小时主题', () => {
    it('构造多小时 MemCell + MemScene，distillDay 返回含跨小时主题的摘要', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)

      // 上午 10 点：数据库迁移主题（3 条 coding MemCell，跨 10/11 点）
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '用户设计了数据库迁移方案')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T10:30:00.000Z`, 'coding', '用户编写了迁移脚本')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T11:00:00.000Z`, 'coding', '用户执行了数据库迁移')

      // 下午 14 点：代码审阅主题（2 条 review MemCell，跨 14/15 点）
      insertMemCell(db, 'mc-4', 'ce-1', `${date}T14:00:00.000Z`, 'review', '用户审阅了 PR #42')
      insertMemCell(db, 'mc-5', 'ce-1', `${date}T15:00:00.000Z`, 'review', '用户提出了修改建议')

      // 跨小时主题：数据库迁移主题含 10/11 点成员，代码审阅主题含 14/15 点成员
      insertMemScene(db, 'scene-db', '数据库迁移工作', ['mc-1', 'mc-2', 'mc-3'], '完成数据库迁移方案设计与执行')
      insertMemScene(db, 'scene-review', '代码审阅', ['mc-4', 'mc-5'], '审阅 PR 并提出修改建议')

      const result = await distillDay(date)

      // 基本字段
      expect(result.date).toBe(date)
      expect(result.memcellIds).toHaveLength(5)
      expect(result.memcellIds).toContain('mc-1')
      expect(result.memcellIds).toContain('mc-5')

      // 跨小时主题：2 个，分别对应两个 MemScene
      expect(result.themes).toHaveLength(2)
      const dbTheme = result.themes.find((t) => t.title === '数据库迁移工作')!
      expect(dbTheme).toBeDefined()
      expect(dbTheme.memcellIds).toEqual(['mc-1', 'mc-2', 'mc-3'])
      expect(dbTheme.hours).toEqual([10, 11])
      expect(dbTheme.description).toBe('完成数据库迁移方案设计与执行')

      const reviewTheme = result.themes.find((t) => t.title === '代码审阅')!
      expect(reviewTheme).toBeDefined()
      expect(reviewTheme.memcellIds).toEqual(['mc-4', 'mc-5'])
      expect(reviewTheme.hours).toEqual([14, 15])

      // 摘要非空，来自 AI
      expect(result.summary.length).toBeGreaterThan(0)
      expect(OpenAIClient.chatCompletion).toHaveBeenCalled()
    })

    it('MemScene 无 summary 时 description 由成员 episode 拼接', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '用户编写了单元测试')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, 'coding', '用户运行了测试套件')
      // MemScene 无 summary
      insertMemScene(db, 'scene-test', '测试编写', ['mc-1', 'mc-2'], '')

      const result = await distillDay(date)

      const theme = result.themes.find((t) => t.title === '测试编写')!
      expect(theme).toBeDefined()
      expect(theme.description).toContain('用户编写了单元测试')
      expect(theme.description).toContain('用户运行了测试套件')
    })

    it('仅保留成员含当日 MemCell 的 MemScene', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '用户进行了编码')
      // 当日活跃 MemScene
      insertMemScene(db, 'scene-active', '当日主题', ['mc-1'], '当日活跃')
      // 非当日活跃 MemScene（成员不在当日 MemCell 中）
      insertMemScene(db, 'scene-other', '其他主题', ['mc-other'], '其他日期')

      const result = await distillDay(date)

      expect(result.themes).toHaveLength(1)
      expect(result.themes[0].title).toBe('当日主题')
    })
  })

  // ===================== 当日模式计算 =====================

  describe('当日模式 patterns', () => {
    it('dominantActivity 取出现最多的 activityType（忽略 idle）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码1')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, 'coding', '编码2')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T12:00:00.000Z`, 'browsing', '浏览')

      const result = await distillDay(date)

      expect(result.patterns.dominantActivity).toBe('coding')
    })

    it('switchCount 统计相邻 MemCell 的 activityType 变化次数', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      // coding → review → coding → browsing：3 次切换
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, 'review', '审阅')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T12:00:00.000Z`, 'coding', '编码')
      insertMemCell(db, 'mc-4', 'ce-1', `${date}T13:00:00.000Z`, 'browsing', '浏览')

      const result = await distillDay(date)

      expect(result.patterns.switchCount).toBe(3)
    })

    it('activeHours 统计有 MemCell 的小时去重计数', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码1')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T10:30:00.000Z`, 'coding', '编码2')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T14:00:00.000Z`, 'coding', '编码3')
      insertMemCell(db, 'mc-4', 'ce-1', `${date}T16:00:00.000Z`, 'coding', '编码4')

      const result = await distillDay(date)

      // 10、14、16 三个不同小时
      expect(result.patterns.activeHours).toBe(3)
    })

    it('deepWorkHours 累计连续同 activityType ≥30min 的运行段', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      // coding 运行段：10:00 → 11:00，跨度 60min ≥30min，计入深度工作
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码1')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T10:30:00.000Z`, 'coding', '编码2')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T11:00:00.000Z`, 'coding', '编码3')
      // 切换到 review：中断 coding 运行段
      insertMemCell(db, 'mc-4', 'ce-1', `${date}T12:00:00.000Z`, 'review', '审阅')

      const result = await distillDay(date)

      // coding 运行段跨度 60min = 1 小时
      expect(result.patterns.deepWorkHours).toBe(1)
    })

    it('deepWorkHours 不计入 <30min 的运行段', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      // coding 运行段：10:00 → 10:10，跨度 10min <30min，不计入
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码1')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T10:10:00.000Z`, 'coding', '编码2')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T11:00:00.000Z`, 'review', '审阅')

      const result = await distillDay(date)

      expect(result.patterns.deepWorkHours).toBe(0)
    })

    it('fragmentedPeriods 识别 activityType 频繁切换的小时段', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      // 10 点小时内 4 次切换（coding→review→coding→review→browsing）
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码1')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T10:10:00.000Z`, 'review', '审阅1')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T10:20:00.000Z`, 'coding', '编码2')
      insertMemCell(db, 'mc-4', 'ce-1', `${date}T10:30:00.000Z`, 'review', '审阅2')
      insertMemCell(db, 'mc-5', 'ce-1', `${date}T10:40:00.000Z`, 'browsing', '浏览')
      // 14 点小时稳定 coding，无切换
      insertMemCell(db, 'mc-6', 'ce-1', `${date}T14:00:00.000Z`, 'coding', '编码3')
      insertMemCell(db, 'mc-7', 'ce-1', `${date}T14:30:00.000Z`, 'coding', '编码4')

      const result = await distillDay(date)

      // 10 点小时 4 次切换 ≥3，识别为碎片化；14 点小时 0 次切换
      expect(result.patterns.fragmentedPeriods).toHaveLength(1)
      expect(result.patterns.fragmentedPeriods[0].start).toBe('10:00')
      expect(result.patterns.fragmentedPeriods[0].end).toBe('11:00')
    })
  })

  // ===================== AI 摘要生成与降级 =====================

  describe('AI 摘要生成', () => {
    it('AI 可用时调用 OpenAIClient 并返回 AI 摘要', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码')

      const aiSummary = '这是 AI 生成的日级摘要。'
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: aiSummary,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop'
      })

      const result = await distillDay(date)

      expect(OpenAIClient.chatCompletion).toHaveBeenCalledOnce()
      expect(result.summary).toBe(aiSummary)
    })

    it('AI 调用失败时降级为规则摘要', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码')
      insertMemScene(db, 'scene-1', '编码工作', ['mc-1'], '编码')

      vi.mocked(OpenAIClient.chatCompletion).mockRejectedValue(new Error('AI 调用失败'))

      // 抑制 console.warn
      const originalWarn = console.warn
      console.warn = () => {}
      try {
        const result = await distillDay(date)

        expect(result.summary.length).toBeGreaterThan(0)
        // 降级摘要含日期、MemCell 数量、主要活动
        expect(result.summary).toContain(date)
        expect(result.summary).toContain('coding')
        expect(result.summary).toContain('编码工作')
      } finally {
        console.warn = originalWarn
      }
    })

    it('未配置 API Key 时降级为规则摘要', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码')

      // 模拟未配置 API Key
      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const result = await distillDay(date)

      // 未调用 AI
      expect(OpenAIClient.chatCompletion).not.toHaveBeenCalled()
      // 降级摘要非空
      expect(result.summary.length).toBeGreaterThan(0)
      expect(result.summary).toContain(date)
    })
  })

  // ===================== 持久化 =====================

  describe('持久化到 daily_distills 表', () => {
    it('distillDay 结果写入 daily_distills，getByDate 可读回', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码1')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, 'coding', '编码2')
      insertMemScene(db, 'scene-1', '编码工作', ['mc-1', 'mc-2'], '完成编码任务')

      const result = await distillDay(date)

      // 通过 Repository 读回
      const stored = DailyDistillRepository.getByDate(date)
      expect(stored).not.toBeNull()
      expect(stored!.date).toBe(date)
      expect(stored!.summary).toBe(result.summary)
      expect(stored!.memcellIds).toEqual(['mc-1', 'mc-2'])
      expect(stored!.themes).toHaveLength(1)
      expect(stored!.themes[0].title).toBe('编码工作')
      expect(stored!.patterns.dominantActivity).toBe('coding')
    })

    it('重复调用 distillDay 同日 upsert 不产生重复行', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', '编码1')

      await distillDay(date)
      await distillDay(date)

      // 直接查表确认只有一行
      const rows = db
        .prepare('SELECT COUNT(*) as c FROM daily_distills WHERE date = ?')
        .get(date) as { c: number }
      expect(rows.c).toBe(1)
    })

    it('getByDate 查询不存在日期返回 null', () => {
      expect(DailyDistillRepository.getByDate('2099-01-01')).toBeNull()
    })
  })

  // ===================== 空数据 =====================

  describe('空数据', () => {
    it('当日无 MemCell 时返回空结果且不抛异常', async () => {
      const date = '2026-06-21'

      const result = await distillDay(date)

      expect(result.date).toBe(date)
      expect(result.memcellIds).toEqual([])
      expect(result.themes).toEqual([])
      expect(result.patterns.deepWorkHours).toBe(0)
      expect(result.patterns.switchCount).toBe(0)
      expect(result.patterns.activeHours).toBe(0)
      expect(result.patterns.dominantActivity).toBe('')
      expect(result.patterns.fragmentedPeriods).toEqual([])
      // 摘要仍非空（降级摘要说明无事件）
      expect(result.summary.length).toBeGreaterThan(0)
      expect(result.summary).toContain(date)
    })
  })
})
