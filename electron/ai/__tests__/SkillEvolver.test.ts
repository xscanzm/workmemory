/**
 * SkillEvolver 技能进化引擎测试（Task R2）
 *
 * 测试内容：
 *  - R2.7 验证：构造 3 个"数据库迁移"主题 MemCell（通过 MemScene 关联），确认生成技能卡
 *  - 规则提炼（AI 不可用降级）：
 *    - steps：从 episode 中提取动作句子（含"实现/编写/测试"等动词）
 *    - traps：从 facts 中提取含"错误/失败/注意"关键词的事实
 *    - insights：从 foresight.statement 中提取
 *  - AI 提炼：mock OpenAIClient 返回结构化技能卡，覆盖规则结果
 *  - AI 降级：AI 返回不可解析 / 调用失败时降级为规则提炼
 *  - 去重：同 title 已存在时不重复生成
 *  - 阈值过滤：成员 <3 的 MemScene 不触发技能进化
 *  - 持久化：SkillRepository.insert/getById/getAll/getByTitle 可读回
 *
 * 运行方式：npx vitest run electron/ai/__tests__/SkillEvolver.test.ts
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
import { MemCellRepository } from '../../db/repositories/MemCellRepository'
import { MemSceneRepository } from '../../db/repositories/MemSceneRepository'
import { SkillRepository } from '../../db/repositories/SkillRepository'
import { evolveSkills } from '../SkillEvolver'
import type { Skill } from '../SkillEvolver'
import type { MemCell, MemCellMetadata } from '../../memory/MemCell'
import type { MemScene } from '../../memory/MemSceneClusterer'
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

/** 直接用 SQL 插入最小化 clean_episodes 行（满足 memory_cells 的 FK 约束） */
function insertCleanEpisode(db: DatabaseType, id: string, date: string): void {
  db.prepare(
    `INSERT INTO clean_episodes (
      id, date, hour_bucket, start_time, end_time, title, summary,
      memory_kind, project, entities, topics, materials, outputs, todos,
      blockers, segment_ids, evidence_refs, source_quality, confidence,
      report_eligible, wiki_eligible, wiki_status, created_at, updated_at,
      model_name, distill_version
    ) VALUES (
      @id, @date, '', '00:00:00', '00:00:00', '', '', 'work', '', '[]', '[]',
      '[]', '[]', '[]', '[]', '[]', '[]', 'medium', 0.5, 1, 0, 'none',
      @createdAt, @createdAt, '', ''
    )`
  ).run({ id, date, createdAt: `${date}T00:00:00.000Z` })
}

/** 构造并插入一个 MemCell（数据库迁移主题） */
function seedMigrationMemCell(
  db: DatabaseType,
  id: string,
  createdAt: string,
  options: {
    episode: string
    facts: string[]
    foresightStatements: string[]
  }
): MemCell {
  // 先插入关联的 clean_episode（满足 FK 约束）
  const date = createdAt.slice(0, 10)
  insertCleanEpisode(db, `clean-ep-${id}`, date)

  const metadata: MemCellMetadata = {
    segmentIds: [],
    timestamp: createdAt,
    confidence: 0.8
  }
  const cell: MemCell = {
    id,
    cleanEpisodeId: `clean-ep-${id}`,
    episode: options.episode,
    facts: options.facts,
    foresight: options.foresightStatements.map((statement) => ({
      statement,
      validFrom: createdAt,
      validTo: '2099-12-31',
      confidence: 0.8
    })),
    metadata,
    createdAt
  }
  MemCellRepository.insert(cell)
  return cell
}

/** 构造并插入一个 MemScene（关联指定 MemCell IDs） */
function seedMemScene(sceneId: string, title: string, memberCellIds: string[]): MemScene {
  const scene: MemScene = {
    id: sceneId,
    title,
    centroidEmbedding: new Float32Array([0.1, 0.2, 0.3]),
    memberCellIds,
    summary: '',
    createdAt: '2026-06-21T00:00:00.000Z',
    updatedAt: '2026-06-21T00:00:00.000Z'
  }
  MemSceneRepository.insert(scene)
  return scene
}

