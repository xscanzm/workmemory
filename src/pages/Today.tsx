/**
 * Task B3.1：今日 (Today) 页 — 精品桌面产品视觉重构
 * 三栏桌面布局核心看板，基于统一 UI 组件库重构。
 * - 顶部：亚克力汇总卡（日期 + 记录状态徽标 + 统计数据 + 生成日报 CTA）
 * - 中间：每日一句话总结卡（可编辑）+ 记录状态条
 * - 下方：垂直时间轴 MemoryCard 列表（按时间倒序），可展开 SegmentList
 * - 右侧：ContextPanel 显示选中 Episode/Segment 详情（由 AppLayout 渲染）
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRecordingStore } from '@/store/recordingStore'
import { useIpcInvoke, useIpcSubscribe } from '@/hooks/useIpc'
import { StatusBar } from '@/components/StatusBar'
import { EmptyState } from '@/components/EmptyState'
import { SegmentList } from '@/components/SegmentList'
import {
  getTodayDate,
  parseDate,
  getDayOfWeekName,
  formatTimeRange,
  getEpisodeDuration,
  formatDuration
} from '@/utils/datetime'
import {
  Button,
  IconButton,
  Card,
  Badge,
  Timeline,
  TimelineItem,
  MemoryCard,
  FileText,
  Edit3,
  Check,
  X,
  Loader2,
  BookMarked,
  type MemoryAppIcon,
  type BadgeVariant
} from '@/ui'
import type { Episode, WorkSegment, RecordingState } from '@/types'
import './Today.css'

/** 每日总结标记 topic（与 EpisodeBuilder.DAILY_SUMMARY_TOPIC 保持一致） */
const DAILY_SUMMARY_TOPIC = '__daily_summary__'

/** 应用图标颜色池 */
const APP_ICON_COLORS = [
  '#2b7fff', '#22c5d8', '#22b56a', '#f5a623', '#8b5cf6', '#e5484d', '#7c5cff'
]

/** 根据应用名生成稳定的颜色 */
function getAppIconColor(appName: string): string {
  let hash = 0
  for (let i = 0; i < appName.length; i++) {
    hash = appName.charCodeAt(i) + ((hash << 5) - hash)
  }
  return APP_ICON_COLORS[Math.abs(hash) % APP_ICON_COLORS.length]
}

/** 记录状态徽标配置 */
const RECORDING_STATE_CONFIG: Record<RecordingState, { label: string; variant: BadgeVariant }> = {
  recording: { label: '正在记录', variant: 'success' },
  paused: { label: '已暂停', variant: 'warning' },
  idle: { label: '空闲', variant: 'default' },
  privacy: { label: '已保护', variant: 'privacy' }
}

