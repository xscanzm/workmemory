/**
 * Task B4.1：日历 (Calendar) 页 — 统一 UI 组件库重构
 * - 顶部：月份切换（IconButton ChevronLeft/ChevronRight）+ SegmentedControl 月/周视图 + 回到今天 Button
 * - 月视图：7 列网格，Card 单元格 + Badge 事件数 + 生产力横条 + 日报状态标记
 * - 周视图：7 列大单元格，Card 列出该日 Episode 标题（最多 3 条 + 更多）
 * - 点击日期：右侧 ContextPanel 展示该日一句话故事 + 重点事件列表
 * - 数据：页面层聚合，用 episode:getByDate 逐日查询
 * - 加载态使用 Loader2 旋转图标
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useRecordingStore } from '@/store/recordingStore'
import {
  getMonthGrid,
  getWeekDates,
  formatDate,
  isSameDay,
  getEpisodeDuration,
  formatDuration,
  formatTimeRange,
  addDays
} from '@/utils/datetime'
import {
  Button,
  IconButton,
  Card,
  Badge,
  SegmentedControl,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Check
} from '@/ui'
import type { Episode } from '@/types'
import './Calendar.css'

/** 每日总结标记 topic（与 EpisodeBuilder.DAILY_SUMMARY_TOPIC 保持一致） */
const DAILY_SUMMARY_TOPIC = '__daily_summary__'

type ViewMode = 'month' | 'week'
type ProductivityLevel = 'none' | 'low' | 'medium' | 'high'

/** 单日聚合数据 */
interface DayAgg {
  date: Date
  dateStr: string
  /** 全部 Episode（含日报总结条目） */
  episodes: Episode[]
  /** 排除日报总结后的工作事件 */
  workEpisodes: Episode[]
  totalSeconds: number
  hasDailySummary: boolean
  dailySummaryText: string
  /** C4：该日是否已生成日报（reports 表联动） */
  hasReport: boolean
  productivity: ProductivityLevel
  isToday: boolean
  isCurrentMonth: boolean
}

/** 计算高产度等级：综合时长与事件数 */
function computeProductivity(totalSeconds: number, episodeCount: number): ProductivityLevel {
  if (totalSeconds <= 0 && episodeCount === 0) return 'none'
  const hours = totalSeconds / 3600
  if (hours >= 5 || episodeCount >= 7) return 'high'
  if (hours >= 2 || episodeCount >= 3) return 'medium'
  return 'low'
}

const WEEKDAY_HEADERS: string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const VIEW_OPTIONS = [
  { value: 'month', label: '月视图' },
  { value: 'week', label: '周视图' }
]

