/**
 * IconButton 图标按钮
 * 正方形图标按钮，内置 Tooltip 提示，复用 Button 的变体与尺寸体系。
 * label 同时作为 tooltip 文案与 aria-label，保证无障碍可访问性。
 */
import * as React from 'react'
import { forwardRef } from 'react'
import { Loader2 } from './icons'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './Tooltip'
import type { ButtonSize, ButtonVariant } from './Button'

export interface IconButtonProps extends React.ComponentProps<'button'> {
  /** 必填：用于 tooltip 文案与 aria-label */
  label: string
  /** 图标节点 */
  icon: React.ReactNode
  /** 尺寸 */
  size?: ButtonSize
  /** 变体 */
  variant?: ButtonVariant
  /** 加载态 */
  loading?: boolean
}

const SPINNER_SIZE: Record<ButtonSize, number> = { sm: 12, md: 14, lg: 16 }

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    size = 'md',
    variant = 'ghost',
    loading = false,
    disabled,
    className,
    type,
    onClick,
    ...rest
  },
  ref
) {
  const classes = [
    'wm-ui-iconbutton',
    `wm-ui-iconbutton--${size}`,
    `wm-ui-iconbutton--${variant}`,
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={classes}
      disabled={disabled || loading}
      aria-label={label}
      aria-busy={loading || undefined}
      onClick={onClick}
      {...rest}
    >
      {loading ? (
        <Loader2 size={SPINNER_SIZE[size]} className="wm-ui-iconbutton-spinner" aria-hidden />
      ) : (
        icon
      )}
    </button>
  )

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})
