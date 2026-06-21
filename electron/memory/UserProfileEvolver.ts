/**
 * UserProfileEvolver：用户画像演进（Task M7）
 *
 * 职责：
 *  - evolveProfile(date)：从指定日期的 MemCell 活动与 MemScene 摘要中提取用户画像
 *  - 稳定特质（stable）：primary_activity / preferred_apps / work_pattern
 *    置信度随跨日一致性累积（连续 N 天同值 → confidence 逐步提升至上限 0.95）
 *  - 瞬态状态（transient）：current_focus
 *    每次更新覆盖，valid_to = 当日 + 7 天
 *
 * 画像提取规则：
 *  - primary_activity（stable）：统计当日所有 MemCell 的 metadata.activityType，
 *    取出现次数最多的（忽略 idle），confidence = 出现次数 / 总数
 *  - current_focus（transient）：从当日活跃 MemScene 中取最近更新的标题，
 *    valid_to = 当日 + 7 天
 *  - preferred_apps（stable）：统计当日所有 segment 的 appName（通过 MemCell.metadata.segmentIds
 *    关联 segments 表），取出现频率最高的前 3 个应用，confidence = top1 频率 / 总数
 *  - work_pattern（stable）：统计当日活动时段（上午 6-12 / 下午 12-18 / 晚上 18-6），
 *    取最活跃时段，confidence = 最活跃时段计数 / 总计数
 *
 * 设计说明：
 *  - 同日幂等：若 stable 画像已在本日更新且值一致，不重复累积置信度，避免一日多次启动导致过拟合
 *  - 跨日累积：stable 画像值一致时 confidence += 0.05（上限 0.95），值变化时重置为当日基础置信度
 *  - 借鉴 EverOS User Profile 概念，区分稳定特质与瞬态状态，支持个性化记忆与主动建议
 */
import type { MemCell } from './MemCell'
import type { MemScene } from './MemSceneClusterer'
import { MemCellRepository } from '../db/repositories/MemCellRepository'
import { MemSceneRepository } from '../db/repositories/MemSceneRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import {
  UserProfileRepository,
  type UserProfileEntry
} from '../db/repositories/UserProfileRepository'

/** stable 画像跨日一致性累积步长 */
const STABLE_CONFIDENCE_BOOST = 0.05
/** stable 画像置信度上限 */
const STABLE_CONFIDENCE_MAX = 0.95
/** transient 画像有效期天数 */
const TRANSIENT_VALID_DAYS = 7
/** preferred_apps 取前 N 个应用 */
const PREFERRED_APPS_TOP_N = 3

/** 活动时段定义 */
type TimeSlot = 'morning' | 'afternoon' | 'evening'

/** idle 活动类型，统计 primary_activity 时忽略 */
const IDLE_ACTIVITY = 'idle'

/**
 * 根据 UTC 小时判断活动时段。
 *  - morning：6-12 点
 *  - afternoon：12-18 点
 *  - evening：18-6 点（含深夜 0-6）
 */
