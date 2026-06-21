/**
 * MemCellRepository 单元测试
 *
 * 使用内存数据库（:memory:）初始化 schema + 迁移后测试 CRUD。
 * 由于 memory_cells 通过外键关联 clean_episodes，每个测试先插入一条 clean_episodes 行。
 *
 * 运行方式：npx vitest run electron/db/repositories/__tests__/MemCellRepository.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

// Mock electron 模块，避免测试环境加载 native electron 二进制
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-userdata'
  }
}))

import { SCHEMA_SQL } from '../../schema'
import { runMigrations } from '../../migrations'
import {
  setDatabaseInstance,
  resetDatabaseInstance
} from '../../database'
import { MemCellRepository } from '../MemCellRepository'
import type { MemCell, MemCellMetadata, Foresight } from '../../../memory/MemCell'

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

/** 构造测试用 MemCell */
function makeMemCell(overrides: Partial<MemCell> & { id: string; cleanEpisodeId: string }): MemCell {
  const metadata: MemCellMetadata = {
    segmentIds: ['seg-1', 'seg-2'],
    timestamp: '2026-06-21T10:30:00.000Z',
    confidence: 0.85,
    activityType: 'coding',
    contentType: 'code'
  }
  const foresight: Foresight[] = [
    {
      statement: '未来涉及密钥存储时可复用此方案',
      validFrom: '2026-06-21',
      validTo: '2026-12-31',
      confidence: 0.8
    }
  ]
  return {
    episode: '用户在 VS Code 中实现了 API Key 加密功能',
    facts: ['使用了 safeStorage API', '密钥存储在 userData 目录'],
    foresight,
    metadata,
    createdAt: '2026-06-21T10:30:00.000Z',
    ...overrides
  }
}

