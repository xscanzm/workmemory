/**
 * Switch 开关
 * 封装 @radix-ui/react-switch，36x20 轨道 + 16x16 滑块，
 * 选中态 accent 背景，可选左侧 label。
 */
import * as React from 'react'
import { forwardRef } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

export interface SwitchProps extends React.ComponentProps<typeof SwitchPrimitive.Root> {
  /** 可选标签，渲染在开关左侧 */
  label?: string
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { label, checked, onCheckedChange, disabled, className, ...rest },
  ref
) {
  const root = (
    <SwitchPrimitive.Root
      ref={ref}
      className={`wm-ui-switch-root ${className ?? ''}`.trim()}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      {...rest}
    >
      <SwitchPrimitive.Thumb className="wm-ui-switch-thumb" />
    </SwitchPrimitive.Root>
  )

  if (!label) return root

  return (
    <label className="wm-ui-switch-wrap">
      <span className="wm-ui-switch-label">{label}</span>
      {root}
    </label>
  )
})
