/**
 * WikiExtractor：Wiki 自动提取器
 *
 * 基于 IngestCandidate 的候选源 Episodes 的 OCR 文本，提炼 Markdown Wiki 内容。
 *
 * 提取结构化内容：
 *  - oneLineSummary：基于高频动作词 + 对象
 *  - currentProgress：检测"已完成"、"进行中"、"待办"等状态词
 *  - keyFacts：提取陈述句（含"是"、"为"、"使用"、"采用"等动词），去重 top 5
 *  - pendingQuestions：提取疑问句（含"?"、"？"、"是否"、"怎么"、"如何"）
 *  - extractedLinks：提取其他已知 WikiPage 标题在文本中的出现，生成 [[link]]
 *
 * 生成 Markdown 字符串（含 YAML front matter：title/type/aliases/sources/confidence）。
 * 纯规则提取，不调用外部 AI（本地优先）。
 */
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { WikiRepository } from '../db/repositories/WikiRepository'
import { extractKeywords } from '../capture/EpisodeBuilder'
import type { IngestCandidate } from './HighValueSignalDetector'
import { getWikiLinkEngine } from './WikiLinkEngine'

/** Wiki 提取结果 */
export interface WikiExtractionResult {
  /** 完整 Markdown（含 YAML front matter） */
  markdown: string
  oneLineSummary: string
  keyFacts: string[]
  pendingQuestions: string[]
  /** 提取的 [[link]] 目标标题列表 */
  extractedLinks: string[]
}

/** 动作词映射（用于 oneLineSummary 生成） */
const ACTION_VERBS: Array<{ pattern: RegExp; verb: string }> = [
  { pattern: /(编写|实现|开发|编码|coding|implement)/i, verb: '编写' },
  { pattern: /(修改|更新|调整|优化|重构|fix|update|modify|refactor)/i, verb: '修改' },
  { pattern: /(撰写|起草|draft|write)/i, verb: '撰写' },
  { pattern: /(编辑|修订|审阅|edit|revise|review)/i, verb: '编辑' },
  { pattern: /(测试|调试|test|debug)/i, verb: '测试' },
  { pattern: /(部署|发布|上线|deploy|release|publish)/i, verb: '部署' },
  { pattern: /(设计|规划|架构|design|plan|architect)/i, verb: '设计' },
  { pattern: /(搜索|查询|检索|search|query|find)/i, verb: '搜索' },
  { pattern: /(沟通|讨论|交流|会议|chat|discuss|meeting)/i, verb: '沟通' },
  { pattern: /(配置|设置|config|setting)/i, verb: '配置' },
  { pattern: /(创建|新建|添加|create|add|new)/i, verb: '创建' }
]

/** 状态词模式（用于 currentProgress 检测） */
const PROGRESS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /已完成|done|completed|finished|完成/i, label: '已完成' },
  { pattern: /进行中|ongoing|in progress|processing|推进中/i, label: '进行中' },
  { pattern: /待办|todo|pending|待处理|未开始|planned/i, label: '待办' },
  { pattern: /阻塞|blocked|卡住|stuck|暂停|paused/i, label: '阻塞' }
]

/** 陈述句动词模式（用于 keyFacts 提取） */
const DECLARATIVE_VERB_REGEX = /(是|为|使用|采用|基于|属于|包含|涉及|需要|要求|支持|提供|实现|通过|利用|借助|依赖)/

/** 疑问句标记 */
const QUESTION_REGEX = /[?？]/
const QUESTION_MARKER_REGEX = /(是否|怎么|如何|为什么|为何|哪儿|哪里|哪个|哪些|什么|怎样|能否|可以吗|吗|呢)/

/** 句子分割正则（中英文标点） */
const SENTENCE_SPLIT_REGEX = /[。！？!?\n；;]+/

/** keyFacts 最大数量 */
const KEY_FACTS_MAX = 5
/** pendingQuestions 最大数量 */
const PENDING_QUESTIONS_MAX = 5

/**
 * WikiExtractor：Wiki 自动提取器。
 */
export class WikiExtractor {
  /**
   * 基于 IngestCandidate 提炼 Markdown Wiki 内容。
   *
   * 流程：
   *  1. 聚合 sourceIds 对应 Episodes 的所有 Segment ocr_text
   *  2. 提取结构化内容（oneLineSummary / currentProgress / keyFacts / pendingQuestions）
   *  3. 提取双链标签（已知 WikiPage 标题在文本中的出现）
   *  4. 生成 Markdown（含 YAML front matter）
   */
  extractFromCandidate(candidate: IngestCandidate): WikiExtractionResult {
    // 1. 聚合 OCR 文本
    const episodes = this.getEpisodes(candidate.sourceIds)
    const aggregatedText = this.aggregateOcrText(episodes)
    const titlesAndSummaries = episodes
      .map(e => `${e.title}\n${e.oneLineSummary}`)
      .join('\n')
    const fullText = `${aggregatedText}\n${titlesAndSummaries}`

    // 2. 提取结构化内容
    const oneLineSummary = this.extractOneLineSummary(fullText, candidate)
    const currentProgress = this.extractCurrentProgress(fullText)
    const keyFacts = this.extractKeyFacts(fullText)
    const pendingQuestions = this.extractPendingQuestions(fullText)

    // 3. 提取双链标签
    const extractedLinks = this.extractWikiLinks(fullText)

    // 4. 生成 Markdown
    const markdown = this.generateMarkdown(
      candidate,
      oneLineSummary,
      currentProgress,
      keyFacts,
      pendingQuestions,
      extractedLinks,
      episodes
    )

    return {
      markdown,
      oneLineSummary,
      keyFacts,
      pendingQuestions,
      extractedLinks
    }
  }

