/**
 * ReflectionEngine 周级反思引擎测试（Task R1）
 *
 * 测试内容：
 *  - R1.6 验证：构造"下午碎片化"模式，确认反思报告含改进建议
 *  - 模式识别：碎片化时段 → warning；深度工作时段 → positive；频繁切换 → warning
 *  - 改进建议：碎片化时段 → "设置专注模式"；频繁切换 → "批量处理"
 *  - 趋势分析：deepWorkHours/switchCount/dominantActivity 较上周变化
 *  - AI 增强：mock OpenAIClient 返回更深入的反思，覆盖规则结果
 *  - AI 降级：未配置 API Key 时降级为规则反思
 *  - 持久化：reflect 结果写入 reflection_reports 表，getByWeekStart 可读回
 *  - 空数据：无 weekly_patterns 时仍生成空报告
 *
 * 运行方式：npx vitest run electron/ai/__tests__/ReflectionEngine.test.ts
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
// 默认未配置 API Key，触发规则降级路径；个别测试用例通过 vi.mocked 动态调整
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

// Mock OpenAIClient（控制 AI 返回内容）
vi.mock('../OpenAIClient', () => ({
  OpenAIClient: {
    chatCompletion: vi.fn()
  }
}))

import { SCHEMA_SQL } from '../../db/schema'
import { runMigrations } from '../../db/migrations'
import { setDatabaseInstance, resetDatabaseInstance } from '../../db/database'
import { DailyDistillRepository } from '../../db/repositories/DailyDistillRepository'
import { ReflectionReportRepository } from '../../db/repositories/ReflectionReportRepository'
import { UserProfileRepository } from '../../db/repositories/UserProfileRepository'
import { detectPatterns } from '../WeeklyPatternDetector'
import { reflect } from '../ReflectionEngine'
import type { DayDistillResult } from '../DailyDistillManager'
import type { ReflectionReport } from '../ReflectionEngine'
import { OpenAIClient } from '../OpenAIClient'
import { SettingsStore } from '../../db/SettingsStore'

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

/** 构造并插入一周含 14:00 碎片化的 daily_distills，并触发 detectPatterns */
async function seedWeekWithAfternoonFragmentation(
  weekStart: string,
  options: {
    deepWorkHours?: number
    switchCount?: number
    dominantActivity?: string
  } = {}
): Promise<void> {
  for (let i = 0; i < 7; i++) {
    const date = addDays(weekStart, i)
    const distill = makeDistill(date, {
      deepWorkHours: options.deepWorkHours ?? 3 + i * 0.5,
      fragmentedPeriods: [{ start: '14:00', end: '15:00' }],
      switchCount: options.switchCount ?? 8,
      dominantActivity: options.dominantActivity ?? 'coding',
      themes: [
        { title: 'VS Code 编码', hours: [9, 10, 11] },
        { title: 'Chrome 文档查阅', hours: [14, 15] }
      ]
    })
    DailyDistillRepository.upsert(distill)
  }
  await detectPatterns(weekStart)
}