describe('MemCellRepository', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== insert + getById =====================

  describe('insert + getById', () => {
    it('插入 MemCell 后可通过 ID 查询并正确反序列化所有字段', () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const memCell = makeMemCell({ id: 'mc-1', cleanEpisodeId: 'ce-1' })
      MemCellRepository.insert(memCell)

      const found = MemCellRepository.getById('mc-1')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('mc-1')
      expect(found!.cleanEpisodeId).toBe('ce-1')
      expect(found!.episode).toBe('用户在 VS Code 中实现了 API Key 加密功能')
      expect(found!.facts).toEqual(['使用了 safeStorage API', '密钥存储在 userData 目录'])
      expect(found!.foresight).toHaveLength(1)
      expect(found!.foresight[0].statement).toBe('未来涉及密钥存储时可复用此方案')
      expect(found!.foresight[0].validFrom).toBe('2026-06-21')
      expect(found!.foresight[0].validTo).toBe('2026-12-31')
      expect(found!.foresight[0].confidence).toBe(0.8)
      expect(found!.metadata.segmentIds).toEqual(['seg-1', 'seg-2'])
      expect(found!.metadata.timestamp).toBe('2026-06-21T10:30:00.000Z')
      expect(found!.metadata.confidence).toBe(0.85)
      expect(found!.metadata.activityType).toBe('coding')
      expect(found!.metadata.contentType).toBe('code')
      expect(found!.createdAt).toBe('2026-06-21T10:30:00.000Z')
    })

    it('查询不存在的 ID 返回 null', () => {
      expect(MemCellRepository.getById('nonexistent')).toBeNull()
    })

    it('插入时未提供 id 则自动生成 UUID', () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const memCell = makeMemCell({ id: '', cleanEpisodeId: 'ce-1' })
      MemCellRepository.insert(memCell)

      const all = db.prepare('SELECT * FROM memory_cells').all() as Array<{ id: string }>
      expect(all).toHaveLength(1)
      expect(all[0].id).not.toBe('')
      expect(all[0].id.length).toBeGreaterThan(10)
    })

    it('插入时未提供 createdAt 则自动生成 ISO 时间戳', () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const memCell = makeMemCell({ id: 'mc-auto-ts', cleanEpisodeId: 'ce-1', createdAt: '' })
      MemCellRepository.insert(memCell)

      const found = MemCellRepository.getById('mc-auto-ts')
      expect(found).not.toBeNull()
      expect(found!.createdAt).not.toBe('')
      // ISO 时间戳格式校验
      expect(found!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('空 facts 和 foresight 数组正确序列化与反序列化', () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const memCell = makeMemCell({
        id: 'mc-empty',
        cleanEpisodeId: 'ce-1',
        facts: [],
        foresight: []
      })
      MemCellRepository.insert(memCell)

      const found = MemCellRepository.getById('mc-empty')
      expect(found).not.toBeNull()
      expect(found!.facts).toEqual([])
      expect(found!.foresight).toEqual([])
    })
  })

  // ===================== getByCleanEpisodeId =====================

  describe('getByCleanEpisodeId', () => {
    it('按关联 CleanEpisode ID 查询返回所有匹配 MemCell（按 created_at 升序）', () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertCleanEpisode(db, 'ce-2', '2026-06-21')

      MemCellRepository.insert(makeMemCell({ id: 'mc-1', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T10:30:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-2', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T09:00:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-3', cleanEpisodeId: 'ce-2', createdAt: '2026-06-21T11:00:00.000Z' }))

      const ce1Cells = MemCellRepository.getByCleanEpisodeId('ce-1')
      expect(ce1Cells).toHaveLength(2)
      // 按 created_at 升序：mc-2 (09:00) 在 mc-1 (10:30) 之前
      expect(ce1Cells[0].id).toBe('mc-2')
      expect(ce1Cells[1].id).toBe('mc-1')

      const ce2Cells = MemCellRepository.getByCleanEpisodeId('ce-2')
      expect(ce2Cells).toHaveLength(1)
      expect(ce2Cells[0].id).toBe('mc-3')
    })

    it('查询无关联记录的 CleanEpisode 返回空数组', () => {
      insertCleanEpisode(db, 'ce-empty', '2026-06-21')
      const cells = MemCellRepository.getByCleanEpisodeId('ce-empty')
      expect(cells).toEqual([])
    })
  })

  // ===================== getByDateRange =====================

  describe('getByDateRange', () => {
    beforeEach(() => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      MemCellRepository.insert(makeMemCell({ id: 'mc-1', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T08:00:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-2', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T10:30:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-3', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T14:00:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-4', cleanEpisodeId: 'ce-1', createdAt: '2026-06-22T09:00:00.000Z' }))
    })

    it('查询完整日期范围内的 MemCell', () => {
      const cells = MemCellRepository.getByDateRange(
        '2026-06-21T00:00:00.000Z',
        '2026-06-21T23:59:59.999Z'
      )
      expect(cells).toHaveLength(3)
      expect(cells.map(c => c.id)).toEqual(['mc-1', 'mc-2', 'mc-3'])
    })

    it('查询跨日期范围', () => {
      const cells = MemCellRepository.getByDateRange(
        '2026-06-21T00:00:00.000Z',
        '2026-06-22T23:59:59.999Z'
      )
      expect(cells).toHaveLength(4)
    })

    it('查询窄范围只返回匹配项', () => {
      const cells = MemCellRepository.getByDateRange(
        '2026-06-21T09:00:00.000Z',
        '2026-06-21T11:00:00.000Z'
      )
      expect(cells).toHaveLength(1)
      expect(cells[0].id).toBe('mc-2')
    })

    it('查询无匹配范围返回空数组', () => {
      const cells = MemCellRepository.getByDateRange(
        '2026-07-01T00:00:00.000Z',
        '2026-07-02T00:00:00.000Z'
      )
      expect(cells).toEqual([])
    })

    it('结果按 created_at 升序排列', () => {
      const cells = MemCellRepository.getByDateRange(
        '2026-06-21T00:00:00.000Z',
        '2026-06-22T23:59:59.999Z'
      )
      for (let i = 1; i < cells.length; i++) {
        expect(cells[i].createdAt >= cells[i - 1].createdAt).toBe(true)
      }
    })
  })

  // ===================== deleteByHour =====================

  describe('deleteByHour', () => {
    beforeEach(() => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      MemCellRepository.insert(makeMemCell({ id: 'mc-1', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T10:30:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-2', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T10:45:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-3', cleanEpisodeId: 'ce-1', createdAt: '2026-06-21T11:00:00.000Z' }))
      MemCellRepository.insert(makeMemCell({ id: 'mc-4', cleanEpisodeId: 'ce-1', createdAt: '2026-06-22T10:30:00.000Z' }))
    })

    it('删除指定日期指定小时的 MemCell，返回删除行数', () => {
      const deleted = MemCellRepository.deleteByHour('2026-06-21', 10)
      expect(deleted).toBe(2)

      // mc-1 和 mc-2 被删除，mc-3 和 mc-4 保留
      expect(MemCellRepository.getById('mc-1')).toBeNull()
      expect(MemCellRepository.getById('mc-2')).toBeNull()
      expect(MemCellRepository.getById('mc-3')).not.toBeNull()
      expect(MemCellRepository.getById('mc-4')).not.toBeNull()
    })

    it('删除不匹配的小时返回 0', () => {
      const deleted = MemCellRepository.deleteByHour('2026-06-21', 9)
      expect(deleted).toBe(0)
      // 所有记录保留
      expect(MemCellRepository.getById('mc-1')).not.toBeNull()
      expect(MemCellRepository.getById('mc-3')).not.toBeNull()
    })

    it('删除不匹配的日期返回 0', () => {
      const deleted = MemCellRepository.deleteByHour('2026-07-01', 10)
      expect(deleted).toBe(0)
    })

    it('删除后可重新插入（重新蒸馏场景）', () => {
      // 删除 10 点的数据
      MemCellRepository.deleteByHour('2026-06-21', 10)
      expect(MemCellRepository.getByDateRange(
        '2026-06-21T00:00:00.000Z',
        '2026-06-21T23:59:59.999Z'
      )).toHaveLength(1)

      // 重新插入
      MemCellRepository.insert(makeMemCell({
        id: 'mc-new',
        cleanEpisodeId: 'ce-1',
        createdAt: '2026-06-21T10:30:00.000Z',
        episode: '重新蒸馏后的新叙事'
      }))

      const cells = MemCellRepository.getByDateRange(
        '2026-06-21T00:00:00.000Z',
        '2026-06-21T23:59:59.999Z'
      )
      expect(cells).toHaveLength(2)
      const newCell = MemCellRepository.getById('mc-new')
      expect(newCell).not.toBeNull()
      expect(newCell!.episode).toBe('重新蒸馏后的新叙事')
    })
  })

  // ===================== 外键约束 =====================

  describe('外键约束', () => {
    it('插入不存在的 clean_episode_id 应抛出外键约束错误', () => {
      const memCell = makeMemCell({ id: 'mc-fk', cleanEpisodeId: 'nonexistent-ce' })
      expect(() => MemCellRepository.insert(memCell)).toThrow()
    })
  })

  // ===================== JSON 序列化完整性 =====================

  describe('JSON 序列化完整性', () => {
    it('多个 foresight 和复杂 metadata 正确往返', () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const foresight: Foresight[] = [
        { statement: '预见 A', validFrom: '2026-06-21', validTo: '2026-09-21', confidence: 0.9 },
        { statement: '预见 B', validFrom: '2026-07-01', validTo: '2026-12-31', confidence: 0.6 },
        { statement: '预见 C', validFrom: '2026-08-01', validTo: '2027-01-01', confidence: 0.3 }
      ]
      const metadata: MemCellMetadata = {
        segmentIds: ['s1', 's2', 's3', 's4'],
        timestamp: '2026-06-21T10:30:00.000Z',
        confidence: 0.92,
        activityType: 'coding',
        contentType: 'code'
      }
      const memCell = makeMemCell({
        id: 'mc-complex',
        cleanEpisodeId: 'ce-1',
        facts: ['事实1', '事实2', '事实3'],
        foresight,
        metadata
      })
      MemCellRepository.insert(memCell)

      const found = MemCellRepository.getById('mc-complex')
      expect(found).not.toBeNull()
      expect(found!.facts).toEqual(['事实1', '事实2', '事实3'])
      expect(found!.foresight).toHaveLength(3)
      expect(found!.foresight[0].statement).toBe('预见 A')
      expect(found!.foresight[2].confidence).toBe(0.3)
      expect(found!.metadata.segmentIds).toEqual(['s1', 's2', 's3', 's4'])
      expect(found!.metadata.confidence).toBe(0.92)
    })
  })
})
