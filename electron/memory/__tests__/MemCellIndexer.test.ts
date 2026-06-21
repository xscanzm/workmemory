/**
 * MemCellIndexer 单元测试（Task M4）
 *
 * 测试内容：
 *  - indexMemCell：生成 embedding 并存储，文本拼接正确（episode + facts）
 *  - 事件监听：startIndexing 后 emit 'memcell-created' 事件触发索引
 *  - stopIndexing：停止后不再响应事件
 *  - rebuildEmbeddings：批量补建，跳过已有 embedding 的 MemCell
 *  - 错误隔离：embed/insert 失败不抛异常，不阻塞后续处理
 *  - facts 为空时仅 embed episode
 *
 * 运行方式：npx vitest run electron/memory/__tests__/MemCellIndexer.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock electron 模块（MemCellIndexer 传递性依赖 database.ts → electron）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userdata' }
}))

import { MemCellIndexer } from '../MemCellIndexer'
import type { EmbeddingRepositoryLike, MemCellRepositoryLike } from '../MemCellIndexer'
import { MEMCELL_CREATED_EVENT, memCellEventBus } from '../../events/bus'
import type { MemCell } from '../MemCell'
import type { EmbeddingService } from '../EmbeddingService'

/** 构造测试用 MemCell */
function makeMemCell(overrides: Partial<MemCell> = {}): MemCell {
  return {
    id: 'mc-001',
    cleanEpisodeId: 'ce-001',
    episode: '用户实现了 API Key 加密功能',
    facts: ['使用了 safeStorage API', '密钥存储在 userData 目录'],
    foresight: [],
    metadata: {
      segmentIds: ['seg-001'],
      timestamp: '2026-06-21T10:00:00.000Z',
      confidence: 0.9
    },
    createdAt: '2026-06-21T10:00:00.000Z',
    ...overrides
  }
}

/** mock 依赖集合：保留对每个 mock 函数的引用以便断言 */
interface MockDeps {
  mockEmbeddingService: EmbeddingService
  mockEmbeddingRepository: EmbeddingRepositoryLike
  mockMemCellRepository: MemCellRepositoryLike
  embedMock: ReturnType<typeof vi.fn>
  getModelVersionMock: ReturnType<typeof vi.fn>
  insertMock: ReturnType<typeof vi.fn>
  getByMemoryCellIdMock: ReturnType<typeof vi.fn>
  getByDateRangeMock: ReturnType<typeof vi.fn>
}

/** 构造 mock 依赖 */
function makeMocks(): MockDeps {
  const embedMock = vi.fn().mockResolvedValue(new Float32Array(384))
  const getModelVersionMock = vi.fn().mockReturnValue('tfidf-hash-384')

  const mockEmbeddingService = {
    embed: embedMock,
    getModelVersion: getModelVersionMock
  } as unknown as EmbeddingService

  const insertMock = vi.fn()
  const getByMemoryCellIdMock = vi.fn().mockReturnValue(null)

  const mockEmbeddingRepository = {
    insert: insertMock,
    getByMemoryCellId: getByMemoryCellIdMock
  } as unknown as EmbeddingRepositoryLike

  const getByDateRangeMock = vi.fn().mockReturnValue([])
  const mockMemCellRepository = {
    getByDateRange: getByDateRangeMock
  } as unknown as MemCellRepositoryLike

  return {
    mockEmbeddingService,
    mockEmbeddingRepository,
    mockMemCellRepository,
    embedMock,
    getModelVersionMock,
    insertMock,
    getByMemoryCellIdMock,
    getByDateRangeMock
  }
}

