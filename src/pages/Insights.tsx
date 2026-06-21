/**
 * Task B4.1：洞察 (Insights) 页 — 统一 UI 组件库重构
 * - 纯 SVG/CSS 图表（不使用第三方图表库）
 * - 项目 / 联系人 / 工作类型时间分布
 * - 每日工作时长趋势（折线图）
 * - 异常洞察：窗口切换次数、碎片化分析、深度工作时长
 * - 数据：页面层聚合最近 7 天的 Episode + Segment
 */
import { useState, useEffect, useMemo } from 'react'
import { useRecordingStore } from '@/store/recordingStore'
import { EmptyState } from '@/components/EmptyState'
import {
  getRecentDates,
  parseDate,
  getEpisodeDuration,
  formatDuration,
  getDayOfWeekName
} from '@/utils/datetime'
import {
  classifyWorkType,
  getWorkTypeLabel,
  getWorkTypeColor,
  type WorkType
} from '@/utils/workType'
import { filterHighConfidenceEntities } from '@/utils/entity'
import {
  Card,
  Loader2,
  RefreshCw,
  MoreHorizontal,
  Sparkles,
  Clock
} from '@/ui'
import type { Episode, WorkSegment } from '@/types'
import './Insights.css'

/** 每日总结标记 topic */
const DAILY_SUMMARY_TOPIC = '__daily_summary__'

/** 洞察分析天数 */
const INSIGHT_DAYS = 7

/** 短事件阈值（秒）：低于此值为碎片化 */
const FRAGMENT_THRESHOLD = 300 // 5 分钟

/** 深度工作阈值（秒）：高于此值为深度工作 */
const DEEP_WORK_THRESHOLD = 1500 // 25 分钟

// ===================== 数据类型 =====================

interface DailyStat {
  date: string
  totalSeconds: number
  episodeCount: number
  segmentCount: number
}

interface ProjectStat {
  name: string
  totalSeconds: number
  episodeCount: number
}

interface ContactStat {
  name: string
  totalSeconds: number
  episodeCount: number
}

interface WorkTypeStat {
  type: WorkType
  totalSeconds: number
  segmentCount: number
}

type MetricLevel = 'good' | 'warning' | 'danger'

interface InsightMetric {
  level: MetricLevel
  title: string
  value: string
  description: string
  icon: JSX.Element
}

type OverviewVariant = 'warning' | 'accent' | 'cyan' | 'success'

// ===================== 主组件 =====================