export function Calendar(): JSX.Element {
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)

  const todayDate = useMemo<Date>(() => new Date(), [])
  const [viewDate, setViewDate] = useState<Date>(
    new Date(todayDate.getFullYear(), todayDate.getMonth(), 1)
  )
  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null)
  const [dayAggs, setDayAggs] = useState<Map<string, DayAgg>>(new Map())
  const [loading, setLoading] = useState<boolean>(true)

  // 根据视图模式计算需要加载的日期
  const datesToLoad = useMemo<Date[]>(() => {
    if (viewMode === 'month') {
      return getMonthGrid(viewDate.getFullYear(), viewDate.getMonth())
    }
    return getWeekDates(viewDate)
  }, [viewDate, viewMode])

  // 批量加载所有可见日期的 Episode 数据 + 日报状态（C4.1/C4.4）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all(
      datesToLoad.map(
        async (date): Promise<DayAgg> => {
          const dateStr = formatDate(date)
          let episodes: Episode[] = []
          let reports: Array<{ id: string }> = []
          try {
            episodes = await window.workmemory.episode.getByDate(dateStr)
          } catch {
            episodes = []
          }
          // C4：查询该日是否已生成日报（reports 表联动）
          try {
            reports = await window.workmemory.report.getByDate(dateStr)
          } catch {
            reports = []
          }
          const dailySummaryEp = episodes.find((e) => e.topics.includes(DAILY_SUMMARY_TOPIC))
          const workEpisodes = episodes.filter((e) => !e.topics.includes(DAILY_SUMMARY_TOPIC))
          const totalSeconds = workEpisodes.reduce(
            (sum, e) => sum + getEpisodeDuration(e.startTime, e.endTime),
            0
          )
          return {
            date,
            dateStr,
            episodes,
            workEpisodes,
            totalSeconds,
            hasDailySummary: !!dailySummaryEp,
            dailySummaryText: dailySummaryEp?.oneLineSummary ?? '',
            hasReport: reports.length > 0,
            productivity: computeProductivity(totalSeconds, workEpisodes.length),
            isToday: isSameDay(date, todayDate),
            isCurrentMonth: date.getMonth() === viewDate.getMonth()
          }
        }
      )
    )
      .then((aggs) => {
        if (cancelled) return
        const map = new Map<string, DayAgg>()
        for (const agg of aggs) {
          map.set(agg.dateStr, agg)
        }
        setDayAggs(map)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datesToLoad, refreshTrigger])

  // 进入页面时清空右侧上下文
  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // 月份/周切换
  const handlePrev = useCallback((): void => {
    if (viewMode === 'month') {
      setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))
    } else {
      setViewDate(addDays(viewDate, -7))
    }
  }, [viewDate, viewMode])

  const handleNext = useCallback((): void => {
    if (viewMode === 'month') {
      setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))
    } else {
      setViewDate(addDays(viewDate, 7))
    }
  }, [viewDate, viewMode])

  const handleToday = useCallback((): void => {
    setViewDate(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1))
    setViewMode('month')
  }, [todayDate])

  const handleSelectDate = useCallback(
    (dateStr: string): void => {
      setSelectedDateStr(dateStr)
      const agg = dayAggs.get(dateStr)
      if (agg) {
        setContextItem({
          type: 'day',
          date: dateStr,
          summary: agg.dailySummaryText,
          episodes: agg.workEpisodes,
          hasReport: agg.hasReport
        })
      }
    },
    [dayAggs, setContextItem]
  )

  // 顶部标题
  const headerLabel = useMemo<string>(() => {
    if (viewMode === 'month') {
      return `${viewDate.getFullYear()}年${viewDate.getMonth() + 1}月`
    }
    const weekDates = getWeekDates(viewDate)
    const start = weekDates[0]
    const end = weekDates[6]
    if (start.getMonth() === end.getMonth()) {
      return `${start.getFullYear()}年${start.getMonth() + 1}月 ${start.getDate()} - ${end.getDate()}日`
    }
    return `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 - ${end.getMonth() + 1}月${end.getDate()}日`
  }, [viewDate, viewMode])

  // 月视图统计
  const monthStats = useMemo<{ totalDays: number; activeDays: number; totalHours: number }>(() => {
    let activeDays = 0
    let totalSeconds = 0
    let totalDays = 0
    for (const agg of dayAggs.values()) {
      if (!agg.isCurrentMonth) continue
      totalDays++
      if (agg.workEpisodes.length > 0) activeDays++
      totalSeconds += agg.totalSeconds
    }
    return { totalDays, activeDays, totalHours: totalSeconds / 3600 }
  }, [dayAggs])

  return (
    <div className="wm-cal">
      <header className="wm-cal-header">
        <div className="wm-cal-titles">
          <h1 className="wm-cal-title">日历</h1>
          <span className="wm-cal-subtitle">Calendar</span>
        </div>
        <div className="wm-cal-nav">
          <IconButton
            label="上一个"
            size="sm"
            variant="secondary"
            icon={<ChevronLeft size={16} />}
            onClick={handlePrev}
          />
          <span className="wm-cal-nav-label">{headerLabel}</span>
          <IconButton
            label="下一个"
            size="sm"
            variant="secondary"
            icon={<ChevronRight size={16} />}
            onClick={handleNext}
          />
          <Button size="sm" variant="secondary" onClick={handleToday}>
            回到今天
          </Button>
        </div>
      </header>

      <div className="wm-cal-toolbar">
        <SegmentedControl
          options={VIEW_OPTIONS}
          value={viewMode}
          onChange={(v) => setViewMode(v as ViewMode)}
          size="sm"
        />
        <div className="wm-cal-legend">
          <span className="wm-cal-legend-item">
            <span className="wm-cal-legend-bar wm-cal-legend-low" />
            <span>低产</span>
          </span>
          <span className="wm-cal-legend-item">
            <span className="wm-cal-legend-bar wm-cal-legend-medium" />
            <span>中产</span>
          </span>
          <span className="wm-cal-legend-item">
            <span className="wm-cal-legend-bar wm-cal-legend-high" />
            <span>高产</span>
          </span>
          <span className="wm-cal-legend-item">
            <Check size={12} className="wm-cal-legend-check" />
            <span>已生成日报</span>
          </span>
          {viewMode === 'month' && monthStats.activeDays > 0 && (
            <span className="wm-cal-legend-item wm-cal-legend-stat">
              本月 {monthStats.activeDays}/{monthStats.totalDays} 天有记录 · 共 {monthStats.totalHours.toFixed(1)}h
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="wm-cal-loading">
          <Loader2 size={16} className="wm-cal-loading-spinner" />
          <span>加载日历数据...</span>
        </div>
      ) : viewMode === 'month' ? (
        <MonthGrid
          dates={datesToLoad}
          dayAggs={dayAggs}
          selectedDateStr={selectedDateStr}
          onSelectDate={handleSelectDate}
        />
      ) : (
        <WeekGrid
          dates={datesToLoad}
          dayAggs={dayAggs}
          selectedDateStr={selectedDateStr}
          onSelectDate={handleSelectDate}
        />
      )}
    </div>
  )
}

// ===================== 月视图网格 =====================

interface MonthGridProps {
  dates: Date[]
  dayAggs: Map<string, DayAgg>
  selectedDateStr: string | null
  onSelectDate: (dateStr: string) => void
}

