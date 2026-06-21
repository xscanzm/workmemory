/**
 * EpisodeBuilder：Episode 语义合并引擎
 *
 * 将连续的 Segment 片段合成人类可理解的 Episode 工作事件。
 *
 * 合并算法：
 *  1. 时间连续性：相邻 Segment 时间差 <5 分钟
 *  2. 语义相似度：OCR 关键词一致（Jaccard >0.3）或窗口标题含相同任务单号
 *  3. 应用频繁切换融合：10 分钟内 ≥3 个不同应用但关键词指向同一主题 → 融合
 *
 * 合并产出 Episode：title、one_line_summary、segmentIds、entities、topics、startTime、endTime
 *
 * 持久化：删除该日期旧 Episodes（非 user_edited）→ 插入新 Episodes；
 *        保留 user_edited 的 Episode 不动。
 *
 * 事件：'episodes-rebuilt'(date)
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { Episode, WorkSegment, ActivityType } from '@/types'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import {
  CHINESE_MENU_WORDS,
  ENGLISH_MENU_WORDS,
  CHINESE_BUTTON_WORDS,
  ENGLISH_BUTTON_WORDS,
  NETWORK_INDICATOR_WORDS
} from '../ocr/OcrTextCleaner'

/** 时间连续性阈值（秒）：相邻 Segment 时间差 <5 分钟 */
const TIME_CONTINUITY_THRESHOLD_SEC = 5 * 60
/** 应用频繁切换融合窗口（秒）：10 分钟 */
const APP_SWITCH_FUSION_WINDOW_SEC = 10 * 60
/** 应用频繁切换融合阈值：≥3 个不同应用 */
const APP_SWITCH_FUSION_MIN_APPS = 3
/** 主题聚类 Jaccard 相似度阈值 */
const TOPIC_SIMILARITY_THRESHOLD = 0.3
/** 关键词提取 top N */
const KEYWORDS_TOP_N = 10
/** 每日总结标记 topic */
export const DAILY_SUMMARY_TOPIC = '__daily_summary__'

/** 中文停用词 */
const CHINESE_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '等', '也', '都', '就', '还', '又',
  '把', '被', '让', '给', '向', '从', '到', '对', '为', '按', '由', '于', '以',
  '及', '但', '而', '且', '则', '若', '如', '虽', '然', '因', '所', '之', '其',
  '此', '这', '那', '哪', '些', '个', '们', '你', '我', '他', '她', '它', '一',
  '二', '三', '中', '上', '下', '里', '外', '前', '后', '左', '右', '内', '间',
  '不', '没', '有', '无', '非', '未', '已', '正', '将', '会', '能', '可', '应',
  '需', '要', '想', '觉', '得', '看', '见', '听', '说', '问', '答', '知', '道',
  '来', '去', '过', '着', '地', '得', '吧', '吗', '呢', '啊', '哦', '嗯', '哈',
  '个', '只', '本', '该', '各', '每', '另', '同', '此', '些', '某'
])

/** 英文停用词 */
const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'not', 'no', 'yes', 'if', 'then', 'else', 'when', 'where', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'now'
])

/**
 * UI 噪声词集合（中文原样 + 英文小写）。
 * 复用 OcrTextCleaner 的噪声词表，用于 extractKeywords / generateTitle /
 * generateOneLineSummary 过滤 UI 通用噪声，避免生成无意义的关键词拼接。
 */
const UI_NOISE_WORDS: Set<string> = new Set<string>([
  ...CHINESE_MENU_WORDS,
  ...CHINESE_BUTTON_WORDS,
  ...NETWORK_INDICATOR_WORDS,
  ...ENGLISH_MENU_WORDS.map(w => w.toLowerCase()),
  ...ENGLISH_BUTTON_WORDS.map(w => w.toLowerCase())
])