export function Insights(): JSX.Element {
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)

  const [allEpisodes, setAllEpisodes] = useState<Episode[]>([])
  const [allSegments, setAllSegments] = useState<WorkSegment[]>([])
  const [loading, setLoading] = useState<boolean>(true)

  const dates = useMemo<string[]>(() => getRecentDates(INSIGHT_DAYS), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      Promise.all(dates.map((d) => window.workmemory.episode.getByDate(d).catch(() => [] as Episode[]))),
      Promise.all(dates.map((d) => window.workmemory.segment.getActiveByDate(d).catch(() => [] as WorkSegment[])))
    ])
      .then(([episodeResults, segmentResults]) => {
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

  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // segment 映射
  const segmentMap = useMemo<Map<string, WorkSegment>>(() => {
    return new Map(allSegments.map((s) => [s.id, s]))
  }, [allSegments])

  // 每日统计
  const dailyStats = useMemo<DailyStat[]>(() => {
    return dates.map((date) => {
      const dayEpisodes = allEpisodes.filter((e) => e.date === date)
      const daySegments = allSegments.filter((s) => s.date === date)
      const totalSeconds = dayEpisodes.reduce(
        (sum, e) => sum + getEpisodeDuration(e.startTime, e.endTime),
        0
      )
      return {
        date,
        totalSeconds,
        episodeCount: dayEpisodes.length,
        segmentCount: daySegments.length
      }
    })
  }, [dates, allEpisodes, allSegments])

  // 项目时间分布（低置信实体不进入统计）
  const projectStats = useMemo<ProjectStat[]>(() => {
    const projectMap = new Map<string, ProjectStat>()
    for (const ep of allEpisodes) {
      const duration = getEpisodeDuration(ep.startTime, ep.endTime)
      const projects = filterHighConfidenceEntities(ep.entities)
        .filter((e) => e.type === 'project')
        .map((e) => e.name)
      const targets = projects.length > 0 ? projects : ['未分类']
      for (const name of targets) {
        const existing = projectMap.get(name)
        if (existing) {
          existing.totalSeconds += duration
          existing.episodeCount++
        } else {
          projectMap.set(name, { name, totalSeconds: duration, episodeCount: 1 })
        }
      }
    }
    return [...projectMap.values()].sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 6)
  }, [allEpisodes])

  // 联系人时间分布（低置信实体不进入统计）
  const contactStats = useMemo<ContactStat[]>(() => {
    const contactMap = new Map<string, ContactStat>()
    for (const ep of allEpisodes) {
      const duration = getEpisodeDuration(ep.startTime, ep.endTime)
      const persons = filterHighConfidenceEntities(ep.entities)
        .filter((e) => e.type === 'person')
        .map((e) => e.name)
      for (const name of persons) {
        const existing = contactMap.get(name)
        if (existing) {
          existing.totalSeconds += duration
          existing.episodeCount++
        } else {
          contactMap.set(name, { name, totalSeconds: duration, episodeCount: 1 })
        }
      }
    }
    return [...contactMap.values()].sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 6)
  }, [allEpisodes])

  // 工作类型分布（基于 segment）
  const workTypeStats = useMemo<WorkTypeStat[]>(() => {
    const typeMap = new Map<WorkType, WorkTypeStat>()
    for (const seg of allSegments) {
      const type = classifyWorkType(seg.appName, seg.processName)
      const existing = typeMap.get(type)
      if (existing) {
        existing.totalSeconds += seg.durationSeconds
        existing.segmentCount++
      } else {
        typeMap.set(type, { type, totalSeconds: seg.durationSeconds, segmentCount: 1 })
      }
    }
    const order: WorkType[] = ['development', 'communication', 'document', 'misc']
    return order
      .map((t) => typeMap.get(t))
      .filter((s): s is WorkTypeStat => s !== undefined)
  }, [allSegments])

  // 异常洞察指标
  const insights = useMemo<InsightMetric[]>(() => {
    const metrics: InsightMetric[] = []
    const totalEpisodes = allEpisodes.length
    const totalSegments = allSegments.length
    const totalSeconds = allEpisodes.reduce(
      (sum, e) => sum + getEpisodeDuration(e.startTime, e.endTime),
      0
    )

    // 1. 窗口切换次数
    const avgSegmentsPerEpisode = totalEpisodes > 0 ? totalSegments / totalEpisodes : 0
    const switchLevel: MetricLevel =
      avgSegmentsPerEpisode > 6 ? 'danger' : avgSegmentsPerEpisode > 4 ? 'warning' : 'good'
    metrics.push({
      level: switchLevel,
      title: '窗口切换频率',
      value: `${totalSegments} 次 / 均 ${avgSegmentsPerEpisode.toFixed(1)} 次/事件`,
      description:
        avgSegmentsPerEpisode > 6
          ? '窗口切换过于频繁，注意力可能被打散。建议合并同类任务，减少应用切换。'
          : avgSegmentsPerEpisode > 4
            ? '窗口切换略多，可尝试在单一应用中完成更多任务。'
            : '窗口切换频率健康，保持了较好的专注度。',
      icon: <RefreshCw size={20} />
    })

    // 2. 碎片化分析
    const fragmentEpisodes = allEpisodes.filter(
      (e) => getEpisodeDuration(e.startTime, e.endTime) < FRAGMENT_THRESHOLD
    )
    const fragmentRatio = totalEpisodes > 0 ? fragmentEpisodes.length / totalEpisodes : 0
    const fragmentLevel: MetricLevel =
      fragmentRatio > 0.4 ? 'danger' : fragmentRatio > 0.25 ? 'warning' : 'good'
    metrics.push({
      level: fragmentLevel,
      title: '碎片化事件',
      value: `${fragmentEpisodes.length} 个短事件（< 5 分钟）`,
      description:
        fragmentRatio > 0.4
          ? '碎片化严重，大量短事件说明工作被打断频繁。建议预留整块时间处理核心任务。'
          : fragmentRatio > 0.25
            ? '存在一定碎片化，可考虑合并相邻的短事件。'
            : '事件粒度合理，工作节奏较为连贯。',
      icon: <MoreHorizontal size={20} />
    })

    // 3. 深度工作时长
    const deepWorkEpisodes = allEpisodes.filter((e) => {
      const duration = getEpisodeDuration(e.startTime, e.endTime)
      if (duration < DEEP_WORK_THRESHOLD) return false
      const epSegments = e.segmentIds
        .map((id) => segmentMap.get(id))
        .filter((s): s is WorkSegment => s !== undefined)
      const uniqueApps = new Set(epSegments.map((s) => s.appName)).size
      return uniqueApps <= 2
    })
    const deepWorkSeconds = deepWorkEpisodes.reduce(
      (sum, e) => sum + getEpisodeDuration(e.startTime, e.endTime),
      0
    )
    const deepWorkRatio = totalSeconds > 0 ? deepWorkSeconds / totalSeconds : 0
    const deepLevel: MetricLevel =
      deepWorkRatio > 0.4 ? 'good' : deepWorkRatio > 0.2 ? 'warning' : 'danger'
    metrics.push({
      level: deepLevel,
      title: '深度工作时长',
      value: `${formatDuration(deepWorkSeconds)} · ${deepWorkEpisodes.length} 个深度时段`,
      description:
        deepWorkRatio > 0.4
          ? '深度工作占比优秀，保持了高质量的不被打断的工作时段。'
          : deepWorkRatio > 0.2
            ? '深度工作占比一般，可尝试增加 25 分钟以上的专注时段。'
            : '深度工作时长不足，建议每天预留至少 2 个 25 分钟以上的专注时段。',
      icon: <Sparkles size={20} />
    })

    // 4. 总工作时长
    const avgDailySeconds = totalSeconds / INSIGHT_DAYS
    const totalLevel: MetricLevel =
      avgDailySeconds > 6 * 3600 ? 'warning' : avgDailySeconds > 3 * 3600 ? 'good' : 'warning'
    metrics.push({
      level: totalLevel,
      title: '日均工作时长',
      value: `${formatDuration(avgDailySeconds)} / 天`,
      description:
        avgDailySeconds > 6 * 3600
          ? '工作时长偏长，注意劳逸结合，避免过度疲劳。'
          : avgDailySeconds > 3 * 3600
            ? '工作时长适中，保持了健康的工作节奏。'
            : '工作时长偏少，可能数据记录不完整或当天工作较少。',
      icon: <Clock size={20} />
    })

    return metrics
  }, [allEpisodes, allSegments, segmentMap])

  // 总览数据
  const overview = useMemo(() => {
    const totalSeconds = allEpisodes.reduce(
      (sum, e) => sum + getEpisodeDuration(e.startTime, e.endTime),
      0
    )
    const activeDays = dailyStats.filter((d) => d.totalSeconds > 0).length
    return {
      totalSeconds,
      totalEpisodes: allEpisodes.length,
      totalSegments: allSegments.length,
      activeDays,
      avgDailySeconds: activeDays > 0 ? totalSeconds / activeDays : 0
    }
  }, [allEpisodes, allSegments, dailyStats])

  if (loading) {
    return (
      <div className="wm-insights">
        <div className="wm-insights-loading">
          <Loader2 size={16} className="wm-insights-loading-spinner" />
          <span>正在汇总洞察数据...</span>
        </div>
      </div>
    )
  }

  if (allEpisodes.length === 0) {
    return (
      <div className="wm-insights">
        <header className="wm-insights-header">
          <div className="wm-insights-titles">
            <h1 className="wm-insights-title">洞察</h1>
            <span className="wm-insights-subtitle">Insights</span>
          </div>
        </header>
        <Card variant="acrylic" padding="md">
          <EmptyState
            title="暂无足够的洞察数据"
            description={`WorkMemory 需要至少 1 天的工作记录才能生成洞察分析。当前最近 ${INSIGHT_DAYS} 天内未检测到工作事件。`}
          />
        </Card>
      </div>
    )
  }

  return (
    <div className="wm-insights">
      <header className="wm-insights-header">
        <div className="wm-insights-titles">
          <h1 className="wm-insights-title">洞察</h1>
          <span className="wm-insights-subtitle">Insights</span>
        </div>
        <span className="wm-insights-meta">
          最近 {INSIGHT_DAYS} 天 · {overview.activeDays} 天有记录
        </span>
      </header>

      {/* 总览卡片 */}
      <div className="wm-insights-overview">
        <OverviewCard label="总工作时长" value={formatDuration(overview.totalSeconds)} variant="warning" />
        <OverviewCard label="工作事件" value={`${overview.totalEpisodes}`} variant="accent" />
        <OverviewCard label="原始片段" value={`${overview.totalSegments}`} variant="cyan" />
        <OverviewCard label="日均时长" value={formatDuration(overview.avgDailySeconds)} variant="success" />
      </div>

      {/* 每日工作时长趋势 */}
      <Card variant="acrylic" padding="md" className="wm-insights-chart-card">
        <div className="wm-insights-chart-header">
          <h2 className="wm-insights-chart-title">每日工作时长趋势</h2>
          <span className="wm-insights-chart-meta">最近 {INSIGHT_DAYS} 天</span>
        </div>
        <DailyTrendChart data={dailyStats} />
      </Card>

      <div className="wm-insights-row">
        {/* 工作类型分布（环形图） */}
        <Card variant="acrylic" padding="md" className="wm-insights-chart-card">
          <div className="wm-insights-chart-header">
            <h2 className="wm-insights-chart-title">工作类型分布</h2>
            <span className="wm-insights-chart-meta">按时长</span>
          </div>
          <WorkTypeDonutChart data={workTypeStats} />
        </Card>

        {/* 异常洞察 */}
        <Card variant="acrylic" padding="md" className="wm-insights-chart-card">
          <div className="wm-insights-chart-header">
            <h2 className="wm-insights-chart-title">效率洞察</h2>
            <span className="wm-insights-chart-meta">异常检测</span>
          </div>
          <div className="wm-insights-metrics">
            {insights.map((metric, i) => (
              <InsightMetricCard key={i} metric={metric} />
            ))}
          </div>
        </Card>
      </div>

      <div className="wm-insights-row">
        {/* 项目时间分布 */}
        <Card variant="acrylic" padding="md" className="wm-insights-chart-card">
          <div className="wm-insights-chart-header">
            <h2 className="wm-insights-chart-title">项目时间分布</h2>
            <span className="wm-insights-chart-meta">Top 6</span>
          </div>
          <HorizontalBarChart
            items={projectStats.map((p) => ({ label: p.name, value: p.totalSeconds, sublabel: `${p.episodeCount} 个事件` }))}
            color="var(--wm-color-success)"
          />
        </Card>

        {/* 联系人时间分布 */}
        <Card variant="acrylic" padding="md" className="wm-insights-chart-card">
          <div className="wm-insights-chart-header">
            <h2 className="wm-insights-chart-title">联系人时间分布</h2>
            <span className="wm-insights-chart-meta">Top 6</span>
          </div>
          {contactStats.length > 0 ? (
            <HorizontalBarChart
              items={contactStats.map((c) => ({ label: c.name, value: c.totalSeconds, sublabel: `${c.episodeCount} 次互动` }))}
              color="var(--wm-color-accent)"
            />
          ) : (
            <div className="wm-insights-no-data">暂无联系人数据</div>
          )}
        </Card>
      </div>

    </div>
  )
}

