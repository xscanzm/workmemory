/**
 * Dialog 对话框
 * 封装 @radix-ui/react-dialog，导出 Dialog/DialogTrigger/DialogContent/DialogHeader/
 * DialogTitle/DialogDescription/DialogFooter/DialogClose。
 * 内容区 8px 圆角 + 窗口阴影 + 默认 480px 最大宽度，遮罩 rgba(0,0,0,0.4) 淡入，
 * 右上角 X 关闭按钮，ESC 默认关闭（Radix 行为）。
 */
import * as React from 'react'
import { forwardRef } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from './icons'

/** Dialog Root：受控/非受控根容器 */
export const Dialog: React.FC<React.ComponentProps<typeof DialogPrimitive.Root>> = (props) => (
  <DialogPrimitive.Root {...props} />
)

/** Dialog Trigger：触发器 */
export const DialogTrigger: React.FC<React.ComponentProps<typeof DialogPrimitive.Trigger>> = (props) => (
  <DialogPrimitive.Trigger {...props} />
)

export interface DialogContentProps extends React.ComponentProps<typeof DialogPrimitive.Content> {}

/** Dialog Content：内容区，含遮罩与右上角关闭按钮 */
export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(function DialogContent(
  { className, children, ...rest },
  ref
) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="wm-ui-dialog-overlay" />
      <DialogPrimitive.Content
        ref={ref}
        className={`wm-ui-dialog-content ${className ?? ''}`.trim()}
        {...rest}
      >
        {children}
        <DialogPrimitive.Close className="wm-ui-dialog-close" aria-label="关闭">
          <X size={16} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

/** Dialog Header：标题区容器 */
export const DialogHeader: React.FC<React.ComponentProps<'div'>> = ({ className, ...rest }) => (
  <div className={`wm-ui-dialog-header ${className ?? ''}`.trim()} {...rest} />
)

/** Dialog Title：标题 */
export const DialogTitle: React.FC<React.ComponentProps<typeof DialogPrimitive.Title>> = (props) => (
  <DialogPrimitive.Title className="wm-ui-dialog-title" {...props} />
)

/** Dialog Description：描述文案 */
export const DialogDescription: React.FC<React.ComponentProps<typeof DialogPrimitive.Description>> = (props) => (
  <DialogPrimitive.Description className="wm-ui-dialog-description" {...props} />
)

/** Dialog Footer：底部操作区 */
export const DialogFooter: React.FC<React.ComponentProps<'div'>> = ({ className, ...rest }) => (
  <div className={`wm-ui-dialog-footer ${className ?? ''}`.trim()} {...rest} />
)

/** Dialog Close：关闭触发器，可包裹自定义关闭按钮 */
export const DialogClose: React.FC<React.ComponentProps<typeof DialogPrimitive.Close>> = (props) => (
  <DialogPrimitive.Close {...props} />
)
