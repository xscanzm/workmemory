/**
 * MemCellIndexer：MemCell 语义向量索引器（Task M4）
 *
 * 职责：
 *  - 监听事件总线上的 'memcell-created' 事件，异步为新建 MemCell 生成 embedding 并存储
 *  - 提供 rebuildEmbeddings(dateRange?) 批量补建历史 MemCell 的 embedding
 *  - 错误隔离：embedding 生成失败不阻塞 DistillManager 主流程，仅记录日志
 *
 * 设计说明：
 *  - 通过事件总线解耦：DistillManager 不直接调用 MemCellIndexer，仅 emit 事件
 *  - 依赖注入：构造函数接收 EmbeddingService 和两个 Repository，便于测试 mock
 *  - 异步处理：事件监听器内部调用 indexMemCell 并 catch 异常，不影响事件发射方
 *
 * 文本拼接规则：
 *  - facts 非空：`episode + ' ' + facts.join(' ')`
 *  - facts 为空：仅 `episode`
 */
import type { EmbeddingService } from './EmbeddingService'
import { embeddingService } from './EmbeddingService'
import { EmbeddingRepository } from '../db/repositories/EmbeddingRepository'
import { MemCellRepository } from '../db/repositories/MemCellRepository'
import type { MemCell } from './MemCell'
import { MEMCELL_CREATED_EVENT, memCellEventBus } from '../events/bus'
import type { MemSceneClusterer } from './MemSceneClusterer'
import { getMemSceneClusterer } from './MemSceneClusterer'

/** EmbeddingRepository 依赖接口（结构化类型，便于测试 mock） */
export interface EmbeddingRepositoryLike {
  insert(memoryCellId: string, embedding: Float32Array, modelVersion: string): void
  getByMemoryCellId(memoryCellId: string): {
    embedding: Float32Array
    modelVersion: string
  } | null
}

/** MemCellRepository 依赖接口（结构化类型，便于测试 mock） */
export interface MemCellRepositoryLike {
  getByDateRange(startDate: string, endDate: string): MemCell[]
}

/** 批量补建结果 */
export interface RebuildResult {
  /** 范围内 MemCell 总数 */
  total: number
  /** 成功生成 embedding 的数量 */
  success: number
  /** 失败数量 */
  failed: number
}

/** 全量补建时使用的下界时间戳（覆盖所有历史数据） */
const DATE_RANGE_LOWER_BOUND = '1970-01-01T00:00:00.000Z'

/** 全量补建时使用的上界时间戳（覆盖未来若干年的数据） */
const DATE_RANGE_UPPER_BOUND = '2999-12-31T23:59:59.999Z'

/**
 * MemCellIndexer：MemCell 语义向量索引器。
 *
 * 使用方式：
 * ```ts
 * const indexer = new MemCellIndexer(embeddingService, EmbeddingRepository, MemCellRepository)
 * indexer.startIndexing()  // app ready 后调用
 * // ... DistillManager 写入 MemCell 后会自动触发索引
 * indexer.stopIndexing()   // app 退出前调用
 * ```
 */
