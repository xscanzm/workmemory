/**
 * DailyDistillManager：日级理解（Task H1）
 *
 * 在小时级 MemCell 基础上构建日级理解，发现跨小时主题和当日工作模式。
 *
 * 职责：
 *  - distillDay(date)：聚合当日所有 MemCell + MemScene + 用户画像，
 *    产出日级摘要 + 跨小时主题 + 当日模式（深度工作时长/碎片化时段/切换次数）
 *  - 跨小时主题：按 MemScene 分组，每个 MemScene 对应一个主题（含相关 MemCell 与涉及小时）
 *  - 当日模式：基于 MemCell 时间分布与 activityType 计算
 *  - 摘要生成：调用 AI（传入 MemCell episodes + MemScene titles + patterns），
 *    AI 不可用时降级为基于规则的摘要
 *
 * 触发：每日 23:00 或次日首次启动（由 main/index.ts 调用）
 *
 * 借鉴 EverOS Day Distill 概念，将小时级记忆聚合为日级理解，
 * 支持跨小时主题发现与当日工作模式识别。
 */
import type { MemCell } from '../memory/MemCell'
import type { MemScene } from '../memory/MemSceneClusterer'
import type { UserProfileEntry } from '../db/repositories/UserProfileRepository'
import { MemCellRepository } from '../db/repositories/MemCellRepository'
import { MemSceneRepository } from '../db/repositories/MemSceneRepository'
import { UserProfileRepository } from '../db/repositories/UserProfileRepository'
import { DailyDistillRepository } from '../db/repositories/DailyDistillRepository'
import { SettingsStore } from '../db/SettingsStore'
import { OpenAIClient } from './OpenAIClient'
import { buildChains } from './CausalChainBuilder'

/** 跨小时主题：由 MemScene 聚类映射而来 */
export interface DayTheme {
  /** 主题标题（取自 MemScene.title） */
  title: string
  /** 主题描述（取自 MemScene.summary，无则由成员 episode 拼接） */
  description: string
  /** 相关 MemCell ID（当日活跃成员） */
  memcellIds: string[]
  /** 涉及的小时（0-23，去重升序） */
  hours: number[]
}

/** 当日工作模式 */
export interface DayPattern {
  /** 深度工作时长（小时，连续同 activityType 非 idle 且 ≥30min 的运行段时长之和） */
  deepWorkHours: number
  /** 碎片化时段（activityType 频繁切换的小时段） */
  fragmentedPeriods: { start: string; end: string }[]
  /** 上下文切换次数（相邻 MemCell 的 activityType 变化次数） */
  switchCount: number
  /** 活跃小时数（有 MemCell 的小时去重计数） */
  activeHours: number
  /** 主要活动类型（出现最多的 activityType，忽略 idle） */
  dominantActivity: string
}

/** 日级理解结果 */
export interface DayDistillResult {
  /** 日期（YYYY-MM-DD） */
  date: string
  /** 日级摘要（2-3 句） */
  summary: string
  /** 跨小时主题 */
  themes: DayTheme[]
  /** 当日模式 */
  patterns: DayPattern
  /** 涉及的 MemCell ID */
  memcellIds: string[]
}

/** idle 活动类型，统计时忽略 */
const IDLE_ACTIVITY = 'idle'
/** 深度工作最小连续时长（毫秒，30 分钟） */
const DEEP_WORK_MIN_MS = 30 * 60 * 1000
/** 单条 MemCell 默认时长（毫秒，5 分钟），用于单元素运行段兜底 */
const DEFAULT_CELL_DURATION_MS = 5 * 60 * 1000
/** 碎片化时段阈值：单小时内 activityType 切换次数 ≥3 视为碎片化 */
const FRAGMENTED_SWITCH_THRESHOLD = 3
/** 摘要最大字符数（降级摘要截断） */
const SUMMARY_MAX_CHARS = 500

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

/** 将日期字符串（YYYY-MM-DD）转为当日起止 ISO 时间戳 */
function dayRange(date: string): { start: string; end: string } {
  return {
    start: `${date}T00:00:00.000Z`,
    end: `${date}T23:59:59.999Z`
  }
}

/** 从 ISO 时间戳提取 UTC 小时（0-23） */
function hourOf(iso: string): number {
  return new Date(iso).getUTCHours()
}

/** 将小时数格式化为 "HH:00" */
function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** 判断 activityType 是否有效（非空、非 idle） */
function isActiveActivity(activity: string | undefined): activity is string {
  return !!activity && activity !== IDLE_ACTIVITY
}

/**
 * 计算 dominantActivity：统计 MemCell 的 activityType，取众数（忽略 idle）。
 * 无有效活动数据时返回空字符串。
 */
