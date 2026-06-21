/**
 * DistillManager MemCell 输出集成测试（Task M2）
 *
 * 验证：
 *  - mock OpenAIClient 返回含 episode/facts/foresight 的 JSON 后，
 *    distillHour 除写 CleanEpisode 外，还写 MemCell 到 memory_cells 表
 *  - MemCell.episode/facts/foresight 从 AI 输出正确提取
 *  - MemCell.metadata 含 segmentIds/timestamp/confidence/activityType/contentType
 *  - AI 未输出 episode/facts/foresight 时降级（episode 用 summary，facts/foresight 空数组）
 *  - MemCell 写入失败不阻塞 CleanEpisode 写入（错误隔离）
 *
 * 运行方式：npx vitest run electron/ai/__tests__/DistillManager.memcell.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

// Mock electron 模块（database.ts 顶层 import { app } from 'electron'）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userdata' }
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
import { CleanEpisodeRepository } from '../../db/repositories/CleanEpisodeRepository'
import { MemCellRepository } from '../../db/repositories/MemCellRepository'
import { DistillManager } from '../DistillManager'
import { OpenAIClient } from '../OpenAIClient'

/** 创建内存数据库并运行迁移 */
function createInMemoryDb(): DatabaseType {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  return db as unknown as DatabaseType
}

/** 直接用 SQL 插入测试 segment（绕过 SegmentRepository.insert，避免 created_at 列缺失问题） */
function insertSegment(
  db: DatabaseType,
  overrides: {
    id: string
    startTime?: string
    endTime?: string
    activityType?: string | null
    contentType?: string | null
  }
): void {
  const params = {
    id: overrides.id,
    date: '2026-06-21',
    startTime: overrides.startTime ?? '10:00:00',
    endTime: overrides.endTime ?? '10:05:00',
    appName: 'Visual Studio Code',
    windowTitle: 'settings.ts - workmemory',
    ocrText: '使用 Electron safeStorage API 加密 API Key',
    ocrSummary: '实现 API Key 加密',
    sourceStatus: 'ocr_done',
    sourceQuality: 'medium',
    activityType: overrides.activityType ?? 'coding',
    contentType: overrides.contentType ?? 'code'
  }
  db.prepare(
    `INSERT INTO segments (
      id, date, start_time, end_time, duration_seconds,
      app_name, process_name, window_title, ocr_text, ocr_summary,
      image_hash, screenshot_path, is_selected_for_report, is_private,
      is_important, is_deleted, source_status, user_title, user_summary,
      user_note, tags, ocr_blocks, ocr_confidence, capture_source,
      source_quality, active_window_bounds, display_bounds,
      activity_type, content_type
    ) VALUES (
      @id, @date, @startTime, @endTime, 300,
      @appName, 'Code.exe', @windowTitle, @ocrText, @ocrSummary,
      '', '', 0, 0,
      0, 0, @sourceStatus, '', '',
      '', '[]', '[]', 0.0, 'unknown',
      @sourceQuality, '', '',
      @activityType, @contentType
    )`
  ).run(params)
}

/** 构造含 episode/facts/foresight 的 AI 响应 JSON */
function makeAiResponse(segmentIds: string[]): string {
  return JSON.stringify({
    events: [
      {
        title: '实现 API Key 加密功能',
        summary: '使用 Electron safeStorage API 实现了 API Key 的加密存储',
        startTime: '10:00:00',
        endTime: '10:30:00',
        memoryKind: 'coding',
        project: 'workmemory',
        entities: [],
        topics: ['加密', 'safeStorage'],
        materials: ['Electron 文档'],
        outputs: ['加密模块'],
        todos: [],
        blockers: [],
        segmentIds,
        evidenceRefs: [
          { segmentId: segmentIds[0], quote: 'safeStorage API', reason: '明确提到加密' }
        ],
        sourceQuality: 'high',
        confidence: 0.9,
        reportEligible: true,
        wikiEligible: false,
        wikiStatus: 'none',
        episode: '用户在 VS Code 中实现了 API Key 加密功能，使用了 Electron 的 safeStorage API',
        facts: ['使用了 safeStorage API', '密钥存储在 userData 目录', '加密失败时降级到明文'],
        foresight: [
          {
            statement: '未来涉及密钥存储时可复用 safeStorage 方案',
            validFrom: '2026-06-21',
            validTo: '2027-06-21',
            confidence: 0.8
          }
        ]
      }
    ]
  })
}