export class MemCellIndexer {
  private listener: ((memCell: MemCell) => void) | null = null
  private initialized = false

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly embeddingRepository: EmbeddingRepositoryLike,
    private readonly memCellRepository: MemCellRepositoryLike,
    private readonly memSceneClusterer?: MemSceneClusterer
  ) {}

  /** 开始监听 'memcell-created' 事件 */
  startIndexing(): void {
    if (this.initialized) return
    this.listener = (memCell: MemCell) => {
      // 异步生成 embedding，失败不阻塞主流程（异常在此捕获并记录）
      this.indexMemCell(memCell).catch((e) => {
        console.error(
          '[MemCellIndexer] 事件监听索引失败:',
          e instanceof Error ? e.message : String(e)
        )
      })
    }
    memCellEventBus.on(MEMCELL_CREATED_EVENT, this.listener)
    this.initialized = true
  }

  /** 停止监听 'memcell-created' 事件 */
  stopIndexing(): void {
    if (this.listener) {
      memCellEventBus.removeListener(MEMCELL_CREATED_EVENT, this.listener)
      this.listener = null
    }
    this.initialized = false
  }

  /**
   * 索引单个 MemCell：生成 embedding 并存储到 embeddings 表
   *
   * 错误隔离：内部 try-catch 包裹，失败时仅记录日志，不抛出异常，
   * 确保不影响 DistillManager 主流程或事件循环。
   *
   * M6：embedding 生成并存储后，触发 MemSceneClusterer.clusterMemCell 进行主题聚类。
   * 聚类失败不影响索引主流程（独立 try-catch 隔离）。
   *
   * @param memCell 待索引的 MemCell
   */
  async indexMemCell(memCell: MemCell): Promise<void> {
    try {
      const text = buildEmbeddingText(memCell)
      const embedding = await this.embeddingService.embed(text)
      const modelVersion = this.embeddingService.getModelVersion()
      this.embeddingRepository.insert(memCell.id, embedding, modelVersion)
    } catch (e) {
      console.error(
        `[MemCellIndexer] MemCell ${memCell.id} embedding 生成失败:`,
        e instanceof Error ? e.message : String(e)
      )
      return
    }

    // M6: embedding 生成后触发 MemScene 聚类（错误隔离：聚类失败不影响索引主流程）
    if (this.memSceneClusterer) {
      try {
        await this.memSceneClusterer.clusterMemCell(memCell)
      } catch (e) {
        console.error(
          `[MemCellIndexer] MemCell ${memCell.id} MemScene 聚类失败:`,
          e instanceof Error ? e.message : String(e)
        )
      }
    }
  }

  /**
   * 批量补建：为历史 MemCell 补建 embedding
   *
   * - 未提供 dateRange 时，处理全部 MemCell
   * - 已有 embedding 的 MemCell 会被跳过（避免重复生成）
   * - 单条失败不阻塞后续处理，最终返回 success/failed 计数
   *
   * @param dateRange 可选，{ start, end } ISO 时间戳范围（基于 created_at）
   * @returns { total, success, failed }
   */
  async rebuildEmbeddings(
    dateRange?: { start: string; end: string }
  ): Promise<RebuildResult> {
    const start = dateRange?.start ?? DATE_RANGE_LOWER_BOUND
    const end = dateRange?.end ?? DATE_RANGE_UPPER_BOUND

    const memCells = this.memCellRepository.getByDateRange(start, end)
    let success = 0
    let failed = 0

    for (const memCell of memCells) {
      // 跳过已有 embedding 的 MemCell（避免重复生成）
      const existing = this.embeddingRepository.getByMemoryCellId(memCell.id)
      if (existing !== null) continue

      try {
        const text = buildEmbeddingText(memCell)
        const embedding = await this.embeddingService.embed(text)
        const modelVersion = this.embeddingService.getModelVersion()
        this.embeddingRepository.insert(memCell.id, embedding, modelVersion)
        success++
      } catch (e) {
        console.error(
          `[MemCellIndexer] 批量补建 MemCell ${memCell.id} 失败:`,
          e instanceof Error ? e.message : String(e)
        )
        failed++
      }
    }

    return { total: memCells.length, success, failed }
  }
}

/**
 * 构造 embedding 输入文本
 *
 * 规则：
 *  - facts 非空：`episode + ' ' + facts.join(' ')`
 *  - facts 为空：仅 `episode`（避免尾部多余空格）
 */
function buildEmbeddingText(memCell: MemCell): string {
  if (memCell.facts.length > 0) {
    return `${memCell.episode} ${memCell.facts.join(' ')}`
  }
  return memCell.episode
}

// ===================== 单例 =====================

let indexerInstance: MemCellIndexer | null = null

/**
 * 获取 MemCellIndexer 单例
 *
 * 使用全局 EmbeddingService 单例和 Repository 常量构造。
 * 测试时建议直接 `new MemCellIndexer(...)` 注入 mock 依赖，不使用此单例。
 */
export function getMemCellIndexer(): MemCellIndexer {
  if (indexerInstance === null) {
    indexerInstance = new MemCellIndexer(
      embeddingService,
      EmbeddingRepository,
      MemCellRepository,
      getMemSceneClusterer()
    )
  }
  return indexerInstance
}

/** 重置单例（仅供测试） */
export function resetMemCellIndexer(): void {
  if (indexerInstance) {
    indexerInstance.stopIndexing()
    indexerInstance = null
  }
}
