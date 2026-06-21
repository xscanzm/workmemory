/**
 * FeedbackLoop：反馈回流引擎（Task R3）。
 *
 * 在反思与进化 Sprint 中，记录用户对系统输出的反馈（重命名 Episode、拒绝 Wiki 条目、
 * 编辑日报），分析反馈模式，调整系统行为（关键词权重表）。
 *
 * 职责：
 *  - recordFeedback(event)：记录单条反馈事件，写入 feedback_events 表（applied=0）
 *  - applyFeedback()：扫描所有未应用反馈事件，按 type 分组分析：
 *    - episode_renamed：分析 before 中的高频词，若用户总是改为不含该词的标题，
 *      视为对该词的"拒绝"，累计拒绝次数后降低该词在 keywordWeights 中的权重
 *    - wiki_rejected：分析被拒绝的 Wiki 条目特征（before 中的词在 after 中消失），
 *      同样累计拒绝次数后降低权重
 *    - report_edited：分析被编辑的日报段落（before 中的词在 after 中消失），
 *      同样累计拒绝次数后降低权重
 *  - 调整内存中的 keywordWeights（初始权重 1.0，频繁被拒绝的词权重衰减）
 *  - 标记已处理的 feedback_events 为 applied=1
 *
 * 触发：用户编辑动作发生时调用 recordFeedback；applyFeedback 可由 main/index.ts
 * 在每日/每周反思时调用，或由用户主动触发。
 *
 * 借鉴 EverOS 反馈回流概念，将用户隐式反馈转化为系统可调参数，
 * 实现"自我进化"的闭环。
 */
import { FeedbackEventRepository } from '../db/repositories/FeedbackEventRepository'

/** 反馈事件类型 */
export type FeedbackEventType = 'episode_renamed' | 'wiki_rejected' | 'report_edited'

/** 反馈事件：用户对系统输出的修改/拒绝记录 */
export interface FeedbackEvent {
  /**
   * 反馈事件 ID（由仓库内部生成）。
   * recordFeedback 调用方可传空字符串，仓库 insert 时生成 UUID；
   * getUnapplied / getByType 返回时携带实际 ID，供 markApplied 使用。
   */
  id: string
  /** 反馈类型 */
  type: FeedbackEventType
  /** 被反馈对象的 ID（Episode ID / Wiki ID / Report ID） */
  targetId: string
  /** 修改前的内容（如原标题） */
  before: string
  /** 修改后的内容（如新标题；wiki_rejected 时为空字符串） */
  after: string
  /** ISO 时间戳 */
  timestamp: string
}

/**
 * 内存中的关键词权重表（可调参数）。
 *  - 初始权重为 1.0（未在表中显式记录的词视为 1.0）
 *  - applyFeedback 后，频繁被用户拒绝的词权重衰减
 *  - 如"推进"被频繁修改，权重降低到 0.3 左右
 *
 * 该表供 EpisodeBuilder 等模块在生成标题/摘要时参考，避免反复使用用户不认可的词。
 */
export const keywordWeights: Map<string, number> = new Map()

/** 初始权重（未在 keywordWeights 中记录的词的默认值） */
const INITIAL_WEIGHT = 1.0
/** 权重下限，避免衰减到 0 失去区分度 */
const MIN_WEIGHT = 0.1
/** 每次拒绝的权重衰减系数（乘法）：每次拒绝后权重 *= 0.7 */
const WEIGHT_DECAY_FACTOR = 0.7
/** 触发权重调整的最小拒绝次数（"频繁修改"阈值） */
const REJECTION_THRESHOLD = 3