/** 等待微任务队列排空（事件监听器内部异步处理完成） */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MemCellIndexer', () => {
  let indexer: MemCellIndexer
  let mocks: MockDeps

  beforeEach(() => {
    mocks = makeMocks()
    indexer = new MemCellIndexer(
      mocks.mockEmbeddingService,
      mocks.mockEmbeddingRepository,
      mocks.mockMemCellRepository
    )
    // 抑制 console.error（错误隔离测试会触发错误日志）
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    indexer.stopIndexing()
    memCellEventBus.removeAllListeners(MEMCELL_CREATED_EVENT)
    vi.restoreAllMocks()
  })

  // ===================== indexMemCell =====================

  describe('indexMemCell', () => {
    it('生成 embedding 并存储到 repository', async () => {
      const memCell = makeMemCell()
      const expectedEmbedding = new Float32Array(384).fill(0.5)
      mocks.embedMock.mockResolvedValue(expectedEmbedding)

      await indexer.indexMemCell(memCell)

      // 验证文本拼接：episode + ' ' + facts.join(' ')
      const expectedText =
        '用户实现了 API Key 加密功能 使用了 safeStorage API 密钥存储在 userData 目录'
      expect(mocks.embedMock).toHaveBeenCalledWith(expectedText)
      expect(mocks.getModelVersionMock).toHaveBeenCalled()
      expect(mocks.insertMock).toHaveBeenCalledWith(
        'mc-001',
        expectedEmbedding,
        'tfidf-hash-384'
      )
    })

    it('facts 为空时仅 embed episode（不含尾部空格）', async () => {
      const memCell = makeMemCell({ facts: [] })
      await indexer.indexMemCell(memCell)

      expect(mocks.embedMock).toHaveBeenCalledWith('用户实现了 API Key 加密功能')
    })

    it('使用正确的 modelVersion 从 EmbeddingService 获取', async () => {
      mocks.getModelVersionMock.mockReturnValue('onnx-multilingual-e5-small')
      await indexer.indexMemCell(makeMemCell())

      expect(mocks.insertMock).toHaveBeenCalledWith(
        'mc-001',
        expect.any(Float32Array),
        'onnx-multilingual-e5-small'
      )
    })
  })

  // ===================== 错误隔离 =====================

  describe('错误隔离', () => {
    it('embed 抛异常时不抛出，仅记录日志', async () => {
      mocks.embedMock.mockRejectedValue(new Error('ONNX 推理失败'))

      // 不应抛出
      await expect(indexer.indexMemCell(makeMemCell())).resolves.toBeUndefined()

      // insert 不应被调用
      expect(mocks.insertMock).not.toHaveBeenCalled()
      // 错误被记录
      expect(console.error).toHaveBeenCalled()
    })

    it('repository.insert 抛异常时不抛出，仅记录日志', async () => {
      mocks.insertMock.mockImplementation(() => {
        throw new Error('数据库写入失败')
      })

      await expect(indexer.indexMemCell(makeMemCell())).resolves.toBeUndefined()
      expect(console.error).toHaveBeenCalled()
    })

    it('事件监听器内异常不阻塞事件发射方', async () => {
      mocks.embedMock.mockRejectedValue(new Error('异步失败'))
      indexer.startIndexing()

      // emit 不应抛出（即使监听器内部异步处理会失败）
      expect(() => {
        memCellEventBus.emit(MEMCELL_CREATED_EVENT, makeMemCell())
      }).not.toThrow()

      await flushMicrotasks()
      // 异步错误被捕获并记录
      expect(console.error).toHaveBeenCalled()
    })
  })

  // ===================== 事件监听 =====================

  describe('startIndexing / stopIndexing', () => {
    it('startIndexing 后 emit 事件触发索引', async () => {
      indexer.startIndexing()

      const memCell = makeMemCell({ id: 'mc-event-001' })
      memCellEventBus.emit(MEMCELL_CREATED_EVENT, memCell)

      // 等待异步索引完成
      await flushMicrotasks()

      expect(mocks.embedMock).toHaveBeenCalledTimes(1)
      expect(mocks.insertMock).toHaveBeenCalledWith(
        'mc-event-001',
        expect.any(Float32Array),
        'tfidf-hash-384'
      )
    })

    it('stopIndexing 后不再响应事件', async () => {
      indexer.startIndexing()
      indexer.stopIndexing()

      memCellEventBus.emit(MEMCELL_CREATED_EVENT, makeMemCell())
      await flushMicrotasks()

      expect(mocks.embedMock).not.toHaveBeenCalled()
      expect(mocks.insertMock).not.toHaveBeenCalled()
    })

    it('多次调用 startIndexing 只注册一次监听', async () => {
      indexer.startIndexing()
      indexer.startIndexing()
      indexer.startIndexing()

      memCellEventBus.emit(MEMCELL_CREATED_EVENT, makeMemCell())
      await flushMicrotasks()

      // 只触发一次 embed（监听器只注册一次）
      expect(mocks.embedMock).toHaveBeenCalledTimes(1)
    })

    it('stopIndexing 后可重新 startIndexing', async () => {
      indexer.startIndexing()
      indexer.stopIndexing()

      // 重新启动
      indexer.startIndexing()
      memCellEventBus.emit(MEMCELL_CREATED_EVENT, makeMemCell({ id: 'mc-restart' }))
      await flushMicrotasks()

      expect(mocks.embedMock).toHaveBeenCalledTimes(1)
      expect(mocks.insertMock).toHaveBeenCalledWith(
        'mc-restart',
        expect.any(Float32Array),
        'tfidf-hash-384'
      )
    })

    it('未调用 startIndexing 时不响应事件', async () => {
      memCellEventBus.emit(MEMCELL_CREATED_EVENT, makeMemCell())
      await flushMicrotasks()

      expect(mocks.embedMock).not.toHaveBeenCalled()
    })
  })

  // ===================== rebuildEmbeddings =====================

  describe('rebuildEmbeddings', () => {
    it('为无 embedding 的 MemCell 批量补建', async () => {
      const cells = [
        makeMemCell({ id: 'mc-1', episode: '事件一', facts: ['事实一'] }),
        makeMemCell({ id: 'mc-2', episode: '事件二', facts: ['事实二'] })
      ]
      mocks.getByDateRangeMock.mockReturnValue(cells)
      mocks.getByMemoryCellIdMock.mockReturnValue(null)

      const result = await indexer.rebuildEmbeddings()

      expect(result).toEqual({ total: 2, success: 2, failed: 0 })
      expect(mocks.embedMock).toHaveBeenCalledTimes(2)
      expect(mocks.insertMock).toHaveBeenCalledTimes(2)
    })

    it('跳过已有 embedding 的 MemCell', async () => {
      const cells = [
        makeMemCell({ id: 'mc-1' }),
        makeMemCell({ id: 'mc-2' }),
        makeMemCell({ id: 'mc-3' })
      ]
      mocks.getByDateRangeMock.mockReturnValue(cells)
      // mc-2 已有 embedding
      mocks.getByMemoryCellIdMock.mockImplementation((id: string) =>
        id === 'mc-2'
          ? { embedding: new Float32Array(384), modelVersion: 'tfidf-hash-384' }
          : null
      )

      const result = await indexer.rebuildEmbeddings()

      expect(result).toEqual({ total: 3, success: 2, failed: 0 })
      // 只为 mc-1 和 mc-3 生成 embedding
      expect(mocks.embedMock).toHaveBeenCalledTimes(2)
      expect(mocks.insertMock).toHaveBeenCalledTimes(2)
    })

    it('使用 dateRange 过滤 MemCell', async () => {
      mocks.getByDateRangeMock.mockReturnValue([])
      const dateRange = { start: '2026-06-01T00:00:00.000Z', end: '2026-06-30T23:59:59.999Z' }

      await indexer.rebuildEmbeddings(dateRange)

      expect(mocks.getByDateRangeMock).toHaveBeenCalledWith(
        '2026-06-01T00:00:00.000Z',
        '2026-06-30T23:59:59.999Z'
      )
    })

    it('未提供 dateRange 时使用全量范围', async () => {
      mocks.getByDateRangeMock.mockReturnValue([])

      await indexer.rebuildEmbeddings()

      const [start, end] = mocks.getByDateRangeMock.mock.calls[0]
      // 下界覆盖 1970，上界覆盖 2999
      expect(start).toBe('1970-01-01T00:00:00.000Z')
      expect(end).toBe('2999-12-31T23:59:59.999Z')
    })

    it('单条失败不阻塞后续处理，返回 failed 计数', async () => {
      const cells = [
        makeMemCell({ id: 'mc-1', episode: '事件一' }),
        makeMemCell({ id: 'mc-2', episode: '事件二' }),
        makeMemCell({ id: 'mc-3', episode: '事件三' })
      ]
      mocks.getByDateRangeMock.mockReturnValue(cells)
      mocks.getByMemoryCellIdMock.mockReturnValue(null)
      // mc-2 的 embed 失败
      mocks.embedMock.mockImplementation((text: string) => {
        if (text.includes('事件二')) {
          return Promise.reject(new Error('模拟失败'))
        }
        return Promise.resolve(new Float32Array(384))
      })

      const result = await indexer.rebuildEmbeddings()

      expect(result).toEqual({ total: 3, success: 2, failed: 1 })
      expect(mocks.insertMock).toHaveBeenCalledTimes(2)
    })

    it('空数据库返回全零结果', async () => {
      mocks.getByDateRangeMock.mockReturnValue([])

      const result = await indexer.rebuildEmbeddings()

      expect(result).toEqual({ total: 0, success: 0, failed: 0 })
      expect(mocks.embedMock).not.toHaveBeenCalled()
    })

    it('文本拼接与 indexMemCell 一致', async () => {
      const cell = makeMemCell({
        id: 'mc-text',
        episode: '用户编写了单元测试',
        facts: ['使用 vitest', 'mock 了依赖']
      })
      mocks.getByDateRangeMock.mockReturnValue([cell])
      mocks.getByMemoryCellIdMock.mockReturnValue(null)

      await indexer.rebuildEmbeddings()

      expect(mocks.embedMock).toHaveBeenCalledWith(
        '用户编写了单元测试 使用 vitest mock 了依赖'
      )
    })
  })

  // ===================== 集成：事件 → 索引 → 存储 =====================

  describe('集成：事件触发索引', () => {
    it('emit 事件后 embeddings 表有对应记录（模拟）', async () => {
      const expectedVec = new Float32Array(384).fill(0.7)
      mocks.embedMock.mockResolvedValue(expectedVec)

      indexer.startIndexing()
      const memCell = makeMemCell({
        id: 'mc-integration',
        episode: '集成测试事件',
        facts: ['验证事件触发索引']
      })

      memCellEventBus.emit(MEMCELL_CREATED_EVENT, memCell)
      await flushMicrotasks()

      // 验证完整流程：embed 被调用 → insert 被调用，参数正确
      expect(mocks.embedMock).toHaveBeenCalledWith('集成测试事件 验证事件触发索引')
      expect(mocks.getModelVersionMock).toHaveBeenCalled()
      expect(mocks.insertMock).toHaveBeenCalledWith(
        'mc-integration',
        expectedVec,
        'tfidf-hash-384'
      )
    })
  })
})
