/**
 * TimeAuditEngine：时间审计统计引擎
 *
 * 功能：
 *  - computeTimeAudit(dateRange)：聚合统计
 *    - 按项目聚合时间：按 entities(type=project) 分组累加 durationSeconds
 *    - 按联系人聚合时间：按 entities(type=person) 分组
 *    - 按工作类型聚合时间：根据 segment.app_name/process_name 分类
 *  - classifyWorkType(appName, processName)：沟通/文档/开发/杂务
 *  - getDailyTrend(days)：最近 N 天每日工作时长趋势
 *
 * 工作类型分类规则：
 *  - 沟通：微信/WeChat、钉钉/DingTalk、飞书/Feishu/Lark、Slack、Teams、QQ、Telegram、Discord
 *  - 文档：Word/WINWORD、WPS/wps、Notion、Obsidian、Typora、MarkText
 *  - 开发：Code/VSCode、IDEA、WebStorm、PyCharm、GoLand、Terminal/cmd/powershell/WindowsTerminal、Git
 *  - 杂务：其他（浏览器归杂务除非标题含开发关键词）
 */
import type { Episode, WorkSegment } from '@/types'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { filterHighConfidenceEntities } from '@/utils/entity'

/** 日期范围 */
export interface DateRange {
  /** YYYY-MM-DD */
  start: string
  /** YYYY-MM-DD */
  end: string
}

/** 工作类型 */
export type WorkType = 'communication' | 'document' | 'development' | 'misc'

/** 工作类型中文名 */
export const WORK_TYPE_LABELS: Record<WorkType, string> = {
  communication: '沟通',
  document: '文档',
  development: '开发',
  misc: '杂务'
}

/** 项目/联系人时间分布项 */
export interface TimeDistributionItem {
  name: string
  /** 秒 */
  seconds: number
  episodeCount: number
}

/** 工作类型时间分布项 */
export interface WorkTypeDistributionItem {
  type: WorkType
  label: string
  seconds: number
  /** 占比 0-100 */
  percentage: number
}

/** 时间审计结果 */
export interface TimeAuditResult {
  byProject: TimeDistributionItem[]
  byPerson: TimeDistributionItem[]
  byWorkType: WorkTypeDistributionItem[]
  /** 总工作时长（秒） */
  totalSeconds: number
}

/** 每日趋势项 */
export interface DailyTrendItem {
  /** YYYY-MM-DD */
  date: string
  /** 秒 */
  seconds: number
  episodeCount: number
}

/** 沟通类应用关键词 */
const COMMUNICATION_APPS = [
  '微信', 'wechat', '钉钉', 'dingtalk', '飞书', 'feishu', 'lark',
  'slack', 'teams', 'qq', 'telegram', 'discord', '企业微信', 'wecom',
  'im', '消息', 'message'
]

/** 文档类应用关键词 */
const DOCUMENT_APPS = [
  'word', 'winword', 'wps', 'notion', 'obsidian', 'typora', 'marktext',
  'excel', 'powerpoint', 'ppt', 'onenote', 'evernote', '印象笔记',
  '文档', 'document', 'sheet', 'note'
]

/** 开发类应用关键词 */
const DEVELOPMENT_APPS = [
  'code', 'vscode', 'idea', 'webstorm', 'pycharm', 'goland', 'phpstorm',
  'rubymine', 'clion', 'terminal', 'cmd', 'powershell', 'windowsterminal',
  'git', 'github', 'gitlab', 'sourcetree', 'postman', 'docker', 'vim',
  'neovim', 'emacs', 'sublime', 'atom', 'eclipse', 'netbeans', 'xcode',
  'visual studio', 'devenv', 'node', 'npm', 'yarn', 'pnpm', 'webpack',
  'vite', 'tsc', 'cargo', 'rustc', 'go ', 'python', 'java', 'mvn', 'gradle'
]

/** 开发关键词（用于浏览器标题判断） */
const DEV_KEYWORDS_IN_TITLE = [
  'github', 'gitlab', 'stackoverflow', '文档', 'api', 'code', '编程',
  '开发', 'debug', 'error', 'exception', '编译', 'compile', 'lint'
]

/**
 * TimeAuditEngine：时间审计统计引擎。
 */
export class TimeAuditEngine {
  /**
   * 计算时间审计统计。
   *
   * @param dateRange 日期范围
   * @returns 按项目/联系人/工作类型聚合的时间分布
   */
  computeTimeAudit(dateRange: DateRange): TimeAuditResult {
    const episodes = EpisodeRepository.getByDateRange(dateRange.start, dateRange.end)
    const segments = this.getSegmentsForEpisodes(episodes)

    // 按项目聚合
    const byProject = this.aggregateByEntity(episodes, 'project')

    // 按联系人聚合
    const byPerson = this.aggregateByEntity(episodes, 'person')

    // 按工作类型聚合
    const byWorkType = this.aggregateByWorkType(segments)

    // 总时长
    const totalSeconds = byWorkType.reduce((sum, item) => sum + item.seconds, 0)

    return {
      byProject: this.sortAndTruncate(byProject),
      byPerson: this.sortAndTruncate(byPerson),
      byWorkType,
      totalSeconds
    }
  }

