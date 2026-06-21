/**
 * SkillEvolver：技能进化引擎（Task R2）。
 *
 * 在反思与进化 Sprint 中，从重复出现的 MemScene 主题中提炼技能卡（SOP 步骤、陷阱、洞察），
 * 实现"自我进化"。
 *
 * 职责：
 *  - evolveSkills()：扫描所有 MemScene，筛选成员 ≥3 的主题（重复工作信号）
 *  - 对每个符合条件的 MemScene：
 *    - 获取所有成员 MemCell（episode + facts + foresight）
 *    - 调用 AI 提炼 SOP 步骤、陷阱、洞察
 *    - AI 不可用时降级为基于规则的技能提炼：
 *      - steps：从 MemCell.episode 中提取动作序列（按时间排序，提取动词开头的句子）
 *      - traps：从 MemCell.facts 中提取含"错误"/"失败"/"注意"关键词的事实
 *      - insights：从 MemCell.foresight 中提取 statement
 *    - 构造 Skill 对象，存入 skills 表（按 title 去重）
 *  - 返回新生成的 Skill 列表
 *
 * 触发：每周 ReflectionEngine 完成后（由 main/index.ts 调用）
 *
 * 借鉴 EverOS Skill 概念，将重复工作模式提炼为可复用的技能卡，
 * 支持用户对自身工作方法的持续沉淀与进化。
 */
import { randomUUID } from 'node:crypto'
import type { MemCell } from '../memory/MemCell'
import type { MemScene } from '../memory/MemSceneClusterer'
import { MemSceneRepository } from '../db/repositories/MemSceneRepository'
import { MemCellRepository } from '../db/repositories/MemCellRepository'
import { SkillRepository } from '../db/repositories/SkillRepository'
import { SettingsStore } from '../db/SettingsStore'
import { OpenAIClient } from './OpenAIClient'

/** 技能卡：从重复 MemScene 主题中提炼的 SOP / 陷阱 / 洞察 */
export interface Skill {
  /** 技能 ID（UUID） */
  id: string
  /** 技能标题，如"数据库迁移工作流"（取自 MemScene.title） */
  title: string
  /** SOP 步骤，如["1. 分析现有 schema", "2. 编写迁移脚本", "3. 测试迁移"] */
  steps: string[]
  /** 陷阱，如["忘记处理回滚", "未测试大数据量性能"] */
  traps: string[]
  /** 洞察，如["使用 ALTER TABLE 比重建表更安全"] */
  insights: string[]
  /** 来源 MemCell ID 列表 */
  sourceCellIds: string[]
  /** 置信度 0-1 */
  confidence: number
  /** ISO 时间戳（进化时间） */
  evolvedAt: string
}

/** 触发技能进化的最小 MemScene 成员数（重复工作信号阈值） */
const MIN_MEMBER_CELL_IDS = 3

/** 陷阱关键词：facts 含以下任一关键词时视为陷阱 */
const TRAP_KEYWORDS = ['错误', '失败', '注意', '陷阱', '坑', '问题', 'bug', '异常', '风险']

/** AI 返回的技能体（解析用） */
interface AiSkillBody {
  title?: unknown
  steps?: unknown
  traps?: unknown
  insights?: unknown
  confidence?: unknown
}

/** 步骤最大数量（避免 AI 返回过长列表） */
const MAX_STEPS = 12
/** 陷阱最大数量 */
const MAX_TRAPS = 10
/** 洞察最大数量 */
const MAX_INSIGHTS = 10
/** 单条步骤/陷阱/洞察最大字符数 */
const MAX_ITEM_CHARS = 300

function nowIso(): string {
  return new Date().toISOString()
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

/** 限制数组长度并截断每项字符数 */
function capItems(items: string[], maxCount: number): string[] {
  return items
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxCount)
    .map((s) => s.slice(0, MAX_ITEM_CHARS))
}

/** 将置信度限制在 [0, 1] 范围内，保留两位小数 */
function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100))
}