/** 动作词映射（用于 one_line_summary 生成） */
const ACTION_VERBS: Array<{ pattern: RegExp; action: string }> = [
  { pattern: /(编写|写|实现|开发|编码|编程|coding|implement)/i, action: '编写代码' },
  { pattern: /(确认|核对|验证|检查|审查|review|check|verify)/i, action: '确认' },
  { pattern: /(沟通|讨论|交流|回复|聊天|会议|chat|discuss|meeting)/i, action: '沟通' },
  { pattern: /(阅读|查看|浏览|看|read|view|browse)/i, action: '查看' },
  { pattern: /(修改|更新|调整|优化|重构|fix|update|modify|refactor)/i, action: '修改' },
  { pattern: /(测试|调试|test|debug)/i, action: '测试' },
  { pattern: /(部署|发布|上线|deploy|release|publish)/i, action: '部署' },
  { pattern: /(设计|规划|架构|design|plan|architect)/i, action: '设计' },
  { pattern: /(搜索|查询|检索|search|query|find)/i, action: '搜索' },
  { pattern: /(创建|新建|添加|create|add|new)/i, action: '创建' },
  { pattern: /(删除|移除|remove|delete)/i, action: '删除' },
  { pattern: /(配置|设置|config|setting)/i, action: '配置' }
]

/** 任务单号前缀 → 项目名映射 */
const TASK_PREFIX_TO_PROJECT: Record<string, string> = {
  ORD: '订单', PRD: '需求', BUG: '缺陷', ISSUE: 'Issue', PR: 'PR',
  MR: '合并请求', TASK: '任务', TODO: '待办', JIRA: 'Jira', GIT: 'Git',
  API: 'API', DOC: '文档', SPEC: '规格', FEAT: '功能', TEST: '测试',
  DEV: '开发', OPS: '运维'
}

/** Segment 聚类（用于合并算法中间状态） */
interface SegmentCluster {
  segments: WorkSegment[]
  keywords: Set<string>
  taskIds: Set<string>
  apps: Set<string>
}

/**
 * EpisodeBuilder：Episode 语义合并引擎。
 *
 * 事件：
 *  - 'episodes-rebuilt'：Episode 重建完成，携带 date
 */
export class EpisodeBuilder extends EventEmitter {
  /**
   * 重建指定日期的 Episodes。
   *
   * 流程：
   *  1. 读取该日期所有 active Segments（未删除），按时间排序
   *  2. 执行合并算法（时间连续性 + 语义相似度 + 应用频繁切换融合）
   *  3. 为每个聚类生成 Episode（title、one_line_summary、topics）
   *  4. 持久化：删除非 user_edited 旧 Episodes → 插入新 Episodes
   *  5. emit 'episodes-rebuilt'
   */
  rebuildEpisodesForDate(date: string): Episode[] {
    // 1. 读取 active Segments
    const allSegments = SegmentRepository.getActiveByDate(date)
    // 屏幕记录不能完全依赖 OCR 成功：pending/ocr_failed 也可先用窗口标题形成粗粒度事件，
    // OCR 完成后再重建为更完整的语义事件。隐私片段仍然排除。
    const segments = allSegments.filter(
      s => !s.isPrivate && s.sourceStatus !== 'private'
    )

    // 2. 执行合并算法
    const clusters = this.clusterSegments(segments)

    // 3. 生成 Episodes
    const newEpisodes = clusters.map(cluster => this.createEpisodeFromCluster(cluster, date))

    // 4. 持久化
    this.persistEpisodes(date, newEpisodes)

    // 5. emit 事件
    this.emit('episodes-rebuilt', date)

    return newEpisodes
  }

  // ===================== 合并算法 =====================

  /**
   * 将 Segments 聚类为多个 Cluster。
   *
   * 算法：
   *  1. 每个 Segment 初始化为独立 Cluster
   *  2. 遍历相邻 Cluster，若满足合并条件则合并
   *  3. 应用频繁切换融合：10 分钟内 ≥3 个不同应用但关键词同主题 → 融合
   */
  private clusterSegments(segments: WorkSegment[]): SegmentCluster[] {
    if (segments.length === 0) return []

    // 按时间排序
    const sorted = [...segments].sort((a, b) => {
      return timeToSeconds(a.startTime) - timeToSeconds(b.startTime)
    })

    // 初始化聚类
    let clusters: SegmentCluster[] = sorted.map(segment => ({
      segments: [segment],
      keywords: new Set(extractKeywords(this.segmentText(segment))),
      taskIds: new Set(extractTaskIds(this.segmentText(segment))),
      apps: new Set([segment.appName])
    }))

    // 第一轮：时间连续性 + 语义相似度合并
    clusters = this.mergeByContinuityAndSimilarity(clusters)

    // 第二轮：应用频繁切换融合
    clusters = this.mergeByAppSwitchFusion(clusters)

    return clusters
  }

