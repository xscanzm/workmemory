/**
 * MemSceneClusterer 单元测试（Task M6）
 *
 * 测试内容：
 *  - 同主题聚类：3 个语义相似的 MemCell 归并到同一 MemScene
 *  - 不同主题：1 个不同主题的 MemCell 新建独立 MemScene
 *  - 标题生成：AI 不可用时降级为 episode 前 30 字
 *  - 质心增量更新：归并后质心 = (旧质心 * 旧成员数 + 新向量) / (旧成员数 + 1)
 *  - 错误处理：MemCell 没有 embedding 时抛出错误
 *  - MemSceneRepository CRUD：insert/getById/getAll/addMember/updateCentroid/update
 *
 * 运行方式：npx vitest run electron/memory/__tests__/MemSceneClusterer.test.ts
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

// Mock OpenAIClient：防止测试环境发起真实 HTTP 请求，强制走降级标题逻辑
vi.mock('../../ai/OpenAIClient', () => ({
  OpenAIClient: {
    chatCompletion: vi.fn().mockRejectedValue(new Error('AI 不可用（测试环境）'))
  }
}))

import { SCHEMA_SQL } from '../../db/schema'
import { runMigrations } from '../../db/migrations'
import { setDatabaseInstance, resetDatabaseInstance } from '../../db/database'
import { EmbeddingRepository } from '../../db/repositories/EmbeddingRepository'
import { MemSceneRepository } from '../../db/repositories/MemSceneRepository'
import { MemSceneClusterer } from '../MemSceneClusterer'
import type { MemScene } from '../MemSceneClusterer'
import { EmbeddingService } from '../EmbeddingService'
import type { MemCell } from '../MemCell'

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

/** 插入一条最小 memory_cells 行（满足外键约束） */
function insertMemoryCell(
  db: DatabaseType,
  id: string,
  cleanEpisodeId: string,
  episode: string
): void {
  db.prepare(
    `INSERT INTO memory_cells (id, clean_episode_id, episode, facts, foresight, metadata, created_at)
     VALUES (?, ?, ?, '[]', '[]', '{}', ?)`
  ).run(id, cleanEpisodeId, episode, '2026-06-21T10:00:00.000Z')
}

/** 构造测试用 MemCell */
function makeMemCell(id: string, episode: string): MemCell {
  return {
    id,
    cleanEpisodeId: 'ce-1',
    episode,
    facts: [],
    foresight: [],
    metadata: {
      segmentIds: [],
      timestamp: '2026-06-21T10:00:00.000Z',
      confidence: 0.9
    },
    createdAt: '2026-06-21T10:00:00.000Z'
  }
}