  /**
   * 获取最近 N 天每日工作时长趋势。
   *
   * @param days 天数
   * @returns 每日趋势项列表（按日期升序）
   */
  getDailyTrend(days: number): DailyTrendItem[] {
    const trend: DailyTrendItem[] = []
    const today = new Date()

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
      const dateStr = this.formatDate(date)
      const episodes = EpisodeRepository.getByDate(dateStr)
      const segments = this.getSegmentsForEpisodes(episodes)
      const seconds = segments.reduce((sum, s) => sum + s.durationSeconds, 0)
      trend.push({
        date: dateStr,
        seconds,
        episodeCount: episodes.length
      })
    }

    return trend
  }

  /**
   * 工作类型分类。
   *
   * @param appName 应用名
   * @param processName 进程名
   * @param windowTitle 窗口标题（用于浏览器开发场景判断）
   * @returns 工作类型
   */
  classifyWorkType(appName: string, processName: string, windowTitle = ''): WorkType {
    const combined = `${appName} ${processName} ${windowTitle}`.toLowerCase()

    // 沟通类
    for (const keyword of COMMUNICATION_APPS) {
      if (combined.includes(keyword.toLowerCase())) return 'communication'
    }

    // 文档类
    for (const keyword of DOCUMENT_APPS) {
      if (combined.includes(keyword.toLowerCase())) return 'document'
    }

    // 开发类
    for (const keyword of DEVELOPMENT_APPS) {
      if (combined.includes(keyword.toLowerCase())) return 'development'
    }

    // 浏览器特殊处理：标题含开发关键词则归开发
    if (this.isBrowser(appName, processName)) {
      const titleLower = windowTitle.toLowerCase()
      for (const keyword of DEV_KEYWORDS_IN_TITLE) {
        if (titleLower.includes(keyword.toLowerCase())) return 'development'
      }
    }

    return 'misc'
  }

  // ===================== 内部方法 =====================

  /** 按 Entity 类型聚合时间 */
  private aggregateByEntity(
    episodes: Episode[],
    entityType: 'project' | 'person'
  ): TimeDistributionItem[] {
    const map = new Map<string, { seconds: number; episodeCount: number }>()

    for (const episode of episodes) {
      const duration = this.computeEpisodeDuration(episode)
      const entities = filterHighConfidenceEntities(episode.entities).filter(e => e.type === entityType)
      if (entities.length === 0) {
        // 无实体关联的归入"未分类"
        const name = '未分类'
        const existing = map.get(name) ?? { seconds: 0, episodeCount: 0 }
        existing.seconds += duration
        existing.episodeCount += 1
        map.set(name, existing)
        continue
      }
      for (const entity of entities) {
        const name = entity.name.trim() || '未分类'
        const existing = map.get(name) ?? { seconds: 0, episodeCount: 0 }
        existing.seconds += duration
        existing.episodeCount += 1
        map.set(name, existing)
      }
    }

    return [...map.entries()].map(([name, val]) => ({
      name,
      seconds: val.seconds,
      episodeCount: val.episodeCount
    }))
  }

  /** 按工作类型聚合时间 */
  private aggregateByWorkType(segments: WorkSegment[]): WorkTypeDistributionItem[] {
    const map = new Map<WorkType, number>()
    map.set('communication', 0)
    map.set('document', 0)
    map.set('development', 0)
    map.set('misc', 0)

    for (const segment of segments) {
      const workType = this.classifyWorkType(
        segment.appName,
        segment.processName,
        segment.windowTitle
      )
      map.set(workType, (map.get(workType) ?? 0) + segment.durationSeconds)
    }

    const total = [...map.values()].reduce((sum, s) => sum + s, 0)
    return [...map.entries()].map(([type, seconds]) => ({
      type,
      label: WORK_TYPE_LABELS[type],
      seconds,
      percentage: total > 0 ? Math.round((seconds / total) * 1000) / 10 : 0
    }))
  }

  /** 获取 Episodes 关联的所有 Segments */
  private getSegmentsForEpisodes(episodes: Episode[]): WorkSegment[] {
    const segmentIds: string[] = []
    for (const episode of episodes) {
      segmentIds.push(...episode.segmentIds)
    }
    if (segmentIds.length === 0) return []
    return SegmentRepository.getByIds(segmentIds)
  }

  /** 计算 Episode 时长（秒）：endTime - startTime */
  private computeEpisodeDuration(episode: Episode): number {
    const start = this.timeToSeconds(episode.startTime)
    const end = this.timeToSeconds(episode.endTime)
    const diff = end - start
    return diff > 0 ? diff : 0
  }

  /** 排序并截断（取 top 20） */
  private sortAndTruncate(items: TimeDistributionItem[]): TimeDistributionItem[] {
    return items
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 20)
  }

  /** 判断是否为浏览器 */
  private isBrowser(appName: string, processName: string): boolean {
    const combined = `${appName} ${processName}`.toLowerCase()
    return (
      combined.includes('chrome') ||
      combined.includes('edge') ||
      combined.includes('firefox') ||
      combined.includes('safari') ||
      combined.includes('opera') ||
      combined.includes('brave') ||
      combined.includes('browser')
    )
  }

  /** "HH:MM:SS" → 秒 */
  private timeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':')
    if (parts.length === 3) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10)
    }
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60
    }
    return 0
  }

  /** Date → YYYY-MM-DD */
  private formatDate(d: Date): string {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
}
