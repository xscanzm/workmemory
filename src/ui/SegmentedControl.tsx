/**
 * SegmentedControl 分段选择器
 * 类 iOS 分段控件，容器 surface-alt 背景，激活段 surface 背景 + accent 文本 + 阴影。
 */
import * as React from 'react'

export interface SegmentedOption {
  value: string
  label: string
  icon?: React.ReactNode
}

export interface SegmentedControlProps extends Omit<React.ComponentProps<'div'>, 'onChange'> {
  /** 选项列表 */
  options: SegmentedOption[]
  /** 当前值 */
  value: string
  /** 值变更回调 */
  onChange: (value: string) => void
  /** 尺寸 */
  size?: 'sm' | 'md'
  /** 选项 name，用于无障碍分组 */
  name?: string
}

export const SegmentedControl: React.FC<SegmentedControlProps> = ({
  options,
  value,
  onChange,
  size = 'md',
  name,
  className,
  ...rest
}) => {
  const autoId = React.useId()
  const groupName = name ?? `wm-ui-segmented-${autoId}`
  const containerClasses = [
    'wm-ui-segmented',
    `wm-ui-segmented--${size}`,
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={containerClasses} role="radiogroup" {...rest}>
      {options.map((option) => {
        const active = option.value === value
        const itemClasses = [
          'wm-ui-segmented-item',
          `wm-ui-segmented-item--${size}`,
          active ? 'wm-ui-segmented-item--active' : ''
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={itemClasses}
            onClick={() => onChange(option.value)}
          >
            {option.icon && <span aria-hidden>{option.icon}</span>}
            {option.label}
          </button>
        )
      })}
      <input type="hidden" name={groupName} value={value} readOnly />
    </div>
  )
}