describe('ReflectionEngine', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    // 重置 mock 状态：默认未配置 API Key，触发规则降级
    vi.mocked(SettingsStore.getApiKey).mockReturnValue('')
    vi.mocked(OpenAIClient.chatCompletion).mockReset()
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== R1.6 验证：下午碎片化含改进建议 =====================

  describe('R1.6 下午碎片化模式生成改进建议', () => {
    it('构造 7 天含 14:00 碎片化的 weekly_patterns，反思报告含"专注模式"建议', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)

      // 应包含碎片化时段模式（severity: warning）
      const fragmentedPattern = report.patterns.find(
        (p) => p.description.includes('碎片化') && p.severity === 'warning'
      )
      expect(fragmentedPattern).toBeDefined()
      expect(fragmentedPattern!.description).toContain('14:00')

      // 应包含改进建议（含"专注模式"）
      const focusSuggestion = report.suggestions.find(
        (s) => s.title.includes('专注模式') || s.action.includes('专注')
      )
      expect(focusSuggestion).toBeDefined()
      expect(focusSuggestion!.rationale.length).toBeGreaterThan(0)
      expect(focusSuggestion!.action.length).toBeGreaterThan(0)
    })

    it('反思报告含 patterns/suggestions/trends 三个字段', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)

      expect(report.weekStart).toBe(weekStart)
      expect(Array.isArray(report.patterns)).toBe(true)
      expect(Array.isArray(report.suggestions)).toBe(true)
      expect(Array.isArray(report.trends)).toBe(true)
      expect(report.patterns.length).toBeGreaterThan(0)
      expect(report.suggestions.length).toBeGreaterThan(0)
      expect(report.trends.length).toBeGreaterThan(0)
      expect(report.createdAt).toBeTruthy()
    })
  })

  // ===================== 模式识别 =====================

  describe('模式识别 patterns', () => {
    it('碎片化时段出现 >= 3 天时 severity 为 warning', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)
      const fragmented = report.patterns.find((p) =>
        p.description.includes('碎片化')
      )
      expect(fragmented).toBeDefined()
      expect(fragmented!.severity).toBe('warning')
    })

    it('深度工作时段 severity 为 positive', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)
      const deepWork = report.patterns.find((p) =>
        p.description.includes('深度工作时段')
      )
      expect(deepWork).toBeDefined()
      expect(deepWork!.severity).toBe('positive')
    })

    it('频繁上下文切换（日均 >= 15 次）识别为 warning', async () => {
      const weekStart = '2026-06-15'
      // 构造高切换次数的周数据
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        DailyDistillRepository.upsert(
          makeDistill(date, {
            deepWorkHours: 3,
            switchCount: 20, // 日均 20 次，远超阈值
            themes: [{ title: '编码', hours: [9, 10] }]
          })
        )
      }
      await detectPatterns(weekStart)

      const report = await reflect(weekStart)
      const highSwitch = report.patterns.find((p) =>
        p.description.includes('频繁上下文切换')
      )
      expect(highSwitch).toBeDefined()
      expect(highSwitch!.severity).toBe('warning')
    })

    it('效率趋势下降时识别为 warning', async () => {
      const weekStart = '2026-06-15'
      // 构造 deepWorkHours 递减的周数据
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        DailyDistillRepository.upsert(
          makeDistill(date, {
            deepWorkHours: 8 - i, // 8,7,6,5,4,3,2 递减
            themes: [{ title: '编码', hours: [9, 10] }]
          })
        )
      }
      await detectPatterns(weekStart)

      const report = await reflect(weekStart)
      const declining = report.patterns.find((p) =>
        p.description.includes('效率趋势')
      )
      expect(declining).toBeDefined()
      expect(declining!.severity).toBe('warning')
    })

    it('所有 pattern 的 severity 取值在 positive/neutral/warning 内', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)
      for (const p of report.patterns) {
        expect(['positive', 'neutral', 'warning']).toContain(p.severity)
        expect(p.description.length).toBeGreaterThan(0)
        expect(Array.isArray(p.evidence)).toBe(true)
      }
    })
  })

  // ===================== 改进建议 =====================

  describe('改进建议 suggestions', () => {
    it('碎片化时段生成"设置专注模式"建议', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)
      const focus = report.suggestions.find(
        (s) => s.title.includes('专注模式') || s.action.includes('专注')
      )
      expect(focus).toBeDefined()
      expect(focus!.title).toContain('14:00')
    })

    it('频繁切换生成"批量处理"建议', async () => {
      const weekStart = '2026-06-15'
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i)
        DailyDistillRepository.upsert(
          makeDistill(date, {
            deepWorkHours: 3,
            switchCount: 20,
            themes: [{ title: '编码', hours: [9, 10] }]
          })
        )
      }
      await detectPatterns(weekStart)

      const report = await reflect(weekStart)
      const batch = report.suggestions.find(
        (s) => s.title.includes('批量处理') || s.action.includes('批量')
      )
      expect(batch).toBeDefined()
    })

    it('深度工作时段稳定时生成"保持"建议', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart, { deepWorkHours: 4 })

      const report = await reflect(weekStart)
      const keep = report.suggestions.find(
        (s) => s.title.includes('保持') && s.title.includes('深度工作')
      )
      expect(keep).toBeDefined()
    })

    it('所有 suggestion 含 title/rationale/action 三字段', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)
      for (const s of report.suggestions) {
        expect(s.title.length).toBeGreaterThan(0)
        expect(s.rationale.length).toBeGreaterThan(0)
        expect(s.action.length).toBeGreaterThan(0)
      }
    })
  })

  // ===================== 趋势分析 =====================

  describe('趋势分析 trends', () => {
    it('无上周数据时 deepWorkHours 趋势为 stable', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)
      const deepTrend = report.trends.find((t) => t.metric === 'deepWorkHours')
      expect(deepTrend).toBeDefined()
      expect(deepTrend!.direction).toBe('stable')
      expect(deepTrend!.comparison).toContain('无上周数据对比')
    })

    it('有上周数据时 deepWorkHours 上升识别为 up', async () => {
      const lastWeekStart = '2026-06-08'
      const thisWeekStart = '2026-06-15'

      // 上周：deepWorkHours 较低
      await seedWeekWithAfternoonFragmentation(lastWeekStart, {
        deepWorkHours: 2
      })
      // 本周：deepWorkHours 较高
      await seedWeekWithAfternoonFragmentation(thisWeekStart, {
        deepWorkHours: 5
      })

      const report = await reflect(thisWeekStart)
      const deepTrend = report.trends.find((t) => t.metric === 'deepWorkHours')
      expect(deepTrend).toBeDefined()
      expect(deepTrend!.direction).toBe('up')
      expect(deepTrend!.comparison).toContain('提升')
    })

    it('有上周数据时 deepWorkHours 下降识别为 down', async () => {
      const lastWeekStart = '2026-06-08'
      const thisWeekStart = '2026-06-15'

      // 上周：deepWorkHours 较高
      await seedWeekWithAfternoonFragmentation(lastWeekStart, {
        deepWorkHours: 6
      })
      // 本周：deepWorkHours 较低
      await seedWeekWithAfternoonFragmentation(thisWeekStart, {
        deepWorkHours: 2
      })

      const report = await reflect(thisWeekStart)
      const deepTrend = report.trends.find((t) => t.metric === 'deepWorkHours')
      expect(deepTrend).toBeDefined()
      expect(deepTrend!.direction).toBe('down')
      expect(deepTrend!.comparison).toContain('下降')
    })

    it('switchCount 趋势含方向与对比描述', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart, { switchCount: 8 })

      const report = await reflect(weekStart)
      const switchTrend = report.trends.find((t) => t.metric === 'switchCount')
      expect(switchTrend).toBeDefined()
      expect(['up', 'down', 'stable']).toContain(switchTrend!.direction)
      expect(switchTrend!.comparison.length).toBeGreaterThan(0)
    })

    it('所有 trend 含 metric/direction/comparison 三字段', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)
      for (const t of report.trends) {
        expect(t.metric.length).toBeGreaterThan(0)
        expect(['up', 'down', 'stable']).toContain(t.direction)
        expect(t.comparison.length).toBeGreaterThan(0)
      }
    })
  })

  // ===================== AI 增强 =====================

  describe('AI 增强', () => {
    it('AI 可用时返回的反思覆盖规则结果', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      // 配置 API Key
      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: JSON.stringify({
          patterns: [
            {
              description: 'AI 识别的碎片化模式',
              severity: 'warning',
              evidence: ['2026-06-15', '2026-06-16']
            }
          ],
          suggestions: [
            {
              title: 'AI 建议：在 14:00 设置专注模式',
              rationale: 'AI 理由',
              action: 'AI 行动'
            }
          ],
          trends: [
            {
              metric: 'deepWorkHours',
              direction: 'up',
              comparison: 'AI 趋势：较上周提升 20%'
            }
          ]
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop'
      })

      const report = await reflect(weekStart)

      // AI 结果应覆盖规则结果
      expect(report.patterns).toHaveLength(1)
      expect(report.patterns[0].description).toBe('AI 识别的碎片化模式')
      expect(report.suggestions).toHaveLength(1)
      expect(report.suggestions[0].title).toBe('AI 建议：在 14:00 设置专注模式')
      expect(report.trends).toHaveLength(1)
      expect(report.trends[0].comparison).toBe('AI 趋势：较上周提升 20%')
    })

    it('AI 返回不可解析时降级为规则反思', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: '这不是 JSON',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop'
      })

      const report = await reflect(weekStart)

      // 应使用规则结果（含碎片化模式与建议）
      const fragmented = report.patterns.find((p) =>
        p.description.includes('碎片化')
      )
      expect(fragmented).toBeDefined()
      const focus = report.suggestions.find(
        (s) => s.title.includes('专注模式') || s.action.includes('专注')
      )
      expect(focus).toBeDefined()
    })

    it('AI 调用失败时降级为规则反思', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockRejectedValueOnce(new Error('网络错误'))

      const report = await reflect(weekStart)

      // 应使用规则结果
      const fragmented = report.patterns.find((p) =>
        p.description.includes('碎片化')
      )
      expect(fragmented).toBeDefined()
    })

    it('AI 返回空数组时保留规则结果', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: JSON.stringify({
          patterns: [],
          suggestions: [],
          trends: []
        }),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop'
      })

      const report = await reflect(weekStart)

      // AI 返回空数组时不应覆盖规则结果
      expect(report.patterns.length).toBeGreaterThan(0)
      expect(report.suggestions.length).toBeGreaterThan(0)
      expect(report.trends.length).toBeGreaterThan(0)
    })
  })

  // ===================== 持久化 =====================

  describe('持久化到 reflection_reports 表', () => {
    it('reflect 结果写入 reflection_reports，getByWeekStart 可读回', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      const report = await reflect(weekStart)

      const stored = ReflectionReportRepository.getByWeekStart(weekStart)
      expect(stored).not.toBeNull()
      expect(stored!.weekStart).toBe(weekStart)
      expect(stored!.patterns).toHaveLength(report.patterns.length)
      expect(stored!.suggestions).toHaveLength(report.suggestions.length)
      expect(stored!.trends).toHaveLength(report.trends.length)
    })

    it('upsert 同一 weekStart 时更新已有记录', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)

      await reflect(weekStart)
      const first = ReflectionReportRepository.getByWeekStart(weekStart)
      expect(first).not.toBeNull()

      // 再次调用，应更新而非插入
      await reflect(weekStart)
      const second = ReflectionReportRepository.getByWeekStart(weekStart)
      expect(second).not.toBeNull()
      expect(second!.patterns).toHaveLength(first!.patterns.length)
    })

    it('getByWeekStart 查询不存在返回 null', () => {
      expect(ReflectionReportRepository.getByWeekStart('2099-01-01')).toBeNull()
    })
  })

  // ===================== 空数据 =====================

  describe('空数据', () => {
    it('无 weekly_patterns 时仍生成空报告（含趋势兜底）', async () => {
      const weekStart = '2026-06-15'
      // 不调用 detectPatterns，weekly_patterns 表为空

      const report = await reflect(weekStart)

      expect(report.weekStart).toBe(weekStart)
      expect(Array.isArray(report.patterns)).toBe(true)
      expect(Array.isArray(report.suggestions)).toBe(true)
      expect(Array.isArray(report.trends)).toBe(true)
      // 趋势应有兜底（deepWorkHours + switchCount）
      expect(report.trends.length).toBeGreaterThan(0)
    })

    it('无用户画像时不影响反思报告生成', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart)
      // user_profile 表为空

      const report = await reflect(weekStart)
      expect(report.patterns.length).toBeGreaterThan(0)
    })
  })

  // ===================== 用户画像集成 =====================

  describe('用户画像集成', () => {
    it('含 work_pattern 画像且深度工作稳定时识别"稳定工作模式"', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart, { switchCount: 5 })

      // 插入 work_pattern 画像
      UserProfileRepository.upsert({
        key: 'work_pattern',
        value: 'morning_person',
        type: 'stable',
        confidence: 0.8,
        sources: [],
        updatedAt: new Date().toISOString()
      })

      const report = await reflect(weekStart)
      const stable = report.patterns.find((p) =>
        p.description.includes('稳定的工作模式')
      )
      expect(stable).toBeDefined()
      expect(stable!.severity).toBe('positive')
    })
  })

  // ===================== 报告完整性 =====================

  describe('报告完整性', () => {
    it('完整 7 天数据时反思报告含模式、建议与趋势', async () => {
      const weekStart = '2026-06-15'
      await seedWeekWithAfternoonFragmentation(weekStart, {
        deepWorkHours: 4,
        switchCount: 8
      })

      const report: ReflectionReport = await reflect(weekStart)

      // 应有 warning 模式（碎片化）
      expect(report.patterns.some((p) => p.severity === 'warning')).toBe(true)
      // 应有 positive 模式（深度工作时段）
      expect(report.patterns.some((p) => p.severity === 'positive')).toBe(true)
      // 应有改进建议
      expect(report.suggestions.length).toBeGreaterThan(0)
      // 应有趋势分析
      expect(report.trends.length).toBeGreaterThan(0)
    })
  })
})