// ===================== 总览卡片 =====================

function OverviewCard({ label, value, variant }: { label: string; value: string; variant: OverviewVariant }): JSX.Element {
  return (
    <Card variant="acrylic" padding="md" className="wm-insights-overview-card">
      <span className="wm-insights-overview-label">{label}</span>
      <span className={`wm-insights-overview-value wm-insights-overview-value--${variant}`}>{value}</span>
    </Card>
  )
}

// ===================== 每日趋势折线图（纯 SVG） =====================

function DailyTrendChart({ data }: { data: DailyStat[] }): JSX.Element {
  const width = 880
  const height = 180
  const padding = { top: 20, right: 20, bottom: 36, left: 44 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom

  const maxSeconds = Math.max(...data.map((d) => d.totalSeconds), 3600)
  const maxHours = Math.ceil(maxSeconds / 3600)
  const yMax = maxHours * 3600

  // 坐标映射
  const xStep = chartWidth / Math.max(data.length - 1, 1)
  const points = data.map((d, i) => ({
    x: padding.left + i * xStep,
    y: padding.top + chartHeight - (d.totalSeconds / yMax) * chartHeight,
    data: d
  }))

  // 折线路径
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')

  // 区域填充路径
  const areaPath =
    `M ${points[0].x.toFixed(1)} ${(padding.top + chartHeight).toFixed(1)} ` +
    points.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
    ` L ${points[points.length - 1].x.toFixed(1)} ${(padding.top + chartHeight).toFixed(1)} Z`

  // Y 轴刻度
  const yTicks = Array.from({ length: maxHours + 1 }, (_, i) => i)

  return (
    <div className="wm-trend-chart">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="wm-trend-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--wm-color-warning)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--wm-color-warning)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Y 轴网格线 + 刻度 */}
        {yTicks.map((h) => {
          const y = padding.top + chartHeight - (h * 3600 / yMax) * chartHeight
          return (
            <g key={h}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="var(--wm-color-border)"
                strokeWidth="1"
                strokeDasharray={h === 0 ? '0' : '3 3'}
              />
              <text
                x={padding.left - 8}
                y={y + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--wm-color-text-muted)"
              >
                {h}h
              </text>
            </g>
          )
        })}

        {/* 区域填充 */}
        <path d={areaPath} fill="url(#wm-trend-area)" />

        {/* 折线 */}
        <path
          d={linePath}
          fill="none"
          stroke="var(--wm-color-warning)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* 数据点 */}
        {points.map((p, i) => {
          const dateObj = parseDate(p.data.date)
          const isToday = i === points.length - 1
          return (
            <g key={p.data.date}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isToday ? 5 : 3.5}
                fill="var(--wm-color-surface)"
                stroke="var(--wm-color-warning)"
                strokeWidth="2"
              />
              {p.data.totalSeconds > 0 && (
                <text
                  x={p.x}
                  y={p.y - 10}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="600"
                  fill="var(--wm-color-warning)"
                >
                  {formatDuration(p.data.totalSeconds)}
                </text>
              )}
              <text
                x={p.x}
                y={height - padding.bottom + 16}
                textAnchor="middle"
                fontSize="10"
                fill="var(--wm-color-text-muted)"
              >
                {p.data.date.substring(5)}
              </text>
              <text
                x={p.x}
                y={height - padding.bottom + 28}
                textAnchor="middle"
                fontSize="9"
                fill="var(--wm-color-text-muted)"
                opacity="0.7"
              >
                {getDayOfWeekName(dateObj)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ===================== 工作类型环形图（纯 SVG） =====================

function WorkTypeDonutChart({ data }: { data: WorkTypeStat[] }): JSX.Element {
  const total = data.reduce((sum, d) => sum + d.totalSeconds, 0)
  const radius = 60
  const strokeWidth = 18
  const circumference = 2 * Math.PI * radius
  const center = 90

  let accumulatedOffset = 0
  const segments = data.map((d) => {
    const ratio = total > 0 ? d.totalSeconds / total : 0
    const length = ratio * circumference
    const segment = {
      type: d.type,
      label: getWorkTypeLabel(d.type),
      color: getWorkTypeColor(d.type),
      seconds: d.totalSeconds,
      ratio,
      dasharray: `${length.toFixed(2)} ${(circumference - length).toFixed(2)}`,
      dashoffset: (-accumulatedOffset).toFixed(2)
    }
    accumulatedOffset += length
    return segment
  })

  return (
    <div className="wm-donut-chart">
      <div className="wm-donut-chart-svg-wrap">
        <svg viewBox="0 0 180 180" width="180" height="180">
          {/* 背景圆环 */}
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="var(--wm-color-surface-alt)"
            strokeWidth={strokeWidth}
          />
          {total > 0 && segments.map((seg) => (
            <circle
              key={seg.type}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeDasharray={seg.dasharray}
              strokeDashoffset={seg.dashoffset}
              transform={`rotate(-90 ${center} ${center})`}
              strokeLinecap="butt"
            />
          ))}
          {/* 中心文字 */}
          <text
            x={center}
            y={center - 6}
            textAnchor="middle"
            fontSize="11"
            fill="var(--wm-color-text-muted)"
          >
            总时长
          </text>
          <text
            x={center}
            y={center + 14}
            textAnchor="middle"
            fontSize="16"
            fontWeight="700"
            fill="var(--wm-color-text-primary)"
          >
            {formatDuration(total)}
          </text>
        </svg>
      </div>
      <div className="wm-donut-chart-legend">
        {segments.map((seg) => (
          <div key={seg.type} className="wm-donut-chart-legend-item">
            <span className="wm-donut-chart-legend-dot" style={{ background: seg.color }} />
            <span className="wm-donut-chart-legend-label">{seg.label}</span>
            <span className="wm-donut-chart-legend-value">{formatDuration(seg.seconds)}</span>
            <span className="wm-donut-chart-legend-ratio">
              {(seg.ratio * 100).toFixed(0)}%
            </span>
          </div>
        ))}
        {segments.length === 0 && (
          <div className="wm-donut-chart-empty">暂无工作类型数据</div>
        )}
      </div>

    </div>
  )
}

// ===================== 水平条形图（纯 CSS） =====================

interface BarChartItem {
  label: string
  value: number
  sublabel?: string
}

function HorizontalBarChart({ items, color }: { items: BarChartItem[]; color: string }): JSX.Element {
  const maxValue = Math.max(...items.map((i) => i.value), 1)

  if (items.length === 0) {
    return <div className="wm-bar-chart-empty">暂无数据</div>
  }

  return (
    <div className="wm-bar-chart">
      {items.map((item, idx) => {
        const ratio = (item.value / maxValue) * 100
        return (
          <div key={`${item.label}-${idx}`} className="wm-bar-chart-item">
            <div className="wm-bar-chart-label-row">
              <span className="wm-bar-chart-label" title={item.label}>{item.label}</span>
              <span className="wm-bar-chart-value">{formatDuration(item.value)}</span>
            </div>
            <div className="wm-bar-chart-track">
              <div
                className="wm-bar-chart-fill"
                style={{ width: `${ratio}%`, background: color }}
              />
            </div>
            {item.sublabel && (
              <span className="wm-bar-chart-sublabel">{item.sublabel}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ===================== 洞察指标卡片 =====================

function InsightMetricCard({ metric }: { metric: InsightMetric }): JSX.Element {
  return (
    <div className={`wm-metric-card wm-metric-card--${metric.level}`}>
      <div className={`wm-metric-card-icon wm-metric-card-icon--${metric.level}`}>
        {metric.icon}
      </div>
      <div className="wm-metric-card-body">
        <div className="wm-metric-card-header">
          <span className="wm-metric-card-title">{metric.title}</span>
          <span className={`wm-metric-card-value wm-metric-card-value--${metric.level}`}>{metric.value}</span>
        </div>
        <p className="wm-metric-card-desc">{metric.description}</p>
      </div>
    </div>
  )
}
