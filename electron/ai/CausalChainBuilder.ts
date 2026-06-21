/**
 * CausalChainBuilder：跨 Episode 因果链构建（Task H3）。
 *
 * 在日级 MemCell 基础上识别相邻 MemCell 之间的因果关系，构建跨 Episode 因果链。
 *
 * 职责：
 *  - buildChains(date)：获取当日 MemCell，按时间排序，构建相邻对（含 30 分钟窗口内的非相邻对）
 *  - AI 推断：构建提示词，让 AI 从相邻 MemCell 中识别因果
 *    （"查阅 safeStorage 文档" enables "实现 API Key 加密"）
 *  - 降级规则（AI 不可用时）：基于 activityType 序列和关键词匹配推断因果
 *  - 持久化：通过 CausalChainRepository.insert 写入 causal_chains 表
 *
 * 触发：DailyDistillManager.distillDay 完成后调用
 *
 * 借鉴 EverOS Causal Chain 概念，将工作记忆事件链式化，
 * 支持"原因→结果"的因果追溯，为后续工作流分析与洞察提供基础。
 */
import { randomUUID } from 'node:crypto'
import type { MemCell } from '../memory/MemCell'
import { MemCellRepository } from '../db/repositories/MemCellRepository'
import { CausalChainRepository } from '../db/repositories/CausalChainRepository'
import { SettingsStore } from '../db/SettingsStore'
import { OpenAIClient } from './OpenAIClient'

/** 因果关系类型 */
export type CausalRelation = 'leads_to' | 'blocks' | 'enables'

/** 因果链：原因 MemCell → 结果 MemCell 的因果关系 */
export interface CausalChain {
  /** 主键 ID */
  id: string
  /** 原因 MemCell ID */
  causeCellId: string
  /** 结果 MemCell ID */
  effectCellId: string
  /** 关系类型：leads_to（导致）/ blocks（阻碍）/ enables（使可能） */
  relation: CausalRelation
  /** 置信度 0-1 */
  confidence: number
  /** 证据描述（人类可读） */
  evidence: string
  /** ISO 创建时间戳 */
  createdAt: string
}

/** AI 返回的因果关系项（解析用） */
interface AiCausalItem {
  causeCellId: string
  effectCellId: string
  relation: CausalRelation
  confidence: number
  evidence: string
}

/** 时间窗口（毫秒）：30 分钟内的非相邻 MemCell 也视为候选因果对 */
const CAUSAL_WINDOW_MS = 30 * 60 * 1000
/** 单次 AI 提示词最大候选对数（避免超长） */
const MAX_PAIRS_PER_PROMPT = 20
/** 证据描述最大字符数 */
const EVIDENCE_MAX_CHARS = 300

/** 阻塞关键词：含此关键词的 MemCell 视为可能阻塞后续 */
const BLOCK_KEYWORDS = ['错误', '失败', 'bug', '报错', '异常', '崩溃', '冲突', '卡住', '阻塞']
/** 文档/资料查阅关键词：用于识别 reading 类 MemCell 是否为"查阅文档" */
const DOC_KEYWORDS = ['文档', '资料', '教程', '手册', '参考', '查阅', '阅读', '学习']

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

function nowIso(): string {
  return new Date().toISOString()
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100))
}

function truncateEvidence(text: string): string {
  return text.length > EVIDENCE_MAX_CHARS ? text.slice(0, EVIDENCE_MAX_CHARS) : text
}

/**
 * 构建候选因果对：相邻 MemCell 对 + 30 分钟窗口内的非相邻对。
 *  - 相邻对：i 与 i+1
 *  - 窗口对：i 与 j（j > i+1，且 createdAt 差 ≤ 30 分钟）
 *  - 每条候选对携带 cause/effect 的 episode + facts，供 AI 或规则推断
 */
interface CandidatePair {
  cause: MemCell
  effect: MemCell
}

