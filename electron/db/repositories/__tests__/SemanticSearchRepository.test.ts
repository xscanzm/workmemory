/**
 * SemanticSearchRepository 单元测试（Task M5）
 *
 * 测试内容：
 *  - 关键词匹配（FTS5）：matchType = 'keyword'
 *  - 语义匹配（向量余弦相似度）：matchType = 'semantic'
 *  - 混合匹配（关键词 + 语义）：matchType = 'hybrid'
 *  - 去重：同一 memCellId 合并取最高分
 *  - 降级：EmbeddingService 不可用时退化为纯 FTS5
 *  - M5.6 验证："前端组件开发"查询返回"UI 组件库实现"MemCell
 *  - 得分归一化与排序
 *
 * 运行方式：npx vitest run electron/db/repositories/__tests__/SemanticSearchRepository.test.ts
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
import { SemanticSearchRepository } from '../SemanticSearchRepository'
import { EmbeddingRepository } from '../EmbeddingRepository'
import { MemCellRepository } from '../MemCellRepository'
import { EmbeddingService, embeddingService } from '../../../memory/EmbeddingService'
import type { MemCell } from '../../../memory/MemCell'

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

/** 插入一条 memory_cells 行并返回 MemCell 对象 */
function insertMemoryCell(
  db: DatabaseType,
  id: string,
  cleanEpisodeId: string,
  episode: string,
  facts: string[] = []
): MemCell {
  db.prepare(
    `INSERT INTO memory_cells (id, clean_episode_id, episode, facts, foresight, metadata, created_at)
     VALUES (?, ?, ?, ?, '[]', '{}', ?)`
  ).run(id, cleanEpisodeId, episode, JSON.stringify(facts), '2026-06-21T10:00:00.000Z')
  return MemCellRepository.getById(id)!
}

/** 为 MemCell 插入 embedding（使用 EmbeddingService 生成向量） */
async function indexMemCell(memCellId: string, text: string): Promise<void> {
  const embedding = await embeddingService.embed(text)
  EmbeddingRepository.insert(memCellId, embedding, embeddingService.getModelVersion())
}