/**
 * 构建 AI 用户提示词：包含 MemScene 标题与所有成员 MemCell 的 episode + facts + foresight。
 */
function buildAiUserPrompt(scene: MemScene, cells: MemCell[]): string {
  const cellLines = cells
    .map((c, i) => {
      const facts = c.facts.length > 0 ? c.facts.map((f) => `  - ${f}`).join('\n') : '  （无）'
      const foresight = c.foresight.length > 0
        ? c.foresight.map((f) => `  - ${f.statement}`).join('\n')
        : '  （无）'
      return [
        `### MemCell ${i + 1}（id=${c.id}, createdAt=${c.createdAt}）`,
        `episode: ${c.episode}`,
        'facts:',
        facts,
        'foresight:',
        foresight
      ].join('\n')
    })
    .join('\n\n')

  return [
    `主题（MemScene）：${scene.title}`,
    `成员 MemCell 数：${cells.length}`,
    '',
    '## 成员 MemCell 列表',
    cellLines,
    '',
    '请基于以上同主题的 MemCell，提炼一份技能卡，包含：',
    '- title：技能标题（简洁，如"数据库迁移工作流"，可沿用主题标题或更精确化）',
    '- steps：SOP 步骤数组（按时间顺序的可执行步骤，每项以"1. ""2. "序号开头）',
    '- traps：陷阱数组（重复工作中容易踩的坑、易错点）',
    '- insights：洞察数组（从多次实践中得出的可复用经验、最佳实践）',
    '- confidence：置信度 0-1（成员越多、信息越完整则越高）',
    '',
    '输出格式：{"title": "...", "steps": [...], "traps": [...], "insights": [...], "confidence": 0.x}',
    '只返回 JSON 对象，第一个字符必须是 {，不要 Markdown、不要额外解释。'
  ].join('\n')
}

/**
 * 解析 AI 返回的 JSON 为 AiSkillBody。
 * 返回值约定：
 *  - null：响应不可解析（非 JSON 或结构不符），调用方应降级为规则提炼
 *  - AiSkillBody：响应是合法的 JSON 对象（字段可能为空）
 */
function parseAiResponse(content: string): AiSkillBody | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  return parsed as AiSkillBody
}

/** 校验并规范化 AI 返回的字符串数组字段 */
function normalizeAiStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string')
}

/**
 * 调用 AI 提炼技能卡。
 * 返回值约定：
 *  - null：AI 不可用（未配置 API Key）、调用失败、或响应不可解析，调用方应使用规则提炼
 *  - AiSkillBody：AI 成功返回合法 JSON
 */
