/**
 * Episode 卡片
 * 基于 MemoryCard 统一组件渲染：时间范围、应用图标、标题、一句话总结、
 * 标签、实体、日报勾选、保存到 Wiki 按钮、展开/折叠原始 Segment 列表。
 */
import type { Episode, WorkSegment } from '@/types'
import { formatTimeRange, getEpisodeDuration, formatDuration } from '../utils/datetime'
import { SegmentList } from './SegmentList'
import { Button, MemoryCard, BookMarked, type MemoryAppIcon } from '@/ui'

interface EpisodeCardProps {
  episode: Episode
  segments: WorkSegment[]
  expanded: boolean
  selected: boolean
  onToggleExpand: () => void
  onSelect: () => void
  onToggleReport: (eligible: boolean) => void
  onSaveToWiki: () => void
  onSegmentClick: (segment: WorkSegment) => void
  onSegmentDelete: (segmentId: string) => void
  onSegmentToggleImportant: (segmentId: string, important: boolean) => void
  onSegmentToggleReport: (segmentId: string, selected: boolean) => void
}

const APP_ICON_COLORS = [
  '#2b7fff', '#22c5d8', '#22b56a', '#f5a623', '#8b5cf6', '#e5484d', '#7c5cff'
]

function getAppIconColor(appName: string): string {
  let hash = 0
  for (let i = 0; i < appName.length; i++) {
    hash = appName.charCodeAt(i) + ((hash << 5) - hash)
  }
  return APP_ICON_COLORS[Math.abs(hash) % APP_ICON_COLORS.length]
}

export function EpisodeCard({
  episode,
  segments,
  expanded,
  selected,
  onToggleExpand,
  onSelect,
  onToggleReport,
  onSaveToWiki,
  onSegmentClick,
  onSegmentDelete,
  onSegmentToggleImportant,
  onSegmentToggleReport
}: EpisodeCardProps): JSX.Element {
  const duration = getEpisodeDuration(episode.startTime, episode.endTime)
  const appNames = [...new Set(segments.map((s) => s.appName).filter(Boolean))]
  const appIcons: MemoryAppIcon[] = appNames.map((name) => ({
    name,
    color: getAppIconColor(name)
  }))

  return (
    <MemoryCard
      time={formatTimeRange(episode.startTime, episode.endTime)}
      duration={formatDuration(duration)}
      title={episode.title}
      summary={episode.oneLineSummary}
      topics={episode.topics}
      entities={episode.entities}
      appIcons={appIcons}
      selected={selected}
      expanded={expanded}
      reportEligible={episode.reportEligible}
      onSelect={onSelect}
      onToggleExpand={onToggleExpand}
      onToggleReport={onToggleReport}
      actions={
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<BookMarked size={13} />}
          onClick={(e) => {
            e.stopPropagation()
            onSaveToWiki()
          }}
        >
          Wiki
        </Button>
      }
    >
      <SegmentList
        segments={segments}
        onSegmentClick={onSegmentClick}
        onSegmentDelete={onSegmentDelete}
        onToggleImportant={onSegmentToggleImportant}
        onToggleReport={onSegmentToggleReport}
      />
    </MemoryCard>
  )
}