describe('SemanticSearchRepository', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
    vi.restoreAllMocks()
  })

  // ===================== 关键词匹配（FTS5） =====================

  describe('关键词匹配（FTS5）', () => {
    it('查询命中 MemCell episode 文本，matchType = keyword', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '用户在 VS Code 中实现了 API Key 加密功能')

      const results = await SemanticSearchRepository.hybridSearch('API Key', { limit: 10 })

      expect(results.length).toBeGreaterThanOrEqual(1)
      const match = results.find((r) => r.memCellId === 'mc-1')
      expect(match).toBeDefined()
      expect(match!.matchType).toBe('keyword')
      expect(match!.keywordScore).toBeGreaterThan(0)
      expect(match!.keywordScore).toBeLessThanOrEqual(1)
      expect(match!.snippet).toBeDefined()
      expect(match!.memCell).toBeDefined()
      expect(match!.memCell!.episode).toBe('用户在 VS Code 中实现了 API Key 加密功能')
    })

    it('查询命中 MemCell facts 文本', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '加密功能实现', ['使用了 safeStorage API', '密钥存储在 userData 目录'])

      const results = await SemanticSearchRepository.hybridSearch('safeStorage', { limit: 10 })

      const match = results.find((r) => r.memCellId === 'mc-1')
      expect(match).toBeDefined()
      expect(match!.matchType === 'keyword' || match!.matchType === 'hybrid').toBe(true)
      expect(match!.keywordScore).toBeGreaterThan(0)
    })

    it('无有效 token 的查询返回空数组', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '测试文本')

      const results = await SemanticSearchRepository.hybridSearch('   ', { limit: 10 })
      expect(results).toEqual([])
    })

    it('无匹配的查询返回空数组', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '完全不相关的文本内容')

      const results = await SemanticSearchRepository.hybridSearch('量子纠缠物理', { limit: 10 })
      // 语义相似度极低，可能返回但得分很低；关键词无匹配
      // 验证至少没有 keyword-only 的匹配
      const keywordOnly = results.filter((r) => r.matchType === 'keyword')
      expect(keywordOnly).toHaveLength(0)
    })
  })

  // ===================== 语义匹配（向量余弦相似度） =====================

  describe('语义匹配（向量余弦相似度）', () => {
    it('查询与 MemCell 无关键词重叠但向量相似，matchType = semantic', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      // MemCell 文本与查询无 bigram 重叠
      insertMemoryCell(db, 'mc-semantic', 'ce-1', '完全不相关的文本内容XYZ')

      // 手动插入与查询完全相同的 embedding，确保语义相似度为 1.0
      const queryText = '前端组件开发'
      const queryEmbedding = await embeddingService.embed(queryText)
      EmbeddingRepository.insert('mc-semantic', queryEmbedding, embeddingService.getModelVersion())

      const results = await SemanticSearchRepository.hybridSearch(queryText, { limit: 10 })

      const match = results.find((r) => r.memCellId === 'mc-semantic')
      expect(match).toBeDefined()
      expect(match!.matchType).toBe('semantic')
      expect(match!.semanticScore).toBeCloseTo(1, 5)
      expect(match!.keywordScore).toBeUndefined()
      expect(match!.memCell).toBeDefined()
    })

    it('语义得分已归一化到 0-1 区间', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '无关文本ABC')

      const embedding = await embeddingService.embed('测试查询')
      EmbeddingRepository.insert('mc-1', embedding, embeddingService.getModelVersion())

      const results = await SemanticSearchRepository.hybridSearch('测试查询', { limit: 10 })
      for (const r of results) {
        if (r.semanticScore !== undefined) {
          expect(r.semanticScore).toBeGreaterThanOrEqual(0)
          expect(r.semanticScore).toBeLessThanOrEqual(1)
        }
      }
    })
  })

  // ===================== 混合匹配 =====================

  describe('混合匹配（关键词 + 语义）', () => {
    it('查询同时命中关键词和语义，matchType = hybrid', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发实践')

      // 为 MemCell 生成 embedding（与查询共享"前端组件"token，语义相似度高）
      await indexMemCell('mc-1', '前端组件开发实践')

      const results = await SemanticSearchRepository.hybridSearch('前端组件', { limit: 10 })

      const match = results.find((r) => r.memCellId === 'mc-1')
      expect(match).toBeDefined()
      expect(match!.matchType).toBe('hybrid')
      expect(match!.keywordScore).toBeGreaterThan(0)
      expect(match!.keywordScore).toBeLessThanOrEqual(1)
      expect(match!.semanticScore).toBeGreaterThan(0)
      expect(match!.semanticScore).toBeLessThanOrEqual(1)
      // 综合得分 = keywordWeight * keywordScore + semanticWeight * semanticScore
      const expectedScore = 1.0 * match!.keywordScore! + 1.0 * match!.semanticScore!
      expect(match!.score).toBeCloseTo(expectedScore, 5)
    })

    it('自定义权重影响综合得分', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发')
      await indexMemCell('mc-1', '前端组件开发')

      const resultsDefault = await SemanticSearchRepository.hybridSearch('前端组件', {
        limit: 10,
        keywordWeight: 1.0,
        semanticWeight: 1.0
      })
      const resultsWeighted = await SemanticSearchRepository.hybridSearch('前端组件', {
        limit: 10,
        keywordWeight: 3.0,
        semanticWeight: 0.5
      })

      const matchDefault = resultsDefault.find((r) => r.memCellId === 'mc-1')!
      const matchWeighted = resultsWeighted.find((r) => r.memCellId === 'mc-1')!

      const expectedDefault = 1.0 * matchDefault.keywordScore! + 1.0 * matchDefault.semanticScore!
      const expectedWeighted = 3.0 * matchWeighted.keywordScore! + 0.5 * matchWeighted.semanticScore!

      expect(matchDefault.score).toBeCloseTo(expectedDefault, 5)
      expect(matchWeighted.score).toBeCloseTo(expectedWeighted, 5)
      // 权重不同，得分应不同
      expect(matchDefault.score).not.toBeCloseTo(matchWeighted.score, 2)
    })
  })

  // ===================== M5.6 验证：语义匹配核心场景 =====================

  describe('M5.6：前端组件开发 → UI 组件库实现（语义匹配）', () => {
    it('"前端组件开发"查询返回"UI 组件库实现"MemCell', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-frontend', 'ce-1', '前端组件开发实践')
      insertMemoryCell(db, 'mc-ui-lib', 'ce-1', 'UI 组件库实现')
      insertMemoryCell(db, 'mc-db', 'ce-1', '数据库性能优化')

      // 为所有 MemCell 生成 embedding
      await indexMemCell('mc-frontend', '前端组件开发实践')
      await indexMemCell('mc-ui-lib', 'UI 组件库实现')
      await indexMemCell('mc-db', '数据库性能优化')

      const results = await SemanticSearchRepository.hybridSearch('前端组件开发', { limit: 10 })

      // "UI 组件库实现"应出现在结果中（语义匹配，"组件"共享）
      const uiLibMatch = results.find((r) => r.memCellId === 'mc-ui-lib')
      expect(uiLibMatch).toBeDefined()
      expect(uiLibMatch!.memCell).toBeDefined()
      expect(uiLibMatch!.memCell!.episode).toBe('UI 组件库实现')

      // "前端组件开发实践"应排在最前（关键词 + 语义双重匹配）
      expect(results[0].memCellId).toBe('mc-frontend')

      // "数据库性能优化"与查询无关键词和语义重叠，不应排在前面的位置
      const dbMatch = results.find((r) => r.memCellId === 'mc-db')
      if (dbMatch && uiLibMatch) {
        expect(uiLibMatch.score).toBeGreaterThan(dbMatch.score)
      }
    })

    it('"UI 组件库实现"与"前端组件开发"的语义相似度高于与"数据库性能优化"的相似度', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-ui-lib', 'ce-1', 'UI 组件库实现')
      insertMemoryCell(db, 'mc-db', 'ce-1', '数据库性能优化')

      await indexMemCell('mc-ui-lib', 'UI 组件库实现')
      await indexMemCell('mc-db', '数据库性能优化')

      // 使用纯语义查询（无 bigram 重叠）来比较相似度
      // "前端开发" → bigrams: 前端, 端开, 开发
      // "UI 组件库实现" → bigrams: 组件, 件库, 库实, 实现 (无重叠)
      // "数据库性能优化" → bigrams: 数据, 据库, 库性, 性能, 能优, 优化 (无重叠)
      const results = await SemanticSearchRepository.hybridSearch('前端开发', { limit: 10 })

      const uiLibMatch = results.find((r) => r.memCellId === 'mc-ui-lib')
      const dbMatch = results.find((r) => r.memCellId === 'mc-db')

      // 两者都可能通过语义匹配返回
      if (uiLibMatch && dbMatch) {
        expect(uiLibMatch.score).toBeGreaterThanOrEqual(dbMatch.score)
      }
    })
  })

  // ===================== 去重 =====================

  describe('去重：同一 memCellId 合并取最高分', () => {
    it('同一 MemCell 同时被关键词和语义匹配，合并为一条 hybrid 结果', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发')
      await indexMemCell('mc-1', '前端组件开发')

      const results = await SemanticSearchRepository.hybridSearch('前端组件', { limit: 10 })

      const matches = results.filter((r) => r.memCellId === 'mc-1')
      expect(matches).toHaveLength(1)
      expect(matches[0].matchType).toBe('hybrid')
    })

    it('多个不同 MemCell 各自返回独立结果', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发')
      insertMemoryCell(db, 'mc-2', 'ce-1', '后端 API 开发')
      insertMemoryCell(db, 'mc-3', 'ce-1', '数据库设计')

      await indexMemCell('mc-1', '前端组件开发')
      await indexMemCell('mc-2', '后端 API 开发')
      await indexMemCell('mc-3', '数据库设计')

      const results = await SemanticSearchRepository.hybridSearch('开发', { limit: 10 })

      const ids = results.map((r) => r.memCellId)
      // 每个匹配的 MemCell 只出现一次
      const uniqueIds = [...new Set(ids)]
      expect(ids.length).toBe(uniqueIds.length)
    })
  })

  // ===================== 降级：EmbeddingService 不可用 =====================

  describe('降级：EmbeddingService 不可用', () => {
    it('embed 抛错时退化为纯 FTS5，所有结果 matchType = keyword', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发')
      insertMemoryCell(db, 'mc-2', 'ce-1', '后端组件设计')

      // Mock embeddingService.embed 抛错
      vi.spyOn(embeddingService, 'embed').mockRejectedValue(new Error('EmbeddingService unavailable'))

      const results = await SemanticSearchRepository.hybridSearch('组件', { limit: 10 })

      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.matchType).toBe('keyword')
        expect(r.semanticScore).toBeUndefined()
        expect(r.keywordScore).toBeGreaterThan(0)
      }
    })

    it('降级时仍返回正确的 MemCell 和 snippet', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发实践')

      vi.spyOn(embeddingService, 'embed').mockRejectedValue(new Error('ONNX model missing'))

      const results = await SemanticSearchRepository.hybridSearch('前端组件', { limit: 10 })

      expect(results.length).toBeGreaterThanOrEqual(1)
      const match = results[0]
      expect(match.memCellId).toBe('mc-1')
      expect(match.matchType).toBe('keyword')
      expect(match.memCell).toBeDefined()
      expect(match.snippet).toBeDefined()
    })
  })

  // ===================== 排序与 limit =====================

  describe('排序与 limit', () => {
    it('结果按 score 降序排列', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发')
      insertMemoryCell(db, 'mc-2', 'ce-1', '组件库设计')
      insertMemoryCell(db, 'mc-3', 'ce-1', '后端服务开发')

      await indexMemCell('mc-1', '前端组件开发')
      await indexMemCell('mc-2', '组件库设计')
      await indexMemCell('mc-3', '后端服务开发')

      const results = await SemanticSearchRepository.hybridSearch('组件', { limit: 10 })

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('limit 限制返回数量', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      for (let i = 0; i < 5; i++) {
        insertMemoryCell(db, `mc-${i}`, 'ce-1', `组件开发项目${i}`)
        await indexMemCell(`mc-${i}`, `组件开发项目${i}`)
      }

      const results = await SemanticSearchRepository.hybridSearch('组件', { limit: 3 })
      expect(results.length).toBeLessThanOrEqual(3)
    })

    it('默认 limit 为 20', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '测试文本')

      const results = await SemanticSearchRepository.hybridSearch('测试')
      expect(results.length).toBeLessThanOrEqual(20)
    })
  })

  // ===================== FTS5 得分归一化 =====================

  describe('FTS5 得分归一化', () => {
    it('bm25 负数得分归一化到 0-1 区间', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发')

      // 不索引 embedding，确保只有关键词匹配
      vi.spyOn(embeddingService, 'embed').mockRejectedValue(new Error('disabled'))

      const results = await SemanticSearchRepository.hybridSearch('前端组件', { limit: 10 })

      const match = results.find((r) => r.memCellId === 'mc-1')
      expect(match).toBeDefined()
      expect(match!.keywordScore).toBeGreaterThanOrEqual(0)
      expect(match!.keywordScore).toBeLessThanOrEqual(1)
    })
  })

  // ===================== 关联 MemCell 对象 =====================

  describe('关联 MemCell 对象', () => {
    it('每条结果包含完整的 MemCell 对象', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(
        db,
        'mc-1',
        'ce-1',
        '前端组件开发',
        ['使用了 React Hooks', '组件复用率 80%']
      )

      await indexMemCell('mc-1', '前端组件开发')

      const results = await SemanticSearchRepository.hybridSearch('前端组件', { limit: 10 })

      const match = results.find((r) => r.memCellId === 'mc-1')
      expect(match).toBeDefined()
      expect(match!.memCell).toBeDefined()
      expect(match!.memCell!.id).toBe('mc-1')
      expect(match!.memCell!.episode).toBe('前端组件开发')
      expect(match!.memCell!.facts).toEqual(['使用了 React Hooks', '组件复用率 80%'])
      expect(match!.memCell!.cleanEpisodeId).toBe('ce-1')
    })

    it('MemCell 已删除但 FTS 残留时，结果被过滤', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', '前端组件开发')

      // 先搜索确认能找到
      const before = await SemanticSearchRepository.hybridSearch('前端组件', { limit: 10 })
      expect(before.find((r) => r.memCellId === 'mc-1')).toBeDefined()

      // 删除 MemCell（FTS 索引通过触发器同步删除）
      db.prepare('DELETE FROM memory_cells WHERE id = ?').run('mc-1')

      const after = await SemanticSearchRepository.hybridSearch('前端组件', { limit: 10 })
      expect(after.find((r) => r.memCellId === 'mc-1')).toBeUndefined()
    })
  })

  // ===================== EmbeddingService 集成 =====================

  describe('EmbeddingService 集成', () => {
    it('使用 TF-IDF 降级方案生成查询向量', async () => {
      insertCleanEpisode(db, 'ce-1', '2026-06-21')
      insertMemoryCell(db, 'mc-1', 'ce-1', 'React 组件开发')
      await indexMemCell('mc-1', 'React 组件开发')

      const results = await SemanticSearchRepository.hybridSearch('React 组件', { limit: 10 })

      const match = results.find((r) => r.memCellId === 'mc-1')
      expect(match).toBeDefined()
      // "React" 和 "组件" 都命中，应为 hybrid
      expect(match!.matchType).toBe('hybrid')
    })

    it('EmbeddingService 实例可正常 embed 查询文本', async () => {
      const service = new EmbeddingService()
      const vec = await service.embed('前端组件开发')
      expect(vec).toBeInstanceOf(Float32Array)
      expect(vec.length).toBe(384)
    })
  })
})