/** 构造 3 个"数据库迁移"主题 MemCell + 关联 MemScene */
function seedMigrationTheme(db: DatabaseType): { cells: MemCell[]; scene: MemScene } {
  const cell1 = seedMigrationMemCell(
    db,
    'mc-migration-1',
    '2026-06-15T09:00:00.000Z',
    {
      episode:
        '用户在 VS Code 中分析了现有 schema。用户编写了迁移脚本，添加了新字段。用户测试了迁移脚本，验证数据完整性。',
      facts: [
        '使用了 ALTER TABLE 添加字段',
        '忘记处理回滚导致迁移失败',
        '未测试大数据量性能，出现注意点'
      ],
      foresightStatements: [
        '使用 ALTER TABLE 比重建表更安全',
        '迁移前应备份完整数据库'
      ]
    }
  )
  const cell2 = seedMigrationMemCell(
    db,
    'mc-migration-2',
    '2026-06-16T10:00:00.000Z',
    {
      episode:
        '用户实现了数据迁移工具。用户执行了迁移，处理了字段类型转换。用户验证了迁移结果，修复了错误。',
      facts: [
        '字段类型转换错误导致数据丢失',
        '使用事务保证迁移原子性',
        '注意索引重建耗时较长'
      ],
      foresightStatements: [
        '迁移应在低峰期执行以减少影响',
        '事务回滚是处理迁移失败的关键机制'
      ]
    }
  )
  const cell3 = seedMigrationMemCell(
    db,
    'mc-migration-3',
    '2026-06-17T14:00:00.000Z',
    {
      episode:
        '用户设计了分阶段迁移方案。用户部署了迁移脚本到生产环境。用户监控了迁移过程，记录了性能指标。',
      facts: [
        '分阶段迁移降低了风险',
        '未监控迁移过程导致问题延迟发现',
        '注意生产环境数据量远超测试环境'
      ],
      foresightStatements: [
        '分阶段迁移是处理大型 schema 变更的最佳实践',
        '迁移过程需要实时监控与告警'
      ]
    }
  )
  const scene = seedMemScene('scene-migration', '数据库迁移工作流', [
    cell1.id,
    cell2.id,
    cell3.id
  ])
  return { cells: [cell1, cell2, cell3], scene }
}

