/**
 * UserProfileEvolver 单元测试（Task M7）
 *
 * 测试内容：
 *  - M7.6 验证：构造 7 天编码活动 MemCell + MemScene，确认 user_profile 含
 *    primary_activity=coding, type=stable，且置信度随跨日一致性累积
 *  - primary_activity 提取：众数统计，忽略 idle
 *  - current_focus 提取：transient 类型，valid_to = 当日 + 7 天
 *  - preferred_apps 提取：从 segment appName 统计 top 3
 *  - work_pattern 提取：活动时段统计
 *  - 同日幂等：重复调用 evolveProfile 不重复累积置信度
 *  - UserProfileRepository CRUD：upsert/get/getStable/getTransient/getAll
 *
 * 运行方式：npx vitest run electron/memory/__tests__/UserProfileEvolver.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

// Mock electron 模块（SettingsStore 传递性依赖 electron 的 app/safeStorage）
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
import { MemCellRepository } from '../../db/repositories/MemCellRepository'
import { MemSceneRepository } from '../../db/repositories/MemSceneRepository'
import {
  UserProfileRepository,
  type UserProfileEntry
} from '../../db/repositories/UserProfileRepository'
import { evolveProfile } from '../UserProfileEvolver'
import type { MemCell, MemCellMetadata } from '../MemCell'
import type { MemScene } from '../MemSceneClusterer'

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

/** 插入一条最小 segments 行（用于 preferred_apps 测试） */
function insertSegment(
  db: DatabaseType,
  id: string,
  date: string,
  appName: string
): void {
  db.prepare(
    `INSERT INTO segments (id, date, start_time, end_time, app_name)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, date, '10:00:00', '10:30:00', appName)
}

/** 构造并插入 MemCell（含 activityType 和 segmentIds 元数据） */
function insertMemCell(
  db: DatabaseType,
  id: string,
  cleanEpisodeId: string,
  createdAt: string,
  activityType: string,
  segmentIds: string[] = []
): void {
  const metadata: MemCellMetadata = {
    segmentIds,
    timestamp: createdAt,
    confidence: 0.9,
    activityType,
    contentType: 'code'
  }
  const memCell: MemCell = {
    id,
    cleanEpisodeId,
    episode: `用户进行了 ${activityType} 活动`,
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
  updatedAt: string
): void {
  void db
  const scene: MemScene = {
    id,
    title,
    centroidEmbedding: new Float32Array(1).fill(0.5),
    memberCellIds,
    summary: '',
    createdAt: updatedAt,
    updatedAt
  }
  MemSceneRepository.insert(scene)
}

/** 生成 2026-06-15 起的第 n 天日期（YYYY-MM-DD） */
function dayOffset(n: number): string {
  const d = new Date('2026-06-15T00:00:00.000Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

describe('UserProfileEvolver', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== M7.6 验证：7 天编码活动 =====================

  describe('7 天编码活动画像演进', () => {
    it('7 天编码活动后 user_profile 含 primary_activity=coding, type=stable', async () => {
      // 构造 7 天数据：每天 3 个 coding MemCell + 1 个 browsing MemCell
      for (let day = 0; day < 7; day++) {
        const date = dayOffset(day)
        const ceId = `ce-${day}`
        insertCleanEpisode(db, ceId, date)

        // 3 个 coding MemCell（上午 10 点）
        for (let j = 0; j < 3; j++) {
          insertMemCell(
            db,
            `mc-${day}-${j}`,
            ceId,
            `${date}T10:0${j}:00.000Z`,
            'coding'
          )
        }
        // 1 个 browsing MemCell（下午 14 点）
        insertMemCell(
          db,
          `mc-${day}-b`,
          ceId,
          `${date}T14:00:00.000Z`,
          'browsing'
        )
      }

      // 逐日演进画像
      for (let day = 0; day < 7; day++) {
        await evolveProfile(dayOffset(day))
      }

      // 验证 primary_activity
      const profile = UserProfileRepository.get('primary_activity')
      expect(profile).not.toBeNull()
      expect(profile!.key).toBe('primary_activity')
      expect(profile!.value).toBe('coding')
      expect(profile!.type).toBe('stable')
      // 基础置信度 = 3/4 = 0.75，7 天累积后应接近上限 0.95
      expect(profile!.confidence).toBeGreaterThan(0.7)
      expect(profile!.confidence).toBeLessThanOrEqual(0.95)
      // sources 应为当日 coding MemCell ID
      expect(profile!.sources.length).toBe(3)
      expect(profile!.sources.some((s) => s.startsWith('mc-6-'))).toBe(true)
    })

    it('置信度随跨日一致性逐步累积至上限 0.95', async () => {
      // 构造 5 天数据：每天 3 个 coding + 1 个 browsing（基础置信度 0.75）
      for (let day = 0; day < 5; day++) {
        const date = dayOffset(day)
        const ceId = `ce-${day}`
        insertCleanEpisode(db, ceId, date)
        for (let j = 0; j < 3; j++) {
          insertMemCell(db, `mc-${day}-${j}`, ceId, `${date}T10:00:00.000Z`, 'coding')
        }
        insertMemCell(db, `mc-${day}-b`, ceId, `${date}T14:00:00.000Z`, 'browsing')
      }

      // Day 1：无历史，置信度 = 0.75
      await evolveProfile(dayOffset(0))
      let profile = UserProfileRepository.get('primary_activity')!
      expect(profile.confidence).toBeCloseTo(0.75, 5)

      // Day 2：累积 +0.05 → 0.80
      await evolveProfile(dayOffset(1))
      profile = UserProfileRepository.get('primary_activity')!
      expect(profile.confidence).toBeCloseTo(0.8, 5)

      // Day 3：累积 +0.05 → 0.85
      await evolveProfile(dayOffset(2))
      profile = UserProfileRepository.get('primary_activity')!
      expect(profile.confidence).toBeCloseTo(0.85, 5)

      // Day 4：累积 +0.05 → 0.90
      await evolveProfile(dayOffset(3))
      profile = UserProfileRepository.get('primary_activity')!
      expect(profile.confidence).toBeCloseTo(0.9, 5)

      // Day 5：累积 +0.05 → 0.95（上限）
      await evolveProfile(dayOffset(4))
      profile = UserProfileRepository.get('primary_activity')!
      expect(profile.confidence).toBeCloseTo(0.95, 5)
    })

    it('活动类型变化时重置置信度', async () => {
      // Day 1：coding 活动
      const date1 = dayOffset(0)
      insertCleanEpisode(db, 'ce-0', date1)
      insertMemCell(db, 'mc-0-0', 'ce-0', `${date1}T10:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-0-1', 'ce-0', `${date1}T11:00:00.000Z`, 'coding')
      await evolveProfile(date1)
      let profile = UserProfileRepository.get('primary_activity')!
      expect(profile.value).toBe('coding')
      expect(profile.confidence).toBeCloseTo(1.0, 5)

      // Day 2：改为 writing 活动
      const date2 = dayOffset(1)
      insertCleanEpisode(db, 'ce-1', date2)
      insertMemCell(db, 'mc-1-0', 'ce-1', `${date2}T10:00:00.000Z`, 'writing')
      insertMemCell(db, 'mc-1-1', 'ce-1', `${date2}T11:00:00.000Z`, 'writing')
      await evolveProfile(date2)
      profile = UserProfileRepository.get('primary_activity')!
      expect(profile.value).toBe('writing')
      // 值变化，重置为基础置信度
      expect(profile.confidence).toBeCloseTo(1.0, 5)
    })
  })

  // ===================== primary_activity 提取 =====================

  describe('primary_activity 提取', () => {
    it('取出现次数最多的 activityType', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T12:00:00.000Z`, 'browsing')

      await evolveProfile(date)

      const profile = UserProfileRepository.get('primary_activity')!
      expect(profile.value).toBe('coding')
      // confidence = 2/3
      expect(profile.confidence).toBeCloseTo(2 / 3, 5)
    })

    it('忽略 idle 活动类型', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'idle')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, 'idle')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T12:00:00.000Z`, 'coding')

      await evolveProfile(date)

      const profile = UserProfileRepository.get('primary_activity')!
      expect(profile.value).toBe('coding')
      // idle 被忽略，只有 1 个 coding，confidence = 1/1 = 1.0
      expect(profile.confidence).toBeCloseTo(1.0, 5)
    })

    it('无有效活动数据时不写入 primary_activity', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'idle')

      await evolveProfile(date)

      expect(UserProfileRepository.get('primary_activity')).toBeNull()
    })
  })

  // ===================== current_focus 提取 =====================

  describe('current_focus 提取', () => {
    it('从当日活跃 MemScene 提取最近更新的标题，type=transient', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding')

      // 插入 MemScene，成员包含当日 MemCell
      insertMemScene(db, 'scene-1', '数据库迁移工作', ['mc-1'], `${date}T12:00:00.000Z`)

      await evolveProfile(date)

      const profile = UserProfileRepository.get('current_focus')!
      expect(profile.value).toBe('数据库迁移工作')
      expect(profile.type).toBe('transient')
      expect(profile.sources).toEqual(['scene-1'])
      // validTo = 当日 + 7 天
      const expectedValidTo = dayOffset(7)
      expect(profile.validTo).toBe(expectedValidTo)
    })

    it('取最近更新的 MemScene 标题', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, 'coding')

      // 两个 MemScene，第二个 updatedAt 更晚
      insertMemScene(db, 'scene-old', '旧主题', ['mc-1'], `${date}T10:30:00.000Z`)
      insertMemScene(db, 'scene-new', '新主题', ['mc-2'], `${date}T11:30:00.000Z`)

      await evolveProfile(date)

      const profile = UserProfileRepository.get('current_focus')!
      expect(profile.value).toBe('新主题')
    })

    it('无活跃 MemScene 时不写入 current_focus', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding')

      // MemScene 成员不含当日 MemCell
      insertMemScene(db, 'scene-other', '其他主题', ['mc-other'], `${date}T12:00:00.000Z`)

      await evolveProfile(date)

      expect(UserProfileRepository.get('current_focus')).toBeNull()
    })

    it('每次更新覆盖旧值', async () => {
      const date1 = dayOffset(0)
      insertCleanEpisode(db, 'ce-0', date1)
      insertMemCell(db, 'mc-0', 'ce-0', `${date1}T10:00:00.000Z`, 'coding')
      insertMemScene(db, 'scene-0', '主题A', ['mc-0'], `${date1}T12:00:00.000Z`)
      await evolveProfile(date1)
      expect(UserProfileRepository.get('current_focus')!.value).toBe('主题A')

      const date2 = dayOffset(1)
      insertCleanEpisode(db, 'ce-1', date2)
      insertMemCell(db, 'mc-1', 'ce-1', `${date2}T10:00:00.000Z`, 'coding')
      insertMemScene(db, 'scene-1', '主题B', ['mc-1'], `${date2}T12:00:00.000Z`)
      await evolveProfile(date2)
      expect(UserProfileRepository.get('current_focus')!.value).toBe('主题B')
    })
  })

  // ===================== preferred_apps 提取 =====================

  describe('preferred_apps 提取', () => {
    it('从 segment appName 统计 top 3 应用', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)

      // 插入 segments
      insertSegment(db, 'seg-1', date, 'VS Code')
      insertSegment(db, 'seg-2', date, 'VS Code')
      insertSegment(db, 'seg-3', date, 'VS Code')
      insertSegment(db, 'seg-4', date, 'Chrome')
      insertSegment(db, 'seg-5', date, 'Chrome')
      insertSegment(db, 'seg-6', date, 'Terminal')

      // MemCell 关联 segments
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding', [
        'seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5', 'seg-6'
      ])

      await evolveProfile(date)

      const profile = UserProfileRepository.get('preferred_apps')!
      expect(profile.type).toBe('stable')
      const apps = profile.value.split(',')
      expect(apps).toHaveLength(3)
      expect(apps[0]).toBe('VS Code')
      expect(apps).toContain('Chrome')
      expect(apps).toContain('Terminal')
      // confidence = top1 频率 / 总数 = 3/6 = 0.5
      expect(profile.confidence).toBeCloseTo(0.5, 5)
    })

    it('无 segment 数据时不写入 preferred_apps', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding')

      await evolveProfile(date)

      expect(UserProfileRepository.get('preferred_apps')).toBeNull()
    })
  })

  // ===================== work_pattern 提取 =====================

  describe('work_pattern 提取', () => {
    it('取最活跃时段（上午）', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      // 上午 10 点 3 个，下午 14 点 1 个
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T10:30:00.000Z`, 'coding')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T11:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-4', 'ce-1', `${date}T14:00:00.000Z`, 'browsing')

      await evolveProfile(date)

      const profile = UserProfileRepository.get('work_pattern')!
      expect(profile.value).toBe('morning')
      expect(profile.type).toBe('stable')
      // confidence = 3/4
      expect(profile.confidence).toBeCloseTo(0.75, 5)
    })

    it('取最活跃时段（晚上）', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-1', date)
      // 晚上 20 点 2 个，上午 10 点 1 个
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T20:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T21:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-3', 'ce-1', `${date}T10:00:00.000Z`, 'browsing')

      await evolveProfile(date)

      const profile = UserProfileRepository.get('work_pattern')!
      expect(profile.value).toBe('evening')
    })

    it('无活动数据时不写入 work_pattern', async () => {
      const date = dayOffset(0)
      // 不插入任何 MemCell
      await evolveProfile(date)
      expect(UserProfileRepository.get('work_pattern')).toBeNull()
    })
  })

  // ===================== 同日幂等 =====================

  describe('同日幂等', () => {
    it('同日重复调用 evolveProfile 不重复累积置信度', async () => {
      const date = dayOffset(0)
      insertCleanEpisode(db, 'ce-0', date)
      insertMemCell(db, 'mc-0-0', 'ce-0', `${date}T10:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-0-1', 'ce-0', `${date}T11:00:00.000Z`, 'coding')
      insertMemCell(db, 'mc-0-2', 'ce-0', `${date}T12:00:00.000Z`, 'browsing')

      // 第一次调用
      await evolveProfile(date)
      const profile1 = UserProfileRepository.get('primary_activity')!
      const confidence1 = profile1.confidence

      // 同日第二次调用
      await evolveProfile(date)
      const profile2 = UserProfileRepository.get('primary_activity')!
      expect(profile2.confidence).toBe(confidence1)
    })
  })

  // ===================== 空数据 =====================

  describe('空数据', () => {
    it('当日无 MemCell 时不写入任何画像', async () => {
      await evolveProfile(dayOffset(0))
      expect(UserProfileRepository.getAll()).toHaveLength(0)
    })
  })
})

