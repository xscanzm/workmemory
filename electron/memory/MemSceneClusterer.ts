/**
 * MemSceneClusterer：MemScene 主题自组织聚类（Task M6）
 *
 * 职责：
 *  - clusterMemCell(memCell)：将新 MemCell 增量聚类到现有 MemScene 或新建 MemScene
 *  - 聚类算法：计算新 MemCell embedding 与所有现有 MemScene 质心的余弦相似度，
 *    最大值 >0.8 则归并（更新质心为成员均值），否则新建 MemScene
 *  - 标题生成：新建时用 AI 生成标题（基于首个 MemCell episode），归并时保留原标题
 *
 * 设计说明：
 *  - 增量聚类：每次只处理一个新 MemCell，不重新聚类全部历史数据
 *  - 质心增量更新：归并时新质心 = (旧质心 * 旧成员数 + 新向量) / (旧成员数 + 1)，
 *    避免重新计算所有成员向量的开销
 *  - 错误隔离：聚类失败由调用方（MemCellIndexer）处理，本模块抛出异常
 *
 * 借鉴 EverOS MemScene 概念，将语义相似的 MemCell 自组织聚类为 MemScene（主题场景），
 * 支持跨时间的主题关联发现。
 */
import { randomUUID } from 'node:crypto'
import type { MemCell } from './MemCell'
import { EmbeddingService } from './EmbeddingService'
import { EmbeddingRepository } from '../db/repositories/EmbeddingRepository'
import { MemSceneRepository } from '../db/repositories/MemSceneRepository'
import { OpenAIClient } from '../ai/OpenAIClient'
import { SettingsStore } from '../db/SettingsStore'

/** MemScene：主题场景，语义相似的 MemCell 聚类 */
export interface MemScene {
  id: string
  /** 主题标题，如"数据库迁移工作" */
  title: string
  /** 质心向量（成员 embedding 的均值） */
  centroidEmbedding: Float32Array
  /** 成员 MemCell ID 列表 */
  memberCellIds: string[]
  /** 主题摘要（可选，初始为空） */
  summary: string
  /** ISO 创建时间 */
  createdAt: string
  /** ISO 更新时间 */
  updatedAt: string
}

/** 聚类结果 */
export interface ClusterResult {
  sceneId: string
  isNew: boolean
}

/** 聚类阈值：余弦相似度 >0.8 则归并到现有 MemScene */
const SIMILARITY_THRESHOLD = 0.8

/** 降级标题最大长度（按字符计） */
const FALLBACK_TITLE_MAX_CHARS = 30

/** EmbeddingRepository 依赖接口（结构化类型，便于测试 mock） */
export interface EmbeddingRepositoryLike {
  getByMemoryCellId(memoryCellId: string): {
    embedding: Float32Array
    modelVersion: string
  } | null
}

/** MemSceneRepository 依赖接口（结构化类型，便于测试 mock） */
export interface MemSceneRepositoryLike {
  insert(scene: MemScene): void
  update(scene: MemScene): void
  getById(id: string): MemScene | null
  getAll(): MemScene[]
  addMember(sceneId: string, memCellId: string): void
  updateCentroid(sceneId: string, centroid: Float32Array): void
}

/**
 * 从 SettingsStore 读取 API 配置（API Key 走加密存储 getApiKey()，不读明文）
 */
function getApiConfig(): { baseUrl: string; apiKey: string; model: string } {
  const settings = SettingsStore.get()
  return {
    baseUrl: settings.apiBaseUrl || 'https://api.openai.com/v1',
    apiKey: SettingsStore.getApiKey(),
    model: settings.modelName || 'gpt-4o-mini'
  }
}

/**
 * 调用 AI 生成 MemScene 标题（基于 MemCell episode）
 * AI 不可用（未配置 API Key 或调用失败）时降级为 episode 前 30 字
 */
async function generateSceneTitle(episode: string): Promise<string> {
  const fallback = episode.slice(0, FALLBACK_TITLE_MAX_CHARS)
  try {
    const apiConfig = getApiConfig()
    if (!apiConfig.apiKey) {
      return fallback
    }
    const result = await OpenAIClient.chatCompletion({
      baseUrl: apiConfig.baseUrl,
      apiKey: apiConfig.apiKey,
      model: apiConfig.model,
      messages: [
        {
          role: 'system',
          content:
            '你是一个主题标题生成器。根据给定的工作记忆事件描述，生成一个简洁的中文主题标题（不超过 15 个字，不要引号、不要标点结尾）。只返回标题文本。'
        },
        {
          role: 'user',
          content: episode
        }
      ],
      temperature: 0.3,
      maxTokens: 30
    })
    const title = result.content.trim()
    return title || fallback
  } catch (e) {
    console.warn(
      '[MemSceneClusterer] AI 标题生成失败，降级使用 episode 前 30 字:',
      e instanceof Error ? e.message : String(e)
    )
    return fallback
  }
}

