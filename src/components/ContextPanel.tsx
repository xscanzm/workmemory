/**
 * 右侧上下文详情面板容器
 * 接收选中项（从 store 读取），显示完整 OCR、来源截图、关联项目/人、备注/标签、删除/拆分按钮。
 * 根据上下文类型（episode / segment / day / search-match / empty）渲染不同内容。
 */
import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRecordingStore } from '../store/recordingStore'
import type { MatchReason } from '../store/recordingStore'
import type { Episode, WorkSegment, EntityRefType } from '@/types'
import { formatTimeRange, getEpisodeDuration, formatDuration, parseDate, getDayOfWeekName } from '../utils/datetime'
import { Badge, Button, Card, Clock, FileText, Image, type BadgeVariant } from '@/ui'
import styles from './ContextPanel.module.css'

const ENTITY_VARIANT: Record<EntityRefType, BadgeVariant> = {
  person: 'accent',
  project: 'success',
  document: 'warning',
  url: 'default'
}

export function ContextPanel(): JSX.Element {
  const contextItem = useRecordingStore((s) => s.contextItem)

  return (
    <div className={`wm-scroll ${styles.panel}`}>
      {contextItem === null && <DefaultHint />}
      {contextItem?.type === 'empty' && <EmptyHint />}
      {contextItem?.type === 'episode' && <EpisodeDetail key={contextItem.episode.id} episode={contextItem.episode} segments={contextItem.segments} />}
      {contextItem?.type === 'segment' && <SegmentDetail key={contextItem.segment.id} segment={contextItem.segment} />}
      {contextItem?.type === 'day' && <DayDetail date={contextItem.date} summary={contextItem.summary} episodes={contextItem.episodes} hasReport={contextItem.hasReport} />}
      {contextItem?.type === 'search-match' && <SearchMatchDetail reasons={contextItem.reasons} episode={contextItem.episode} />}
    </div>
  )
}

function DefaultHint(): JSX.Element {
  return (
    <div className={styles.hint}>
      <Clock size={48} className={styles.hintIcon} />
      <p className={styles.hintText}>
        选中任意片段或 Episode 后，此处展示关联详情、实体引用与匹配原因。
      </p>
    </div>
  )
}

function EmptyHint(): JSX.Element {
  return (
    <div className={styles.hint}>
      <FileText size={48} className={styles.hintIcon} />
      <p className={styles.hintText}>暂无选中项</p>
    </div>
  )
}

// ===================== Episode 详情 =====================