/**
 * 将文本分词为关键词集合（中文双字 bigram + 英文单词）。
 *
 * 与 EpisodeBuilder.extractKeywords 的分词策略保持一致，确保反馈分析的关键词
 * 与标题生成时的关键词处于同一粒度。仅返回去重后的集合，不排序。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  if (!text || text.length === 0) return tokens

  // 中文双字 bigram
  const chineseSegments = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const seg of chineseSegments) {
    for (let i = 0; i < seg.length - 1; i++) {
      tokens.add(seg.slice(i, i + 2))
    }
  }

  // 英文单词（长度 >= 2，小写化）
  const englishWords = text.match(/[a-zA-Z]{2,}/g) ?? []
  for (const w of englishWords) {
    tokens.add(w.toLowerCase())
  }

  return tokens
}

/**
 * 获取关键词当前权重（未在表中记录的词返回 INITIAL_WEIGHT）。
 */
export function getKeywordWeight(keyword: string): number {
  return keywordWeights.get(keyword) ?? INITIAL_WEIGHT
}

/**
 * 重置关键词权重表（仅供测试使用）。
 * 清空所有已调整的权重，使所有词回到初始权重 1.0。
 */
export function resetKeywordWeights(): void {
  keywordWeights.clear()
}

/**
 * 记录用户反馈事件。
 *
 * 将反馈事件写入 feedback_events 表（applied=0），等待 applyFeedback 分析处理。
 * id 由仓库内部生成（randomUUID），调用方无需提供。
 *
 * @param event 反馈事件（不含 id，由仓库内部生成）
 */
export function recordFeedback(event: Omit<FeedbackEvent, 'id'>): void {
  try {
    FeedbackEventRepository.insert(event)
  } catch (e) {
    // 持久化失败不应中断用户编辑流程，仅记录日志
    console.error(
      '[FeedbackLoop] 记录反馈事件失败:',
      e instanceof Error ? e.message : String(e)
    )
  }
}

/**
 * 应用反馈：分析未应用的反馈事件，调整关键词权重表，标记为已应用。
 *
 * 处理流程：
 *  1. 通过 FeedbackEventRepository.getUnapplied 获取所有 applied=0 的事件
 *  2. 对每条事件，提取 before 中的关键词集合与 after 中的关键词集合
 *  3. 在 before 中但不在 after 中的词视为"被拒绝词"，累计拒绝次数
 *  4. 对拒绝次数 >= REJECTION_THRESHOLD 的词，按 WEIGHT_DECAY_FACTOR 衰减权重：
 *     newWeight = max(MIN_WEIGHT, INITIAL_WEIGHT * WEIGHT_DECAY_FACTOR^rejectCount)
 *     - 仅衰减，不回升（若新权重 >= 当前权重则不更新）
 *  5. 通过 FeedbackEventRepository.markApplied 标记所有已处理事件为 applied=1
 *
 * 无未应用事件时直接返回，不抛出错误。
 */
export function applyFeedback(): void {
  const unapplied = FeedbackEventRepository.getUnapplied()
  if (unapplied.length === 0) return

  // 累计每个关键词被拒绝的次数（在 before 中出现但在 after 中消失）
  const rejectionCounts = new Map<string, number>()
  for (const event of unapplied) {
    const beforeTokens = tokenize(event.before)
    const afterTokens = tokenize(event.after)
    for (const token of beforeTokens) {
      if (!afterTokens.has(token)) {
        rejectionCounts.set(token, (rejectionCounts.get(token) ?? 0) + 1)
      }
    }
  }

  // 对频繁被拒绝的词衰减权重
  for (const [keyword, rejectCount] of rejectionCounts) {
    if (rejectCount < REJECTION_THRESHOLD) continue
    const currentWeight = getKeywordWeight(keyword)
    const decayedWeight = Math.max(
      MIN_WEIGHT,
      INITIAL_WEIGHT * Math.pow(WEIGHT_DECAY_FACTOR, rejectCount)
    )
    // 仅衰减，不回升
    if (decayedWeight < currentWeight) {
      keywordWeights.set(keyword, decayedWeight)
    }
  }

  // 标记所有已处理事件为 applied=1
  FeedbackEventRepository.markApplied(unapplied.map((e) => e.id))
}