/**
 * 计算归并后的新质心（增量更新，避免重新计算所有成员向量）
 * 新质心 = (旧质心 * 旧成员数 + 新向量) / (旧成员数 + 1)
 */
function computeNewCentroid(
  oldCentroid: Float32Array,
  newVector: Float32Array,
  oldMemberCount: number
): Float32Array {
  const dim = oldCentroid.length
  const result = new Float32Array(dim)
  const newCount = oldMemberCount + 1
  for (let i = 0; i < dim; i++) {
    result[i] = (oldCentroid[i] * oldMemberCount + newVector[i]) / newCount
  }
  return result
}

/**
 * MemSceneClusterer：MemScene 主题自组织聚类器。
 *
 * 使用方式：
 * ```ts
 * const clusterer = new MemSceneClusterer(embeddingRepository, memSceneRepository)
 * const result = await clusterer.clusterMemCell(memCell)
 * ```
 */
export class MemSceneClusterer {
  constructor(
    private readonly embeddingRepository: EmbeddingRepositoryLike,
    private readonly memSceneRepository: MemSceneRepositoryLike
  ) {}

  /**
   * 增量聚类：将新 MemCell 归并到现有 MemScene 或新建 MemScene
   *
   * 算法：
   *  1. 从 EmbeddingRepository 获取新 MemCell 的 embedding
   *  2. 加载所有现有 MemScene 的质心
   *  3. 计算新 embedding 与每个质心的余弦相似度
   *  4. 最大相似度 >0.8 → 归并：addMember + updateCentroid（增量更新质心）
   *  5. 最大相似度 ≤0.8 → 新建：AI 生成标题，centroid = 新向量
   *
   * @param memCell 待聚类的 MemCell
   * @returns { sceneId, isNew }
   * @throws 当 MemCell 没有 embedding 时抛出错误
   */
  async clusterMemCell(memCell: MemCell): Promise<ClusterResult> {
    // 1. 获取新 MemCell 的 embedding
    const record = this.embeddingRepository.getByMemoryCellId(memCell.id)
    if (record === null) {
      throw new Error(`MemCell ${memCell.id} 没有 embedding，无法聚类`)
    }
    const newEmbedding = record.embedding

    // 2. 加载所有现有 MemScene
    const scenes = this.memSceneRepository.getAll()

    // 3. 计算与每个质心的余弦相似度，找最大值
    let bestScene: MemScene | null = null
    let bestScore = -Infinity
    for (const scene of scenes) {
      const score = EmbeddingService.cosineSimilarity(
        newEmbedding,
        scene.centroidEmbedding
      )
      if (score > bestScore) {
        bestScore = score
        bestScene = scene
      }
    }

    // 4. 归并或新建
    if (bestScene !== null && bestScore > SIMILARITY_THRESHOLD) {
      // 归并到现有 MemScene：增量更新质心
      const oldMemberCount = bestScene.memberCellIds.length
      const newCentroid = computeNewCentroid(
        bestScene.centroidEmbedding,
        newEmbedding,
        oldMemberCount
      )
      this.memSceneRepository.addMember(bestScene.id, memCell.id)
      this.memSceneRepository.updateCentroid(bestScene.id, newCentroid)
      return { sceneId: bestScene.id, isNew: false }
    }

    // 5. 新建 MemScene：AI 生成标题，centroid = 新向量
    const title = await generateSceneTitle(memCell.episode)
    const now = new Date().toISOString()
    const scene: MemScene = {
      id: randomUUID(),
      title,
      centroidEmbedding: newEmbedding,
      memberCellIds: [memCell.id],
      summary: '',
      createdAt: now,
      updatedAt: now
    }
    this.memSceneRepository.insert(scene)
    return { sceneId: scene.id, isNew: true }
  }
}

// ===================== 单例 =====================

let clustererInstance: MemSceneClusterer | null = null

/**
 * 获取 MemSceneClusterer 单例
 *
 * 使用全局 EmbeddingRepository 和 MemSceneRepository 常量构造。
 * 测试时建议直接 `new MemSceneClusterer(...)` 注入 mock 依赖，不使用此单例。
 */
export function getMemSceneClusterer(): MemSceneClusterer {
  if (clustererInstance === null) {
    clustererInstance = new MemSceneClusterer(
      EmbeddingRepository,
      MemSceneRepository
    )
  }
  return clustererInstance
}

/** 重置单例（仅供测试） */
export function resetMemSceneClusterer(): void {
  clustererInstance = null
}
