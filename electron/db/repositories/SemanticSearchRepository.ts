/**
 * SemanticSearchRepository：MemCell 混合检索数据访问层（Task M5）
 *
 * 混合检索 = FTS5 关键词匹配 + 语义向量余弦相似度。
 *
 * 检索流程：
 *  1. FTS5 关键词匹配：对 fts_memory_cells 虚拟表执行 MATCH 查询，
 *     使用 bm25() 得分（负数，越小越相关）归一化到 0-1。
 *  2. 语义向量检索：EmbeddingService.embed(query) 生成查询向量，
 *     EmbeddingRepository.searchBySimilarity 计算余弦相似度（已为 0-1）。
 *  3. 合并去重：同一 memory_cell_id 合并，按
 *     `score = keywordWeight * ftsScore + semanticWeight * semanticScore` 计算综合得分。
 *  4. matchType 判断：仅关键词 → 'keyword'；仅语义 → 'semantic'；两者 → 'hybrid'。
 *  5. 降级：EmbeddingService 不可用时退化为纯 FTS5，所有结果 matchType = 'keyword'。
 *
 * 得分归一化：
 *  - FTS5 bm25 返回负数（越小越相关），归一化公式：`abs(score) / (1 + abs(score))`
 *    确保 bm25 = 0（无匹配）→ 0.0，bm25 = -10（强匹配）→ 0.91
 *  - 语义得分（余弦相似度）已落在 [0, 1] 区间
 */
import type { MemCell } from '../../memory/MemCell'
import { embeddingService } from '../../memory/EmbeddingService'
import { EmbeddingRepository } from './EmbeddingRepository'
import { MemCellRepository } from './MemCellRepository'
import { getDatabase } from '../database'

/** 匹配类型 */
export type MatchType = 'keyword' | 'semantic' | 'hybrid'

/** 混合检索选项 */
export interface HybridSearchOptions {
  /** 返回结果数量上限 */
  limit: number
  /** 关键词得分权重（默认 1.0） */
  keywordWeight: number
  /** 语义得分权重（默认 1.0） */
  semanticWeight: number
}

/** 混合检索单条结果 */
export interface SearchResult {
  /** 关联的 MemCell ID */
  memCellId: string
  /** 综合得分（keywordWeight * ftsScore + semanticWeight * semanticScore） */
  score: number
  /** 匹配类型：关键词匹配 / 语义相似 / 混合 */
  matchType: MatchType
  /** FTS5 归一化得分（0-1），仅关键词匹配或混合时有值 */
  keywordScore?: number
  /** 语义相似度得分（0-1），仅语义匹配或混合时有值 */
  semanticScore?: number
  /** 关联的 MemCell 对象 */
  memCell?: MemCell
  /** FTS5 命中片段（关键词匹配时提供） */
  snippet?: string
}

/** 默认检索选项 */
const DEFAULT_OPTIONS: HybridSearchOptions = {
  limit: 20,
  keywordWeight: 1.0,
  semanticWeight: 1.0
}

/** snippet 最大 token 数 */
const SNIPPET_TOKENS = 12

interface FtsMemoryCellRow {
  id: string
  bm25_score: number
  snippet: string
}

/**
 * 将查询字符串分词（与 SearchRepository.tokenize 保持一致）：
 * - 中文：双字滑窗（bigram）
 * - 英文：按空格/标点切分单词（≥2 字符）
 * - 数字：独立 token
 */
function tokenize(query: string): string[] {
  const terms: string[] = []
  // 中文双字滑窗
  const chineseChars = query.match(/[\u4e00-\u9fa5]/g)
  if (chineseChars) {
    const chineseText = chineseChars.join('')
    for (let i = 0; i < chineseText.length - 1; i++) {
      terms.push(chineseText.substring(i, i + 2))
    }
    if (chineseText.length === 1) {
      terms.push(chineseText)
    }
  }
  // 英文单词
  const englishWords = query.match(/[a-zA-Z]+/g)
  if (englishWords) {
    for (const word of englishWords) {
      if (word.length >= 2) terms.push(word.toLowerCase())
    }
  }
  // 数字 token
  const numbers = query.match(/\d+/g)
  if (numbers) {
    for (const num of numbers) {
      terms.push(num)
    }
  }
  return [...new Set(terms)]
}

/**
 * 构建 FTS5 MATCH 表达式。
 * 每个 term 用双引号包裹（短语查询），转义内部双引号，term 间用 OR 连接。
 * 返回 null 表示无有效 term。
 */
