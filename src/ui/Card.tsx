/**
 * Card 卡片容器
 * 8px 圆角，支持 solid/acrylic 两种背景、elevated 阴影、selected 强调边框，
 * 传入 onClick 时变为可点击（含键盘可达性）。
 */
import * as React from 'react'
import { forwardRef } from 'react'

export type CardVariant = 'solid' | 'acrylic'
export type CardPadding = 'sm' | 'md' | 'lg'

export interface CardProps extends React.ComponentProps<'div'> {
  /** 背景变体，solid 实色 / acrylic 亚克力毛玻璃 */
  variant?: CardVariant
  /** 内边距：sm=8 / md=12 / lg=16 */
  padding?: CardPadding
  /** 是否添加卡片阴影 */
  elevated?: boolean
  /** 选中态：accent 边框 + 强调阴影 */
  selected?: boolean
  /** 点击回调，传入后卡片变为可点击并支持键盘操作 */
  onClick?: React.MouseEventHandler<HTMLDivElement>
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  {
    variant = 'solid',
    padding = 'md',
    elevated = false,
    selected = false,
    onClick,
    className,
    children,
    ...rest
  },
  ref
) {
  const clickable = Boolean(onClick)
  const classes = [
    'wm-ui-card',
    `wm-ui-card--${variant}`,
    `wm-ui-card--pad-${padding}`,
    elevated ? 'wm-ui-card--elevated' : '',
    clickable ? 'wm-ui-card--clickable' : '',
    selected ? 'wm-ui-card--selected' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    if (!onClick) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick(e as unknown as React.MouseEvent<HTMLDivElement>)
    }
  }

  return (
    <div
      ref={ref}
      className={classes}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? handleKeyDown : undefined}
      aria-pressed={clickable ? selected : undefined}
      {...rest}
    >
      {children}
    </div>
  )
})
