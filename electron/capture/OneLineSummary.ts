/**
 * OneLineSummary：今日一句话总结生成器
 *
 * 功能：
 *  - generateDailySummary(date)：读取该日期所有 Episodes，合成一句话总结
 *  - 规则：取耗时最长的 2-3 个 Episode 主题 + 动作词组合
 *  - 用户编辑保护：若该日期已有 user_edited 的每日总结 Episode，则不覆盖
 *  - setDailySummary(date, text)：用户手动改写，标记 user_edited=true
 *  - getDailySummary(date)：获取当前每日总结
 *
 * 每日总结存储：使用特殊的 Episode 记录，topics 包含 __daily_summary__ 标记，
 * segmentIds 为空。EpisodeBuilder 重建时保留此 Episode（不删除）。
 */
import { randomUUID } from 'node:crypto'
import type { Episode } from '@/types'
import { EpisodeRepository } from '../db/repositories/EpisodeRepository'
import { DAILY_SUMMARY_TOPIC } from './EpisodeBuilder'

/** 动作词映射（用于从 Episode title/summary 提取动作） */
const ACTION_PATTERNS: Array<{ pattern: RegExp; verb: string }> = [
  { pattern: /(编写|开发|实现|编码|coding|implement)/i, verb: '推进' },
  { pattern: /(确认|核对|验证|检查|review|check|verify)/i, verb: '确认' },
  { pattern: /(沟通|讨论|交流|会议|chat|discuss|meeting)/i, verb: '沟通' },
  { pattern: /(修改|更新|调整|优化|重构|fix|update|refactor)/i, verb: '完成' },
  { pattern: /(测试|调试|test|debug)/i, verb: '完成' },
  { pattern: /(部署|发布|上线|deploy|release)/i, verb: '完成' },
  { pattern: /(设计|规划|架构|design|plan)/i, verb: '推进' },
  { pattern: /(搜索|查询|检索|search|query)/i, verb: '进行' },
  { pattern: /(阅读|查看|浏览|read|view|browse)/i, verb: '查看' },
  { pattern: /(创建|新建|添加|create|add)/i, verb: '完成' }
]

/** 默认动作词 */
const DEFAULT_VERB = '推进'

/**
 * OneLineSummary：今日一句话总结生成器。
 */
export class OneLineSummary {
  /**
   * 生成每日总结。
   *
   * 规则：
   *  1. 若已有 user_edited 的每日总结 Episode，直接返回（不覆盖）
   *  2. 否则读取所有 Episodes，取耗时最长的 2-3 个，提取主题 + 动作词组合
   *  3. 合成一句话总结
   *  4. 存储为每日总结 Episode（若已存在非 user_edited 的则更新）
   */
  generateDailySummary(date: string): string {
    // 检查是否已有每日总结 Episode
    const existing = this.findDailySummaryEpisode(date)

    // 用户编辑保护：若 user_edited 则不覆盖
    if (existing && existing.userEdited) {
      return existing.oneLineSummary
    }

    // 读取所有 Episodes（排除每日总结本身）
    const allEpisodes = EpisodeRepository.getByDate(date)
    const episodes = allEpisodes.filter(e => !e.topics.includes(DAILY_SUMMARY_TOPIC))

    if (episodes.length === 0) {
      const summary = '今日暂无工作记录'
      this.upsertDailySummary(date, summary, false)
      return summary
    }

    // 按耗时排序（endTime - startTime 降序）
    const sorted = [...episodes].sort((a, b) => {
      return this.getDuration(b) - this.getDuration(a)
    })

    // 取耗时最长的 2-3 个
    const topCount = Math.min(sorted.length, sorted.length >= 3 ? 3 : 2)
    const topEpisodes = sorted.slice(0, topCount)

    // 合成一句话
    const summary = this.synthesizeSummary(topEpisodes)

    // 存储
    this.upsertDailySummary(date, summary, false)

    return summary
  }

