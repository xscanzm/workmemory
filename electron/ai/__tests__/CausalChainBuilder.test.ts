/**
 * CausalChainBuilder 跨 Episode 因果链测试（Task H3）
 *
 * 测试内容：
 *  - H3.7 验证：构造"查阅文档→实现功能"相邻 MemCell，确认 causal_chain 关系为 enables
 *  - AI 因果推断：mock OpenAIClient 返回因果关系，确认写入 causal_chains 表
 *  - AI 不可用降级：未配置 API Key 时降级为规则推断
 *    - reading → coding: enables（查阅资料使实现成为可能）
 *    - coding → coding: leads_to（连续编码）
 *    - browsing → chatting: leads_to（浏览后讨论）
 *    - 含"错误"/"失败"/"bug"关键词的 MemCell blocks 后续
 *  - 时间窗口：30 分钟内的非相邻对也参与因果推断
 *  - 持久化：CausalChainRepository.insert/getByDate/getByCauseCellId/getByEffectCellId
 *  - 空数据：当日无 MemCell 或仅 1 条时返回空数组
 *
 * 运行方式：npx vitest run electron/ai/__tests__/CausalChainBuilder.test.ts
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
import { CausalChainRepository } from '../../db/repositories/CausalChainRepository'
import { buildChains } from '../CausalChainBuilder'
import { OpenAIClient } from '../OpenAIClient'
import { SettingsStore } from '../../db/SettingsStore'
import type { MemCell, MemCellMetadata } from '../../memory/MemCell'

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
  episode: string,
  facts: string[] = []
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
    facts,
    foresight: [],
    metadata,
    createdAt
  }
  MemCellRepository.insert(memCell)
}

describe('CausalChainBuilder', () => {
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

  // ===================== H3.7 验证：查阅文档→实现功能 enables =====================

  describe('H3.7 查阅文档→实现功能 enables', () => {
    it('AI 推断：查阅 safeStorage 文档 enables 实现 API Key 加密', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      // 查阅文档（reading）
      insertMemCell(
        db,
        'mc-doc',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了 safeStorage API 文档',
        ['safeStorage 用于加密存储敏感数据', '密钥由操作系统密钥链管理']
      )
      // 实现功能（coding）
      insertMemCell(
        db,
        'mc-impl',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了 API Key 加密功能',
        ['使用 safeStorage.encryptString 加密 API Key', '密文存储在 userData 目录']
      )

      // mock AI 返回 enables 关系
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: JSON.stringify({
          chains: [
            {
              causeCellId: 'mc-doc',
              effectCellId: 'mc-impl',
              relation: 'enables',
              confidence: 0.9,
              evidence: '查阅 safeStorage 文档为实现 API Key 加密提供了方法基础'
            }
          ]
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop'
      })

      const chains = await buildChains(date)

      expect(chains).toHaveLength(1)
      expect(chains[0].causeCellId).toBe('mc-doc')
      expect(chains[0].effectCellId).toBe('mc-impl')
      expect(chains[0].relation).toBe('enables')
      expect(chains[0].confidence).toBeGreaterThan(0)
      expect(chains[0].evidence.length).toBeGreaterThan(0)
      expect(OpenAIClient.chatCompletion).toHaveBeenCalled()
    })

    it('降级规则：reading → coding 含文档关键词时识别为 enables', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-doc',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了 safeStorage 文档',
        ['阅读官方文档了解 API 用法']
      )
      insertMemCell(
        db,
        'mc-impl',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了 API Key 加密功能',
        []
      )

      // 未配置 API Key，降级为规则推断
      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      expect(OpenAIClient.chatCompletion).not.toHaveBeenCalled()
      const enablesChain = chains.find((c) => c.relation === 'enables')
      expect(enablesChain).toBeDefined()
      expect(enablesChain!.causeCellId).toBe('mc-doc')
      expect(enablesChain!.effectCellId).toBe('mc-impl')
      expect(enablesChain!.confidence).toBeGreaterThanOrEqual(0.7)
    })

    it('降级规则：reading → coding 无文档关键词时仍识别为 enables', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-read',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户阅读了相关源码',
        []
      )
      insertMemCell(
        db,
        'mc-code',
        'ce-1',
        `${date}T10:20:00.000Z`,
        'coding',
        '用户编写了对应实现',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      const enablesChain = chains.find((c) => c.relation === 'enables')
      expect(enablesChain).toBeDefined()
      expect(enablesChain!.causeCellId).toBe('mc-read')
      expect(enablesChain!.effectCellId).toBe('mc-code')
    })
  })

  // ===================== 降级规则：其他关系类型 =====================

  describe('降级规则推断', () => {
    it('coding → coding 识别为 leads_to（连续编码）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'coding',
        '用户编写了数据库迁移脚本',
        []
      )
      insertMemCell(
        db,
        'mc-2',
        'ce-1',
        `${date}T10:20:00.000Z`,
        'coding',
        '用户执行了数据库迁移',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      const leadsToChain = chains.find((c) => c.relation === 'leads_to')
      expect(leadsToChain).toBeDefined()
      expect(leadsToChain!.causeCellId).toBe('mc-1')
      expect(leadsToChain!.effectCellId).toBe('mc-2')
    })

    it('browsing → chatting 识别为 leads_to（浏览后讨论）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-browse',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'browsing',
        '用户浏览了技术博客',
        []
      )
      insertMemCell(
        db,
        'mc-chat',
        'ce-1',
        `${date}T10:15:00.000Z`,
        'chatting',
        '用户与同事讨论了博客内容',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      const leadsToChain = chains.find((c) => c.relation === 'leads_to')
      expect(leadsToChain).toBeDefined()
      expect(leadsToChain!.causeCellId).toBe('mc-browse')
      expect(leadsToChain!.effectCellId).toBe('mc-chat')
    })

    it('含"错误"关键词的 MemCell blocks 后续', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-err',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'coding',
        '用户遇到了依赖版本冲突错误',
        ['npm install 失败']
      )
      insertMemCell(
        db,
        'mc-build',
        'ce-1',
        `${date}T10:10:00.000Z`,
        'coding',
        '用户尝试构建项目',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      const blocksChain = chains.find((c) => c.relation === 'blocks')
      expect(blocksChain).toBeDefined()
      expect(blocksChain!.causeCellId).toBe('mc-err')
      expect(blocksChain!.effectCellId).toBe('mc-build')
    })

    it('含"失败"关键词的 MemCell blocks 后续', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-fail',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'coding',
        '用户测试失败',
        ['测试套件报错']
      )
      insertMemCell(
        db,
        'mc-fix',
        'ce-1',
        `${date}T10:05:00.000Z`,
        'coding',
        '用户开始修复',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      const blocksChain = chains.find((c) => c.relation === 'blocks')
      expect(blocksChain).toBeDefined()
    })

    it('含"bug"关键词的 MemCell blocks 后续', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-bug',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'coding',
        '用户发现了 bug',
        []
      )
      insertMemCell(
        db,
        'mc-next',
        'ce-1',
        `${date}T10:05:00.000Z`,
        'coding',
        '用户继续后续工作',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      const blocksChain = chains.find((c) => c.relation === 'blocks')
      expect(blocksChain).toBeDefined()
      expect(blocksChain!.causeCellId).toBe('mc-bug')
    })

    it('AI 调用失败时降级为规则推断', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-doc',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-impl',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      vi.mocked(OpenAIClient.chatCompletion).mockRejectedValue(new Error('AI 调用失败'))

      // 抑制 console.warn
      const originalWarn = console.warn
      console.warn = () => {}
      try {
        const chains = await buildChains(date)

        // 降级为规则推断，应识别出 enables
        const enablesChain = chains.find((c) => c.relation === 'enables')
        expect(enablesChain).toBeDefined()
      } finally {
        console.warn = originalWarn
      }
    })
  })

  // ===================== 时间窗口 =====================

  describe('时间窗口', () => {
    it('30 分钟内的非相邻对也参与因果推断', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      // 三条 MemCell，mc-1 与 mc-3 不相邻但相差 25 分钟（<30min）
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-2',
        'ce-1',
        `${date}T10:10:00.000Z`,
        'coding',
        '用户编写了部分代码',
        []
      )
      insertMemCell(
        db,
        'mc-3',
        'ce-1',
        `${date}T10:25:00.000Z`,
        'coding',
        '用户完成了实现',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      // 应包含 mc-1 → mc-2、mc-2 → mc-3、mc-1 → mc-3 三种候选对
      // mc-1 (reading) → mc-2 (coding) 为 enables
      // mc-1 (reading) → mc-3 (coding) 为 enables（非相邻但窗口内）
      const enablesChains = chains.filter((c) => c.relation === 'enables')
      expect(enablesChains.length).toBeGreaterThanOrEqual(1)
      // 至少存在 mc-1 → mc-2 或 mc-1 → mc-3 的 enables 关系
      const hasMc1Cause = enablesChains.some((c) => c.causeCellId === 'mc-1')
      expect(hasMc1Cause).toBe(true)
    })

    it('超过 30 分钟的非相邻对不参与因果推断', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      // mc-1 与 mc-3 相差 35 分钟（>30min），不应构成候选对
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-2',
        'ce-1',
        `${date}T10:05:00.000Z`,
        'coding',
        '用户编写了代码',
        []
      )
      insertMemCell(
        db,
        'mc-3',
        'ce-1',
        `${date}T10:35:00.000Z`,
        'coding',
        '用户继续工作',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      // mc-1 → mc-3 不应出现（超过 30 分钟窗口）
      const mc1ToMc3 = chains.find(
        (c) => c.causeCellId === 'mc-1' && c.effectCellId === 'mc-3'
      )
      expect(mc1ToMc3).toBeUndefined()
    })
  })

  // ===================== 持久化 =====================

  describe('持久化到 causal_chains 表', () => {
    it('buildChains 结果写入 causal_chains，getByDate 可读回', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-doc',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-impl',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      const chains = await buildChains(date)

      // 通过 Repository 读回
      const stored = CausalChainRepository.getByDate(date)
      expect(stored.length).toBe(chains.length)
      expect(stored[0].causeCellId).toBe(chains[0].causeCellId)
      expect(stored[0].effectCellId).toBe(chains[0].effectCellId)
      expect(stored[0].relation).toBe(chains[0].relation)
    })

    it('getByCauseCellId 查询作为原因的链', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-doc',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-impl',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      await buildChains(date)

      const asCause = CausalChainRepository.getByCauseCellId('mc-doc')
      expect(asCause.length).toBeGreaterThanOrEqual(1)
      expect(asCause.every((c) => c.causeCellId === 'mc-doc')).toBe(true)
    })

    it('getByEffectCellId 查询作为结果的链', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-doc',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-impl',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      vi.mocked(SettingsStore.getApiKey).mockReturnValueOnce('')

      await buildChains(date)

      const asEffect = CausalChainRepository.getByEffectCellId('mc-impl')
      expect(asEffect.length).toBeGreaterThanOrEqual(1)
      expect(asEffect.every((c) => c.effectCellId === 'mc-impl')).toBe(true)
    })

    it('getByDate 查询不存在日期返回空数组', () => {
      expect(CausalChainRepository.getByDate('2099-01-01')).toEqual([])
    })

    it('getByCauseCellId/getByEffectCellId 查询不存在 ID 返回空数组', () => {
      expect(CausalChainRepository.getByCauseCellId('nonexistent')).toEqual([])
      expect(CausalChainRepository.getByEffectCellId('nonexistent')).toEqual([])
    })
  })

  // ===================== 空数据 =====================

  describe('空数据', () => {
    it('当日无 MemCell 时返回空数组', async () => {
      const date = '2026-06-21'

      const chains = await buildChains(date)

      expect(chains).toEqual([])
      expect(OpenAIClient.chatCompletion).not.toHaveBeenCalled()
    })

    it('当日仅 1 条 MemCell 时返回空数组', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'coding',
        '用户进行了编码',
        []
      )

      const chains = await buildChains(date)

      expect(chains).toEqual([])
      expect(OpenAIClient.chatCompletion).not.toHaveBeenCalled()
    })
  })

  // ===================== AI 返回解析容错 =====================

  describe('AI 返回解析', () => {
    it('AI 返回非候选对的 cellId 时被过滤', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-2',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      // AI 返回不存在的 cellId
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: JSON.stringify({
          chains: [
            {
              causeCellId: 'nonexistent',
              effectCellId: 'mc-2',
              relation: 'enables',
              confidence: 0.9,
              evidence: '不存在的原因'
            }
          ]
        }),
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop'
      })

      const chains = await buildChains(date)

      // 不存在的 cellId 被过滤，返回空
      expect(chains).toEqual([])
    })

    it('AI 返回无效 relation 时被过滤', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-2',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: JSON.stringify({
          chains: [
            {
              causeCellId: 'mc-1',
              effectCellId: 'mc-2',
              relation: 'invalid_relation',
              confidence: 0.9,
              evidence: '无效关系'
            }
          ]
        }),
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop'
      })

      const chains = await buildChains(date)

      expect(chains).toEqual([])
    })

    it('AI 返回非 JSON 时降级为规则推断', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-2',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      // AI 返回非 JSON 文本
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: '这不是 JSON',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop'
      })

      const chains = await buildChains(date)

      // 降级为规则推断，应识别出 enables
      const enablesChain = chains.find((c) => c.relation === 'enables')
      expect(enablesChain).toBeDefined()
    })

    it('confidence 被限制在 0-1 范围', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-1',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-2',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: JSON.stringify({
          chains: [
            {
              causeCellId: 'mc-1',
              effectCellId: 'mc-2',
              relation: 'enables',
              confidence: 1.5,
              evidence: '超高置信度'
            }
          ]
        }),
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: 'stop'
      })

      const chains = await buildChains(date)

      expect(chains[0].confidence).toBeLessThanOrEqual(1)
      expect(chains[0].confidence).toBeGreaterThanOrEqual(0)
    })
  })

  // ===================== DailyDistillManager 集成触发 =====================

  describe('DailyDistillManager 集成触发', () => {
    it('distillDay 完成后自动触发 buildChains', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(
        db,
        'mc-doc',
        'ce-1',
        `${date}T10:00:00.000Z`,
        'reading',
        '用户查阅了文档',
        []
      )
      insertMemCell(
        db,
        'mc-impl',
        'ce-1',
        `${date}T10:30:00.000Z`,
        'coding',
        '用户实现了功能',
        []
      )

      // 动态导入避免顶层 mock 顺序问题
      const { distillDay } = await import('../DailyDistillManager')

      // mock AI 摘要生成（distillDay 内部调用）+ 因果推断（buildChains 内部调用）
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValue({
        content: JSON.stringify({
          chains: [
            {
              causeCellId: 'mc-doc',
              effectCellId: 'mc-impl',
              relation: 'enables',
              confidence: 0.9,
              evidence: '查阅文档使实现成为可能'
            }
          ]
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop'
      })

      await distillDay(date)

      // 验证 causal_chains 表已写入
      const stored = CausalChainRepository.getByDate(date)
      expect(stored.length).toBeGreaterThanOrEqual(1)
      const enablesChain = stored.find((c) => c.relation === 'enables')
      expect(enablesChain).toBeDefined()
    })
  })
})
