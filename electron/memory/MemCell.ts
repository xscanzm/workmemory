/**
 * MemCell：结构化记忆单元
 * 借鉴 EverOS MemCell 概念，将记忆从"存储信息"升级为"结构化记忆单元"。
 * 包含 episode（第三人称叙事）、facts（原子事实数组）、foresight（带有效期的预见）三部分。
 */

/** 预见：带有效期的前瞻性陈述 */
export interface Foresight {
  /** 预见陈述，如 "未来涉及密钥存储时可复用此方案" */
  statement: string
  /** ISO 日期，开始生效 */
  validFrom: string
  /** ISO 日期，失效日期 */
  validTo: string
  /** 置信度 0-1 */
  confidence: number
}

/** MemCell 元数据：来源与质量信息 */
export interface MemCellMetadata {
  /** 来源 segment ID */
  segmentIds: string[]
  /** 来源时间戳 */
  timestamp: string
  /** 整体置信度 */
  confidence: number
  /** 活动类型（来自 P1） */
  activityType?: string
  /** 内容类型（来自 P2） */
  contentType?: string
}

/** MemCell：结构化记忆单元 */
export interface MemCell {
  id: string
  /** 关联的 CleanEpisode ID */
  cleanEpisodeId: string
  /** 第三人称叙事，如 "用户在 VS Code 中实现了 API Key 加密功能" */
  episode: string
  /** 原子事实数组，如 ["使用了 safeStorage API", "密钥存储在 userData 目录"] */
  facts: string[]
  /** 预见数组，带有效期 */
  foresight: Foresight[]
  /** 元数据 */
  metadata: MemCellMetadata
  /** ISO 时间戳 */
  createdAt: string
}
