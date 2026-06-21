/**
 * SQLite JSON 数组字段的安全序列化/反序列化工具。
 * 领域对象中数组字段在入库前 JSON.stringify，出库后 JSON.parse。
 */

export function parseJsonArray<T = string>(value: string | null | undefined): T[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function stringifyJsonArray(value: unknown[] | undefined | null): string {
  if (!value) return '[]'
  try {
    return JSON.stringify(value)
  } catch {
    return '[]'
  }
}

/** 安全解析任意 JSON 字段（对象或数组） */
export function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