  /**
   * 第一轮合并：时间连续性（<5min）+ 语义相似度（关键词 Jaccard >0.3 或共享任务单号）
   */
  private mergeByContinuityAndSimilarity(clusters: SegmentCluster[]): SegmentCluster[] {
    if (clusters.length <= 1) return clusters

    const result: SegmentCluster[] = [clusters[0]]

    for (let i = 1; i < clusters.length; i++) {
      const prev = result[result.length - 1]
      const curr = clusters[i]

      const prevEnd = timeToSeconds(prev.segments[prev.segments.length - 1].endTime)
      const currStart = timeToSeconds(curr.segments[0].startTime)
      const gap = currStart - prevEnd

      const timeContinuous = gap >= 0 && gap <= TIME_CONTINUITY_THRESHOLD_SEC
      const semanticallySimilar = this.isSemanticallySimilar(prev, curr)

      if (timeContinuous && semanticallySimilar) {
        // 合并到前一个 Cluster
        this.mergeCluster(prev, curr)
      } else {
        result.push(curr)
      }
    }

    return result
  }

  /**
   * 第二轮合并：应用频繁切换融合。
   * 10 分钟内 ≥3 个不同应用但关键词指向同一主题（Jaccard >0.3）→ 融合。
   */
  private mergeByAppSwitchFusion(clusters: SegmentCluster[]): SegmentCluster[] {
    if (clusters.length <= 1) return clusters

    const result: SegmentCluster[] = [clusters[0]]

    for (let i = 1; i < clusters.length; i++) {
      const prev = result[result.length - 1]
      const curr = clusters[i]

      const prevEnd = timeToSeconds(prev.segments[prev.segments.length - 1].endTime)
      const currStart = timeToSeconds(curr.segments[0].startTime)
      const gap = currStart - prevEnd

      // 在 10 分钟窗口内
      const withinFusionWindow = gap >= 0 && gap <= APP_SWITCH_FUSION_WINDOW_SEC

      if (withinFusionWindow) {
        // 检查合并后是否满足频繁切换条件
        const mergedApps = new Set([...prev.apps, ...curr.apps])
        const sameTopic = jaccardSimilarity(prev.keywords, curr.keywords) > TOPIC_SIMILARITY_THRESHOLD

        if (mergedApps.size >= APP_SWITCH_FUSION_MIN_APPS && sameTopic) {
          // 频繁切换融合
          this.mergeCluster(prev, curr)
          continue
        }

        // 即使不满足 ≥3 应用，如果时间连续且同主题也合并
        if (gap <= TIME_CONTINUITY_THRESHOLD_SEC && sameTopic) {
          this.mergeCluster(prev, curr)
          continue
        }
      }

      result.push(curr)
    }

    return result
  }

  /** 判断两个 Cluster 是否语义相似 */
  private isSemanticallySimilar(a: SegmentCluster, b: SegmentCluster): boolean {
    // activityType 感知：两个聚类都有非 idle 的主导 activityType 且不同 → 不合并
    // （如 reading 代码文档 vs coding 写代码，即使关键词重叠也不误合并）
    // 其中一方为 undefined 或 idle 时，向后兼容，不影响现有判断
    const activityA = this.getDominantActivityType(a)
    const activityB = this.getDominantActivityType(b)
    if (activityA && activityB && activityA !== activityB) return false

    // 共享任务单号 → 相似
    for (const taskId of a.taskIds) {
      if (b.taskIds.has(taskId)) return true
    }

    // 关键词 Jaccard 相似度 >0.3
    if (jaccardSimilarity(a.keywords, b.keywords) > TOPIC_SIMILARITY_THRESHOLD) return true

    // 同一应用 + 关键词有交集
    const sameApp = [...a.apps].some(app => b.apps.has(app))
    if (sameApp) {
      const intersection = [...a.keywords].filter(k => b.keywords.has(k))
      if (intersection.length > 0) return true
    }

    return false
  }