function hourToSlot(hour: number): TimeSlot {
  if (hour >= 6 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}

/**
 * 计算日期 + N 天后的日期字符串（YYYY-MM-DD）。
 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * 插入或更新 stable 画像条目，处理跨日置信度累积与同日幂等。
 *
 * 累积规则：
 *  - 若已存在同 key、同 type=stable、同 value 的条目：
 *    - 同日重复运行（sources 重叠，即处理了同一批 MemCell）：保持已有置信度（不重复累积）
 *    - 跨日一致（sources 不重叠，即处理了新一天的数据）：
 *      confidence = min(0.95, max(当日基础置信度, 已有置信度 + 0.05))
 *  - 若值变化或不存在：使用当日基础置信度
 *
 * 同日幂等通过 sources 重叠检测实现：同一日的 MemCell ID 相同，重复处理时 sources 重叠，
 * 不累积置信度；不同日期的 MemCell ID 不同，sources 不重叠，累积置信度。
 */
function upsertStable(entry: UserProfileEntry): void {
  const existing = UserProfileRepository.get(entry.key)
  let confidence = entry.confidence
  if (
    existing !== null &&
    existing.type === 'stable' &&
    existing.value === entry.value
  ) {
    const existingSources = new Set(existing.sources)
    const isSameDay = entry.sources.some((s) => existingSources.has(s))
    if (!isSameDay) {
      // 跨日一致：累积置信度
      confidence = Math.min(
        STABLE_CONFIDENCE_MAX,
        Math.max(entry.confidence, existing.confidence + STABLE_CONFIDENCE_BOOST)
      )
    } else {
      // 同日重复运行：保持已有置信度，避免一日多次启动过拟合
      confidence = existing.confidence
    }
  }
  UserProfileRepository.upsert({ ...entry, confidence })
}

/**
 * 计算 primary_activity（stable）：统计当日 MemCell 的 activityType，取众数（忽略 idle）。
 * @returns 画像条目；无有效活动数据时返回 null
 */
function computePrimaryActivity(
  memCells: MemCell[],
  now: string
): UserProfileEntry | null {
  const counts = new Map<string, { count: number; sources: string[] }>()
  for (const cell of memCells) {
    const activity = cell.metadata.activityType
    if (!activity || activity === IDLE_ACTIVITY) continue
    const entry = counts.get(activity) ?? { count: 0, sources: [] }
    entry.count += 1
    entry.sources.push(cell.id)
    counts.set(activity, entry)
  }
  if (counts.size === 0) return null

  let topActivity = ''
  let topCount = 0
  let topSources: string[] = []
  for (const [activity, { count, sources }] of counts) {
    if (count > topCount) {
      topActivity = activity
      topCount = count
      topSources = sources
    }
  }

  const total = Array.from(counts.values()).reduce((sum, e) => sum + e.count, 0)
  const confidence = total > 0 ? topCount / total : 0

  return {
    key: 'primary_activity',
    value: topActivity,
    type: 'stable',
    confidence,
    sources: topSources,
    updatedAt: now
  }
}

/**
 * 计算 current_focus（transient）：从当日活跃 MemScene 中取最近更新的标题。
 * @param activeScenes 当日活跃的 MemScene 列表
 * @param date 当日日期（YYYY-MM-DD），用于计算 valid_to
 * @returns 画像条目；无活跃 MemScene 时返回 null
 */
function computeCurrentFocus(
  activeScenes: MemScene[],
  date: string,
  now: string
): UserProfileEntry | null {
  if (activeScenes.length === 0) return null

  const sorted = [...activeScenes].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )
  const latest = sorted[0]

  return {
    key: 'current_focus',
    value: latest.title,
    type: 'transient',
    confidence: 1.0,
    validTo: addDays(date, TRANSIENT_VALID_DAYS),
    sources: [latest.id],
    updatedAt: now
  }
}

/**
 * 计算 preferred_apps（stable）：统计当日所有 segment 的 appName，取频率最高的前 3 个。
 * appName 通过 MemCell.metadata.segmentIds 关联 segments 表获取。
 * @returns 画像条目；无有效 segment 数据时返回 null
 */
function computePreferredApps(
  memCells: MemCell[],
  now: string
): UserProfileEntry | null {
  const segmentIds = new Set<string>()
  for (const cell of memCells) {
    for (const sid of cell.metadata.segmentIds) {
      segmentIds.add(sid)
    }
  }
  if (segmentIds.size === 0) return null

  const segments = SegmentRepository.getByIds(Array.from(segmentIds))
  if (segments.length === 0) return null

  const counts = new Map<string, number>()
  for (const seg of segments) {
    if (!seg.appName) continue
    counts.set(seg.appName, (counts.get(seg.appName) ?? 0) + 1)
  }
  if (counts.size === 0) return null

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, PREFERRED_APPS_TOP_N)
  const total = sorted.reduce((sum, [, c]) => sum + c, 0)
  const top1Freq = top[0][1]
  const confidence = total > 0 ? top1Freq / total : 0

  return {
    key: 'preferred_apps',
    value: top.map(([app]) => app).join(','),
    type: 'stable',
    confidence,
    sources: memCells.map((c) => c.id),
    updatedAt: now
  }
}