// ===================== UserProfileRepository CRUD =====================

describe('UserProfileRepository', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  function makeEntry(overrides: Partial<UserProfileEntry> = {}): UserProfileEntry {
    return {
      key: 'primary_activity',
      value: 'coding',
      type: 'stable',
      confidence: 0.85,
      sources: ['mc-1', 'mc-2'],
      updatedAt: '2026-06-21T10:00:00.000Z',
      ...overrides
    }
  }

  describe('upsert + get', () => {
    it('插入后可通过 key 查询', () => {
      const entry = makeEntry()
      UserProfileRepository.upsert(entry)

      const found = UserProfileRepository.get('primary_activity')
      expect(found).not.toBeNull()
      expect(found!.key).toBe('primary_activity')
      expect(found!.value).toBe('coding')
      expect(found!.type).toBe('stable')
      expect(found!.confidence).toBe(0.85)
      expect(found!.sources).toEqual(['mc-1', 'mc-2'])
      expect(found!.updatedAt).toBe('2026-06-21T10:00:00.000Z')
    })

    it('查询不存在的 key 返回 null', () => {
      expect(UserProfileRepository.get('nonexistent')).toBeNull()
    })

    it('upsert 同 key 时更新全部字段', () => {
      UserProfileRepository.upsert(makeEntry())
      UserProfileRepository.upsert(
        makeEntry({
          value: 'writing',
          confidence: 0.6,
          sources: ['mc-3'],
          updatedAt: '2026-06-22T10:00:00.000Z'
        })
      )

      const found = UserProfileRepository.get('primary_activity')!
      expect(found.value).toBe('writing')
      expect(found.confidence).toBe(0.6)
      expect(found.sources).toEqual(['mc-3'])
      expect(found.updatedAt).toBe('2026-06-22T10:00:00.000Z')
    })

    it('transient 类型带 validTo 字段正确往返', () => {
      UserProfileRepository.upsert(
        makeEntry({
          key: 'current_focus',
          value: '数据库迁移',
          type: 'transient',
          confidence: 1.0,
          validTo: '2026-06-28',
          sources: ['scene-1']
        })
      )

      const found = UserProfileRepository.get('current_focus')!
      expect(found.type).toBe('transient')
      expect(found.validTo).toBe('2026-06-28')
    })

    it('stable 类型 validTo 为 undefined', () => {
      UserProfileRepository.upsert(makeEntry())

      const found = UserProfileRepository.get('primary_activity')!
      expect(found.validTo).toBeUndefined()
    })
  })

  describe('getStable', () => {
    it('只返回 stable 类型条目', () => {
      UserProfileRepository.upsert(
        makeEntry({ key: 'primary_activity', type: 'stable' })
      )
      UserProfileRepository.upsert(
        makeEntry({ key: 'preferred_apps', type: 'stable' })
      )
      UserProfileRepository.upsert(
        makeEntry({ key: 'current_focus', type: 'transient' })
      )

      const stable = UserProfileRepository.getStable()
      expect(stable).toHaveLength(2)
      expect(stable.every((e) => e.type === 'stable')).toBe(true)
    })

    it('无 stable 条目时返回空数组', () => {
      UserProfileRepository.upsert(
        makeEntry({ key: 'current_focus', type: 'transient' })
      )
      expect(UserProfileRepository.getStable()).toEqual([])
    })
  })

  describe('getTransient', () => {
    it('只返回 transient 类型条目', () => {
      UserProfileRepository.upsert(
        makeEntry({ key: 'primary_activity', type: 'stable' })
      )
      UserProfileRepository.upsert(
        makeEntry({ key: 'current_focus', type: 'transient' })
      )

      const transient = UserProfileRepository.getTransient()
      expect(transient).toHaveLength(1)
      expect(transient[0].key).toBe('current_focus')
      expect(transient[0].type).toBe('transient')
    })

    it('无 transient 条目时返回空数组', () => {
      UserProfileRepository.upsert(
        makeEntry({ key: 'primary_activity', type: 'stable' })
      )
      expect(UserProfileRepository.getTransient()).toEqual([])
    })
  })

  describe('getAll', () => {
    it('返回全部条目（按 updated_at 降序）', () => {
      UserProfileRepository.upsert(
        makeEntry({ key: 'a', updatedAt: '2026-06-21T10:00:00.000Z' })
      )
      UserProfileRepository.upsert(
        makeEntry({ key: 'b', updatedAt: '2026-06-22T10:00:00.000Z' })
      )
      UserProfileRepository.upsert(
        makeEntry({ key: 'c', updatedAt: '2026-06-20T10:00:00.000Z' })
      )

      const all = UserProfileRepository.getAll()
      expect(all).toHaveLength(3)
      // 降序：b (6-22) > a (6-21) > c (6-20)
      expect(all[0].key).toBe('b')
      expect(all[1].key).toBe('a')
      expect(all[2].key).toBe('c')
    })

    it('空表返回空数组', () => {
      expect(UserProfileRepository.getAll()).toEqual([])
    })
  })
})
