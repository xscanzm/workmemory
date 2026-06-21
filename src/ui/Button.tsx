/**
 * Button 通用按钮
 * 支持 primary/secondary/ghost/danger 四种变体与 sm/md/lg 三种尺寸，
 * loading 态展示 Loader2 旋转图标并禁用，支持左右图标与 fullWidth。
 */
import * as React from 'react'
import { forwardRef } from 'react'
import { Loader2 } from './icons'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ComponentProps<'button'> {
  /** 按钮变体 */
  variant?: ButtonVariant
  /** 按钮尺寸 */
  size?: ButtonSize
  /** 加载态：展示旋转图标并禁用 */
  loading?: boolean
  /** 左侧图标 */
  leftIcon?: React.ReactNode
  /** 右侧图标 */
  rightIcon?: React.ReactNode
  /** 是否撑满父容器宽度 */
  fullWidth?: boolean
}

const SPINNER_SIZE: Record<ButtonSize, number> = { sm: 12, md: 14, lg: 16 }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    disabled,
    className,
    children,
    type,
    ...rest
  },
  ref
) {
  const classes = [
    'wm-ui-button',
    `wm-ui-button--${variant}`,
    `wm-ui-button--${size}`,
    fullWidth ? 'wm-ui-button--full' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && (
        <Loader2 size={SPINNER_SIZE[size]} className="wm-ui-button-spinner" aria-hidden />
      )}
      {!loading && leftIcon && (
        <span className="wm-ui-button-icon wm-ui-button-icon-left" aria-hidden>
          {leftIcon}
        </span>
      )}
      {children}
      {!loading && rightIcon && (
        <span className="wm-ui-button-icon wm-ui-button-icon-right" aria-hidden>
          {rightIcon}
        </span>
      )}
    </button>
  )
})