function computeDominantActivity(memCells: MemCell[]): string {
  const counts = new Map<string, number>()
  for (const cell of memCells) {
    const activity = cell.metadata.activityType
    if (!isActiveActivity(activity)) continue
    counts.set(activity, (counts.get(activity) ?? 0) + 1)
  }
  if (counts.size === 0) return ''
  let best = ''
  let bestCount = 0
  for (const [activity, count] of counts) {
    if (count > bestCount) {
      best = activity
      bestCount = count
    }
  }
  return best
}

/**
 * 计算 deepWorkHours：连续同 activityType（非 idle）的运行段时长之和（小时）。
 *  - 按 createdAt 升序遍历，划分最大同 activityType 运行段
 *  - 运行段时长 = max(末尾 - 首条, 单条默认时长)
 *  - 仅累计时长 ≥30 分钟的运行段
 */
function computeDeepWorkHours(memCells: MemCell[]): number {
  if (memCells.length === 0) return 0
  const sorted = [...memCells].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )
  let totalMs = 0
  let runStart = 0
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]
    const activity = current.metadata.activityType
    if (!isActiveActivity(activity)) {
      // idle/空值中断当前运行段
      runStart = i + 1
      continue
    }
    const prev = i > runStart ? sorted[i - 1] : null
    if (prev && prev.metadata.activityType === activity) {
      // 延续当前运行段
      continue
    }
    // 开启新运行段：结算上一段
    if (i > runStart) {
      const runEnd = i - 1
      const first = sorted[runStart]
      const last = sorted[runEnd]
      const span = new Date(last.createdAt).getTime() - new Date(first.createdAt).getTime()
      const duration = Math.max(span, DEFAULT_CELL_DURATION_MS)
      if (duration >= DEEP_WORK_MIN_MS) {
        totalMs += duration
      }
    }
    runStart = i
  }
  // 结算最后一个运行段
  if (runStart < sorted.length) {
    const first = sorted[runStart]
    const last = sorted[sorted.length - 1]
    const activity = first.metadata.activityType
    if (isActiveActivity(activity)) {
      const span = new Date(last.createdAt).getTime() - new Date(first.createdAt).getTime()
      const duration = Math.max(span, DEFAULT_CELL_DURATION_MS)
      if (duration >= DEEP_WORK_MIN_MS) {
        totalMs += duration
      }
    }
  }
  // 转换为小时，保留 1 位小数
  return Math.round((totalMs / (60 * 60 * 1000)) * 10) / 10
}

/**
 * 计算 switchCount：相邻 MemCell（按时间排序）的 activityType 变化次数。
 * 仅统计两个相邻 MemCell 都有有效 activityType 且不同的转换。
 */
function computeSwitchCount(memCells: MemCell[]): number {
  if (memCells.length < 2) return 0
  const sorted = [...memCells].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  )
  let count = 0
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].metadata.activityType
    const curr = sorted[i].metadata.activityType
    if (isActiveActivity(prev) && isActiveActivity(curr) && prev !== curr) {
      count += 1
    }
  }
  return count
}

/**
 * 计算 activeHours：有 MemCell 的小时去重计数。
 */
function computeActiveHours(memCells: MemCell[]): number {
  const hours = new Set<number>()
  for (const cell of memCells) {
    hours.add(hourOf(cell.createdAt))
  }
  return hours.size
}

/**
 * 计算 fragmentedPeriods：activityType 频繁切换的小时段。
 *  - 按小时分组 MemCell
 *  - 单小时内 activityType 切换次数 ≥3 视为碎片化
 *  - 返回 { start: "HH:00", end: "HH+1:00" } 列表（按小时升序）
 */
function computeFragmentedPeriods(memCells: MemCell[]): { start: string; end: string }[] {
  const byHour = new Map<number, MemCell[]>()
  for (const cell of memCells) {
    const h = hourOf(cell.createdAt)
    const arr = byHour.get(h) ?? []
    arr.push(cell)
    byHour.set(h, arr)
  }
  const periods: { start: string; end: string }[] = []
  const sortedHours = Array.from(byHour.keys()).sort((a, b) => a - b)
  for (const h of sortedHours) {
    const cells = byHour.get(h)!
    if (cells.length < 2) continue
    cells.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    let switches = 0
    for (let i = 1; i < cells.length; i++) {
      const prev = cells[i - 1].metadata.activityType
      const curr = cells[i].metadata.activityType
      if (isActiveActivity(prev) && isActiveActivity(curr) && prev !== curr) {
        switches += 1
      }
    }
    if (switches >= FRAGMENTED_SWITCH_THRESHOLD) {
      periods.push({
        start: formatHour(h),
        end: formatHour((h + 1) % 24)
      })
    }
  }
  return periods
}

