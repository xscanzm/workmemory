/**
 * Tooltip 气泡提示
 * 封装 @radix-ui/react-tooltip，提供统一样式与 200ms 默认延迟。
 */
import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

/** Tooltip Provider：作为 Root，提供全局延迟与跳过间隔配置。 */
export const TooltipProvider: React.FC<
  React.ComponentProps<typeof TooltipPrimitive.Provider>
> = ({ delayDuration = 200, skipDelayDuration = 300, ...rest }) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...rest} />
)

/** Tooltip Root：控制单个 tooltip 的开关状态。 */
export const Tooltip: React.FC<React.ComponentProps<typeof TooltipPrimitive.Root>> = (props) => (
  <TooltipPrimitive.Root {...props} />
)

/** Tooltip Trigger：触发器，默认作为子元素的包裹。 */
export const TooltipTrigger: React.FC<React.ComponentProps<typeof TooltipPrimitive.Trigger>> = (props) => (
  <TooltipPrimitive.Trigger {...props} />
)

export interface TooltipContentProps
  extends React.ComponentProps<typeof TooltipPrimitive.Content> {
  /** 弹出方位，默认 top */
  side?: 'top' | 'right' | 'bottom' | 'left'
}

/** Tooltip Content：气泡内容，深色背景白字。 */
export const TooltipContent: React.FC<TooltipContentProps> = ({
  side = 'top',
  sideOffset = 6,
  className,
  children,
  ...rest
}) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      side={side}
      sideOffset={sideOffset}
      className={`wm-ui-tooltip-content ${className ?? ''}`.trim()}
      {...rest}
    >
      {children}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
)