  /** 合并两个 Cluster */
  private mergeCluster(target: SegmentCluster, source: SegmentCluster): void {
    target.segments.push(...source.segments)
    for (const k of source.keywords) target.keywords.add(k)
    for (const t of source.taskIds) target.taskIds.add(t)
    for (const a of source.apps) target.apps.add(a)
  }

  /**
   * 计算聚类的主导 activityType。
   * 多数投票：忽略 undefined 和 'idle'，取出现次数最多的 activityType；
   * 若全部为 undefined/idle，则返回 undefined。
   */
  private getDominantActivityType(cluster: SegmentCluster): ActivityType | undefined {
    const counts = new Map<ActivityType, number>()
    for (const segment of cluster.segments) {
      const at = segment.activityType
      if (at && at !== 'idle') {
        counts.set(at, (counts.get(at) ?? 0) + 1)
      }
    }
    if (counts.size === 0) return undefined

    let best: ActivityType | undefined
    let bestCount = 0
    for (const [at, count] of counts) {
      if (count > bestCount) {
        best = at
        bestCount = count
      }
    }
    return best
  }

  // ===================== Episode 生成 =====================

  /** 从 Cluster 创建 Episode */
  private createEpisodeFromCluster(cluster: SegmentCluster, date: string): Episode {
    const segments = cluster.segments
    const startTime = segments[0].startTime
    const endTime = segments[segments.length - 1].endTime
    const segmentIds = segments.map(s => s.id)

    // 提取主题关键词
    const topics = [...cluster.keywords].slice(0, KEYWORDS_TOP_N)

    // 生成 title
    const title = this.generateTitle(cluster)

    // 生成 one_line_summary
    const oneLineSummary = this.generateOneLineSummary(cluster)

    // 聚类内多数 segment 的 activityType（忽略 undefined/idle）
    const dominantActivityType = this.getDominantActivityType(cluster)

    return {
      id: randomUUID(),
      date,
      startTime,
      endTime,
      title,
      oneLineSummary,
      segmentIds,
      entities: [],
      topics,
      userEdited: false,
      reportEligible: true,
      wikiEligible: false,
      dominantActivityType
    }
  }