describe('SkillEvolver', () => {
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

  // ===================== R2.7 验证：3 个数据库迁移 MemCell 生成技能卡 =====================

  describe('R2.7 数据库迁移主题生成技能卡', () => {
    it('3 个数据库迁移 MemCell（通过 MemScene 关联）生成技能卡', async () => {
      const { cells, scene } = seedMigrationTheme(db)

      const skills = await evolveSkills()

      expect(skills).toHaveLength(1)
      const skill = skills[0]
      expect(skill.title).toBe(scene.title)
      // steps 应从 episode 中提取动作句子（含动词关键词）
      expect(skill.steps.length).toBeGreaterThan(0)
      // 至少有一条 step 含动作关键词（实现/编写/测试/分析/设计/部署/执行/验证/监控/处理/修复 等）
      expect(
        skill.steps.some((s) =>
          ['实现', '编写', '测试', '分析', '设计', '部署', '执行', '验证', '监控', '处理', '修复', '添加'].some(
            (kw) => s.includes(kw)
          )
        )
      ).toBe(true)
      // traps 应从 facts 中提取含陷阱关键词的事实
      expect(skill.traps.length).toBeGreaterThan(0)
      expect(
        skill.traps.some((t) =>
          ['错误', '失败', '注意'].some((kw) => t.includes(kw))
        )
      ).toBe(true)
      // insights 应从 foresight.statement 中提取
      expect(skill.insights.length).toBeGreaterThan(0)
      // sourceCellIds 应包含全部 3 个 MemCell ID
      expect(skill.sourceCellIds).toHaveLength(3)
      for (const c of cells) {
        expect(skill.sourceCellIds).toContain(c.id)
      }
      // confidence 在 [0, 1]
      expect(skill.confidence).toBeGreaterThanOrEqual(0)
      expect(skill.confidence).toBeLessThanOrEqual(1)
      // evolvedAt 是有效 ISO 时间戳
      expect(new Date(skill.evolvedAt).getTime()).not.toBeNaN()
      // id 是非空字符串
      expect(skill.id.length).toBeGreaterThan(0)
    })

    it('技能卡含 title/steps/traps/insights/sourceCellIds/confidence/evolvedAt 七个字段', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill = skills[0]

      expect(typeof skill.id).toBe('string')
      expect(typeof skill.title).toBe('string')
      expect(Array.isArray(skill.steps)).toBe(true)
      expect(Array.isArray(skill.traps)).toBe(true)
      expect(Array.isArray(skill.insights)).toBe(true)
      expect(Array.isArray(skill.sourceCellIds)).toBe(true)
      expect(typeof skill.confidence).toBe('number')
      expect(typeof skill.evolvedAt).toBe('string')
    })
  })

  // ===================== 规则提炼（AI 不可用降级） =====================

  describe('规则提炼（AI 不可用降级）', () => {
    it('steps 从 episode 提取动作句子并按时间排序编号', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill = skills[0]

      // 应有多个步骤
      expect(skill.steps.length).toBeGreaterThan(0)
      // 步骤应以序号开头（"1. "、"2. " 等）
      expect(skill.steps[0]).toMatch(/^\d+\.\s/)
    })

    it('traps 从 facts 提取含陷阱关键词的事实', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill = skills[0]

      // 应提取到含"错误/失败/注意"等关键词的 facts
      expect(skill.traps.length).toBeGreaterThan(0)
      for (const trap of skill.traps) {
        expect(
          ['错误', '失败', '注意', '陷阱', '坑', '问题', 'bug', '异常', '风险'].some(
            (kw) => trap.toLowerCase().includes(kw.toLowerCase())
          )
        ).toBe(true)
      }
    })

    it('insights 从 foresight.statement 提取', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill = skills[0]

      // 应提取到 foresight statement
      expect(skill.insights.length).toBeGreaterThan(0)
      // 应包含原始 foresight 中的某些陈述片段
      const allInsights = skill.insights.join(' ')
      expect(
        ['ALTER TABLE', '事务', '分阶段', '监控', '备份', '低峰期'].some((kw) =>
          allInsights.includes(kw)
        )
      ).toBe(true)
    })

    it('confidence 基于成员数与内容丰富度计算（0-1）', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill = skills[0]

      // 3 个成员 + 有 steps/traps/insights → 应有较高置信度
      expect(skill.confidence).toBeGreaterThan(0)
      expect(skill.confidence).toBeLessThanOrEqual(0.9) // 规则提炼上限 0.9
    })
  })

  // ===================== AI 提炼 =====================

  describe('AI 提炼', () => {
    it('AI 可用时返回的技能卡覆盖规则结果', async () => {
      seedMigrationTheme(db)

      // 配置 API Key
      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: JSON.stringify({
          title: 'AI 数据库迁移工作流',
          steps: [
            '1. AI 分析 schema',
            '2. AI 编写迁移脚本',
            '3. AI 测试迁移'
          ],
          traps: ['AI 陷阱：忘记回滚', 'AI 陷阱：未测试大数据量'],
          insights: ['AI 洞察：使用事务保证原子性'],
          confidence: 0.95
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop'
      })

      const skills = await evolveSkills()
      const skill = skills[0]

      expect(skill.title).toBe('AI 数据库迁移工作流')
      expect(skill.steps).toHaveLength(3)
      expect(skill.steps[0]).toBe('1. AI 分析 schema')
      expect(skill.traps).toHaveLength(2)
      expect(skill.traps[0]).toBe('AI 陷阱：忘记回滚')
      expect(skill.insights).toHaveLength(1)
      expect(skill.insights[0]).toBe('AI 洞察：使用事务保证原子性')
      expect(skill.confidence).toBe(0.95)
    })

    it('AI 返回不可解析时降级为规则提炼', async () => {
      seedMigrationTheme(db)

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: '这不是 JSON',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop'
      })

      const skills = await evolveSkills()
      const skill = skills[0]

      // 应使用规则结果（title 取自 MemScene，steps 含动作关键词）
      expect(skill.title).toBe('数据库迁移工作流')
      expect(skill.steps.length).toBeGreaterThan(0)
      expect(
        skill.steps.some((s) =>
          ['实现', '编写', '测试', '分析', '设计', '部署', '执行', '验证', '监控', '处理', '修复', '添加'].some(
            (kw) => s.includes(kw)
          )
        )
      ).toBe(true)
    })

    it('AI 调用失败时降级为规则提炼', async () => {
      seedMigrationTheme(db)

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockRejectedValueOnce(new Error('网络错误'))

      const skills = await evolveSkills()
      const skill = skills[0]

      // 应使用规则结果
      expect(skill.title).toBe('数据库迁移工作流')
      expect(skill.steps.length).toBeGreaterThan(0)
    })

    it('AI 返回空数组时回退到规则提炼对应字段', async () => {
      seedMigrationTheme(db)

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: JSON.stringify({
          title: '',
          steps: [],
          traps: [],
          insights: []
        }),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop'
      })

      const skills = await evolveSkills()
      const skill = skills[0]

      // title 为空时回退到 MemScene.title
      expect(skill.title).toBe('数据库迁移工作流')
      // steps/traps/insights 为空时回退到规则提炼
      expect(skill.steps.length).toBeGreaterThan(0)
      expect(skill.traps.length).toBeGreaterThan(0)
      expect(skill.insights.length).toBeGreaterThan(0)
    })
  })

  // ===================== 阈值过滤 =====================

  describe('阈值过滤', () => {
    it('成员 <3 的 MemScene 不触发技能进化', async () => {
      // 构造只有 2 个成员的 MemScene
      const cell1 = seedMigrationMemCell(
        db,
        'mc-small-1',
        '2026-06-15T09:00:00.000Z',
        {
          episode: '用户编写了脚本。',
          facts: ['出现错误'],
          foresightStatements: ['需要测试']
        }
      )
      const cell2 = seedMigrationMemCell(
        db,
        'mc-small-2',
        '2026-06-16T10:00:00.000Z',
        {
          episode: '用户测试了脚本。',
          facts: ['注意边界'],
          foresightStatements: ['需要监控']
        }
      )
      seedMemScene('scene-small', '小型主题', [cell1.id, cell2.id])

      const skills = await evolveSkills()

      expect(skills).toHaveLength(0)
    })

    it('无 MemScene 时返回空数组', async () => {
      const skills = await evolveSkills()
      expect(skills).toEqual([])
    })
  })

  // ===================== 去重 =====================

  describe('去重', () => {
    it('同 title 已存在时不重复生成', async () => {
      seedMigrationTheme(db)

      const firstRun = await evolveSkills()
      expect(firstRun).toHaveLength(1)

      // 第二次调用：同 title 已存在，应跳过
      const secondRun = await evolveSkills()
      expect(secondRun).toHaveLength(0)

      // skills 表中仍只有 1 条
      expect(SkillRepository.getAll()).toHaveLength(1)
    })

    it('不同 title 的 MemScene 各自生成技能卡', async () => {
      seedMigrationTheme(db)

      // 再构造一个不同主题的 MemScene（3 个成员）
      const cellA = seedMigrationMemCell(
        db,
        'mc-deploy-a',
        '2026-06-18T09:00:00.000Z',
        {
          episode: '用户部署了应用。用户验证了部署。',
          facts: ['部署失败，回滚到上一版本'],
          foresightStatements: ['蓝绿部署可降低风险']
        }
      )
      const cellB = seedMigrationMemCell(
        db,
        'mc-deploy-b',
        '2026-06-19T10:00:00.000Z',
        {
          episode: '用户实现了 CI/CD 流水线。',
          facts: ['注意流水线超时配置'],
          foresightStatements: ['自动化部署提升效率']
        }
      )
      const cellC = seedMigrationMemCell(
        db,
        'mc-deploy-c',
        '2026-06-20T14:00:00.000Z',
        {
          episode: '用户监控了部署过程。',
          facts: ['未配置告警导致问题延迟发现'],
          foresightStatements: ['部署需配合监控告警']
        }
      )
      seedMemScene('scene-deploy', '应用部署工作流', [cellA.id, cellB.id, cellC.id])

      const skills = await evolveSkills()
      expect(skills).toHaveLength(2)
      const titles = skills.map((s) => s.title).sort()
      expect(titles).toEqual(['应用部署工作流', '数据库迁移工作流'])
    })
  })

  // ===================== 持久化 =====================

  describe('持久化到 skills 表', () => {
    it('evolveSkills 结果写入 skills 表，getById 可读回', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill = skills[0]

      const stored = SkillRepository.getById(skill.id)
      expect(stored).not.toBeNull()
      expect(stored!.id).toBe(skill.id)
      expect(stored!.title).toBe(skill.title)
      expect(stored!.steps).toEqual(skill.steps)
      expect(stored!.traps).toEqual(skill.traps)
      expect(stored!.insights).toEqual(skill.insights)
      expect(stored!.sourceCellIds).toEqual(skill.sourceCellIds)
      expect(stored!.confidence).toBe(skill.confidence)
      expect(stored!.evolvedAt).toBe(skill.evolvedAt)
    })

    it('getByTitle 可读回技能卡（用于去重）', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill = skills[0]

      const stored = SkillRepository.getByTitle(skill.title)
      expect(stored).not.toBeNull()
      expect(stored!.title).toBe(skill.title)
    })

    it('getAll 返回全部技能卡（按 evolved_at 升序）', async () => {
      seedMigrationTheme(db)

      await evolveSkills()

      const all = SkillRepository.getAll()
      expect(all).toHaveLength(1)
      expect(all[0].title).toBe('数据库迁移工作流')
    })

    it('getById 查询不存在返回 null', async () => {
      expect(SkillRepository.getById('non-existent-id')).toBeNull()
    })

    it('getByTitle 查询不存在返回 null', async () => {
      expect(SkillRepository.getByTitle('不存在的标题')).toBeNull()
    })
  })

  // ===================== 技能卡完整性 =====================

  describe('技能卡完整性', () => {
    it('完整 3 个 MemCell 时技能卡含 steps/traps/insights 三类内容', async () => {
      seedMigrationTheme(db)

      const skills = await evolveSkills()
      const skill: Skill = skills[0]

      expect(skill.steps.length).toBeGreaterThan(0)
      expect(skill.traps.length).toBeGreaterThan(0)
      expect(skill.insights.length).toBeGreaterThan(0)
      expect(skill.sourceCellIds).toHaveLength(3)
      expect(skill.confidence).toBeGreaterThan(0)
      expect(skill.confidence).toBeLessThanOrEqual(1)
    })

    it('部分成员 MemCell 不存在时仍能从可用成员提炼', async () => {
      // 构造 4 个成员的 MemScene，但其中 1 个 MemCell 不存在
      const cell1 = seedMigrationMemCell(
        db,
        'mc-partial-1',
        '2026-06-15T09:00:00.000Z',
        {
          episode: '用户分析了 schema。用户编写了迁移脚本。',
          facts: ['忘记处理回滚导致失败'],
          foresightStatements: ['迁移前应备份']
        }
      )
      const cell2 = seedMigrationMemCell(
        db,
        'mc-partial-2',
        '2026-06-16T10:00:00.000Z',
        {
          episode: '用户测试了迁移脚本。',
          facts: ['注意性能问题'],
          foresightStatements: ['需要监控']
        }
      )
      const cell3 = seedMigrationMemCell(
        db,
        'mc-partial-3',
        '2026-06-17T14:00:00.000Z',
        {
          episode: '用户部署了迁移。',
          facts: ['部署错误，已回滚'],
          foresightStatements: ['分阶段部署更安全']
        }
      )
      // 第 4 个成员 ID 不存在于 memory_cells 表
      seedMemScene('scene-partial', '部分缺失主题', [
        cell1.id,
        cell2.id,
        cell3.id,
        'mc-non-existent'
      ])

      const skills = await evolveSkills()
      // 可用成员 3 个 ≥3，应正常生成技能卡
      expect(skills).toHaveLength(1)
      const skill = skills[0]
      expect(skill.sourceCellIds).toHaveLength(3) // 不含不存在的 ID
      expect(skill.sourceCellIds).not.toContain('mc-non-existent')
    })
  })
})