function buildCandidatePairs(memCells: MemCell[]): CandidatePair[] {
  const pairs: CandidatePair[] = []
  const sorted = [...memCells].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (let i = 0; i < sorted.length; i++) {
    const cause = sorted[i]
    const causeTime = new Date(cause.createdAt).getTime()
    for (let j = i + 1; j < sorted.length; j++) {
      const effect = sorted[j]
      const effectTime = new Date(effect.createdAt).getTime()
      const delta = effectTime - causeTime
      // 仅考虑 effect 在 cause 之后且时间窗口内的对
      if (delta < 0) continue
      if (delta > CAUSAL_WINDOW_MS) break // 已超出窗口，后续更远，提前结束
      pairs.push({ cause, effect })
    }
  }
  return pairs
}

/**
 * 构建 AI 用户提示词：列出候选 MemCell 对的 episode + facts。
 */
function buildAiUserPrompt(date: string, pairs: CandidatePair[]): string {
  const pairLines = pairs
    .map((p, idx) => {
      const causeFacts = p.cause.facts.slice(0, 3).join('；')
      const effectFacts = p.effect.facts.slice(0, 3).join('；')
      return [
        `对 ${idx + 1}:`,
        `  原因 MemCell ID: ${p.cause.id}`,
        `  原因时间: ${p.cause.createdAt}`,
        `  原因活动: ${p.cause.metadata.activityType ?? 'unknown'}`,
        `  原因叙事: ${p.cause.episode}`,
        `  原因事实: ${causeFacts || '（无）'}`,
        `  结果 MemCell ID: ${p.effect.id}`,
        `  结果时间: ${p.effect.createdAt}`,
        `  结果活动: ${p.effect.metadata.activityType ?? 'unknown'}`,
        `  结果叙事: ${p.effect.episode}`,
        `  结果事实: ${effectFacts || '（无）'}`
      ].join('\n')
    })
    .join('\n\n')
  return [
    `日期：${date}`,
    '',
    `以下是当日 ${pairs.length} 对相邻或时间相近的 MemCell 候选对。请判断每对是否存在因果关系。`,
    '',
    pairLines,
    '',
    '## 任务',
    '仅返回存在明确因果关系的对，输出 JSON 对象：',
    '{"chains": [{"causeCellId": "...", "effectCellId": "...", "relation": "leads_to|blocks|enables", "confidence": 0.0-1.0, "evidence": "中文证据描述"}]}',
    '',
    '## 关系类型说明',
    '- leads_to: A 导致 B 发生（如"写测试" leads_to "发现 bug"）',
    '- blocks: A 阻碍 B（如"依赖版本冲突" blocks "构建成功"）',
    '- enables: A 使 B 成为可能（如"查阅文档" enables "实现功能"）',
    '',
    '## 要求',
    '- 仅返回 JSON 对象，第一个字符必须是 {',
    '- causeCellId 与 effectCellId 必须来自上述候选对',
    '- confidence 为 0-1 浮点数',
    '- evidence 为简短中文证据描述（不超过 100 字）',
    '- 无因果关系时返回 {"chains": []}'
  ].join('\n')
}

/**
 * 解析 AI 返回的 JSON，提取因果关系列表。
 * 返回值约定：
 *  - null：响应不可解析（非 JSON 或结构不符），调用方应降级为规则推断
 *  - AiCausalItem[]（可能为空）：响应是合法的 {"chains": [...]}，无因果关系时为空数组
 */
function parseAiResponse(content: string, validPairKeys: Set<string>): AiCausalItem[] | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const chains = (parsed as { chains?: unknown }).chains
  if (!Array.isArray(chains)) return null

  const result: AiCausalItem[] = []
  for (const item of chains) {
    if (typeof item !== 'object' || item === null) continue
    const obj = item as Record<string, unknown>
    const causeCellId = typeof obj.causeCellId === 'string' ? obj.causeCellId : ''
    const effectCellId = typeof obj.effectCellId === 'string' ? obj.effectCellId : ''
    if (!causeCellId || !effectCellId) continue
    // 仅接受候选对中存在的 (cause, effect) 组合
    if (!validPairKeys.has(`${causeCellId}|${effectCellId}`)) continue
    const relation = obj.relation
    if (relation !== 'leads_to' && relation !== 'blocks' && relation !== 'enables') continue
    const confidenceRaw = typeof obj.confidence === 'number' ? obj.confidence : 0.5
    const evidence = typeof obj.evidence === 'string' ? obj.evidence : ''
    if (!evidence) continue
    result.push({
      causeCellId,
      effectCellId,
      relation,
      confidence: clampConfidence(confidenceRaw),
      evidence: truncateEvidence(evidence)
    })
  }
  return result
}