/**
 * 计算当日模式（DayPattern）。
 */
function computePatterns(memCells: MemCell[]): DayPattern {
  return {
    deepWorkHours: computeDeepWorkHours(memCells),
    fragmentedPeriods: computeFragmentedPeriods(memCells),
    switchCount: computeSwitchCount(memCells),
    activeHours: computeActiveHours(memCells),
    dominantActivity: computeDominantActivity(memCells)
  }
}

/**
 * 提取跨小时主题：按当日活跃 MemScene 分组，每个 MemScene 对应一个主题。
 *  - 仅保留成员含当日 MemCell 的 MemScene
 *  - hours 取成员 MemCell 的 createdAt 小时去重升序
 *  - description 取 MemScene.summary，无则由成员 episode 拼接（取前 3 条）
 */
function extractThemes(memCells: MemCell[], scenes: MemScene[]): DayTheme[] {
  const cellById = new Map(memCells.map((c) => [c.id, c]))
  const themes: DayTheme[] = []
  for (const scene of scenes) {
    const dayMemberIds = scene.memberCellIds.filter((id) => cellById.has(id))
    if (dayMemberIds.length === 0) continue
    const hours = Array.from(
      new Set(
        dayMemberIds
          .map((id) => hourOf(cellById.get(id)!.createdAt))
          .sort((a, b) => a - b)
      )
    )
    let description = (scene.summary ?? '').trim()
    if (!description) {
      const episodes = dayMemberIds
        .map((id) => cellById.get(id)!.episode)
        .filter((e) => e.length > 0)
        .slice(0, 3)
      description = episodes.join('；')
    }
    themes.push({
      title: scene.title,
      description,
      memcellIds: dayMemberIds,
      hours
    })
  }
  return themes
}

/**
 * 构建发送给 AI 的用户提示词：包含 MemCell episodes、MemScene titles、patterns 概览。
 */
function buildAiUserPrompt(
  date: string,
  memCells: MemCell[],
  themes: DayTheme[],
  patterns: DayPattern,
  profile: UserProfileEntry[]
): string {
  const episodes = memCells
    .map((c) => `- [${c.createdAt}] ${c.episode}`)
    .join('\n')
    .slice(0, 4000)
  const themeTitles = themes
    .map((t) => `- ${t.title}（涉及小时：${t.hours.map(formatHour).join('、')}）`)
    .join('\n')
  const profileLines = profile
    .map((p) => `- ${p.key}: ${p.value} (置信度 ${p.confidence.toFixed(2)})`)
    .join('\n')
  return [
    `日期：${date}`,
    '',
    `## 当日工作记忆事件（共 ${memCells.length} 条）`,
    episodes || '（无）',
    '',
    `## 跨小时主题（共 ${themes.length} 个）`,
    themeTitles || '（无）',
    '',
    '## 当日模式',
    `- 深度工作时长：${patterns.deepWorkHours} 小时`,
    `- 上下文切换次数：${patterns.switchCount}`,
    `- 活跃小时数：${patterns.activeHours}`,
    `- 主要活动：${patterns.dominantActivity || '（无）'}`,
    `- 碎片化时段：${patterns.fragmentedPeriods.map((p) => `${p.start}-${p.end}`).join('、') || '无'}`,
    '',
    '## 用户画像',
    profileLines || '（无）',
    '',
    '请基于以上信息，生成 2-3 句中文日级摘要，概括当日工作主线、跨小时主题与工作模式特征。'
  ].join('\n')
}

/**
 * 调用 AI 生成日级摘要。
 * AI 不可用（未配置 API Key 或调用失败）时返回空字符串，由调用方降级。
 */
