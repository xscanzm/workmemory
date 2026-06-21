/**
 * EmbeddingRepository：MemCell 语义向量数据访问层。
 *
 * embeddings 表存储 MemCell 的语义向量（Float32Array 序列化为 BLOB），
 * 通过 memory_cell_id 外键关联 memory_cells 表。
 *
 * 向量序列化：Float32Array ↔ Buffer（小端序，每 4 字节一个 float）。
 * 语义检索：searchBySimilarity 加载所有 embedding 到内存，计算余弦相似度，返回 top-N。
 */
import { randomUUID } from 'node:crypto'
import { EmbeddingService } from '../../memory/EmbeddingService'
import { getDatabase } from '../database'

interface EmbeddingRow {
  id: string
  memory_cell_id: string
  embedding: Buffer
  model_version: string
  created_at: string
}

interface EmbeddingSearchRow {
  memory_cell_id: string
  embedding: Buffer
}

/** 查询结果：向量 + 模型版本 */
export interface EmbeddingRecord {
  embedding: Float32Array
  modelVersion: string
}

/** 搜索结果：memoryCellId + 相似度分数 */
export interface EmbeddingSearchResult {
  memoryCellId: string
  score: number
}

/** Float32Array → Buffer（小端序） */
function float32ArrayToBuffer(arr: Float32Array): Buffer {
  const buffer = Buffer.alloc(arr.length * 4)
  for (let i = 0; i < arr.length; i++) {
    buffer.writeFloatLE(arr[i], i * 4)
  }
  return buffer
}

/** Buffer → Float32Array（小端序） */
function bufferToFloat32Array(buffer: Buffer): Float32Array {
  const length = Math.floor(buffer.length / 4)
  const arr = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    arr[i] = buffer.readFloatLE(i * 4)
  }
  return arr
}

function nowIso(): string {
  return new Date().toISOString()
}

export const EmbeddingRepository = {
  /**
   * 插入 embedding 记录
   * @param memoryCellId 关联的 MemCell ID
   * @param embedding 语义向量（Float32Array）
   * @param modelVersion 模型版本标识（如 'tfidf-hash-384' 或 'onnx-multilingual-e5-small'）
   */
  insert(memoryCellId: string, embedding: Float32Array, modelVersion: string): void {
    const db = getDatabase()
    const id = randomUUID()
    const createdAt = nowIso()
    const embeddingBuffer = float32ArrayToBuffer(embedding)
    db.prepare(
      `INSERT INTO embeddings (id, memory_cell_id, embedding, model_version, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, memoryCellId, embeddingBuffer, modelVersion, createdAt)
  },

  /**
   * 按 memoryCellId 查询最新的 embedding 记录
   * @returns 向量 + 模型版本；不存在返回 null
   */
  getByMemoryCellId(memoryCellId: string): EmbeddingRecord | null {
    const db = getDatabase()
    const row = db
      .prepare(
        `SELECT embedding, model_version FROM embeddings
         WHERE memory_cell_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(memoryCellId) as Pick<EmbeddingRow, 'embedding' | 'model_version'> | undefined

    if (!row) return null
    return {
      embedding: bufferToFloat32Array(row.embedding),
      modelVersion: row.model_version
    }
  },

  /**
   * 语义检索：加载所有 embedding 到内存，计算余弦相似度，返回 top-N
   * @param queryEmbedding 查询向量
   * @param limit 返回数量上限
   * @returns 按 score 降序排列的 { memoryCellId, score } 数组
   */
  searchBySimilarity(queryEmbedding: Float32Array, limit: number): EmbeddingSearchResult[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT memory_cell_id, embedding FROM embeddings')
      .all() as EmbeddingSearchRow[]

    if (rows.length === 0) return []

    const results: EmbeddingSearchResult[] = rows.map((row) => ({
      memoryCellId: row.memory_cell_id,
      score: EmbeddingService.cosineSimilarity(queryEmbedding, bufferToFloat32Array(row.embedding))
    }))

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }
}