/**
 * 计算 work_pattern（stable）：统计当日活动时段，取最活跃时段。
 * 时段划分：上午 6-12 / 下午 12-18 / 晚上 18-6。
 * @returns 画像条目；无活动数据时返回 null
 */
function computeWorkPattern(
  memCells: MemCell[],
  now: string
): UserProfileEntry | null {
  if (memCells.length === 0) return null

  const slotCounts: Record<TimeSlot, number> = {
    morning: 0,
    afternoon: 0,
    evening: 0
  }
  const slotSources: Record<TimeSlot, string[]> = {
    morning: [],
    afternoon: [],
    evening: []
  }

  for (const cell of memCells) {
    const hour = new Date(cell.createdAt).getUTCHours()
    const slot = hourToSlot(hour)
    slotCounts[slot] += 1
    slotSources[slot].push(cell.id)
  }

  let topSlot: TimeSlot = 'morning'
  let topCount = slotCounts.morning
  for (const slot of ['afternoon', 'evening'] as const) {
    if (slotCounts[slot] > topCount) {
      topSlot = slot
      topCount = slotCounts[slot]
    }
  }

  if (topCount === 0) return null

  const total = slotCounts.morning + slotCounts.afternoon + slotCounts.evening
  const confidence = total > 0 ? topCount / total : 0

  return {
    key: 'work_pattern',
    value: topSlot,
    type: 'stable',
    confidence,
    sources: slotSources[topSlot],
    updatedAt: now
  }
}

/**
 * 演进用户画像：从指定日期的 MemCell 活动与 MemScene 摘要中提取画像并写入 user_profile 表。
 *
 * 处理流程：
 *  1. 通过 MemCellRepository.getByDateRange 获取当日所有 MemCell
 *  2. 通过 MemSceneRepository.getAll 获取所有 MemScene，筛选当日活跃的（成员 MemCell 在当日创建）
 *  3. 计算 primary_activity / current_focus / preferred_apps / work_pattern
 *  4. stable 类型通过 upsertStable 写入（跨日累积置信度，同日幂等）
 *  5. transient 类型直接 upsert（覆盖，valid_to = 当日 + 7 天）
 *
 * @param date 日期字符串（YYYY-MM-DD）
 */
export async function evolveProfile(date: string): Promise<void> {
  const dayStart = `${date}T00:00:00.000Z`
  const dayEnd = `${date}T23:59:59.999Z`
  const now = new Date().toISOString()

  // 1. 获取当日所有 MemCell
  const memCells = MemCellRepository.getByDateRange(dayStart, dayEnd)

  // 2. 获取所有 MemScene，筛选当日活跃的（成员 MemCell 在当日创建）
  const cellIds = new Set(memCells.map((c) => c.id))
  const allScenes = MemSceneRepository.getAll()
  const activeScenes = allScenes.filter((scene) =>
    scene.memberCellIds.some((id) => cellIds.has(id))
  )

  // 3. 计算 stable 画像
  const primaryActivity = computePrimaryActivity(memCells, now)
  if (primaryActivity !== null) {
    upsertStable(primaryActivity)
  }

  const preferredApps = computePreferredApps(memCells, now)
  if (preferredApps !== null) {
    upsertStable(preferredApps)
  }

  const workPattern = computeWorkPattern(memCells, now)
  if (workPattern !== null) {
    upsertStable(workPattern)
  }

  // 4. 计算 transient 画像（直接 upsert 覆盖）
  const currentFocus = computeCurrentFocus(activeScenes, date, now)
  if (currentFocus !== null) {
    UserProfileRepository.upsert(currentFocus)
  }
}