/** 格式化日期为 "2026年6月20日 周六" */
function formatChineseDate(dateStr: string): string {
  const date = parseDate(dateStr)
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${getDayOfWeekName(date)}`
}

function getSegmentDuration(segment: WorkSegment): number {
  if (Number.isFinite(segment.durationSeconds) && segment.durationSeconds > 0) {
    return segment.durationSeconds
  }
  return getEpisodeDuration(segment.startTime, segment.endTime)
}

export function Today(): JSX.Element {
  const navigate = useNavigate()

  // Store
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)
  const recordingState = useRecordingStore((s) => s.recordingState)
  const privacyMode = useRecordingStore((s) => s.privacyMode)
  const setRecordingState = useRecordingStore((s) => s.setRecordingState)
  const setPrivacyMode = useRecordingStore((s) => s.setPrivacyMode)
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const triggerRefresh = useRecordingStore((s) => s.triggerRefresh)

  // Local state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [summaryEditing, setSummaryEditing] = useState<boolean>(false)
  const [summaryValue, setSummaryValue] = useState<string>('')

  // Data loading
  const today = getTodayDate()
  const { data: episodes, loading: episodesLoading } = useIpcInvoke<Episode[]>(
    () => window.workmemory.episode.getByDate(today),
    [today, refreshTrigger]
  )
  const { data: segments } = useIpcInvoke<WorkSegment[]>(
    () => window.workmemory.segment.getActiveByDate(today),
    [today, refreshTrigger]
  )
  const { data: dailySummary } = useIpcInvoke<string>(
    () => window.workmemory.episode.getDailySummary(today),
    [today, refreshTrigger]
  )

  // Capture state subscription
  useEffect(() => {
    window.workmemory.capture
      .getState()
      .then((state) => setRecordingState(state as RecordingState))
      .catch(() => {
        /* capture 未就绪时静默处理 */
      })
  }, [setRecordingState])

  useIpcSubscribe<string>(
    (cb) => window.workmemory.capture.onStateChange(cb),
    (state) => setRecordingState(state as RecordingState),
    [setRecordingState]
  )

  // Clear context on mount
  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // Derived data
  const segmentMap = useMemo<Map<string, WorkSegment>>(() => {
    return new Map((segments ?? []).map((s) => [s.id, s]))
  }, [segments])

  const displayEpisodes = useMemo<Episode[]>(() => {
    if (!episodes) return []
    return episodes
      .filter((e) => !e.topics.includes(DAILY_SUMMARY_TOPIC))
      .filter((e) => e.segmentIds.some((id) => segmentMap.has(id)))
      .sort((a, b) => b.startTime.localeCompare(a.startTime))
  }, [episodes, segmentMap])

  const getEpisodeSegments = useCallback(
    (episode: Episode): WorkSegment[] => {
      return episode.segmentIds
        .map((id) => segmentMap.get(id))
        .filter((s): s is WorkSegment => s !== undefined)
    },
    [segmentMap]
  )

  // 顶部统计数据
  const stats = useMemo(() => {
    const episodeCount = displayEpisodes.length
    const rawSegments = segments ?? []
    const segmentCount = rawSegments.length
    const totalSeconds = rawSegments.reduce((sum, segment) => sum + getSegmentDuration(segment), 0)
    return { episodeCount, segmentCount, totalDuration: formatDuration(totalSeconds) }
  }, [displayEpisodes.length, segments])

  // 有效记录状态（隐私模式优先）
  const effectiveState: RecordingState = privacyMode ? 'privacy' : recordingState
  const stateConfig = RECORDING_STATE_CONFIG[effectiveState]

  // ===================== Handlers =====================

  const handleTogglePause = useCallback(async (): Promise<void> => {
    try {
      if (recordingState === 'paused') {
        await window.workmemory.capture.resume()
      } else {
        await window.workmemory.capture.pause()
      }
    } catch {
      /* 静默处理 */
    }
  }, [recordingState])

  const handleTogglePrivacy = useCallback(async (): Promise<void> => {
    try {
      if (privacyMode) {
        await window.workmemory.capture.resume()
        setPrivacyMode(false)
      } else {
        await window.workmemory.capture.pause()
        setPrivacyMode(true)
      }
    } catch {
      /* 静默处理 */
    }
  }, [privacyMode, setPrivacyMode])

  const handleSaveSummary = useCallback(async (): Promise<void> => {
    await window.workmemory.episode.setDailySummary(today, summaryValue)
    setSummaryEditing(false)
    triggerRefresh()
  }, [today, summaryValue, triggerRefresh])

  const handleSelectEpisode = useCallback(
    (episode: Episode): void => {
      setSelectedId(episode.id)
      setContextItem({ type: 'episode', episode, segments: getEpisodeSegments(episode) })
    },
    [getEpisodeSegments, setContextItem]
  )

  const handleToggleExpand = useCallback((id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleToggleReport = useCallback(
    async (episode: Episode, eligible: boolean): Promise<void> => {
      await window.workmemory.episode.setReportEligible(episode.id, eligible)
      triggerRefresh()
    },
    [triggerRefresh]
  )

  const handleSaveToWiki = useCallback(
    async (episode: Episode): Promise<void> => {
      const epSegments = getEpisodeSegments(episode)
      await window.workmemory.wiki.addToReviewQueue({
        type: 'topic',
        title: episode.title,
        aliases: [],
        content: `## 一句话总结\n${episode.oneLineSummary}\n\n## 时间范围\n${episode.startTime} - ${episode.endTime}\n\n## 关键词\n${episode.topics.join('、')}\n\n## 关联片段\n${epSegments.length} 个原始片段`,
        sources: [episode.id],
        backlinks: [],
        confidence: 0.7
      })
      triggerRefresh()
    },
    [getEpisodeSegments, triggerRefresh]
  )

  const handleSegmentClick = useCallback(
    (segment: WorkSegment): void => {
      setContextItem({ type: 'segment', segment })
    },
    [setContextItem]
  )

  const handleSegmentDelete = useCallback(
    async (segmentId: string): Promise<void> => {
      await window.workmemory.segment.softDelete(segmentId)
      triggerRefresh()
    },
    [triggerRefresh]
  )

  const handleSegmentToggleImportant = useCallback(
    async (segmentId: string, important: boolean): Promise<void> => {
      await window.workmemory.segment.setImportant(segmentId, important)
      triggerRefresh()
    },
    [triggerRefresh]
  )

  const handleSegmentToggleReport = useCallback(
    async (segmentId: string, selected: boolean): Promise<void> => {
      await window.workmemory.segment.setSelectedForReport(segmentId, selected)
      triggerRefresh()
    },
    [triggerRefresh]
  )

  // ===================== Render =====================

  return (
    <div className="wm-today">
      {/* 顶部汇总卡：日期 + 记录状态 + 统计 + 生成日报 CTA */}
      <Card variant="acrylic" elevated padding="lg" className="wm-today-summary-bar">
        <div className="wm-today-summary-left">
          <div className="wm-today-date">
            <h1 className="wm-today-date-main">{formatChineseDate(today)}</h1>
            <span className="wm-today-date-sub">Today</span>
          </div>
          <Badge variant={stateConfig.variant} size="md" dot>
            {stateConfig.label}
          </Badge>
        </div>

        <div className="wm-today-summary-stats">
          <div className="wm-today-stat">
            <span className="wm-today-stat-value">{stats.episodeCount}</span>
            <span className="wm-today-stat-label">事件</span>
          </div>
          <span className="wm-today-stat-divider" />
          <div className="wm-today-stat">
            <span className="wm-today-stat-value">{stats.totalDuration}</span>
            <span className="wm-today-stat-label">总时长</span>
          </div>
          <span className="wm-today-stat-divider" />
          <div className="wm-today-stat">
            <span className="wm-today-stat-value">{stats.segmentCount}</span>
            <span className="wm-today-stat-label">片段</span>
          </div>
        </div>

        <div className="wm-today-summary-right">
          <Button
            variant="primary"
            size="lg"
            leftIcon={<FileText size={16} />}
            onClick={() => navigate(`/reports?date=${today}&generate=1`)}
          >
            生成今日日报
          </Button>
        </div>
      </Card>

      {/* 每日一句话总结卡 */}
      <Card variant="acrylic" padding="md" className="wm-today-daily-card">
        <div className="wm-today-daily-header">
          <span className="wm-today-daily-label">今日一句话总结</span>
          {!summaryEditing && (
            <IconButton
              label="编辑总结"
              size="sm"
              variant="ghost"
              icon={<Edit3 size={14} />}
              onClick={() => {
                setSummaryEditing(true)
                setSummaryValue(dailySummary ?? '')
              }}
            />
          )}
        </div>
        {summaryEditing ? (
          <div className="wm-today-daily-edit">
            <textarea
              className="wm-today-daily-textarea"
              value={summaryValue}
              onChange={(e) => setSummaryValue(e.target.value)}
              autoFocus
              placeholder="输入今日一句话总结..."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSaveSummary()
                }
                if (e.key === 'Escape') {
                  setSummaryEditing(false)
                }
              }}
            />
            <div className="wm-today-daily-actions">
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Check size={13} />}
                onClick={() => void handleSaveSummary()}
              >
                保存
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<X size={13} />}
                onClick={() => {
                  setSummaryEditing(false)
                  setSummaryValue('')
                }}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <p
            className="wm-today-daily-text"
            onDoubleClick={() => {
              setSummaryEditing(true)
              setSummaryValue(dailySummary ?? '')
            }}
          >
            {dailySummary || '双击编辑今日总结...'}
          </p>
        )}
      </Card>

      {/* 记录状态条（暂停/隐私控制） */}
      <StatusBar
        onTogglePause={() => void handleTogglePause()}
        onTogglePrivacy={() => void handleTogglePrivacy()}
      />

      {/* Episode 时间轴 */}
      <div className="wm-today-timeline-section">
        <div className="wm-today-section-header">
          <h2 className="wm-today-section-title">工作时间轴</h2>
          {displayEpisodes.length > 0 && (
            <Badge variant="default" size="sm">
              {displayEpisodes.length} 个事件
            </Badge>
          )}
        </div>

        {episodesLoading ? (
          <div className="wm-today-loading">
            <Loader2 size={16} className="wm-today-loading-spinner" />
            <span>加载中...</span>
          </div>
        ) : displayEpisodes.length === 0 ? (
          <EmptyState
            title="今天还没有工作记忆"
            description="开始工作吧，WorkMemory 会自动记录你的工作痕迹并整理为时间轴。"
          />
        ) : (
          <Timeline className="wm-today-timeline">
            {displayEpisodes.map((episode, idx) => {
              const epSegments = getEpisodeSegments(episode)
              const appNames = [...new Set(epSegments.map((s) => s.appName).filter(Boolean))]
              const appIcons: MemoryAppIcon[] = appNames.map((name) => ({
                name,
                color: getAppIconColor(name)
              }))
              const duration = getEpisodeDuration(episode.startTime, episode.endTime)
              return (
                <TimelineItem key={episode.id} last={idx === displayEpisodes.length - 1}>
                  <MemoryCard
                    time={formatTimeRange(episode.startTime, episode.endTime)}
                    duration={formatDuration(duration)}
                    title={episode.title}
                    summary={episode.oneLineSummary}
                    topics={episode.topics}
                    entities={episode.entities}
                    appIcons={appIcons}
                    selected={selectedId === episode.id}
                    expanded={expandedIds.has(episode.id)}
                    reportEligible={episode.reportEligible}
                    onSelect={() => handleSelectEpisode(episode)}
                    onToggleExpand={() => handleToggleExpand(episode.id)}
                    onToggleReport={(eligible) => void handleToggleReport(episode, eligible)}
                    actions={
                      <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<BookMarked size={13} />}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleSaveToWiki(episode)
                        }}
                      >
                        Wiki
                      </Button>
                    }
                  >
                    <SegmentList
                      segments={epSegments}
                      onSegmentClick={handleSegmentClick}
                      onSegmentDelete={(segId) => void handleSegmentDelete(segId)}
                      onToggleImportant={(segId, important) =>
                        void handleSegmentToggleImportant(segId, important)
                      }
                      onToggleReport={(segId, selected) =>
                        void handleSegmentToggleReport(segId, selected)
                      }
                    />
                  </MemoryCard>
                </TimelineItem>
              )
            })}
          </Timeline>
        )}
      </div>
    </div>
  )
}