  /**
   * 生成 Episode title。
   * 规则：若能提取任务单号/项目名 → "[项目名] 主题"；否则取最频繁应用 + 关键词组合。
   * 降级：当关键词均为 UI 噪声词或为空，且无任务单号/项目名时，
   *      退化到 `${appName} - ${windowTitle前20字}`，避免无意义的关键词拼接。
   */
  private generateTitle(cluster: SegmentCluster): string {
    const segments = cluster.segments
    const taskIds = [...cluster.taskIds]

    // 提取项目名
    let projectName = ''
    if (taskIds.length > 0) {
      const firstTaskId = taskIds[0]
      const prefix = firstTaskId.split('-')[0]
      projectName = TASK_PREFIX_TO_PROJECT[prefix] || prefix
    }

    // 从窗口标题提取项目/需求名
    if (!projectName) {
      for (const segment of segments) {
        const titleMatch = segment.windowTitle.match(/([\u4e00-\u9fff\w]{2,10})(项目|需求|功能|模块)/)
        if (titleMatch) {
          projectName = titleMatch[1] + titleMatch[2]
          break
        }
      }
    }

    // 提取主题关键词（过滤 UI 噪声词后取 top 2-3）
    const meaningfulKeywords = [...cluster.keywords].filter(k => !UI_NOISE_WORDS.has(k))
    const topKeywords = meaningfulKeywords.slice(0, 3).join('')

    if (projectName && topKeywords) {
      return `[${projectName}] ${topKeywords}`
    } else if (projectName) {
      return `[${projectName}] 工作推进`
    }

    // 取最频繁应用 + 窗口标题关键词
    const appCounts = new Map<string, number>()
    for (const segment of segments) {
      appCounts.set(segment.appName, (appCounts.get(segment.appName) ?? 0) + 1)
    }
    const dominantApp = [...appCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

    // 从窗口标题提取关键词
    const titleKeywords = this.extractTitleKeywords(segments)

    // 关键词均为 UI 噪声或为空 → 降级到 appName - windowTitle前20字
    if (dominantApp && titleKeywords) {
      return `${dominantApp} - ${titleKeywords}`
    } else if (dominantApp) {
      return `${dominantApp} 工作`
    } else if (topKeywords) {
      return topKeywords
    }

    return '工作片段'
  }

  /** 从窗口标题提取关键词 */
  private extractTitleKeywords(segments: WorkSegment[]): string {
    const titles = segments.map(s => s.windowTitle).filter(t => t.length > 0)
    if (titles.length === 0) return ''

    // 取最长标题，去除常见后缀
    const longestTitle = titles.sort((a, b) => b.length - a.length)[0]
    // 去除应用名后缀（如 " - Google Chrome", " - Visual Studio Code"）
    const cleaned = longestTitle.replace(/\s*-\s*[^-]+$/, '').trim()
    // 去除后缀后若为空，返回空字符串（避免返回应用名本身）
    if (cleaned === '') return ''
    // 取前 20 字
    return cleaned.slice(0, 20)
  }

  /**
   * 生成 one_line_summary。
   * 规则：基于 OCR 文本提取核心动作 + 对象，组合成一句话。
   * 降级：当无动作词且关键词均为 UI 噪声或为空时，返回 `查看 ${appName} 相关内容`，
   *      避免输出无意义的 "推进关键词"。
   */
  private generateOneLineSummary(cluster: SegmentCluster): string {
    const segments = cluster.segments
    const fullText = segments.map(s => s.ocrText).join('\n')
    const titles = segments.map(s => s.windowTitle).join('\n')
    const combinedText = `${fullText}\n${titles}`

    // 提取动作词
    const actions: string[] = []
    for (const { pattern, action } of ACTION_VERBS) {
      if (pattern.test(combinedText) && !actions.includes(action)) {
        actions.push(action)
      }
    }

    // 提取主题对象（top 关键词，过滤 UI 噪声词）
    const meaningfulKeywords = [...cluster.keywords].filter(k => !UI_NOISE_WORDS.has(k))
    const topKeywords = meaningfulKeywords.slice(0, 3).join('')

    // 提取项目名
    let projectName = ''
    const taskIds = [...cluster.taskIds]
    if (taskIds.length > 0) {
      const prefix = taskIds[0].split('-')[0]
      projectName = TASK_PREFIX_TO_PROJECT[prefix] || prefix
    }

    // 提取主导应用名（用于降级文案）
    const appCounts = new Map<string, number>()
    for (const segment of segments) {
      appCounts.set(segment.appName, (appCounts.get(segment.appName) ?? 0) + 1)
    }
    const dominantApp = [...appCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

    // 降级：无动作词且无有意义关键词 → 查看 ${appName} 相关内容
    if (actions.length === 0 && !topKeywords) {
      if (dominantApp) {
        return `查看 ${dominantApp} 相关内容`
      }
      return '查看相关内容'
    }

    // 组合一句话
    const parts: string[] = []

    if (actions.length > 0 && topKeywords) {
      parts.push(`${actions[0]}${topKeywords}`)
    } else if (actions.length > 0) {
      parts.push(actions[0])
    } else if (topKeywords) {
      parts.push(`推进${topKeywords}`)
    }

    if (actions.length > 1) {
      parts.push(`并${actions[1]}`)
    }

    if (projectName && parts.length > 0) {
      return `${projectName}：${parts.join('，')}`
    }

    if (parts.length > 0) {
      return parts.join('，')
    }

    // 降级：使用窗口标题
    const titleKeywords = this.extractTitleKeywords(segments)
    if (titleKeywords) {
      return `处理${titleKeywords}`
    }

    return '工作推进'
  }

  // ===================== 持久化 =====================

  /**
   * 持久化 Episodes。
   * 删除该日期非 user_edited 旧 Episodes（保留每日总结和用户编辑的）→ 插入新 Episodes。
   */
  private persistEpisodes(date: string, newEpisodes: Episode[]): void {
    const existingEpisodes = EpisodeRepository.getByDate(date)

    for (const existing of existingEpisodes) {
      // 保留 user_edited 的 Episode
      if (existing.userEdited) continue
      // 保留每日总结 Episode
      if (existing.topics.includes(DAILY_SUMMARY_TOPIC)) continue
      // 删除非 user_edited 的旧 Episode
      EpisodeRepository.hardDelete(existing.id)
    }

    // 插入新 Episodes
    for (const episode of newEpisodes) {
      EpisodeRepository.insert(episode)
    }
  }

  // ===================== 工具方法 =====================

  /** 获取 Segment 的文本内容（OCR + 窗口标题） */
  private segmentText(segment: WorkSegment): string {
    return `${segment.ocrText}\n${segment.windowTitle}`
  }
}

// ===================== 导出工具函数 =====================

/**
 * 提取关键词。
 * 分词：中文按字 + 双字组合，英文按空格 → 去停用词 + UI 噪声词 → TF 排序 top10。
 */
export function extractKeywords(text: string): string[] {
  if (!text || text.trim().length === 0) return []

  const freq = new Map<string, number>()

  // 中文单字 + 双字组合
  const chineseChars = text.match(/[\u4e00-\u9fff]/g) ?? []
  for (const ch of chineseChars) {
    if (!CHINESE_STOPWORDS.has(ch)) {
      freq.set(ch, (freq.get(ch) ?? 0) + 1)
    }
  }

  // 中文双字组合
  const chineseText = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const segment of chineseText) {
    for (let i = 0; i < segment.length - 1; i++) {
      const bigram = segment.slice(i, i + 2)
      if (!CHINESE_STOPWORDS.has(bigram[0]) && !CHINESE_STOPWORDS.has(bigram[1])) {
        // 过滤 UI 噪声双字词（如 文件/编辑/视图/确定/取消 等）
        if (!UI_NOISE_WORDS.has(bigram)) {
          freq.set(bigram, (freq.get(bigram) ?? 0) + 1)
        }
      }
    }
  }

  // 英文单词
  const englishWords = text.match(/[a-zA-Z]{2,}/g) ?? []
  for (const word of englishWords) {
    const lower = word.toLowerCase()
    if (!ENGLISH_STOPWORDS.has(lower) && lower.length >= 2) {
      // 过滤 UI 噪声英文词（如 file/edit/view/ok/cancel 等，大小写不敏感）
      if (!UI_NOISE_WORDS.has(lower)) {
        freq.set(lower, (freq.get(lower) ?? 0) + 1)
      }
    }
  }

  // TF 排序，取 top N
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1])
  return sorted.slice(0, KEYWORDS_TOP_N).map(([word]) => word)
}

/**
 * 提取任务单号。
 * 正则：[A-Z]{2,}-\d+、#\d+、PR-\d+、ISSUE-\d+
 */
export function extractTaskIds(text: string): string[] {
  if (!text) return []
  const ids = new Set<string>()

  // [A-Z]{2,}-\d+ 模式（含 PR-\d+, ISSUE-\d+ 等）
  const taskRegex = /([A-Z]{2,})-(\d+)/g
  let match: RegExpExecArray | null
  while ((match = taskRegex.exec(text)) !== null) {
    ids.add(`${match[1]}-${match[2]}`)
  }

  // #\d+ 模式
  const hashRegex = /#(\d+)/g
  while ((match = hashRegex.exec(text)) !== null) {
    ids.add(`#${match[1]}`)
  }

  return [...ids]
}

/**
 * 计算两个集合的 Jaccard 相似度。
 * |A ∩ B| / |A ∪ B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0

  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }

  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 将 "HH:MM:SS" 时间字符串转为秒数。
 */
function timeToSeconds(timeStr: string): number {
  const parts = timeStr.split(':')
  if (parts.length === 3) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)
  }
  if (parts.length === 2) {
    return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60
  }
  return 0
}