async function generateSummaryByAi(
  date: string,
  memCells: MemCell[],
  themes: DayTheme[],
  patterns: DayPattern,
  profile: UserProfileEntry[]
): Promise<string> {
  const apiConfig = getApiConfig()
  if (!apiConfig.apiKey) return ''
  const userPrompt = buildAiUserPrompt(date, memCells, themes, patterns, profile)
  try {
    const result = await OpenAIClient.chatCompletion({
      baseUrl: apiConfig.baseUrl,
      apiKey: apiConfig.apiKey,
      model: apiConfig.model,
      messages: [
        {
          role: 'system',
          content:
            '你是一个工作记忆日级摘要生成器。根据给定的一日工作记忆事件、跨小时主题与当日模式，生成 2-3 句中文摘要。只返回纯文本摘要，不要 Markdown 标题、不要列表、不要额外解释。'
        },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      maxTokens: 300
    })
    return result.content.trim()
  } catch (e) {
    console.warn(
      '[DailyDistillManager] AI 摘要生成失败，降级使用规则摘要:',
      e instanceof Error ? e.message : String(e)
    )
    return ''
  }
}

/**
 * 基于规则的降级摘要：统计 activityType 分布、MemScene 标题、工作时段。
 */
function buildFallbackSummary(
  date: string,
  memCells: MemCell[],
  themes: DayTheme[],
  patterns: DayPattern
): string {
  if (memCells.length === 0) {
    return `${date} 当日无工作记忆事件。`
  }
  // activityType 分布
  const activityCounts = new Map<string, number>()
  for (const cell of memCells) {
    const a = cell.metadata.activityType
    if (!isActiveActivity(a)) continue
    activityCounts.set(a, (activityCounts.get(a) ?? 0) + 1)
  }
  const activityLines = Array.from(activityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([a, c]) => `${a}(${c}次)`)
    .join('、')
  const themeTitles = themes.map((t) => t.title).join('、')
  const parts: string[] = []
  parts.push(
    `${date} 共记录 ${memCells.length} 条工作记忆，主要活动为 ${patterns.dominantActivity || '未知'}`
  )
  if (activityLines) {
    parts.push(`活动分布：${activityLines}`)
  }
  if (themeTitles) {
    parts.push(`涉及主题：${themeTitles}`)
  }
  parts.push(
    `深度工作 ${patterns.deepWorkHours} 小时，切换 ${patterns.switchCount} 次，活跃 ${patterns.activeHours} 小时`
  )
  return parts.join('；').slice(0, SUMMARY_MAX_CHARS)
}

/**
 * 日级理解：聚合当日 MemCell + MemScene + 用户画像，产出日级摘要、跨小时主题与当日模式。
 *
 * 处理流程：
 *  1. 通过 MemCellRepository.getByDateRange 获取当日所有 MemCell
 *  2. 通过 MemSceneRepository.getAll 获取所有 MemScene，筛选当日活跃的（成员含当日 MemCell）
 *  3. 通过 UserProfileRepository.getAll 获取用户画像
 *  4. 计算 patterns（deepWorkHours/fragmentedPeriods/switchCount/activeHours/dominantActivity）
 *  5. 提取 themes（按 MemScene 分组）
 *  6. 生成 summary（AI 优先，降级为规则摘要）
 *  7. 通过 DailyDistillRepository.upsert 持久化
 *
 * @param date 日期字符串（YYYY-MM-DD）
 * @returns 日级理解结果
 */
export async function distillDay(date: string): Promise<DayDistillResult> {
  const { start, end } = dayRange(date)

  // 1. 获取当日所有 MemCell
  const memCells = MemCellRepository.getByDateRange(start, end)
  const memcellIds = memCells.map((c) => c.id)

  // 2. 获取所有 MemScene，筛选当日活跃的
  const cellIdSet = new Set(memcellIds)
  const allScenes = MemSceneRepository.getAll()
  const activeScenes = allScenes.filter((scene) =>
    scene.memberCellIds.some((id) => cellIdSet.has(id))
  )

  // 3. 获取用户画像
  const profile = UserProfileRepository.getAll()

  // 4. 计算当日模式
  const patterns = computePatterns(memCells)

  // 5. 提取跨小时主题
  const themes = extractThemes(memCells, activeScenes)

  // 6. 生成摘要（AI 优先，降级为规则摘要）
  //    当日无 MemCell 时跳过 AI 调用，直接使用规则摘要
  let summary = ''
  if (memCells.length > 0) {
    summary = await generateSummaryByAi(date, memCells, themes, patterns, profile)
  }
  if (!summary) {
    summary = buildFallbackSummary(date, memCells, themes, patterns)
  }

  const result: DayDistillResult = {
    date,
    summary,
    themes,
    patterns,
    memcellIds
  }

  // 7. 持久化
  try {
    DailyDistillRepository.upsert(result)
  } catch (e) {
    console.error(
      '[DailyDistillManager] 日级理解结果持久化失败:',
      e instanceof Error ? e.message : String(e)
    )
  }

  // 8. 触发跨 Episode 因果链构建（Task H3）
  //    在日级理解完成后触发，从当日 MemCell 中识别因果关系并写入 causal_chains 表。
  //    失败仅记录日志，不影响日级理解结果返回。
  try {
    await buildChains(date)
  } catch (e) {
    console.error(
      '[DailyDistillManager] 跨 Episode 因果链构建失败:',
      e instanceof Error ? e.message : String(e)
    )
  }

  return result
}