  // ===================== 结构化内容提取 =====================

  /** 提取一句话总结：高频动作词 + 对象 */
  private extractOneLineSummary(text: string, candidate: IngestCandidate): string {
    // 提取动作词（按出现顺序去重）
    const actions: string[] = []
    for (const { pattern, verb } of ACTION_VERBS) {
      if (pattern.test(text) && !actions.includes(verb)) {
        actions.push(verb)
      }
    }

    // 提取主题对象（top 关键词）
    const keywords = extractKeywords(text)
    const topKeywords = keywords.slice(0, 3).join('')

    // 组合一句话
    if (actions.length > 0 && topKeywords) {
      const actionStr = actions.slice(0, 2).join('并')
      return `${actionStr}${topKeywords}，共涉及 ${candidate.sourceIds.length} 个工作片段`
    }
    if (actions.length > 0) {
      return `${actions[0]}相关内容，共涉及 ${candidate.sourceIds.length} 个工作片段`
    }
    if (topKeywords) {
      return `推进${topKeywords}，共涉及 ${candidate.sourceIds.length} 个工作片段`
    }

    // 降级：使用候选标题
    return `${candidate.suggestedTitle}：基于 ${candidate.sourceIds.length} 个工作片段整理`
  }

  /** 提取当前进展：检测状态词，返回相关句子 */
  private extractCurrentProgress(text: string): string[] {
    const sentences = this.splitSentences(text)
    const progress: string[] = []
    const seenLabels = new Set<string>()

    for (const sentence of sentences) {
      for (const { pattern, label } of PROGRESS_PATTERNS) {
        if (pattern.test(sentence) && !seenLabels.has(label)) {
          seenLabels.add(label)
          progress.push(`[${label}] ${sentence.trim()}`)
          break
        }
      }
      if (progress.length >= 4) break
    }

    return progress
  }

  /** 提取关键事实：含陈述动词的句子，去重 top 5 */
  private extractKeyFacts(text: string): string[] {
    const sentences = this.splitSentences(text)
    const facts: string[] = []
    const seen = new Set<string>()

    for (const sentence of sentences) {
      const trimmed = sentence.trim()
      if (trimmed.length < 5 || trimmed.length > 200) continue
      // 必须含陈述动词
      if (!DECLARATIVE_VERB_REGEX.test(trimmed)) continue
      // 排除疑问句
      if (QUESTION_REGEX.test(trimmed) || QUESTION_MARKER_REGEX.test(trimmed)) continue
      // 去重（按前 30 字）
      const dedupKey = trimmed.slice(0, 30)
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      facts.push(trimmed)
      if (facts.length >= KEY_FACTS_MAX) break
    }

    return facts
  }

  /** 提取待确认问题：疑问句 */
  private extractPendingQuestions(text: string): string[] {
    const sentences = this.splitSentences(text)
    const questions: string[] = []
    const seen = new Set<string>()

    for (const sentence of sentences) {
      const trimmed = sentence.trim()
      if (trimmed.length < 3 || trimmed.length > 200) continue
      // 必须是疑问句
      const isQuestion =
        QUESTION_REGEX.test(trimmed) || QUESTION_MARKER_REGEX.test(trimmed)
      if (!isQuestion) continue
      // 去重
      const dedupKey = trimmed.slice(0, 30)
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      // 确保以 ? 或 ？ 结尾
      let normalized = trimmed
      if (!QUESTION_REGEX.test(normalized)) {
        normalized = `${normalized}？`
      }
      questions.push(normalized)
      if (questions.length >= PENDING_QUESTIONS_MAX) break
    }

    return questions
  }

  /** 提取双链标签：已知 WikiPage 标题在文本中的出现 */
  private extractWikiLinks(text: string): string[] {
    const allPages = WikiRepository.getAll()
    if (allPages.length === 0) return []

    const links: string[] = []
    const seen = new Set<string>()

    for (const page of allPages) {
      // 检查 title 在文本中出现
      if (page.title.length >= 2 && text.includes(page.title)) {
        if (!seen.has(page.title)) {
          seen.add(page.title)
          links.push(page.title)
        }
        continue
      }
      // 检查 aliases 在文本中出现
      for (const alias of page.aliases) {
        if (alias.trim().length >= 2 && text.includes(alias.trim())) {
          if (!seen.has(page.title)) {
            seen.add(page.title)
            links.push(page.title)
          }
          break
        }
      }
    }

    return links
  }

