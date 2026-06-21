/**
 * Badge 状态徽标
 * 胶囊形状，支持 default/accent/success/warning/danger/privacy/cyan 七种颜色变体，
 * 可选前置圆点，sm/md 两种尺寸。
 */
import * as React from 'react'

export type BadgeVariant =
  | 'default'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'privacy'
  | 'cyan'
export type BadgeSize = 'sm' | 'md'

export interface BadgeProps extends React.ComponentProps<'span'> {
  variant?: BadgeVariant
  size?: BadgeSize
  /** 是否在内容前渲染彩色圆点 */
  dot?: boolean
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  size = 'md',
  dot = false,
  className,
  children,
  ...rest
}) => {
  const classes = [
    'wm-ui-badge',
    `wm-ui-badge--${variant}`,
    `wm-ui-badge--${size}`,
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={classes} {...rest}>
      {dot && <span className="wm-ui-badge-dot" aria-hidden />}
      {children}
    </span>
  )
}
