/**
 * Select 下拉选择
 * 封装 @radix-ui/react-select，导出 Select/SelectTrigger/SelectValue/SelectContent/SelectItem。
 * 触发器 32px 高、6px 圆角，内容区 8px 圆角 + 卡片阴影，选中项展示 Check 图标。
 */
import * as React from 'react'
import { forwardRef } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { Check, ChevronDown } from './icons'

/** Select Root：受控/非受控根容器 */
export const Select: React.FC<React.ComponentProps<typeof SelectPrimitive.Root>> = (props) => (
  <SelectPrimitive.Root {...props} />
)

/** Select Value：展示当前选中值或占位符 */
export const SelectValue: React.FC<React.ComponentProps<typeof SelectPrimitive.Value>> = (props) => (
  <SelectPrimitive.Value {...props} />
)

export interface SelectTriggerProps
  extends React.ComponentProps<typeof SelectPrimitive.Trigger> {}

/** Select Trigger：触发器，右侧带 chevron-down 图标 */
export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(function SelectTrigger(
  { className, children, ...rest },
  ref
) {
  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={`wm-ui-select-trigger ${className ?? ''}`.trim()}
      {...rest}
    >
      {children}
      <ChevronDown size={14} className="wm-ui-select-chevron" aria-hidden />
    </SelectPrimitive.Trigger>
  )
})

export interface SelectContentProps
  extends React.ComponentProps<typeof SelectPrimitive.Content> {}

/** Select Content：弹出内容区，含 Portal 与滚动视口 */
export const SelectContent: React.FC<SelectContentProps> = ({
  className,
  children,
  position = 'popper',
  sideOffset = 4,
  ...rest
}) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      position={position}
      sideOffset={sideOffset}
      className={`wm-ui-select-content ${className ?? ''}`.trim()}
      {...rest}
    >
      <SelectPrimitive.Viewport className="wm-ui-select-viewport">
        {children}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
)

export interface SelectItemProps
  extends React.ComponentProps<typeof SelectPrimitive.Item> {}

/** Select Item：选项，高亮态 surface-alt 背景，选中态展示 Check 图标 */
export const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(function SelectItem(
  { className, children, ...rest },
  ref
) {
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={`wm-ui-select-item ${className ?? ''}`.trim()}
      {...rest}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="wm-ui-select-item-indicator">
        <Check size={14} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
})