function buildMatchExpr(terms: string[]): string | null {
  if (terms.length === 0) return null
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`)
  return quoted.join(' OR ')
}

/**
 * 归一化 FTS5 bm25 得分到 0-1 区间。
 *
 * bm25 返回负数（越小越相关）：bm25 = 0 表示无匹配，bm25 = -10 表示强匹配。
 * 归一化公式：`abs(score) / (1 + abs(score))`，确保越相关得分越高：
 * - score = 0（无匹配）→ 0.0
 * - score = -1（中等匹配）→ 0.5
 * - score = -10（强匹配）→ 0.91
 */
function normalizeBm25Score(score: number): number {
  const absScore = Math.abs(score)
  return absScore / (1 + absScore)
}

/** FTS5 关键词匹配结果（内部中间结构） */
interface KeywordMatch {
  memCellId: string
  keywordScore: number
  snippet: string
}

/** 语义匹配结果（内部中间结构） */
interface SemanticMatch {
  memCellId: string
  semanticScore: number
}

/**
 * 执行 FTS5 关键词匹配，返回归一化得分与 snippet。
 * 无有效 token 或无匹配时返回空数组。
 */
function searchByKeyword(query: string, limit: number): KeywordMatch[] {
  const terms = tokenize(query)
  const matchExpr = buildMatchExpr(terms)
  if (!matchExpr) return []

  const db = getDatabase()
  let rows: FtsMemoryCellRow[]
  try {
    rows = db
      .prepare(
        `SELECT m.id,
           bm25(fts_memory_cells) AS bm25_score,
           snippet(fts_memory_cells, 0, '«', '»', '…', ?) AS snippet
         FROM fts_memory_cells
         JOIN memory_cells m ON m.rowid = fts_memory_cells.rowid
         WHERE fts_memory_cells MATCH ?
         ORDER BY bm25_score
         LIMIT ?`
      )
      .all(SNIPPET_TOKENS, matchExpr, limit) as FtsMemoryCellRow[]
  } catch (e) {
    console.error(
      '[SemanticSearchRepository] FTS5 关键词匹配失败:',
      e instanceof Error ? e.message : String(e)
    )
    return []
  }

  return rows.map((row) => ({
    memCellId: row.id,
    keywordScore: normalizeBm25Score(row.bm25_score),
    snippet: row.snippet
  }))
}

export const SemanticSearchRepository = {
  /**
   * 混合检索：FTS5 关键词匹配 + 语义向量余弦相似度。
   *
   * @param query 查询字符串
   * @param options 检索选项（limit / keywordWeight / semanticWeight）
   * @returns 按综合得分降序排列的 SearchResult 数组
   */
  async hybridSearch(
    query: string,
    options: Partial<HybridSearchOptions> = {}
  ): Promise<SearchResult[]> {
    const opts: HybridSearchOptions = { ...DEFAULT_OPTIONS, ...options }
    const { limit, keywordWeight, semanticWeight } = opts

    // 1. FTS5 关键词匹配
    const keywordMatches = searchByKeyword(query, limit)

    // 2. 语义向量检索（带降级）
    let semanticMatches: SemanticMatch[] = []
    let semanticAvailable = true
    try {
      const queryEmbedding = await embeddingService.embed(query)
      const embeddingResults = EmbeddingRepository.searchBySimilarity(queryEmbedding, limit)
      semanticMatches = embeddingResults.map((r) => ({
        memCellId: r.memoryCellId,
        semanticScore: r.score
      }))
    } catch (e) {
      // 降级：EmbeddingService 不可用，仅使用 FTS5 关键词匹配
      console.warn(
        '[SemanticSearchRepository] EmbeddingService 不可用，退化为纯 FTS5 检索:',
        e instanceof Error ? e.message : String(e)
      )
      semanticAvailable = false
    }

    // 3. 合并去重：同一 memCellId 合并，计算综合得分
    const merged = new Map<string, SearchResult>()

    for (const kw of keywordMatches) {
      merged.set(kw.memCellId, {
        memCellId: kw.memCellId,
        score: keywordWeight * kw.keywordScore,
        matchType: 'keyword',
        keywordScore: kw.keywordScore,
        snippet: kw.snippet
      })
    }

    for (const sm of semanticMatches) {
      const existing = merged.get(sm.memCellId)
      if (existing) {
        // 两者都有 → 'hybrid'
        existing.matchType = 'hybrid'
        existing.semanticScore = sm.semanticScore
        existing.score = keywordWeight * (existing.keywordScore ?? 0) + semanticWeight * sm.semanticScore
      } else {
        merged.set(sm.memCellId, {
          memCellId: sm.memCellId,
          score: semanticWeight * sm.semanticScore,
          matchType: 'semantic',
          semanticScore: sm.semanticScore
        })
      }
    }

    // 4. 降级场景：EmbeddingService 不可用时，所有结果 matchType = 'keyword'（已在上文设置）
    //    semanticAvailable 仅用于日志，无需额外处理

    // 5. 按 score 降序排序，取 top-N
    const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit)

    // 6. 关联 MemCell 对象
    for (const result of results) {
      result.memCell = MemCellRepository.getById(result.memCellId) ?? undefined
    }

    // 过滤掉 memCell 为 null 的结果（MemCell 已被删除但 FTS/embedding 残留）
    const filtered = results.filter((r) => r.memCell !== undefined)

    // 引用 semanticAvailable 避免 unused 警告（降级日志已在上文输出）
    void semanticAvailable

    return filtered
  }
}