/** 构造不含 episode/facts/foresight 的 AI 响应（测试降级） */
function makeAiResponseNoMemCell(segmentIds: string[]): string {
  return JSON.stringify({
    events: [
      {
        title: '审阅 PR #42',
        summary: '审阅了同事提交的 PR #42，提出 3 条修改建议',
        startTime: '10:00:00',
        endTime: '10:30:00',
        memoryKind: 'review',
        project: 'workmemory',
        entities: [],
        topics: ['代码审阅'],
        materials: ['PR #42'],
        outputs: ['审阅意见'],
        todos: [],
        blockers: [],
        segmentIds,
        evidenceRefs: [],
        sourceQuality: 'high',
        confidence: 0.85,
        reportEligible: true,
        wikiEligible: false,
        wikiStatus: 'none'
      }
    ]
  })
}

describe('DistillManager MemCell 输出', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    vi.mocked(OpenAIClient.chatCompletion).mockReset()
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== MemCell 正常写入 =====================

  describe('AI 输出含 episode/facts/foresight', () => {
    it('distillHour 写入 CleanEpisode 和 MemCell，MemCell 字段从 AI 输出提取', async () => {
      insertSegment(db, { id: 'seg-001' })
      insertSegment(db, {
        id: 'seg-002',
        startTime: '10:10:00',
        endTime: '10:15:00'
      })

      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: makeAiResponse(['seg-001', 'seg-002']),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        finishReason: 'stop'
      })

      const manager = new DistillManager()
      const result = await manager.distillHour('2026-06-21', '10:00')

      expect(result.created).toBe(1)
      expect(result.skipped).toBe(false)

      // 验证 CleanEpisode 写入
      const cleanEpisodes = CleanEpisodeRepository.getByHour('2026-06-21', '10:00')
      expect(cleanEpisodes).toHaveLength(1)
      const cleanEpisode = cleanEpisodes[0]
      expect(cleanEpisode.title).toBe('实现 API Key 加密功能')

      // 验证 MemCell 写入
      const memCells = MemCellRepository.getByCleanEpisodeId(cleanEpisode.id)
      expect(memCells).toHaveLength(1)
      const memCell = memCells[0]

      // episode 从 AI 输出提取
      expect(memCell.episode).toBe(
        '用户在 VS Code 中实现了 API Key 加密功能，使用了 Electron 的 safeStorage API'
      )
      // facts 从 AI 输出提取
      expect(memCell.facts).toEqual([
        '使用了 safeStorage API',
        '密钥存储在 userData 目录',
        '加密失败时降级到明文'
      ])
      // foresight 从 AI 输出提取
      expect(memCell.foresight).toHaveLength(1)
      expect(memCell.foresight[0].statement).toBe('未来涉及密钥存储时可复用 safeStorage 方案')
      expect(memCell.foresight[0].validFrom).toBe('2026-06-21')
      expect(memCell.foresight[0].validTo).toBe('2027-06-21')
      expect(memCell.foresight[0].confidence).toBe(0.8)

      // metadata 含 segmentIds/timestamp/confidence/activityType/contentType
      expect(memCell.metadata.segmentIds).toEqual(['seg-001', 'seg-002'])
      expect(memCell.metadata.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(memCell.metadata.confidence).toBe(0.9)
      expect(memCell.metadata.activityType).toBe('coding')
      expect(memCell.metadata.contentType).toBe('code')

      // cleanEpisodeId 关联正确
      expect(memCell.cleanEpisodeId).toBe(cleanEpisode.id)
      // id 和 createdAt 已生成
      expect(memCell.id.length).toBeGreaterThan(10)
      expect(memCell.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('多个事件时每个 CleanEpisode 都生成对应 MemCell', async () => {
      insertSegment(db, { id: 'seg-001' })
      insertSegment(db, {
        id: 'seg-002',
        startTime: '10:20:00',
        endTime: '10:25:00'
      })

      const aiResponse = JSON.stringify({
        events: [
          {
            title: '事件一',
            summary: '第一个事件',
            startTime: '10:00:00',
            endTime: '10:15:00',
            memoryKind: 'coding',
            project: 'workmemory',
            entities: [],
            topics: [],
            materials: [],
            outputs: [],
            todos: [],
            blockers: [],
            segmentIds: ['seg-001'],
            evidenceRefs: [],
            sourceQuality: 'high',
            confidence: 0.8,
            reportEligible: true,
            wikiEligible: false,
            wikiStatus: 'none',
            episode: '用户完成了第一个任务',
            facts: ['事实一'],
            foresight: []
          },
          {
            title: '事件二',
            summary: '第二个事件',
            startTime: '10:15:00',
            endTime: '10:30:00',
            memoryKind: 'review',
            project: 'workmemory',
            entities: [],
            topics: [],
            materials: [],
            outputs: [],
            todos: [],
            blockers: [],
            segmentIds: ['seg-002'],
            evidenceRefs: [],
            sourceQuality: 'medium',
            confidence: 0.7,
            reportEligible: true,
            wikiEligible: false,
            wikiStatus: 'none',
            episode: '用户完成了第二个任务',
            facts: ['事实二', '事实三'],
            foresight: []
          }
        ]
      })

      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: aiResponse,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        finishReason: 'stop'
      })

      const manager = new DistillManager()
      const result = await manager.distillHour('2026-06-21', '10:00')

      expect(result.created).toBe(2)

      const cleanEpisodes = CleanEpisodeRepository.getByHour('2026-06-21', '10:00')
      expect(cleanEpisodes).toHaveLength(2)

      // 每个 CleanEpisode 都有对应 MemCell
      for (const ce of cleanEpisodes) {
        const cells = MemCellRepository.getByCleanEpisodeId(ce.id)
        expect(cells).toHaveLength(1)
      }
    })
  })

  // ===================== 降级：AI 未输出 MemCell 字段 =====================

  describe('AI 未输出 episode/facts/foresight 时降级', () => {
    it('episode 降级为 CleanEpisode.summary，facts/foresight 为空数组', async () => {
      insertSegment(db, { id: 'seg-001' })

      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: makeAiResponseNoMemCell(['seg-001']),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        finishReason: 'stop'
      })

      const manager = new DistillManager()
      const result = await manager.distillHour('2026-06-21', '10:00')

      expect(result.created).toBe(1)

      const cleanEpisodes = CleanEpisodeRepository.getByHour('2026-06-21', '10:00')
      expect(cleanEpisodes).toHaveLength(1)

      const memCells = MemCellRepository.getByCleanEpisodeId(cleanEpisodes[0].id)
      expect(memCells).toHaveLength(1)
      const memCell = memCells[0]

      // episode 降级为 summary
      expect(memCell.episode).toBe('审阅了同事提交的 PR #42，提出 3 条修改建议')
      // facts 和 foresight 为空数组
      expect(memCell.facts).toEqual([])
      expect(memCell.foresight).toEqual([])
      // metadata 仍正确填充
      expect(memCell.metadata.segmentIds).toEqual(['seg-001'])
      expect(memCell.metadata.confidence).toBe(0.85)
      expect(memCell.metadata.activityType).toBe('coding')
      expect(memCell.metadata.contentType).toBe('code')
    })
  })

  // ===================== 错误隔离 =====================

  describe('MemCell 写入失败不阻塞 CleanEpisode', () => {
    it('MemCellRepository.insert 抛异常时 CleanEpisode 仍写入，distillHour 仍成功', async () => {
      insertSegment(db, { id: 'seg-001' })

      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: makeAiResponse(['seg-001']),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        finishReason: 'stop'
      })

      // Mock MemCellRepository.insert 抛异常
      const insertSpy = vi.spyOn(MemCellRepository, 'insert').mockImplementation(() => {
        throw new Error('模拟 MemCell 写入失败')
      })

      // 抑制 console.error
      const originalError = console.error
      console.error = () => {}
      try {
        const manager = new DistillManager()
        const result = await manager.distillHour('2026-06-21', '10:00')

        // CleanEpisode 仍成功写入
        expect(result.created).toBe(1)
        expect(result.skipped).toBe(false)
        const cleanEpisodes = CleanEpisodeRepository.getByHour('2026-06-21', '10:00')
        expect(cleanEpisodes).toHaveLength(1)

        // MemCell 未写入（insert 抛异常）
        const memCells = MemCellRepository.getByCleanEpisodeId(cleanEpisodes[0].id)
        expect(memCells).toHaveLength(0)
      } finally {
        console.error = originalError
        insertSpy.mockRestore()
      }
    })
  })

  // ===================== 重新蒸馏清理旧 MemCell =====================

  describe('重新蒸馏时清理旧 MemCell', () => {
    it('重新蒸馏时旧 MemCell 被清理，新 MemCell 正确写入', async () => {
      insertSegment(db, { id: 'seg-001' })

      // 第一次蒸馏
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: makeAiResponse(['seg-001']),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        finishReason: 'stop'
      })

      const manager1 = new DistillManager()
      await manager1.distillHour('2026-06-21', '10:00')

      const cellsAfterFirst = MemCellRepository.getByDateRange(
        '2026-06-21T00:00:00.000Z',
        '2099-12-31T23:59:59.999Z'
      )
      expect(cellsAfterFirst).toHaveLength(1)

      // 模拟重新蒸馏：手动将 distill_runs 状态改为 failed
      db.prepare(
        `UPDATE distill_runs SET status = 'failed' WHERE date = ? AND hour_bucket = ?`
      ).run('2026-06-21', '10:00')

      // 第二次蒸馏（AI 返回不同 episode）
      const secondResponse = JSON.stringify({
        events: [
          {
            title: '更新后的加密功能',
            summary: '更新了 API Key 加密实现',
            startTime: '10:00:00',
            endTime: '10:30:00',
            memoryKind: 'coding',
            project: 'workmemory',
            entities: [],
            topics: [],
            materials: [],
            outputs: [],
            todos: [],
            blockers: [],
            segmentIds: ['seg-001'],
            evidenceRefs: [],
            sourceQuality: 'high',
            confidence: 0.95,
            reportEligible: true,
            wikiEligible: false,
            wikiStatus: 'none',
            episode: '用户更新了 API Key 加密实现',
            facts: ['使用更新的 safeStorage API'],
            foresight: []
          }
        ]
      })
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: secondResponse,
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        finishReason: 'stop'
      })

      const manager2 = new DistillManager()
      const result2 = await manager2.distillHour('2026-06-21', '10:00')
      expect(result2.created).toBe(1)

      // 旧 MemCell 被清理，只有新 MemCell
      const cellsAfterSecond = MemCellRepository.getByDateRange(
        '2026-06-21T00:00:00.000Z',
        '2099-12-31T23:59:59.999Z'
      )
      expect(cellsAfterSecond).toHaveLength(1)
      expect(cellsAfterSecond[0].episode).toBe('用户更新了 API Key 加密实现')
    })
  })
})
