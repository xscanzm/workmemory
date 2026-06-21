/**
 * 原始 Segment 折叠列表
 * 显示时间、应用、窗口标题、OCR 摘要预览、隐私小锁标识（紫色）、重点星标、删除按钮。
 */
import type { WorkSegment, SourceStatus } from '@/types'
import { formatTimeRange, formatDuration } from '../utils/datetime'
import { Badge, IconButton, Shield, Star, Trash2, type BadgeVariant } from '@/ui'
import styles from './SegmentList.module.css'

interface SegmentListProps {
  segments: WorkSegment[]
  onSegmentClick: (segment: WorkSegment) => void
  onSegmentDelete: (segmentId: string) => void
  onToggleImportant: (segmentId: string, important: boolean) => void
  onToggleReport: (segmentId: string, selected: boolean) => void
}

const STATUS_VARIANT: Record<SourceStatus, BadgeVariant> = {
  ocr_done: 'success',
  pending: 'warning',
  private: 'privacy',
  ocr_failed: 'danger',
  no_text: 'default'
}

const STATUS_LABEL: Record<SourceStatus, string> = {
  ocr_done: '已识别',
  pending: '待处理',
  private: '隐私',
  ocr_failed: '识别失败',
  no_text: '无文本'
}

export function SegmentList({
  segments,
  onSegmentClick,
  onSegmentDelete,
  onToggleImportant,
  onToggleReport
}: SegmentListProps): JSX.Element {
  if (segments.length === 0) {
    return <div className={styles.empty}>无原始片段</div>
  }

  return (
    <div className={styles.list}>
      {segments.map((segment) => {
        const itemClass = [
          styles.item,
          segment.isPrivate ? styles.itemPrivate : ''
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={segment.id}
            className={itemClass}
            onClick={() => onSegmentClick(segment)}
          >
            <div className={styles.time}>
              <span className={styles.timeText}>{formatTimeRange(segment.startTime, segment.endTime)}</span>
              <span className={styles.duration}>{formatDuration(segment.durationSeconds)}</span>
            </div>
            <div className={styles.body}>
              <div className={styles.header}>
                <span className={styles.app}>{segment.appName || segment.processName || '未知应用'}</span>
                {segment.isPrivate && (
                  <span className={styles.lock} title="隐私窗口被保护">
                    <Shield size={12} />
                  </span>
                )}
                <span className={styles.title} title={segment.windowTitle}>
                  {segment.isPrivate ? '[隐私窗口被保护]' : segment.windowTitle || '无标题'}
                </span>
                <Badge variant={STATUS_VARIANT[segment.sourceStatus]} size="sm">
                  {STATUS_LABEL[segment.sourceStatus]}
                </Badge>
              </div>
              {!segment.isPrivate && segment.ocrSummary && (
                <p className={styles.ocr}>{segment.ocrSummary}</p>
              )}
              {segment.userNote && (
                <p className={styles.note}>{segment.userNote}</p>
              )}
              {segment.tags.length > 0 && (
                <div className={styles.tags}>
                  {segment.tags.map((tag) => (
                    <Badge key={tag} variant="accent" size="sm">{tag}</Badge>
                  ))}
                </div>
              )}
            </div>
            <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
              <IconButton
                label={segment.isImportant ? '取消重点' : '标为重点'}
                size="sm"
                variant="ghost"
                className={segment.isImportant ? styles.importantActive : ''}
                icon={<Star size={14} fill={segment.isImportant ? 'currentColor' : 'none'} />}
                onClick={() => onToggleImportant(segment.id, !segment.isImportant)}
              />
              <label className={styles.check} title="勾选参与日报">
                <input
                  type="checkbox"
                  className={styles.checkInput}
                  checked={segment.isSelectedForReport}
                  onChange={(e) => onToggleReport(segment.id, e.target.checked)}
                />
                <span className={styles.checkBox} />
              </label>
              <IconButton
                label="删除片段"
                size="sm"
                variant="ghost"
                icon={<Trash2 size={14} />}
                onClick={() => onSegmentDelete(segment.id)}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
