/**
 * MemSceneRepository：MemScene 主题场景数据访问层。
 *
 * memory_scenes 表存储 MemScene（主题场景），由 MemSceneClusterer 自组织聚类产生。
 *  - centroid_embedding：质心向量（Float32Array 序列化为 BLOB，小端序）
 *  - member_cell_ids：成员 MemCell ID 列表（JSON 数组）
 *
 * 向量序列化与 EmbeddingRepository 一致：Float32Array ↔ Buffer（小端序，每 4 字节一个 float）。
 */
import { randomUUID } from 'node:crypto'
import type { MemScene } from '../../memory/MemSceneClusterer'
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

interface MemSceneRow {
  id: string
  title: string
  centroid_embedding: Buffer
  member_cell_ids: string
  summary: string | null
  created_at: string
  updated_at: string
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

function rowToMemScene(row: MemSceneRow): MemScene {
  return {
    id: row.id,
    title: row.title,
    centroidEmbedding: bufferToFloat32Array(row.centroid_embedding),
    memberCellIds: parseJsonArray<string>(row.member_cell_ids),
    summary: row.summary ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export const MemSceneRepository = {
  /**
   * 插入 MemScene
   * @param scene MemScene 对象（id/createdAt 为空时自动生成）
   */
  insert(scene: MemScene): void {
    const db = getDatabase()
    const id = scene.id || randomUUID()
    const createdAt = scene.createdAt || nowIso()
    const updatedAt = scene.updatedAt || createdAt
    db.prepare(
      `INSERT INTO memory_scenes (
        id, title, centroid_embedding, member_cell_ids, summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      scene.title,
      float32ArrayToBuffer(scene.centroidEmbedding),
      stringifyJsonArray(scene.memberCellIds),
      scene.summary || null,
      createdAt,
      updatedAt
    )
  },

  /**
   * 更新 MemScene 的全部可变字段（title/centroid/member_cell_ids/summary）
   * @param scene 待更新的 MemScene（id 必须已存在）
   */
  update(scene: MemScene): void {
    const db = getDatabase()
    const updatedAt = nowIso()
    db.prepare(
      `UPDATE memory_scenes
       SET title = ?, centroid_embedding = ?, member_cell_ids = ?, summary = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      scene.title,
      float32ArrayToBuffer(scene.centroidEmbedding),
      stringifyJsonArray(scene.memberCellIds),
      scene.summary || null,
      updatedAt,
      scene.id
    )
  },

  /**
   * 按 ID 查询 MemScene
   * @returns MemScene 对象；不存在返回 null
   */
  getById(id: string): MemScene | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM memory_scenes WHERE id = ?')
      .get(id) as MemSceneRow | undefined
    return row ? rowToMemScene(row) : null
  },

  /**
   * 查询全部 MemScene（按创建时间升序）
   * @returns MemScene 数组
   */
  getAll(): MemScene[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM memory_scenes ORDER BY created_at ASC')
      .all() as MemSceneRow[]
    return rows.map(rowToMemScene)
  },

  /**
   * 向 MemScene 添加成员 MemCell（追加到 member_cell_ids JSON 数组）
   * 已存在的 memCellId 不会重复添加。同时更新 updated_at。
   * @param sceneId MemScene ID
   * @param memCellId 待添加的 MemCell ID
   */
  addMember(sceneId: string, memCellId: string): void {
    const db = getDatabase()
    const row = db
      .prepare('SELECT member_cell_ids FROM memory_scenes WHERE id = ?')
      .get(sceneId) as Pick<MemSceneRow, 'member_cell_ids'> | undefined
    if (!row) return

    const members = parseJsonArray<string>(row.member_cell_ids)
    if (!members.includes(memCellId)) {
      members.push(memCellId)
    }
    const updatedAt = nowIso()
    db.prepare(
      'UPDATE memory_scenes SET member_cell_ids = ?, updated_at = ? WHERE id = ?'
    ).run(stringifyJsonArray(members), updatedAt, sceneId)
  },

  /**
   * 更新 MemScene 的质心向量。同时更新 updated_at。
   * @param sceneId MemScene ID
   * @param centroid 新的质心向量（Float32Array）
   */
  updateCentroid(sceneId: string, centroid: Float32Array): void {
    const db = getDatabase()
    const updatedAt = nowIso()
    db.prepare(
      'UPDATE memory_scenes SET centroid_embedding = ?, updated_at = ? WHERE id = ?'
    ).run(float32ArrayToBuffer(centroid), updatedAt, sceneId)
  }
}