async function evolveByAi(
  scene: MemScene,
  cells: MemCell[]
): Promise<AiSkillBody | null> {
  const apiConfig = getApiConfig()
  if (!apiConfig.apiKey) return null
  const userPrompt = buildAiUserPrompt(scene, cells)
  try {
    const result = await OpenAIClient.chatCompletion({
      baseUrl: apiConfig.baseUrl,
      apiKey: apiConfig.apiKey,
      model: apiConfig.model,
      messages: [
        {
          role: 'system',
          content:
            '你是一个工作记忆技能进化引擎。根据给定的同主题 MemCell（episode/facts/foresight），' +
            '提炼一份结构化的技能卡：SOP 步骤、陷阱、洞察。' +
            '只返回 JSON 对象，不要 Markdown、不要额外解释。'
        },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      maxTokens: 2048,
      responseFormat: { type: 'json_object' }
    })
    const body = parseAiResponse(result.content)
    if (body === null) {
      console.warn(
        '[SkillEvolver] AI 返回内容无法解析，降级使用规则提炼'
      )
      return null
    }
    return body
  } catch (e) {
    console.warn(
      '[SkillEvolver] AI 技能提炼失败，降级使用规则提炼:',
      e instanceof Error ? e.message : String(e)
    )
    return null
  }
}

/**
 * 规则提炼 steps：从 MemCell.episode 中提取动作序列。
 *
 * 规则：
 *  - 按 createdAt 升序排列 MemCell
 *  - 将每个 episode 按中文/英文标点切分为句子
 *  - 提取以动词开头或包含动作语义的句子（含动词关键词或以"了"结尾表示完成动作）
 *  - 去重并按出现顺序编号（"1. xxx"）
 *
 * 无动作句子时退化为取每个 episode 的首句作为步骤。
 */
function extractStepsByRules(cells: MemCell[]): string[] {
  const sorted = [...cells].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const actionKeywords = [
    '实现', '编写', '修改', '添加', '删除', '创建', '测试', '运行', '执行',
    '分析', '设计', '重构', '部署', '修复', '配置', '安装', '更新', '迁移',
    '检查', '验证', '调试', '提交', '合并', '启动', '停止', '加载', '保存',
    '读取', '写入', '调用', '处理', '转换', '生成', '构建', '编译', '打包'
  ]
  const sentences: string[] = []
  for (const cell of sorted) {
    const parts = cell.episode
      .split(/[。.;；\n!！?？]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (parts.length === 0) continue
    // 优先提取含动作关键词的句子
    const actionParts = parts.filter((p) =>
      actionKeywords.some((kw) => p.includes(kw))
    )
    const picked = actionParts.length > 0 ? actionParts : [parts[0]]
    for (const p of picked) {
      if (!sentences.includes(p)) {
        sentences.push(p)
      }
    }
  }
  return capItems(
    sentences.map((s, i) => `${i + 1}. ${s}`),
    MAX_STEPS
  )
}

/**
 * 规则提炼 traps：从 MemCell.facts 中提取含陷阱关键词的事实。
 */
function extractTrapsByRules(cells: MemCell[]): string[] {
  const traps: string[] = []
  for (const cell of cells) {
    for (const fact of cell.facts) {
      const trimmed = fact.trim()
      if (trimmed.length === 0) continue
      if (TRAP_KEYWORDS.some((kw) => trimmed.toLowerCase().includes(kw.toLowerCase()))) {
        if (!traps.includes(trimmed)) {
          traps.push(trimmed)
        }
      }
    }
  }
  return capItems(traps, MAX_TRAPS)
}

/**
 * 规则提炼 insights：从 MemCell.foresight 中提取 statement。
 */
function extractInsightsByRules(cells: MemCell[]): string[] {
  const insights: string[] = []
  for (const cell of cells) {
    for (const f of cell.foresight) {
      const statement = f.statement.trim()
      if (statement.length === 0) continue
      if (!insights.includes(statement)) {
        insights.push(statement)
      }
    }
  }
  return capItems(insights, MAX_INSIGHTS)
}

/**
 * 规则提炼置信度：基于成员数与提炼出的内容丰富度。
 *  - 基础 0.3，每多一个成员 +0.1
 *  - 有 steps +0.1，有 traps +0.1，有 insights +0.1
 *  - 上限 0.9（规则提炼不超过 0.9，保留 AI 路径更高的置信度空间）
 */
function computeFallbackConfidence(
  memberCount: number,
  steps: string[],
  traps: string[],
  insights: string[]
): number {
  let confidence = 0.3 + Math.min(memberCount - MIN_MEMBER_CELL_IDS, 7) * 0.1
  if (steps.length > 0) confidence += 0.1
  if (traps.length > 0) confidence += 0.1
  if (insights.length > 0) confidence += 0.1
  return clampConfidence(Math.min(confidence, 0.9))
}

/**
 * 基于规则提炼技能卡（AI 不可用时的降级路径）。
 */
function buildSkillByRules(scene: MemScene, cells: MemCell[]): Skill {
  const steps = extractStepsByRules(cells)
  const traps = extractTrapsByRules(cells)
  const insights = extractInsightsByRules(cells)
  const confidence = computeFallbackConfidence(cells.length, steps, traps, insights)
  return {
    id: randomUUID(),
    title: scene.title,
    steps,
    traps,
    insights,
    sourceCellIds: cells.map((c) => c.id),
    confidence,
    evolvedAt: nowIso()
  }
}

/**
 * 基于 AI 返回构造技能卡。
 * AI 返回字段缺失或非法时，回退到规则提炼对应字段。
 */
function buildSkillByAi(
  scene: MemScene,
  cells: MemCell[],
  body: AiSkillBody
): Skill {
  const aiTitle = typeof body.title === 'string' ? body.title.trim() : ''
  const title = aiTitle || scene.title
  const steps = capItems(normalizeAiStringArray(body.steps), MAX_STEPS)
  const traps = capItems(normalizeAiStringArray(body.traps), MAX_TRAPS)
  const insights = capItems(normalizeAiStringArray(body.insights), MAX_INSIGHTS)
  const aiConfidence = typeof body.confidence === 'number' ? body.confidence : -1

  // AI 字段缺失时回退到规则提炼
  const fallbackSteps = steps.length > 0 ? steps : extractStepsByRules(cells)
  const fallbackTraps = traps.length > 0 ? traps : extractTrapsByRules(cells)
  const fallbackInsights = insights.length > 0 ? insights : extractInsightsByRules(cells)

  // 置信度：AI 给出合法值则用 AI 值；否则基于成员数与内容丰富度计算
  let confidence: number
  if (aiConfidence >= 0 && aiConfidence <= 1) {
    confidence = clampConfidence(aiConfidence)
  } else {
    confidence = computeFallbackConfidence(
      cells.length,
      fallbackSteps,
      fallbackTraps,
      fallbackInsights
    )
  }

  return {
    id: randomUUID(),
    title,
    steps: fallbackSteps,
    traps: fallbackTraps,
    insights: fallbackInsights,
    sourceCellIds: cells.map((c) => c.id),
    confidence,
    evolvedAt: nowIso()
  }
}

/**
 * 技能进化：从重复出现的 MemScene 主题中提炼技能卡。
 *
 * 处理流程：
 *  1. 通过 MemSceneRepository.getAll 获取所有 MemScene
 *  2. 筛选 memberCellIds.length >= 3 的 MemScene（重复工作信号）
 *  3. 对每个符合条件的 MemScene：
 *     - 通过 MemCellRepository.getById 获取所有成员 MemCell（跳过不存在的）
 *     - 调用 AI 提炼技能卡；AI 不可用时降级为规则提炼
 *     - 按 title 去重：同 title 已存在则跳过（不重复生成）
 *     - 通过 SkillRepository.insert 持久化
 *  4. 返回新生成的 Skill 列表
 *
 * 无符合条件的 MemScene 时返回空数组，不抛出错误。
 * @returns 新生成的技能卡列表
 */
export async function evolveSkills(): Promise<Skill[]> {
  const scenes = MemSceneRepository.getAll()
  const generated: Skill[] = []

  for (const scene of scenes) {
    if (scene.memberCellIds.length < MIN_MEMBER_CELL_IDS) {
      continue
    }

    // 获取所有成员 MemCell（跳过不存在的，避免脏数据导致整批失败）
    const cells: MemCell[] = []
    for (const cellId of scene.memberCellIds) {
      const cell = MemCellRepository.getById(cellId)
      if (cell) {
        cells.push(cell)
      }
    }
    if (cells.length < MIN_MEMBER_CELL_IDS) {
      // 成员 MemCell 实际可用数不足，跳过
      continue
    }

    // 按 title 去重：同 title 已存在则跳过
    const existing = SkillRepository.getByTitle(scene.title)
    if (existing !== null) {
      continue
    }

    // AI 提炼（不可用时降级为规则提炼）
    const aiBody = await evolveByAi(scene, cells)
    const skill = aiBody
      ? buildSkillByAi(scene, cells, aiBody)
      : buildSkillByRules(scene, cells)

    // 持久化（失败仅记录日志，不中断后续 MemScene 处理）
    try {
      SkillRepository.insert(skill)
      generated.push(skill)
    } catch (e) {
      console.error(
        '[SkillEvolver] 技能卡持久化失败:',
        e instanceof Error ? e.message : String(e)
      )
    }
  }

  return generated
}
