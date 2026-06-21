/**
 * Timeline 垂直时间线
 * 导出 Timeline 容器与 TimelineItem 条目。左侧 12px 轨道承载圆点与连接线，
 * dotColor 自定义圆点颜色，dotIcon 替换圆点为任意节点，last 隐藏连接线。
 */
import * as React from 'react'

/** Timeline 容器 */
export const Timeline: React.FC<React.ComponentProps<'div'>> = ({ className, children, ...rest }) => (
  <div className={`wm-ui-timeline ${className ?? ''}`.trim()} {...rest}>
    {children}
  </div>
)

export interface TimelineItemProps extends React.ComponentProps<'div'> {
  /** 圆点颜色，默认 accent */
  dotColor?: string
  /** 自定义圆点内容，替换默认圆点 */
  dotIcon?: React.ReactNode
  /** 是否为最后一项，隐藏下方连接线 */
  last?: boolean
}

/** Timeline 条目：左侧圆点+连接线，右侧内容 */
export const TimelineItem: React.FC<TimelineItemProps> = ({
  dotColor,
  dotIcon,
  last = false,
  className,
  children,
  ...rest
}) => {
  const dotStyle: React.CSSProperties | undefined = dotColor
    ? { background: dotColor, boxShadow: `0 0 0 1px ${dotColor}` }
    : undefined

  return (
    <div className={`wm-ui-timeline-item ${className ?? ''}`.trim()} {...rest}>
      <div className="wm-ui-timeline-rail">
        {dotIcon ? (
          <span className="wm-ui-timeline-dot wm-ui-timeline-dot--custom">{dotIcon}</span>
        ) : (
          <span className="wm-ui-timeline-dot" style={dotStyle} />
        )}
        {!last && <span className="wm-ui-timeline-line" aria-hidden />}
      </div>
      <div className="wm-ui-timeline-content">{children}</div>
    </div>
  )
}