describe('MemSceneClusterer', () => {
  let db: DatabaseType
  let embeddingService: EmbeddingService
  let clusterer: MemSceneClusterer

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    embeddingService = new EmbeddingService()
    clusterer = new MemSceneClusterer(EmbeddingRepository, MemSceneRepository)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
    vi.restoreAllMocks()
  })

  // ===================== M6.7 验证：同主题聚类 =====================

  describe('同主题聚类', () => {
    it('3 个同主题 MemCell 归并到同一 MemScene', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')

      // 3 个高度相似的 episode（共享"数据库""迁移""备份"等关键词）
      const episodes = [
        '数据库迁移 数据库备份 数据库恢复',
        '数据库迁移 数据库备份 数据库优化',
        '数据库迁移 数据库备份 数据库测试'
      ]
      const memCells = episodes.map((ep, i) => makeMemCell(`mc-${i + 1}`, ep))

      // 插入 MemCell 并生成 embedding
      for (const cell of memCells) {
        insertMemoryCell(db, cell.id, cell.cleanEpisodeId, cell.episode)
        const embedding = await embeddingService.embed(cell.episode)
        EmbeddingRepository.insert(cell.id, embedding, 'tfidf-hash-384')
      }

      // 第 1 个：新建 MemScene
      const result1 = await clusterer.clusterMemCell(memCells[0])
      expect(result1.isNew).toBe(true)

      // 第 2 个：归并到同一 MemScene
      const result2 = await clusterer.clusterMemCell(memCells[1])
      expect(result2.isNew).toBe(false)
      expect(result2.sceneId).toBe(result1.sceneId)

      // 第 3 个：归并到同一 MemScene
      const result3 = await clusterer.clusterMemCell(memCells[2])
      expect(result3.isNew).toBe(false)
      expect(result3.sceneId).toBe(result1.sceneId)

      // 验证 MemScene 有 3 个成员
      const scene = MemSceneRepository.getById(result1.sceneId)
      expect(scene).not.toBeNull()
      expect(scene!.memberCellIds).toHaveLength(3)
      expect(scene!.memberCellIds).toContain('mc-1')
      expect(scene!.memberCellIds).toContain('mc-2')
      expect(scene!.memberCellIds).toContain('mc-3')

      // 全局只有 1 个 MemScene
      expect(MemSceneRepository.getAll()).toHaveLength(1)
    })
  })

  // ===================== M6.7 验证：不同主题新建 =====================

  describe('不同主题新建 MemScene', () => {
    it('不同主题的 MemCell 新建独立 MemScene', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')

      const sameTopicCell = makeMemCell(
        'mc-same',
        '数据库迁移 数据库备份 数据库恢复'
      )
      const diffTopicCell = makeMemCell('mc-diff', '前端 React 组件 开发')

      // 插入并生成 embedding
      for (const cell of [sameTopicCell, diffTopicCell]) {
        insertMemoryCell(db, cell.id, cell.cleanEpisodeId, cell.episode)
        const embedding = await embeddingService.embed(cell.episode)
        EmbeddingRepository.insert(cell.id, embedding, 'tfidf-hash-384')
      }

      // 同主题 → 新建
      const result1 = await clusterer.clusterMemCell(sameTopicCell)
      expect(result1.isNew).toBe(true)

      // 不同主题 → 新建（不归并）
      const result2 = await clusterer.clusterMemCell(diffTopicCell)
      expect(result2.isNew).toBe(true)
      expect(result2.sceneId).not.toBe(result1.sceneId)

      // 全局有 2 个 MemScene
      const allScenes = MemSceneRepository.getAll()
      expect(allScenes).toHaveLength(2)
    })
  })

  // ===================== M6.5 标题生成 =====================

  describe('标题生成', () => {
    it('AI 不可用时降级为 episode 前 30 字', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const episode = '这是一个非常长的数据库迁移工作描述用于测试标题降级逻辑当AI不可用时应该截取前三十个字符作为标题'
      const cell = makeMemCell('mc-title', episode)
      insertMemoryCell(db, cell.id, cell.cleanEpisodeId, cell.episode)
      const embedding = await embeddingService.embed(cell.episode)
      EmbeddingRepository.insert(cell.id, embedding, 'tfidf-hash-384')

      const result = await clusterer.clusterMemCell(cell)
      expect(result.isNew).toBe(true)

      const scene = MemSceneRepository.getById(result.sceneId)
      expect(scene).not.toBeNull()
      // 降级标题 = episode 前 30 字
      expect(scene!.title).toBe(episode.slice(0, 30))
    })

    it('归并时保留原标题', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')

      const cell1 = makeMemCell('mc-1', '数据库迁移 数据库备份 数据库恢复')
      const cell2 = makeMemCell('mc-2', '数据库迁移 数据库备份 数据库优化')

      for (const cell of [cell1, cell2]) {
        insertMemoryCell(db, cell.id, cell.cleanEpisodeId, cell.episode)
        const embedding = await embeddingService.embed(cell.episode)
        EmbeddingRepository.insert(cell.id, embedding, 'tfidf-hash-384')
      }

      const result1 = await clusterer.clusterMemCell(cell1)
      const scene1 = MemSceneRepository.getById(result1.sceneId)
      const originalTitle = scene1!.title

      // 归并第 2 个
      await clusterer.clusterMemCell(cell2)

      // 标题不变
      const scene2 = MemSceneRepository.getById(result1.sceneId)
      expect(scene2!.title).toBe(originalTitle)
    })
  })

  // ===================== M6.2 质心增量更新 =====================

  describe('质心增量更新', () => {
    it('归并后质心 = (emb1 + emb2) / 2', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')

      const cell1 = makeMemCell('mc-1', '数据库迁移 数据库备份 数据库恢复')
      const cell2 = makeMemCell('mc-2', '数据库迁移 数据库备份 数据库优化')

      insertMemoryCell(db, cell1.id, cell1.cleanEpisodeId, cell1.episode)
      const emb1 = await embeddingService.embed(cell1.episode)
      EmbeddingRepository.insert(cell1.id, emb1, 'tfidf-hash-384')

      insertMemoryCell(db, cell2.id, cell2.cleanEpisodeId, cell2.episode)
      const emb2 = await embeddingService.embed(cell2.episode)
      EmbeddingRepository.insert(cell2.id, emb2, 'tfidf-hash-384')

      await clusterer.clusterMemCell(cell1)
      await clusterer.clusterMemCell(cell2)

      const scenes = MemSceneRepository.getAll()
      expect(scenes).toHaveLength(1)
      const centroid = scenes[0].centroidEmbedding

      // 预期质心 = (emb1 + emb2) / 2
      const expectedCentroid = new Float32Array(emb1.length)
      for (let i = 0; i < emb1.length; i++) {
        expectedCentroid[i] = (emb1[i] + emb2[i]) / 2
      }
      for (let i = 0; i < centroid.length; i++) {
        expect(centroid[i]).toBeCloseTo(expectedCentroid[i], 5)
      }
    })

    it('3 成员质心 = (emb1 + emb2 + emb3) / 3', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')

      const episodes = [
        '数据库迁移 数据库备份 数据库恢复',
        '数据库迁移 数据库备份 数据库优化',
        '数据库迁移 数据库备份 数据库测试'
      ]
      const embs: Float32Array[] = []
      for (let i = 0; i < episodes.length; i++) {
        const cell = makeMemCell(`mc-${i + 1}`, episodes[i])
        insertMemoryCell(db, cell.id, cell.cleanEpisodeId, cell.episode)
        const emb = await embeddingService.embed(cell.episode)
        EmbeddingRepository.insert(cell.id, emb, 'tfidf-hash-384')
        embs.push(emb)
        await clusterer.clusterMemCell(cell)
      }

      const scenes = MemSceneRepository.getAll()
      expect(scenes).toHaveLength(1)
      const centroid = scenes[0].centroidEmbedding

      const expectedCentroid = new Float32Array(embs[0].length)
      for (let i = 0; i < expectedCentroid.length; i++) {
        expectedCentroid[i] = (embs[0][i] + embs[1][i] + embs[2][i]) / 3
      }
      for (let i = 0; i < centroid.length; i++) {
        expect(centroid[i]).toBeCloseTo(expectedCentroid[i], 5)
      }
    })
  })

  // ===================== 错误处理 =====================

  describe('错误处理', () => {
    it('MemCell 没有 embedding 时抛出错误', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const cell = makeMemCell('mc-no-emb', '没有 embedding 的 MemCell')
      insertMemoryCell(db, cell.id, cell.cleanEpisodeId, cell.episode)
      // 不插入 embedding

      await expect(clusterer.clusterMemCell(cell)).rejects.toThrow('没有 embedding')
    })
  })

  // ===================== 空数据库 =====================

  describe('空数据库', () => {
    it('首个 MemCell 总是新建 MemScene', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      const cell = makeMemCell('mc-first', '首个 MemCell 任意主题')
      insertMemoryCell(db, cell.id, cell.cleanEpisodeId, cell.episode)
      const embedding = await embeddingService.embed(cell.episode)
      EmbeddingRepository.insert(cell.id, embedding, 'tfidf-hash-384')

      const result = await clusterer.clusterMemCell(cell)
      expect(result.isNew).toBe(true)
      expect(MemSceneRepository.getAll()).toHaveLength(1)
    })
  })
})

