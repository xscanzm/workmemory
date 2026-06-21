/**
 * Task B4.2：搜索 (Search) 页 — 统一 UI 组件库重构 + 命名诚实化
 * - 标题改为"记忆搜索"（原"搜索"），副标题"关键词 + 时间搜索"，诚实命名
 * - D2.4：OCR/标题/摘要维度改用 SQLite FTS5 全文索引（经 IPC search.fts）
 * - 匹配维度：OCR（FTS5）/ 项目 / 时间 / 人物（本地规则匹配）
 * - 结果列表：最佳匹配 Episode + 关联事件链 + 关联实体 + FTS5 命中片段
 * - 右侧 ContextPanel 高亮匹配原因（search-match 类型）
 * - 不依赖主进程语义搜索，FTS5 + 本地规则混合实现
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRecordingStore, type MatchReason } from '@/store/recordingStore'
import { EmptyState } from '@/components/EmptyState'
import {
  getRecentDates,
  parseDate,
  formatTimeRange,
  getEpisodeDuration,
  formatDuration,
  getDayOfWeekName,
  timeToSeconds
} from '@/utils/datetime'
import {
  Card,
  Badge,
  IconButton,
  Search as SearchIcon,
  X,
  Loader2,
  type BadgeVariant
} from '@/ui'
import type { CleanEpisode, Episode, WorkSegment } from '@/types'
import type { FtsSearchResult } from '../../electron/types/ipc'
import './Search.css'

/** 每日总结标记 topic */
const DAILY_SUMMARY_TOPIC = '__daily_summary__'

/** 搜索数据加载天数 */
const SEARCH_DAYS = 30

/** 搜索结果项 */
interface SearchHit {
  episode: Episode
  segments: WorkSegment[]
  reasons: MatchReason[]
  score: number
  /** FTS5 命中片段（OCR/标题/摘要），供卡片展示 */
  snippets: string[]
  cleanEpisode?: CleanEpisode
}

/** 时间匹配模式 */
interface TimePattern {
  matched: boolean
  label: string
  detail: string
  matchedTerms: string[]
  check: (episode: Episode) => boolean
}

// ===================== 分词工具 =====================

/**
 * 将查询字符串分词：
 * - 中文：双字滑窗（bigram）
 * - 英文：按空格/标点切分单词（≥2 字符）
 * - 数字：独立 token（用于日期/时间匹配）
 */
function tokenize(query: string): string[] {
  const terms: string[] = []
  // 中文双字滑窗
  const chineseChars = query.match(/[\u4e00-\u9fa5]/g)
  if (chineseChars) {
    const chineseText = chineseChars.join('')
    for (let i = 0; i < chineseText.length - 1; i++) {
      terms.push(chineseText.substring(i, i + 2))
    }
    if (chineseText.length === 1) {
      terms.push(chineseText)
    }
  }
  // 英文单词
  const englishWords = query.match(/[a-zA-Z]+/g)
  if (englishWords) {
    for (const word of englishWords) {
      if (word.length >= 2) terms.push(word.toLowerCase())
    }
  }
  // 数字 token
  const numbers = query.match(/\d+/g)
  if (numbers) {
    for (const num of numbers) {
      terms.push(num)
    }
  }
  return [...new Set(terms)]
}

// ===================== 时间模式识别 =====================

