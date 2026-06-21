/**
 * MemoryCard 记忆卡片
 * Episode 记忆卡片，时间线式左侧圆点+连接线，右侧内容含应用图标、时间、时长、
 * 标题、摘要、主题标签、实体标签、日报勾选与展开操作。亚克力背景，选中态 accent 强调。
 */
import * as React from 'react'
import { ChevronDown } from './icons'
import { Badge } from './Badge'
import { IconButton } from './IconButton'

/** 实体类型 */
export type MemoryEntityType = 'person' | 'project' | 'document' | 'url'

export interface MemoryEntity {
  type: MemoryEntityType
  name: string
  /** 置信度 0-1（可选，未提供视为高置信） */
  confidence?: number
  /** 用户已确认 */
  userConfirmed?: boolean
}

export interface MemoryAppIcon {
  name: string
  color: string
}

export interface MemoryCardProps extends React.ComponentProps<'div'> {
  /** 时间范围，如 "14:00 - 15:30" */
  time: string
  /** 时长，如 "1h 30m" */
  duration: string
  /** 标题 */
  title: string
  /** 一句话摘要 */
  summary: string
  /** 主题标签 */
  topics?: string[]
  /** 实体列表 */
  entities?: MemoryEntity[]
  /** 应用图标列表 */
  appIcons?: MemoryAppIcon[]
  /** 选中态 */
  selected?: boolean
  /** 展开态 */
  expanded?: boolean
  /** 是否参与日报 */
  reportEligible?: boolean
  /** 选中回调 */
  onSelect?: () => void
  /** 展开/折叠回调 */
  onToggleExpand?: () => void
  /** 日报勾选回调 */
  onToggleReport?: (eligible: boolean) => void
  /** 自定义操作区 */
  actions?: React.ReactNode
}

const ENTITY_VARIANT: Record<MemoryEntityType, 'accent' | 'success' | 'warning' | 'default'> = {
  person: 'accent',
  project: 'success',
  document: 'warning',
  url: 'default'
}

function AppIconBadge({ name, color }: MemoryAppIcon): JSX.Element {
  const initial = name.charAt(0).toUpperCase() || '?'
  return (
    <span
      className="wm-ui-memorycard-appicon"
      style={{ background: `${color}1a`, color }}
      title={name}
    >
      {initial}
    </span>
  )
}

export const MemoryCard: React.FC<MemoryCardProps> = ({
  time,
  duration,
  title,
  summary,
  topics,
  entities,
  appIcons,
  selected = false,
  expanded = false,
  reportEligible = false,
  onSelect,
  onToggleExpand,
  onToggleReport,
  actions,
  children,
  className,
  ...rest
}) => {
  const classes = [
    'wm-ui-memorycard',
    selected ? 'wm-ui-memorycard--selected' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const visibleApps = appIcons?.slice(0, 3) ?? []
  const extraApps = appIcons && appIcons.length > 3 ? appIcons.length - 3 : 0

  const stop: React.MouseEventHandler = (e) => e.stopPropagation()

  return (
    <div
      className={classes}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect()
              }
            }
          : undefined
      }
      aria-pressed={onSelect ? selected : undefined}
      {...rest}
    >
      <div className="wm-ui-timeline-rail">
        <span className="wm-ui-timeline-dot" />
        <span className="wm-ui-timeline-line" aria-hidden />
      </div>

      <div className="wm-ui-memorycard-content">
        <div className="wm-ui-memorycard-header">
          <div className="wm-ui-memorycard-apps">
            {visibleApps.map((app) => (
              <AppIconBadge key={app.name} name={app.name} color={app.color} />
            ))}
            {extraApps > 0 && <span className="wm-ui-memorycard-apps-more">+{extraApps}</span>}
          </div>
          <div className="wm-ui-memorycard-meta">
            <span className="wm-ui-memorycard-time">{time}</span>
            <Badge variant="default" size="sm">
              {duration}
            </Badge>
          </div>
        </div>

        <h3 className="wm-ui-memorycard-title">{title}</h3>
        <p className="wm-ui-memorycard-summary">{summary}</p>

        {topics && topics.length > 0 && (
          <div className="wm-ui-memorycard-tags">
            {topics.map((topic) => (
              <Badge key={topic} variant="cyan" size="sm">
                {topic}
              </Badge>
            ))}
          </div>
        )}

        {entities && entities.length > 0 && (
          <div className="wm-ui-memorycard-entities">
            {entities.map((entity, i) => {
              const isLowConfidence = !entity.userConfirmed && typeof entity.confidence === 'number' && entity.confidence < 0.5
              return (
                <Badge
                  key={`${entity.type}-${entity.name}-${i}`}
                  variant={ENTITY_VARIANT[entity.type]}
                  size="sm"
                  className={isLowConfidence ? 'wm-ui-memorycard-entity-low' : undefined}
                  title={isLowConfidence ? `低置信度实体（${Math.round((entity.confidence as number) * 100)}%）` : undefined}
                >
                  {entity.name}
                  {isLowConfidence && <span className="wm-ui-memorycard-entity-mark">?</span>}
                </Badge>
              )
            })}
          </div>
        )}

        <div className="wm-ui-memorycard-actions" onClick={stop}>
          {onToggleReport && (
            <label className="wm-ui-memorycard-report" title="勾选参与日报">
              <input
                type="checkbox"
                checked={reportEligible}
                onChange={(e) => onToggleReport(e.target.checked)}
              />
              <span>日报</span>
            </label>
          )}
          {actions && <div className="wm-ui-memorycard-actions-slot">{actions}</div>}
          {onToggleExpand && (
            <IconButton
              label={expanded ? '折叠' : '展开'}
              size="sm"
              variant="ghost"
              icon={
                <ChevronDown
                  size={14}
                  style={{
                    transform: expanded ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s'
                  }}
                />
              }
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
            />
          )}
        </div>

        {expanded && children && <div className="wm-ui-memorycard-expanded">{children}</div>}
      </div>
    </div>
  )
}