  // ===================== Markdown 生成 =====================

  /**
   * 生成完整 Markdown（含 YAML front matter）。
   * 结构：
   *  ---
   *  title: "xxx"
   *  type: "topic"
   *  aliases: []
   *  sources: ["ep1", "ep2"]
   *  confidence: 0.8
   *  ---
   *  # xxx
   *  ## 一句话总结
   *  ## 当前进展
   *  ## 关键事实
   *  ## 待确认
   *  ## 相关链接
   */
  private generateMarkdown(
    candidate: IngestCandidate,
    oneLineSummary: string,
    currentProgress: string[],
    keyFacts: string[],
    pendingQuestions: string[],
    extractedLinks: string[],
    episodes: { id: string; date: string; title: string }[]
  ): string {
    const title = candidate.suggestedTitle
    const type = candidate.suggestedType
    const sources = candidate.sourceIds
    const confidence = candidate.confidence

    // YAML front matter
    const yaml = [
      '---',
      `title: "${this.escapeYaml(title)}"`,
      `type: "${type}"`,
      `aliases: []`,
      `sources: ${JSON.stringify(sources)}`,
      `confidence: ${confidence}`,
      '---'
    ].join('\n')

    // 正文
    const sections: string[] = []
    sections.push(`# ${title}`)
    sections.push('')

    // 一句话总结
    sections.push('## 一句话总结')
    sections.push(oneLineSummary)
    sections.push('')

    // 当前进展
    sections.push('## 当前进展')
    if (currentProgress.length > 0) {
      sections.push(...currentProgress.map(p => `- ${p}`))
    } else {
      sections.push('- （暂未检测到明确进展状态）')
    }
    sections.push('')

    // 关键事实
    sections.push('## 关键事实')
    if (keyFacts.length > 0) {
      sections.push(...keyFacts.map(f => `- ${f}`))
    } else {
      sections.push('- （暂未提取到关键事实）')
    }
    sections.push('')

    // 待确认
    sections.push('## 待确认')
    if (pendingQuestions.length > 0) {
      sections.push(...pendingQuestions.map(q => `- ${q}`))
    } else {
      sections.push('- （暂无疑问）')
    }
    sections.push('')

    // 相关链接（双链）
    sections.push('## 相关链接')
    if (extractedLinks.length > 0) {
      sections.push(...extractedLinks.map(l => `- [[${l}]]`))
    } else {
      sections.push('- （暂无关联 Wiki 页）')
    }
    sections.push('')

    // 来源片段
    sections.push('## 来源片段')
    if (episodes.length > 0) {
      for (const ep of episodes) {
        sections.push(`- [${ep.date}] ${ep.title}`)
      }
    } else {
      sections.push('- （无关联片段）')
    }

    return `${yaml}\n\n${sections.join('\n')}`
  }

  // ===================== 内部工具 =====================

  /** 获取 sourceIds 对应的 Episodes */
  private getEpisodes(sourceIds: string[]): { id: string; date: string; title: string; oneLineSummary: string; segmentIds: string[] }[] {
    const episodes: { id: string; date: string; title: string; oneLineSummary: string; segmentIds: string[] }[] = []
    const seen = new Set<string>()
    for (const id of sourceIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const ep = EpisodeRepository.getById(id)
      if (ep) {
        episodes.push({
          id: ep.id,
          date: ep.date,
          title: ep.title,
          oneLineSummary: ep.oneLineSummary,
          segmentIds: ep.segmentIds
        })
      }
    }
    return episodes
  }

  /** 聚合 Episodes 关联 Segments 的 OCR 文本 */
  private aggregateOcrText(
    episodes: { segmentIds: string[]; title: string; oneLineSummary: string }[]
  ): string {
    const segmentIds: string[] = []
    for (const ep of episodes) {
      segmentIds.push(...ep.segmentIds)
    }
    if (segmentIds.length === 0) {
      return episodes.map(e => `${e.title}\n${e.oneLineSummary}`).join('\n')
    }
    const segments = SegmentRepository.getByIds(segmentIds)
    const ocrTexts = segments.map(s => s.ocrText).filter(t => t.length > 0)
    if (ocrTexts.length === 0) {
      return episodes.map(e => `${e.title}\n${e.oneLineSummary}`).join('\n')
    }
    return ocrTexts.join('\n')
  }

  /** 分割句子（中英文标点） */
  private splitSentences(text: string): string[] {
    if (!text) return []
    return text
      .split(SENTENCE_SPLIT_REGEX)
      .map(s => s.trim())
      .filter(s => s.length > 0)
  }

  /** YAML 字符串转义 */
  private escapeYaml(s: string): string {
    return s.replace(/"/g, '\\"')
  }
}

/** 单例 */
let extractorInstance: WikiExtractor | null = null

export function getWikiExtractor(): WikiExtractor {
  if (!extractorInstance) {
    extractorInstance = new WikiExtractor()
  }
  return extractorInstance
}

/** 重新导出 WikiLinkEngine 供外部使用 */
export { getWikiLinkEngine }
