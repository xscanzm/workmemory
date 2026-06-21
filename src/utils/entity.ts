/**
 * 实体工具：低置信过滤与确认态判定。
 *
 * 自动抽取的实体带 confidence（0-1），低于阈值的实体不进入 Wiki/报告默认选择；
 * 用户已确认（userConfirmed=true）的实体视为高可信，不再被低置信过滤。
 */

/** 低置信阈值：低于此值且未用户确认的实体视为低置信 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5

/**
 * 判断实体是否为低置信。
 * 规则：未用户确认 且 confidence < 阈值 → 低置信。
 * 兼容历史数据：confidence 缺失时视为高置信（不过滤）。
 */
export function isLowConfidenceEntity(entity: {
  confidence?: number
  userConfirmed?: boolean
}): boolean {
  if (entity.userConfirmed) return false
  if (typeof entity.confidence !== 'number') return false
  return entity.confidence < LOW_CONFIDENCE_THRESHOLD
}

/**
 * 过滤出高置信实体（排除低置信）。
 * 用于 Wiki 自动提取候选检测、报告默认实体选择、Insights 统计等场景。
 */
export function filterHighConfidenceEntities<T extends { confidence?: number; userConfirmed?: boolean }>(
  entities: T[]
): T[] {
  return entities.filter((e) => !isLowConfidenceEntity(e))
}