function MonthGrid({ dates, dayAggs, selectedDateStr, onSelectDate }: MonthGridProps): JSX.Element {
  return (
    <div className="wm-cal-month">
      <div className="wm-cal-month-header">
        {WEEKDAY_HEADERS.map((name) => (
          <div key={name} className="wm-cal-month-weekday">{name}</div>
        ))}
      </div>
      <div className="wm-cal-month-grid">
        {dates.map((date) => {
          const dateStr = formatDate(date)
          const agg = dayAggs.get(dateStr)
          const hasData = agg !== undefined && agg.workEpisodes.length > 0
          const isSelected = selectedDateStr === dateStr
          const classes = [
            'wm-cal-month-cell',
            agg?.isCurrentMonth ? '' : 'wm-cal-month-cell-outside',
            agg?.isToday ? 'wm-cal-month-cell-today' : '',
            isSelected ? 'wm-cal-month-cell-selected' : '',
            hasData ? '' : 'wm-cal-month-cell-empty'
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <Card
              key={dateStr}
              variant="solid"
              padding="sm"
              selected={isSelected}
              onClick={() => onSelectDate(dateStr)}
              className={classes}
            >
              <div
                className="wm-cal-month-cell-top"
                title={agg ? `${dateStr} · ${agg.workEpisodes.length} 个事件 · ${formatDuration(agg.totalSeconds)}${agg.hasReport ? ' · 已生成日报' : ''}` : dateStr}
              >
                <span className="wm-cal-month-daynum">{date.getDate()}</span>
                {agg?.hasReport ? (
                  <Check size={12} className="wm-cal-month-report" />
                ) : hasData ? (
                  <span className="wm-cal-month-report-dot" title="未生成日报" />
                ) : null}
              </div>
              {hasData && agg && (
                <>
                  <span className="wm-cal-month-duration">
                    {formatDuration(agg.totalSeconds)}
                  </span>
                  <Badge variant="cyan" size="sm">
                    {agg.workEpisodes.length} 个事件
                  </Badge>
                  <div className={`wm-cal-month-bar wm-cal-month-bar-${agg.productivity}`} />
                </>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}

// ===================== 周视图网格 =====================

interface WeekGridProps {
  dates: Date[]
  dayAggs: Map<string, DayAgg>
  selectedDateStr: string | null
  onSelectDate: (dateStr: string) => void
}

function WeekGrid({ dates, dayAggs, selectedDateStr, onSelectDate }: WeekGridProps): JSX.Element {
  return (
    <div className="wm-cal-week">
      <div className="wm-cal-week-header">
        {WEEKDAY_HEADERS.map((name, i) => {
          const date = dates[i]
          const dateStr = formatDate(date)
          const agg = dayAggs.get(dateStr)
          const isToday = agg?.isToday ?? false
          return (
            <div
              key={name}
              className={`wm-cal-week-header-cell ${isToday ? 'wm-cal-week-header-today' : ''}`}
            >
              <span className="wm-cal-week-weekday">{name}</span>
              <span className="wm-cal-week-daynum">{date.getDate()}</span>
              {agg && agg.workEpisodes.length > 0 && (
                <Badge variant="default" size="sm">
                  {formatDuration(agg.totalSeconds)}
                </Badge>
              )}
            </div>
          )
        })}
      </div>
      <div className="wm-cal-week-grid">
        {dates.map((date) => {
          const dateStr = formatDate(date)
          const agg = dayAggs.get(dateStr)
          const episodes = agg?.workEpisodes ?? []
          const isSelected = selectedDateStr === dateStr
          const visibleEpisodes = episodes.slice(0, 3)
          const moreCount = episodes.length - visibleEpisodes.length
          const classes = [
            'wm-cal-week-cell',
            agg?.isToday ? 'wm-cal-week-cell-today' : '',
            isSelected ? 'wm-cal-week-cell-selected' : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <Card
              key={dateStr}
              variant="solid"
              padding="sm"
              selected={isSelected}
              onClick={() => onSelectDate(dateStr)}
              className={classes}
            >
              {episodes.length === 0 ? (
                <div className="wm-cal-week-empty">
                  <span>无记录</span>
                </div>
              ) : (
                <div className="wm-cal-week-episodes">
                  {agg?.hasReport && (
                    <Badge variant="success" size="sm">已生成日报</Badge>
                  )}
                  {visibleEpisodes.map((ep) => (
                    <div key={ep.id} className="wm-cal-week-episode">
                      <span className="wm-cal-week-episode-time">
                        {formatTimeRange(ep.startTime, ep.endTime)}
                      </span>
                      <span className="wm-cal-week-episode-title">{ep.title}</span>
                      {ep.topics.length > 0 && (
                        <Badge variant="cyan" size="sm">
                          {ep.topics[0]}
                        </Badge>
                      )}
                    </div>
                  ))}
                  {moreCount > 0 && (
                    <div className="wm-cal-week-more">还有 {moreCount} 个事件...</div>
                  )}
                </div>
              )}
    </Card>
          )
        })}
      </div>
    </div>
  )
}