function EpisodeDetail({ episode, segments }: { episode: Episode; segments: WorkSegment[] }): JSX.Element {
  const triggerRefresh = useRecordingStore((s) => s.triggerRefresh)
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const [editing, setEditing] = useState<boolean>(false)
  const [editValue, setEditValue] = useState<string>(episode.oneLineSummary)

  const duration = getEpisodeDuration(episode.startTime, episode.endTime)
  const fullOcr = segments.map((s) => s.ocrText).filter((t) => t.length > 0).join('\n---\n')
  const screenshotPath = segments.find((s) => s.screenshotPath)?.screenshotPath ?? ''

  const handleSaveSummary = useCallback(async (): Promise<void> => {
    await window.workmemory.episode.update(episode.id, {
      oneLineSummary: editValue,
      userEdited: true
    })
    setEditing(false)
    triggerRefresh()
  }, [episode.id, editValue, triggerRefresh])

  const handleToggleReport = useCallback(async (): Promise<void> => {
    await window.workmemory.episode.setReportEligible(episode.id, !episode.reportEligible)
    triggerRefresh()
  }, [episode.id, episode.reportEligible, triggerRefresh])

  const handleSaveToWiki = useCallback(async (): Promise<void> => {
    await window.workmemory.wiki.addToReviewQueue({
      type: 'topic',
      title: episode.title,
      aliases: [],
      content: `## 一句话总结\n${episode.oneLineSummary}\n\n## 时间范围\n${episode.startTime} - ${episode.endTime}\n\n## 关键词\n${episode.topics.join('、')}\n\n## 关联片段\n${segments.length} 个原始片段`,
      sources: [episode.id],
      backlinks: [],
      confidence: 0.7
    })
    triggerRefresh()
  }, [episode, segments, triggerRefresh])

  const handleSplit = useCallback(async (): Promise<void> => {
    if (segments.length < 2) return
    const midIdx = Math.floor(segments.length / 2)
    const firstHalf = segments.slice(0, midIdx)
    const secondHalf = segments.slice(midIdx)

    await window.workmemory.episode.update(episode.id, {
      segmentIds: firstHalf.map((s) => s.id),
      endTime: firstHalf[firstHalf.length - 1].endTime,
      oneLineSummary: `${episode.oneLineSummary}（上半部分）`,
      userEdited: true
    })

    const newEpisode: Episode = {
      id: crypto.randomUUID(),
      date: episode.date,
      startTime: secondHalf[0].startTime,
      endTime: secondHalf[secondHalf.length - 1].endTime,
      title: `${episode.title}（下半部分）`,
      oneLineSummary: `${episode.oneLineSummary}（下半部分）`,
      segmentIds: secondHalf.map((s) => s.id),
      entities: episode.entities,
      topics: episode.topics,
      userEdited: true,
      reportEligible: episode.reportEligible,
      wikiEligible: episode.wikiEligible
    }
    await window.workmemory.episode.insert(newEpisode)

    setContextItem(null)
    triggerRefresh()
  }, [episode, segments, setContextItem, triggerRefresh])

  const handleDelete = useCallback(async (): Promise<void> => {
    for (const seg of segments) {
      await window.workmemory.segment.softDelete(seg.id)
    }
    setContextItem(null)
    triggerRefresh()
  }, [segments, setContextItem, triggerRefresh])

  return (
    <>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{episode.title}</span>
        <span className={styles.headerMeta}>
          {formatTimeRange(episode.startTime, episode.endTime)} · {formatDuration(duration)} · {segments.length} 个片段
        </span>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>一句话总结</span>
        {editing ? (
          <div className={styles.editRow}>
            <textarea
              className={styles.editArea}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSaveSummary()
                }
                if (e.key === 'Escape') {
                  setEditing(false)
                  setEditValue(episode.oneLineSummary)
                }
              }}
            />
            <div className={styles.editActions}>
              <Button variant="primary" size="sm" onClick={() => void handleSaveSummary()}>保存</Button>
              <Button variant="secondary" size="sm" onClick={() => { setEditing(false); setEditValue(episode.oneLineSummary) }}>取消</Button>
            </div>
          </div>
        ) : (
          <p className={styles.text} onDoubleClick={() => { setEditing(true); setEditValue(episode.oneLineSummary) }}>
            {episode.oneLineSummary}
            {episode.userEdited && <span className={styles.editedMark}>（已手动编辑）</span>}
          </p>
        )}
      </div>

      {fullOcr && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>完整 OCR 文本</span>
          <div className={`wm-scroll ${styles.ocr}`}>{fullOcr}</div>
        </div>
      )}

      {screenshotPath && <ScreenshotView path={screenshotPath} />}

      {episode.entities.length > 0 && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>关联项目 / 人</span>
          <div className={styles.entityList}>
            {episode.entities.map((entity, i) => (
              <Badge key={`${entity.type}-${entity.name}-${i}`} variant={ENTITY_VARIANT[entity.type]} size="sm">
                {entity.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {episode.topics.length > 0 && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>标签</span>
          <div className={styles.tagList}>
            {episode.topics.map((topic) => (
              <Badge key={topic} variant="cyan" size="sm">{topic}</Badge>
            ))}
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={() => { setEditing(true); setEditValue(episode.oneLineSummary) }}>
          编辑总结
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void handleToggleReport()}>
          {episode.reportEligible ? '取消日报' : '加入日报'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void handleSaveToWiki()}>保存到 Wiki</Button>
        {segments.length >= 2 && (
          <Button variant="secondary" size="sm" onClick={() => void handleSplit()}>拆分</Button>
        )}
        <Button variant="secondary" size="sm" className={styles.dangerBtn} onClick={() => void handleDelete()}>删除</Button>
      </div>
    </>
  )
}

// ===================== Segment 详情 =====================

function SegmentDetail({ segment }: { segment: WorkSegment }): JSX.Element {
  const triggerRefresh = useRecordingStore((s) => s.triggerRefresh)
  const setContextItem = useRecordingStore((s) => s.setContextItem)

  const handleDelete = useCallback(async (): Promise<void> => {
    await window.workmemory.segment.softDelete(segment.id)
    setContextItem(null)
    triggerRefresh()
  }, [segment.id, setContextItem, triggerRefresh])

  const handleToggleImportant = useCallback(async (): Promise<void> => {
    await window.workmemory.segment.setImportant(segment.id, !segment.isImportant)
    triggerRefresh()
  }, [segment.id, segment.isImportant, triggerRefresh])

  const handleToggleReport = useCallback(async (): Promise<void> => {
    await window.workmemory.segment.setSelectedForReport(segment.id, !segment.isSelectedForReport)
    triggerRefresh()
  }, [segment.id, segment.isSelectedForReport, triggerRefresh])

  return (
    <>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{segment.appName || segment.processName || '未知应用'}</span>
        <span className={styles.headerMeta}>
          {formatTimeRange(segment.startTime, segment.endTime)} · {formatDuration(segment.durationSeconds)}
        </span>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>窗口标题</span>
        <p className={styles.text}>
          {segment.isPrivate ? '[隐私窗口被保护]' : segment.windowTitle || '无标题'}
        </p>
      </div>

      {segment.isPrivate && (
        <div className={styles.section}>
          <span className={`${styles.sectionTitle} ${styles.privacyTitle}`}>
            隐私保护
          </span>
          <p className={`${styles.text} ${styles.privacyText}`}>
            此片段已触发隐私规则，截图与 OCR 均未保存。
          </p>
        </div>
      )}

      {!segment.isPrivate && segment.ocrText && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>完整 OCR 文本</span>
          <div className={`wm-scroll ${styles.ocr}`}>{segment.ocrText}</div>
        </div>
      )}

      {!segment.isPrivate && segment.ocrSummary && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>OCR 摘要</span>
          <p className={styles.text}>{segment.ocrSummary}</p>
        </div>
      )}

      {!segment.isPrivate && segment.screenshotPath && <ScreenshotView path={segment.screenshotPath} />}

      {segment.userNote && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>备注</span>
          <p className={styles.note}>{segment.userNote}</p>
        </div>
      )}

      {segment.tags.length > 0 && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>标签</span>
          <div className={styles.tagList}>
            {segment.tags.map((tag) => (
              <Badge key={tag} variant="cyan" size="sm">{tag}</Badge>
            ))}
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={() => void handleToggleImportant()}>
          {segment.isImportant ? '取消重点' : '标为重点'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void handleToggleReport()}>
          {segment.isSelectedForReport ? '取消日报' : '加入日报'}
        </Button>
        <Button variant="secondary" size="sm" className={styles.dangerBtn} onClick={() => void handleDelete()}>删除</Button>
      </div>
    </>
  )
}

// ===================== Day 详情 =====================

function DayDetail({ date, summary, episodes, hasReport }: { date: string; summary: string; episodes: Episode[]; hasReport: boolean }): JSX.Element {
  const navigate = useNavigate()
  const dateObj = parseDate(date)
  const topEpisodes = [...episodes]
    .sort((a, b) => getEpisodeDuration(b.startTime, b.endTime) - getEpisodeDuration(a.startTime, a.endTime))
    .slice(0, 5)

  // C4.2：跳转到 Reports 页并加载该日日报
  const handleViewReport = useCallback((): void => {
    navigate(`/reports?date=${date}`)
  }, [navigate, date])

  return (
    <>
      <div className={styles.header}>
        <span className={styles.headerTitle}>{date} {getDayOfWeekName(dateObj)}</span>
        <span className={styles.headerMeta}>{episodes.length} 个工作事件</span>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>一句话故事</span>
        <p className={styles.text}>{summary || '暂无今日总结'}</p>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>重点事件（Top 5）</span>
        {topEpisodes.length === 0 ? (
          <p className={`${styles.text} ${styles.mutedText}`}>当日无工作事件</p>
        ) : (
          <div className={styles.episodeList}>
            {topEpisodes.map((ep) => (
              <Card key={ep.id} variant="solid" padding="sm" className={styles.episodeItem}>
                <span className={styles.episodeItemTitle}>{ep.title}</span>
                <span className={styles.episodeItemMeta}>
                  {formatTimeRange(ep.startTime, ep.endTime)} · {formatDuration(getEpisodeDuration(ep.startTime, ep.endTime))}
                </span>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div className={styles.actions}>
        {hasReport && (
          <Button variant="primary" size="sm" leftIcon={<FileText size={13} />} onClick={handleViewReport}>
            查看当天日报
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={() => navigate('/')}>
          跳转今日页
        </Button>
      </div>
    </>
  )
}

// ===================== 搜索匹配原因 =====================

const REASON_CLASS: Record<MatchReason['dimension'], string> = {
  ocr: styles.reasonOcr,
  project: styles.reasonProject,
  time: styles.reasonTime,
  person: styles.reasonPerson
}

function SearchMatchDetail({ reasons, episode }: { reasons: MatchReason[]; episode: Episode }): JSX.Element {
  return (
    <>
      <div className={styles.header}>
        <span className={styles.headerTitle}>匹配原因</span>
        <span className={styles.headerMeta}>{episode.title}</span>
      </div>

      {reasons.length === 0 ? (
        <p className={`${styles.text} ${styles.mutedText}`}>无匹配原因</p>
      ) : (
        <div className={styles.reasonList}>
          {reasons.map((reason, i) => (
            <div key={i} className={`${styles.reason} ${REASON_CLASS[reason.dimension]}`}>
              <span className={styles.reasonLabel}>{reason.label}</span>
              <span className={styles.reasonDetail}>{reason.detail}</span>
              {reason.matchedTerms.length > 0 && (
                <div className={styles.reasonTerms}>
                  {reason.matchedTerms.map((term) => (
                    <span key={term} className={styles.reasonTerm}>{term}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// ===================== 截图视图 =====================

function ScreenshotView({ path }: { path: string }): JSX.Element {
  const [error, setError] = useState<boolean>(false)

  if (!path || error) {
    return (
      <div className={styles.section}>
        <span className={styles.sectionTitle}>来源截图</span>
        <Card variant="solid" padding="lg" className={styles.screenshotPlaceholder}>
          <Image size={20} />
          <span>截图未保留（OCR 后已删除）</span>
        </Card>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <span className={styles.sectionTitle}>来源截图</span>
      <div className={styles.screenshot}>
        <img
          className={styles.screenshotImg}
          src={`file://${path}`}
          alt="来源截图"
          onError={() => setError(true)}
        />
      </div>
    </div>
  )
}
