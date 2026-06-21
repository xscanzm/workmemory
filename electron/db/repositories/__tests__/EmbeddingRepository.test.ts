/**
 * EmbeddingRepository 单元测试
 *
 * 测试内容：
 *  - insert + getByMemoryCellId：CRUD 与 Buffer↔Float32Array 转换
 *  - searchBySimilarity：语义检索，按相似度降序返回 top-N
 *
 * 运行方式：npx vitest run electron/db/repositories/__tests__/EmbeddingRepository.test.ts
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
import { EmbeddingRepository } from '../EmbeddingRepository'
import { EmbeddingService } from '../../../memory/EmbeddingService'

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
function insertMemoryCell(db: DatabaseType, id: string, cleanEpisodeId: string): void {
  db.prepare(
    `INSERT INTO memory_cells (id, clean_episode_id, episode, facts, foresight, metadata, created_at)
     VALUES (?, ?, '', '[]', '[]', '{}', ?)`
  ).run(id, cleanEpisodeId, '2026-06-21T10:00:00.000Z')
}

describe('EmbeddingRepository', () => {
  let db: DatabaseType
  let embeddingService: EmbeddingService

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    embeddingService = new EmbeddingService()
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== insert + getByMemoryCellId =====================

  describe('insert + getByMemoryCellId', () => {
    it('插入 embedding 后可通过 memoryCellId 查询', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1')

      const embedding = await embeddingService.embed('前端组件开发')
      EmbeddingRepository.insert('mc-1', embedding, 'tfidf-hash-384')

      const found = EmbeddingRepository.getByMemoryCellId('mc-1')
      expect(found).not.toBeNull()
      expect(found!.embedding).toBeInstanceOf(Float32Array)
      expect(found!.embedding.length).toBe(384)
      expect(found!.modelVersion).toBe('tfidf-hash-384')
    })

    it('查询不存在的 memoryCellId 返回 null', () => {
      expect(EmbeddingRepository.getByMemoryCellId('nonexistent')).toBeNull()
    })

    it('embedding 往返保持精度（Buffer ↔ Float32Array）', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1')

      const embedding = await embeddingService.embed('测试向量精度')
      EmbeddingRepository.insert('mc-1', embedding, 'tfidf-hash-384')

      const found = EmbeddingRepository.getByMemoryCellId('mc-1')
      expect(found).not.toBeNull()

      // 验证每个分量精度（Float32 经 Buffer 序列化应无损）
      for (let i = 0; i < embedding.length; i++) {
        expect(found!.embedding[i]).toBeCloseTo(embedding[i], 5)
      }
    })

    it('同一 memoryCellId 多次插入返回最新记录', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1')

      const emb1 = await embeddingService.embed('第一版向量')
      EmbeddingRepository.insert('mc-1', emb1, 'tfidf-hash-384')

      // 稍等确保 created_at 不同
      await new Promise((resolve) => setTimeout(resolve, 10))

      const emb2 = await embeddingService.embed('第二版向量')
      EmbeddingRepository.insert('mc-1', emb2, 'tfidf-hash-384-v2')

      const found = EmbeddingRepository.getByMemoryCellId('mc-1')
      expect(found).not.toBeNull()
      expect(found!.modelVersion).toBe('tfidf-hash-384-v2')
      // 最新向量应与 emb2 一致
      const sim = EmbeddingService.cosineSimilarity(found!.embedding, emb2)
      expect(sim).toBeCloseTo(1, 5)
    })

    it('外键约束：插入不存在的 memoryCellId 应抛错', () => {
      const embedding = new Float32Array(384)
      expect(() => EmbeddingRepository.insert('nonexistent-mc', embedding, 'tfidf-hash-384')).toThrow()
    })
  })

  // ===================== searchBySimilarity =====================

  describe('searchBySimilarity', () => {
    it('返回按相似度降序排列的 top-N 结果', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1')
      insertMemoryCell(db, 'mc-2', 'ce-1')
      insertMemoryCell(db, 'mc-3', 'ce-1')

      const emb1 = await embeddingService.embed('前端组件开发')
      const emb2 = await embeddingService.embed('UI 组件库实现')
      const emb3 = await embeddingService.embed('数据库性能优化')

      EmbeddingRepository.insert('mc-1', emb1, 'tfidf-hash-384')
      EmbeddingRepository.insert('mc-2', emb2, 'tfidf-hash-384')
      EmbeddingRepository.insert('mc-3', emb3, 'tfidf-hash-384')

      const query = await embeddingService.embed('前端组件')
      const results = EmbeddingRepository.searchBySimilarity(query, 3)

      expect(results).toHaveLength(3)
      // mc-1（前端组件开发）与查询共享"前端组件"，应最相似
      expect(results[0].memoryCellId).toBe('mc-1')
      // 相似度降序
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('limit 限制返回数量', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1')
      insertMemoryCell(db, 'mc-2', 'ce-1')
      insertMemoryCell(db, 'mc-3', 'ce-1')

      const emb1 = await embeddingService.embed('文本一')
      const emb2 = await embeddingService.embed('文本二')
      const emb3 = await embeddingService.embed('文本三')

      EmbeddingRepository.insert('mc-1', emb1, 'tfidf-hash-384')
      EmbeddingRepository.insert('mc-2', emb2, 'tfidf-hash-384')
      EmbeddingRepository.insert('mc-3', emb3, 'tfidf-hash-384')

      const query = await embeddingService.embed('文本一')
      const results = EmbeddingRepository.searchBySimilarity(query, 1)
      expect(results).toHaveLength(1)
      expect(results[0].memoryCellId).toBe('mc-1')
    })

    it('空数据库返回空数组', async () => {
      const query = await embeddingService.embed('查询')
      const results = EmbeddingRepository.searchBySimilarity(query, 10)
      expect(results).toEqual([])
    })

    it('limit 大于记录数时返回全部记录', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1')
      insertMemoryCell(db, 'mc-2', 'ce-1')

      const emb1 = await embeddingService.embed('向量A')
      const emb2 = await embeddingService.embed('向量B')

      EmbeddingRepository.insert('mc-1', emb1, 'tfidf-hash-384')
      EmbeddingRepository.insert('mc-2', emb2, 'tfidf-hash-384')

      const query = await embeddingService.embed('向量A')
      const results = EmbeddingRepository.searchBySimilarity(query, 100)
      expect(results).toHaveLength(2)
    })

    it('查询与自身完全匹配的向量相似度为 1', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1')

      const embedding = await embeddingService.embed('精确匹配测试')
      EmbeddingRepository.insert('mc-1', embedding, 'tfidf-hash-384')

      const results = EmbeddingRepository.searchBySimilarity(embedding, 1)
      expect(results).toHaveLength(1)
      expect(results[0].memoryCellId).toBe('mc-1')
      expect(results[0].score).toBeCloseTo(1, 5)
    })

    it('语义检索：跨语言匹配（中文查询匹配含英文的记录）', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-react', 'ce-1')
      insertMemoryCell(db, 'mc-db', 'ce-1')

      // 两条记录共享 "react" token
      const embReact = await embeddingService.embed('使用 React 开发前端组件')
      const embDb = await embeddingService.embed('MySQL 数据库索引优化')

      EmbeddingRepository.insert('mc-react', embReact, 'tfidf-hash-384')
      EmbeddingRepository.insert('mc-db', embDb, 'tfidf-hash-384')

      const query = await embeddingService.embed('React 组件库')
      const results = EmbeddingRepository.searchBySimilarity(query, 2)

      expect(results[0].memoryCellId).toBe('mc-react')
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })
  })
})