// ===================== MemSceneRepository CRUD =====================

describe('MemSceneRepository', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  function makeScene(overrides: Partial<MemScene> = {}): MemScene {
    return {
      id: 'scene-1',
      title: '测试场景',
      centroidEmbedding: new Float32Array(384).fill(0.5),
      memberCellIds: ['mc-1'],
      summary: '',
      createdAt: '2026-06-21T10:00:00.000Z',
      updatedAt: '2026-06-21T10:00:00.000Z',
      ...overrides
    }
  }

  describe('insert + getById', () => {
    it('插入后可通过 ID 查询', () => {
      const scene = makeScene()
      MemSceneRepository.insert(scene)

      const found = MemSceneRepository.getById('scene-1')
      expect(found).not.toBeNull()
      expect(found!.id).toBe('scene-1')
      expect(found!.title).toBe('测试场景')
      expect(found!.centroidEmbedding).toBeInstanceOf(Float32Array)
      expect(found!.centroidEmbedding.length).toBe(384)
      expect(found!.memberCellIds).toEqual(['mc-1'])
      expect(found!.summary).toBe('')
    })

    it('查询不存在的 ID 返回 null', () => {
      expect(MemSceneRepository.getById('nonexistent')).toBeNull()
    })

    it('embedding 往返保持精度（Buffer ↔ Float32Array）', () => {
      const embedding = new Float32Array(384)
      for (let i = 0; i < 384; i++) {
        embedding[i] = Math.sin(i * 0.1)
      }
      MemSceneRepository.insert(makeScene({ centroidEmbedding: embedding }))

      const found = MemSceneRepository.getById('scene-1')!
      for (let i = 0; i < 384; i++) {
        expect(found.centroidEmbedding[i]).toBeCloseTo(embedding[i], 5)
      }
    })
  })

  describe('getAll', () => {
    it('返回全部 MemScene（按创建时间升序）', () => {
      MemSceneRepository.insert(
        makeScene({ id: 'scene-b', createdAt: '2026-06-22T10:00:00.000Z' })
      )
      MemSceneRepository.insert(
        makeScene({ id: 'scene-a', createdAt: '2026-06-21T10:00:00.000Z' })
      )

      const all = MemSceneRepository.getAll()
      expect(all).toHaveLength(2)
      // 按 created_at ASC 排序：scene-a (6-21) 在前，scene-b (6-22) 在后
      expect(all[0].id).toBe('scene-a')
      expect(all[1].id).toBe('scene-b')
    })

    it('空数据库返回空数组', () => {
      expect(MemSceneRepository.getAll()).toEqual([])
    })
  })

  describe('addMember', () => {
    it('追加成员到 member_cell_ids', () => {
      MemSceneRepository.insert(makeScene({ memberCellIds: ['mc-1'] }))
      MemSceneRepository.addMember('scene-1', 'mc-2')

      const found = MemSceneRepository.getById('scene-1')!
      expect(found.memberCellIds).toEqual(['mc-1', 'mc-2'])
    })

    it('不重复添加已存在的成员', () => {
      MemSceneRepository.insert(makeScene({ memberCellIds: ['mc-1'] }))
      MemSceneRepository.addMember('scene-1', 'mc-1')

      const found = MemSceneRepository.getById('scene-1')!
      expect(found.memberCellIds).toEqual(['mc-1'])
    })

    it('不存在的 sceneId 静默返回', () => {
      expect(() => MemSceneRepository.addMember('nonexistent', 'mc-1')).not.toThrow()
    })
  })

  describe('updateCentroid', () => {
    it('更新质心向量', () => {
      MemSceneRepository.insert(makeScene())
      const newCentroid = new Float32Array(384).fill(0.9)
      MemSceneRepository.updateCentroid('scene-1', newCentroid)

      const found = MemSceneRepository.getById('scene-1')!
      for (let i = 0; i < 384; i++) {
        expect(found.centroidEmbedding[i]).toBeCloseTo(0.9, 5)
      }
    })
  })

  describe('update', () => {
    it('更新全部可变字段', () => {
      MemSceneRepository.insert(makeScene())
      const updated = makeScene({
        title: '更新后的标题',
        centroidEmbedding: new Float32Array(384).fill(0.8),
        memberCellIds: ['mc-1', 'mc-2', 'mc-3'],
        summary: '主题摘要'
      })
      MemSceneRepository.update(updated)

      const found = MemSceneRepository.getById('scene-1')!
      expect(found.title).toBe('更新后的标题')
      expect(found.memberCellIds).toEqual(['mc-1', 'mc-2', 'mc-3'])
      expect(found.summary).toBe('主题摘要')
      for (let i = 0; i < 384; i++) {
        expect(found.centroidEmbedding[i]).toBeCloseTo(0.8, 5)
      }
    })
  })
})