/** 识别查询中的时间模式 */
function detectTimePatterns(query: string): TimePattern[] {
  const patterns: TimePattern[] = []
  const lowerQuery = query.toLowerCase()

  // 时段：上午/早上/下午/晚上
  if (/上午|早上|早晨|清晨|morning/.test(lowerQuery)) {
    patterns.push({
      matched: false,
      label: '时段：上午',
      detail: '匹配 startTime 在 12:00 之前的事件',
      matchedTerms: ['上午'],
      check: (ep) => timeToSeconds(ep.startTime) < 12 * 3600
    })
  }
  if (/下午|午后|afternoon/.test(lowerQuery)) {
    patterns.push({
      matched: false,
      label: '时段：下午',
      detail: '匹配 startTime 在 12:00 - 18:00 之间的事件',
      matchedTerms: ['下午'],
      check: (ep) => {
        const s = timeToSeconds(ep.startTime)
        return s >= 12 * 3600 && s < 18 * 3600
      }
    })
  }
  if (/晚上|夜间|夜晚|evening|night/.test(lowerQuery)) {
    patterns.push({
      matched: false,
      label: '时段：晚上',
      detail: '匹配 startTime 在 18:00 之后的事件',
      matchedTerms: ['晚上'],
      check: (ep) => timeToSeconds(ep.startTime) >= 18 * 3600
    })
  }

  // 星期
  const weekdayMap: Array<{ regex: RegExp; day: number; label: string }> = [
    { regex: /周一|星期一/, day: 1, label: '周一' },
    { regex: /周二|星期二/, day: 2, label: '周二' },
    { regex: /周三|星期三/, day: 3, label: '周三' },
    { regex: /周四|星期四/, day: 4, label: '周四' },
    { regex: /周五|星期五/, day: 5, label: '周五' },
    { regex: /周六|星期六/, day: 6, label: '周六' },
    { regex: /周日|周天|星期日|星期天/, day: 0, label: '周日' }
  ]
  for (const wd of weekdayMap) {
    if (wd.regex.test(query)) {
      patterns.push({
        matched: false,
        label: `星期：${wd.label}`,
        detail: `匹配日期为 ${wd.label} 的事件`,
        matchedTerms: [wd.label],
        check: (ep) => parseDate(ep.date).getDay() === wd.day
      })
    }
  }

  // 具体日期：YYYY-MM-DD 或 M月D日 或 MMDD
  const fullDateMatch = query.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/)
  if (fullDateMatch) {
    const y = parseInt(fullDateMatch[1], 10)
    const m = parseInt(fullDateMatch[2], 10)
    const d = parseInt(fullDateMatch[3], 10)
    const target = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    patterns.push({
      matched: false,
      label: `日期：${target}`,
      detail: `匹配 ${y}年${m}月${d}日 的事件`,
      matchedTerms: [target],
      check: (ep) => ep.date === target
    })
  } else {
    const mdMatch = query.match(/(\d{1,2})月(\d{1,2})日?/)
    if (mdMatch) {
      const m = parseInt(mdMatch[1], 10)
      const d = parseInt(mdMatch[2], 10)
      const today = new Date()
      const target = `${today.getFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      patterns.push({
        matched: false,
        label: `日期：${m}月${d}日`,
        detail: `匹配 ${today.getFullYear()}年${m}月${d}日 的事件`,
        matchedTerms: [`${m}月${d}日`],
        check: (ep) => ep.date === target
      })
    }
  }

  return patterns
}

// ===================== 匹配核心 =====================

interface MatchContext {
  terms: string[]
  timePatterns: TimePattern[]
  /** FTS5 段落匹配：segmentId → snippet（OCR/窗口标题命中） */
  segmentSnippets: Map<string, string>
  /** FTS5 事件匹配：episodeId → snippet（标题/摘要命中） */
  episodeSnippets: Map<string, string>
  cleanEpisodeSnippets: Map<string, string>
  /** FTS5 是否有任意匹配（用于决定是否回退本地 OCR 匹配） */
  ftsHasMatches: boolean
}

/** 对单个 Episode 执行匹配，返回匹配原因列表与得分 */
function matchEpisode(
  episode: Episode,
  segments: WorkSegment[],
  ctx: MatchContext
): { reasons: MatchReason[]; score: number; snippets: string[] } {
  const reasons: MatchReason[] = []
  const snippets: string[] = []
  let score = 0

  // ---- OCR 维度（FTS5 优先，无匹配时回退本地关键词匹配）----
  if (ctx.ftsHasMatches) {
    // FTS5 模式：检查 episode 的 segments 是否命中 fts_segments，或 episode 自身命中 fts_episodes
    const matchedSegSnippets: string[] = []
    for (const seg of segments) {
      const snippet = ctx.segmentSnippets.get(seg.id)
      if (snippet) {
        matchedSegSnippets.push(snippet)
      }
    }
    const epSnippet = ctx.episodeSnippets.get(episode.id)
    if (epSnippet) {
      matchedSegSnippets.push(epSnippet)
    }
    if (matchedSegSnippets.length > 0) {
      reasons.push({
        dimension: 'ocr',
        label: 'OCR/标题匹配',
        detail: `FTS5 全文索引命中 ${matchedSegSnippets.length} 处文本片段`,
        matchedTerms: ctx.terms.slice(0, 8)
      })
      score += matchedSegSnippets.length * 3
      snippets.push(...matchedSegSnippets.slice(0, 3))
    }
  } else if (ctx.terms.length > 0) {
    // 回退：FTS5 无匹配时使用本地关键词匹配（OCR 文本 + 窗口标题）
    const ocrMatchedTerms: string[] = []
    const ocrTexts: string[] = []
    for (const seg of segments) {
      if (seg.ocrText) ocrTexts.push(seg.ocrText)
      if (seg.ocrSummary) ocrTexts.push(seg.ocrSummary)
      if (seg.windowTitle) ocrTexts.push(seg.windowTitle)
    }
    ocrTexts.push(episode.title, episode.oneLineSummary)
    const combinedOcr = ocrTexts.join(' ').toLowerCase()
    for (const term of ctx.terms) {
      if (combinedOcr.includes(term.toLowerCase())) {
        ocrMatchedTerms.push(term)
      }
    }
    if (ocrMatchedTerms.length > 0) {
      reasons.push({
        dimension: 'ocr',
        label: 'OCR 文本匹配',
        detail: `在 ${segments.length} 个片段的 OCR 文本/窗口标题中命中关键词`,
        matchedTerms: ocrMatchedTerms.slice(0, 8)
      })
      score += ocrMatchedTerms.length * 3
    }
  }

  // ---- 项目维度 ----
  if (ctx.terms.length > 0) {
    const projectMatchedTerms: string[] = []
    const projectTexts: string[] = []
    for (const topic of episode.topics) {
      projectTexts.push(topic)
    }
    for (const entity of episode.entities) {
      if (entity.type === 'project' || entity.type === 'document') {
        projectTexts.push(entity.name)
        if (entity.value) projectTexts.push(entity.value)
      }
    }
    const combinedProject = projectTexts.join(' ').toLowerCase()
    for (const term of ctx.terms) {
      if (combinedProject.includes(term.toLowerCase())) {
        projectMatchedTerms.push(term)
      }
    }
    if (projectMatchedTerms.length > 0) {
      reasons.push({
        dimension: 'project',
        label: '项目/主题匹配',
        detail: `在 Episode 的 topics 标签或项目实体中命中关键词`,
        matchedTerms: projectMatchedTerms.slice(0, 8)
      })
      score += projectMatchedTerms.length * 4
    }
  }

  // ---- 人物维度 ----
  if (ctx.terms.length > 0) {
    const personMatchedTerms: string[] = []
    const personTexts: string[] = []
    for (const entity of episode.entities) {
      if (entity.type === 'person') {
        personTexts.push(entity.name)
        if (entity.value) personTexts.push(entity.value)
      }
    }
    const combinedPerson = personTexts.join(' ').toLowerCase()
    for (const term of ctx.terms) {
      if (combinedPerson.includes(term.toLowerCase())) {
        personMatchedTerms.push(term)
      }
    }
    if (personMatchedTerms.length > 0) {
      reasons.push({
        dimension: 'person',
        label: '联系人匹配',
        detail: `在 Episode 关联的人物实体中命中关键词`,
        matchedTerms: personMatchedTerms.slice(0, 8)
      })
      score += personMatchedTerms.length * 5
    }
  }

  // ---- 时间维度 ----
  if (ctx.timePatterns.length > 0) {
    const timeMatchedTerms: string[] = []
    const matchedLabels: string[] = []
    for (const pattern of ctx.timePatterns) {
      if (pattern.check(episode)) {
        pattern.matched = true
        timeMatchedTerms.push(...pattern.matchedTerms)
        matchedLabels.push(pattern.label)
      }
    }
    if (matchedLabels.length > 0) {
      reasons.push({
        dimension: 'time',
        label: '时间匹配',
        detail: matchedLabels.join('、'),
        matchedTerms: [...new Set(timeMatchedTerms)]
      })
      score += matchedLabels.length * 6
    }
  }

  return { reasons, score, snippets }
}

// ===================== 维度映射 =====================

const DIMENSION_LABELS: Record<MatchReason['dimension'], string> = {
  ocr: 'OCR',
  project: '项目',
  time: '时间',
  person: '人物'
}

/** 匹配维度 → Badge 颜色变体 */
const DIMENSION_BADGE_VARIANT: Record<MatchReason['dimension'], BadgeVariant> = {
  ocr: 'accent',
  project: 'success',
  time: 'warning',
  person: 'privacy'
}

/** 实体类型 → Badge 颜色变体 */
const ENTITY_BADGE_VARIANT: Record<string, BadgeVariant> = {
  person: 'accent',
  project: 'success',
  document: 'warning',
  url: 'default'
}

// ===================== 主组件 =====================

export function Search(): JSX.Element {
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)

  const [query, setQuery] = useState<string>('')
  const [debouncedQuery, setDebouncedQuery] = useState<string>('')
  const [allEpisodes, setAllEpisodes] = useState<Episode[]>([])
  const [allCleanEpisodes, setAllCleanEpisodes] = useState<CleanEpisode[]>([])
  const [allSegments, setAllSegments] = useState<WorkSegment[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [hasSearched, setHasSearched] = useState<boolean>(false)
  /** FTS5 全文搜索结果（异步获取） */
  const [ftsResult, setFtsResult] = useState<FtsSearchResult | null>(null)

  // 加载最近 SEARCH_DAYS 天的数据
  const dates = useMemo<string[]>(() => getRecentDates(SEARCH_DAYS), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      Promise.all(dates.map((d) => window.workmemory.episode.getByDate(d).catch(() => [] as Episode[]))),
      Promise.all(dates.map((d) => window.workmemory.cleanEpisode.getByDate(d).catch(() => [] as CleanEpisode[]))),
      Promise.all(dates.map((d) => window.workmemory.segment.getActiveByDate(d).catch(() => [] as WorkSegment[])))
    ])
      .then(([episodeResults, cleanResults, segmentResults]) => {
        if (cancelled) return
        const eps: Episode[] = []
        for (const list of episodeResults) {
          for (const ep of list) {
            if (!ep.topics.includes(DAILY_SUMMARY_TOPIC)) {
              eps.push(ep)
            }
          }
        }
        const segs: WorkSegment[] = []
        for (const list of segmentResults) {
          for (const seg of list) {
            segs.push(seg)
          }
        }
        setAllEpisodes(eps)
        setAllCleanEpisodes(cleanResults.flat())
        setAllSegments(segs)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates, refreshTrigger])

  // 清空右侧上下文
  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // 防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim())
      setHasSearched(query.trim().length > 0)
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  // FTS5 全文搜索（异步，debouncedQuery 变化时触发）
  useEffect(() => {
    if (!debouncedQuery) {
      setFtsResult(null)
      return
    }
    let cancelled = false
    window.workmemory.search
      .fts(debouncedQuery)
      .then((result) => {
        if (!cancelled) setFtsResult(result)
      })
      .catch((e) => {
        if (!cancelled) {
          console.error('[Search] FTS5 搜索失败，回退本地匹配:', e instanceof Error ? e.message : String(e))
          setFtsResult(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [debouncedQuery])

  // segment 映射
  const segmentMap = useMemo<Map<string, WorkSegment>>(() => {
    return new Map(allSegments.map((s) => [s.id, s]))
  }, [allSegments])

  // FTS5 匹配映射：segmentId → snippet, episodeId → snippet
  const ftsMaps = useMemo<{
    segmentSnippets: Map<string, string>
    episodeSnippets: Map<string, string>
    cleanEpisodeSnippets: Map<string, string>
    ftsHasMatches: boolean
  }>(() => {
    const segmentSnippets = new Map<string, string>()
    const episodeSnippets = new Map<string, string>()
    const cleanEpisodeSnippets = new Map<string, string>()
    if (ftsResult) {
      for (const clean of ftsResult.cleanEpisodes ?? []) {
        cleanEpisodeSnippets.set(clean.cleanEpisodeId, clean.snippet)
      }
      for (const seg of ftsResult.segments) {
        segmentSnippets.set(seg.segmentId, seg.snippet)
      }
      for (const ep of ftsResult.episodes) {
        episodeSnippets.set(ep.episodeId, ep.snippet)
      }
    }
    return {
      segmentSnippets,
      episodeSnippets,
      cleanEpisodeSnippets,
      ftsHasMatches: segmentSnippets.size > 0 || episodeSnippets.size > 0
        || cleanEpisodeSnippets.size > 0
    }
  }, [ftsResult])

  // 执行搜索
  const searchResults = useMemo<SearchHit[]>(() => {
    if (!debouncedQuery) return []
    const terms = tokenize(debouncedQuery)
    const timePatterns = detectTimePatterns(debouncedQuery)
    if (terms.length === 0 && timePatterns.length === 0) return []
    const ctx: MatchContext = {
      terms,
      timePatterns,
      segmentSnippets: ftsMaps.segmentSnippets,
      episodeSnippets: ftsMaps.episodeSnippets,
      cleanEpisodeSnippets: ftsMaps.cleanEpisodeSnippets,
      ftsHasMatches: ftsMaps.ftsHasMatches
    }

    const hits: SearchHit[] = []
    for (const cleanEpisode of allCleanEpisodes) {
      const epSegments = cleanEpisode.segmentIds
        .map((id) => segmentMap.get(id))
        .filter((s): s is WorkSegment => s !== undefined)
      const syntheticEpisode: Episode = {
        id: cleanEpisode.id,
        date: cleanEpisode.date,
        startTime: cleanEpisode.startTime,
        endTime: cleanEpisode.endTime,
        title: cleanEpisode.title,
        oneLineSummary: cleanEpisode.summary,
        segmentIds: cleanEpisode.segmentIds,
        entities: cleanEpisode.entities,
        topics: cleanEpisode.topics,
        userEdited: false,
        reportEligible: cleanEpisode.reportEligible,
        wikiEligible: cleanEpisode.wikiEligible
      }
      const cleanSnippet = ctx.cleanEpisodeSnippets.get(cleanEpisode.id)
      const { reasons, score, snippets } = matchEpisode(syntheticEpisode, epSegments, ctx)
      if (cleanSnippet && !snippets.includes(cleanSnippet)) {
        reasons.push({
          dimension: 'ocr',
          label: '工作记忆匹配',
          detail: '命中小时级理解后的工作记忆事件',
          matchedTerms: terms.slice(0, 8)
        })
        snippets.unshift(cleanSnippet)
      }
      const finalScore = score + (cleanSnippet ? 12 : 8)
      if (reasons.length > 0 && finalScore > 0) {
        hits.push({ episode: syntheticEpisode, segments: epSegments, reasons, score: finalScore, snippets, cleanEpisode })
      }
    }
    for (const episode of allEpisodes) {
      if (allCleanEpisodes.some((clean) => clean.segmentIds.some((id) => episode.segmentIds.includes(id)))) {
        continue
      }
      const epSegments = episode.segmentIds
        .map((id) => segmentMap.get(id))
        .filter((s): s is WorkSegment => s !== undefined)
      const { reasons, score, snippets } = matchEpisode(episode, epSegments, ctx)
      if (reasons.length > 0 && score > 0) {
        hits.push({ episode, segments: epSegments, reasons, score, snippets })
      }
    }
    hits.sort((a, b) => b.score - a.score)
    return hits
  }, [debouncedQuery, allEpisodes, allCleanEpisodes, segmentMap, ftsMaps])

  // 关联实体聚合
  const relatedEntities = useMemo<{ name: string; type: string; count: number }[]>(() => {
    const entityCount = new Map<string, { name: string; type: string; count: number }>()
    for (const hit of searchResults) {
      for (const entity of hit.episode.entities) {
        const key = `${entity.type}:${entity.name}`
        const existing = entityCount.get(key)
        if (existing) {
          existing.count++
        } else {
          entityCount.set(key, { name: entity.name, type: entity.type, count: 1 })
        }
      }
    }
    return [...entityCount.values()].sort((a, b) => b.count - a.count).slice(0, 12)
  }, [searchResults])

  // 维度统计
  const dimensionStats = useMemo<{ dimension: MatchReason['dimension']; count: number }[]>(() => {
    const counts: Record<MatchReason['dimension'], number> = { ocr: 0, project: 0, time: 0, person: 0 }
    for (const hit of searchResults) {
      const seen = new Set<MatchReason['dimension']>()
      for (const reason of hit.reasons) {
        if (!seen.has(reason.dimension)) {
          counts[reason.dimension]++
          seen.add(reason.dimension)
        }
      }
    }
    return (Object.entries(counts) as Array<[MatchReason['dimension'], number]>)
      .map(([dimension, count]) => ({ dimension, count }))
      .filter((d) => d.count > 0)
  }, [searchResults])

  const handleSelectHit = useCallback(
    (hit: SearchHit): void => {
      setContextItem({
        type: 'search-match',
        reasons: hit.reasons,
        episode: hit.episode
      })
    },
    [setContextItem]
  )

  const handleClear = useCallback((): void => {
    setQuery('')
    setDebouncedQuery('')
    setHasSearched(false)
    setContextItem(null)
  }, [setContextItem])

  return (
    <div className="wm-search">
      <header className="wm-search-header">
        <div className="wm-search-titles">
          <h1 className="wm-search-title">记忆搜索</h1>
          <span className="wm-search-subtitle">关键词 + 时间搜索</span>
        </div>
        <span className="wm-search-meta">
          索引最近 {SEARCH_DAYS} 天 · {allCleanEpisodes.length || allEpisodes.length} 个事件
        </span>
      </header>

      <div className="wm-search-input-wrap">
        <SearchIcon size={18} className="wm-search-input-icon" />
        <input
          className="wm-search-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="记忆搜索：项目名、人名、关键词、上午/下午/周X..."
          autoFocus
        />
        {query && (
          <IconButton
            label="清空"
            size="sm"
            variant="ghost"
            icon={<X size={14} />}
            onClick={handleClear}
          />
        )}
      </div>

      {loading ? (
        <div className="wm-search-loading">
          <Loader2 size={16} className="wm-search-loading-spinner" />
          <span>正在索引工作记忆...</span>
        </div>
      ) : !hasSearched ? (
        <Card variant="acrylic" padding="md" className="wm-search-hint-card">
          <EmptyState
            title="输入关键词开始搜索"
            description="支持中文双字分词与英文单词匹配，可按 OCR 文本、项目主题、联系人、时段（上午/下午/周X）多维度检索。"
          />
          <div className="wm-search-suggestions">
            <span className="wm-search-suggestions-label">试试搜索：</span>
            {['上午的会议', '项目讨论', '文档编写', '周一的工作', '下午的开发'].map((s) => (
              <button
                key={s}
                className="wm-search-suggestion-chip"
                onClick={() => setQuery(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </Card>
      ) : searchResults.length === 0 ? (
        <Card variant="acrylic" padding="md" className="wm-search-empty-card">
          <EmptyState
            title={`未找到与 "${debouncedQuery}" 相关的结果`}
            description="尝试更换关键词，或缩短查询语句。搜索覆盖最近 30 天的 OCR 文本、项目主题、联系人与时间维度。"
          />
        </Card>
      ) : (
        <div className="wm-search-results">
          <div className="wm-search-stats">
            <span className="wm-search-stats-count">
              找到 <strong>{searchResults.length}</strong> 个匹配事件
            </span>
            <div className="wm-search-stats-dims">
              {dimensionStats.map((d) => (
                <Badge key={d.dimension} variant={DIMENSION_BADGE_VARIANT[d.dimension]} size="sm">
                  {DIMENSION_LABELS[d.dimension]} · {d.count}
                </Badge>
              ))}
            </div>
          </div>

          {relatedEntities.length > 0 && (
            <Card variant="acrylic" padding="md" className="wm-search-entities-card">
              <span className="wm-search-entities-title">关联实体</span>
              <div className="wm-search-entities-list">
                {relatedEntities.map((entity) => (
                  <Badge
                    key={`${entity.type}-${entity.name}`}
                    variant={ENTITY_BADGE_VARIANT[entity.type] ?? 'default'}
                    size="sm"
                    className="wm-search-entity"
                  >
                    {entity.name}
                    <span className="wm-search-entity-count">{entity.count}</span>
                  </Badge>
                ))}
              </div>
            </Card>
          )}

          <div className="wm-search-hits">
            {searchResults.map((hit, idx) => (
              <SearchHitCard
                key={hit.episode.id}
                hit={hit}
                rank={idx + 1}
                onClick={() => handleSelectHit(hit)}
              />
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

// ===================== 搜索结果卡片 =====================

interface SearchHitCardProps {
  hit: SearchHit
  rank: number
  onClick: () => void
}

function SearchHitCard({ hit, rank, onClick }: SearchHitCardProps): JSX.Element {
  const { episode, reasons, score } = hit
  const duration = getEpisodeDuration(episode.startTime, episode.endTime)
  const dateObj = parseDate(episode.date)

  return (
    <Card
      variant="acrylic"
      padding="md"
      onClick={onClick}
      className="wm-search-hit"
    >
      <div className={`wm-search-hit-rank ${rank === 1 ? 'wm-search-hit-rank-top' : ''}`}>
        {rank}
      </div>
      <div className="wm-search-hit-body">
        <div className="wm-search-hit-header">
          <span className="wm-search-hit-date">
            {episode.date} {getDayOfWeekName(dateObj)}
          </span>
          <span className="wm-search-hit-time">
            {formatTimeRange(episode.startTime, episode.endTime)} · {formatDuration(duration)}
          </span>
          <Badge variant="privacy" size="sm" className="wm-search-hit-score">
            相关度 {score}
          </Badge>
        </div>
        <h3 className="wm-search-hit-title">{episode.title}</h3>
        {hit.cleanEpisode && <Badge variant="success" size="sm">工作记忆事件</Badge>}
        <p className="wm-search-hit-summary">{episode.oneLineSummary}</p>
        <div className="wm-search-hit-reasons">
          {reasons.map((reason, i) => (
            <Badge
              key={i}
              variant={DIMENSION_BADGE_VARIANT[reason.dimension]}
              size="sm"
              className="wm-search-hit-reason"
            >
              {reason.label}
              {reason.matchedTerms.length > 0 && (
                <span className="wm-search-hit-reason-terms">
                  {reason.matchedTerms.slice(0, 3).map((t) => (
                    <span key={t} className="wm-search-hit-reason-term">{t}</span>
                  ))}
                </span>
              )}
            </Badge>
          ))}
        </div>
        {episode.topics.length > 0 && (
          <div className="wm-search-hit-topics">
            {episode.topics.slice(0, 4).map((topic) => (
              <Badge key={topic} variant="cyan" size="sm">{topic}</Badge>
            ))}
          </div>
        )}
        {hit.snippets.length > 0 && (
          <div className="wm-search-hit-snippets">
            {hit.snippets.map((snippet, i) => (
              <SnippetPreview key={i} snippet={snippet} />
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

// ===================== FTS5 片段预览 =====================

/**
 * 渲染 FTS5 snippet() 返回的文本片段：
 * - «匹配词» 标记内的高亮显示
 * - 其余文本正常渲染
 */
function SnippetPreview({ snippet }: { snippet: string }): JSX.Element {
  const parts: Array<{ text: string; match: boolean }> = []
  const regex = /«([^»]*)»/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(snippet)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ text: snippet.slice(lastIndex, m.index), match: false })
    }
    parts.push({ text: m[1], match: true })
    lastIndex = regex.lastIndex
  }
  if (lastIndex < snippet.length) {
    parts.push({ text: snippet.slice(lastIndex), match: false })
  }
  return (
    <p className="wm-search-hit-snippet">
      {parts.map((part, i) =>
        part.match ? (
          <mark key={i} className="wm-search-hit-snippet-mark">{part.text}</mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </p>
  )
}