  /**
   * 用户手动改写每日总结。
   * 标记 user_edited=true，此后自动更新永不覆盖。
   */
  setDailySummary(date: string, text: string): boolean {
    this.upsertDailySummary(date, text, true)
    return true
  }

  /**
   * 获取当前每日总结。
   * 若不存在则返回空字符串。
   */
  getDailySummary(date: string): string {
    const existing = this.findDailySummaryEpisode(date)
    return existing?.oneLineSummary ?? ''
  }

  // ===================== 内部方法 =====================

  /** 查找指定日期的每日总结 Episode */
  private findDailySummaryEpisode(date: string): Episode | null {
    const episodes = EpisodeRepository.getByDate(date)
    return episodes.find(e => e.topics.includes(DAILY_SUMMARY_TOPIC)) ?? null
  }

  /** 计算 Episode 耗时（秒） */
  private getDuration(episode: Episode): number {
    return timeToSeconds(episode.endTime) - timeToSeconds(episode.startTime)
  }

  /**
   * 合成一句话总结。
   * 取 top Episodes 的主题 + 动作词组合。
   */
  private synthesizeSummary(episodes: Episode[]): string {
    if (episodes.length === 0) return '今日暂无工作记录'

    const parts: string[] = []

    for (let i = 0; i < episodes.length; i++) {
      const episode = episodes[i]
      const topic = this.extractTopic(episode)
      const verb = this.extractActionVerb(episode)

      if (i === 0) {
        // 第一个：主要推进...
        parts.push(`主要${verb}${topic}`)
      } else if (i === episodes.length - 1) {
        // 最后一个：并完成...
        parts.push(`并${verb}${topic}`)
      } else {
        // 中间：同时...
        parts.push(`${verb}${topic}`)
      }
    }

    return `今日${parts.join('，')}。`
  }

  /** 从 Episode 提取主题 */
  private extractTopic(episode: Episode): string {
    // 优先使用 title 中的主题部分（去除 [项目名] 前缀）
    const titleMatch = episode.title.match(/^\[[^\]]+\]\s*(.+)$/)
    if (titleMatch) {
      return titleMatch[1]
    }

    // 使用 title 本身（去除应用名前缀）
    const appPrefixMatch = episode.title.match(/^[^-]+-\s*(.+)$/)
    if (appPrefixMatch) {
      return appPrefixMatch[1]
    }

    // 使用 top 关键词
    if (episode.topics.length > 0) {
      return episode.topics.slice(0, 3).join('')
    }

    return episode.title
  }

  /** 从 Episode 提取动作词 */
  private extractActionVerb(episode: Episode): string {
    const text = `${episode.title} ${episode.oneLineSummary}`

    for (const { pattern, verb } of ACTION_PATTERNS) {
      if (pattern.test(text)) {
        return verb
      }
    }

    return DEFAULT_VERB
  }

  /**
   * 插入或更新每日总结 Episode。
   * 若 userEdited=true，使用 update 设置 userEdited 标记。
   */
  private upsertDailySummary(date: string, summary: string, userEdited: boolean): void {
    const existing = this.findDailySummaryEpisode(date)

    if (existing) {
      // 更新现有每日总结
      EpisodeRepository.update(existing.id, {
        oneLineSummary: summary,
        userEdited,
        date,
        startTime: '00:00:00',
        endTime: '23:59:59'
      })
    } else {
      // 插入新的每日总结 Episode
      const dailyEpisode: Episode = {
        id: randomUUID(),
        date,
        startTime: '00:00:00',
        endTime: '23:59:59',
        title: `${date} 今日总结`,
        oneLineSummary: summary,
        segmentIds: [],
        entities: [],
        topics: [DAILY_SUMMARY_TOPIC],
        userEdited,
        reportEligible: false,
        wikiEligible: false
      }
      EpisodeRepository.insert(dailyEpisode)
    }
  }
}

/** 将 "HH:MM:SS" 时间字符串转为秒数 */
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