/**
 * 调用 AI 推断因果关系。
 * 返回值约定：
 *  - null：AI 不可用（未配置 API Key）、调用失败、或响应不可解析，调用方应降级为规则推断
 *  - AiCausalItem[]（可能为空）：AI 成功返回合法 JSON（无因果关系时为空数组）
 */
async function inferByAi(pairs: CandidatePair[]): Promise<AiCausalItem[] | null> {
  if (pairs.length === 0) return []
  const apiConfig = getApiConfig()
  if (!apiConfig.apiKey) return null

  // 候选对过多时分批处理
  const batches: CandidatePair[][] = []
  for (let i = 0; i < pairs.length; i += MAX_PAIRS_PER_PROMPT) {
    batches.push(pairs.slice(i, i + MAX_PAIRS_PER_PROMPT))
  }

  const validPairKeys = new Set(pairs.map((p) => `${p.cause.id}|${p.effect.id}`))
  const allItems: AiCausalItem[] = []

  for (const batch of batches) {
    const userPrompt = buildAiUserPrompt('', batch)
    try {
      const result = await OpenAIClient.chatCompletion({
        baseUrl: apiConfig.baseUrl,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
        messages: [
          {
            role: 'system',
            content:
              '你是一个工作记忆因果链识别器。根据给定的相邻工作记忆事件对，判断它们之间是否存在因果关系（leads_to/blocks/enables）。只返回 JSON 对象，不要 Markdown、不要额外解释。'
          },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        maxTokens: 2048,
        responseFormat: { type: 'json_object' }
      })
      const items = parseAiResponse(result.content, validPairKeys)
      // 响应不可解析时降级为规则推断
      if (items === null) {
        console.warn(
          '[CausalChainBuilder] AI 返回内容无法解析，降级使用规则推断'
        )
        return null
      }
      allItems.push(...items)
    } catch (e) {
      console.warn(
        '[CausalChainBuilder] AI 因果推断失败，降级使用规则推断:',
        e instanceof Error ? e.message : String(e)
      )
      return null
    }
  }
  return allItems
}

/** 判断文本是否含阻塞关键词 */
function containsBlockKeyword(text: string): boolean {
  return BLOCK_KEYWORDS.some((kw) => text.includes(kw))
}

/** 判断文本是否含文档/资料查阅关键词 */
function containsDocKeyword(text: string): boolean {
  return DOC_KEYWORDS.some((kw) => text.includes(kw))
}

/**
 * 基于规则的降级因果推断：根据 activityType 序列和关键词匹配推断因果关系。
 *
 * 规则：
 *  1. cause 含阻塞关键词 → blocks（依赖版本冲突 blocks 构建成功）
 *  2. reading → coding/writing 且 cause 含文档关键词 → enables（查阅文档 enables 实现功能）
 *  3. reading → coding/writing（无文档关键词） → enables（查阅资料使实现成为可能）
 *  4. coding → coding（同主题/连续） → leads_to（连续编码）
 *  5. browsing → chatting → leads_to（浏览后讨论）
 *  6. reading → reading → leads_to（连续阅读）
 *  7. 其他相邻对 → leads_to（默认因果，低置信度）
 */
function inferByRules(pairs: CandidatePair[]): AiCausalItem[] {
  const items: AiCausalItem[] = []
  for (const { cause, effect } of pairs) {
    const causeActivity = cause.metadata.activityType ?? ''
    const effectActivity = effect.metadata.activityType ?? ''
    const causeText = `${cause.episode} ${cause.facts.join(' ')}`
    const _effectText = `${effect.episode} ${effect.facts.join(' ')}`

    // 规则 1：cause 含阻塞关键词 → blocks
    if (containsBlockKeyword(causeText)) {
      items.push({
        causeCellId: cause.id,
        effectCellId: effect.id,
        relation: 'blocks',
        confidence: 0.7,
        evidence: truncateEvidence(
          `原因事件含阻塞关键词，可能阻碍后续工作：${cause.episode}`
        )
      })
      continue
    }

    // 规则 2/3：reading → coding/writing → enables
    if (
      causeActivity === 'reading' &&
      (effectActivity === 'coding' || effectActivity === 'writing')
    ) {
      const hasDoc = containsDocKeyword(causeText)
      items.push({
        causeCellId: cause.id,
        effectCellId: effect.id,
        relation: 'enables',
        confidence: hasDoc ? 0.85 : 0.7,
        evidence: truncateEvidence(
          hasDoc
            ? `查阅文档/资料使后续实现成为可能：${cause.episode} → ${effect.episode}`
            : `阅读资料为后续实现提供基础：${cause.episode} → ${effect.episode}`
        )
      })
      continue
    }

    // 规则 4：coding → coding → leads_to（连续编码）
    if (causeActivity === 'coding' && effectActivity === 'coding') {
      items.push({
        causeCellId: cause.id,
        effectCellId: effect.id,
        relation: 'leads_to',
        confidence: 0.6,
        evidence: truncateEvidence(`连续编码工作：${cause.episode} → ${effect.episode}`)
      })
      continue
    }

    // 规则 5：browsing → chatting → leads_to（浏览后讨论）
    if (causeActivity === 'browsing' && effectActivity === 'chatting') {
      items.push({
        causeCellId: cause.id,
        effectCellId: effect.id,
        relation: 'leads_to',
        confidence: 0.6,
        evidence: truncateEvidence(
          `浏览资料后进行讨论：${cause.episode} → ${effect.episode}`
        )
      })
      continue
    }

    // 规则 6：reading → reading → leads_to（连续阅读）
    if (causeActivity === 'reading' && effectActivity === 'reading') {
      items.push({
        causeCellId: cause.id,
        effectCellId: effect.id,
        relation: 'leads_to',
        confidence: 0.55,
        evidence: truncateEvidence(`连续阅读：${cause.episode} → ${effect.episode}`)
      })
      continue
    }

    // 规则 7：仅相邻对（窗口内非相邻对跳过）默认 leads_to，低置信度
    // 此处通过判断时间差是否极小（<5min）来限定为相邻
    const delta = new Date(effect.createdAt).getTime() - new Date(cause.createdAt).getTime()
    if (delta <= 5 * 60 * 1000) {
      items.push({
        causeCellId: cause.id,
        effectCellId: effect.id,
        relation: 'leads_to',
        confidence: 0.4,
        evidence: truncateEvidence(
          `相邻工作事件存在时序因果：${cause.episode} → ${effect.episode}`
        )
      })
    }
  }
  return items
}

/**
 * 构建当日跨 Episode 因果链。
 *
 * 处理流程：
 *  1. 通过 MemCellRepository.getByDateRange 获取当日所有 MemCell（按 createdAt 升序）
 *  2. 构建候选因果对：相邻对 + 30 分钟窗口内的非相邻对
 *  3. 推断因果关系：AI 优先，降级为规则推断
 *  4. 通过 CausalChainRepository.insert 持久化
 *
 * @param date 日期字符串（YYYY-MM-DD）
 * @returns 当日构建的因果链数组
 */
export async function buildChains(date: string): Promise<CausalChain[]> {
  const { start, end } = dayRange(date)
  const memCells = MemCellRepository.getByDateRange(start, end)
  if (memCells.length < 2) return []

  // 1. 构建候选因果对
  const pairs = buildCandidatePairs(memCells)
  if (pairs.length === 0) return []

  // 2. 推断因果关系（AI 优先，降级为规则）
  let items: AiCausalItem[] | null = await inferByAi(pairs)
  if (items === null) {
    items = inferByRules(pairs)
  }

  if (items.length === 0) return []

  // 3. 持久化并返回 CausalChain 对象
  const ts = nowIso()
  const chains: CausalChain[] = items.map((item) => ({
    id: randomUUID(),
    causeCellId: item.causeCellId,
    effectCellId: item.effectCellId,
    relation: item.relation,
    confidence: item.confidence,
    evidence: item.evidence,
    createdAt: ts
  }))

  for (const chain of chains) {
    try {
      CausalChainRepository.insert(chain)
    } catch (e) {
      console.error(
        '[CausalChainBuilder] 因果链持久化失败:',
        e instanceof Error ? e.message : String(e)
      )
    }
  }

  return chains
}
