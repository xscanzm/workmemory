/**
 * TextField 文本输入框
 * 带标签、错误提示、可选左侧图标与 hint，sm/md/lg 三种尺寸。
 * 6px 圆角，聚焦时 accent 边框 + 光晕，错误态 danger 边框。
 */
import * as React from 'react'
import { forwardRef } from 'react'

export type TextFieldSize = 'sm' | 'md' | 'lg'

export interface TextFieldProps extends Omit<React.ComponentProps<'input'>, 'size'> {
  /** 标签 */
  label?: string
  /** 错误信息，传入后显示 danger 边框与错误文案 */
  error?: string
  /** 提示文案 */
  hint?: string
  /** 左侧图标 */
  leftIcon?: React.ReactNode
  /** 尺寸 */
  size?: TextFieldSize
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    error,
    hint,
    leftIcon,
    size = 'md',
    className,
    id,
    required,
    disabled,
    ...rest
  },
  ref
) {
  const fieldId = id ?? rest.name ?? undefined
  const wrapClasses = [
    'wm-ui-textfield',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  const inputWrapClasses = [
    'wm-ui-textfield-inputwrap',
    `wm-ui-textfield-inputwrap--${size}`,
    leftIcon ? 'wm-ui-textfield-inputwrap--has-lefticon' : '',
    error ? 'wm-ui-textfield-inputwrap--error' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={wrapClasses}>
      {label && (
        <label className="wm-ui-textfield-label" htmlFor={fieldId}>
          {label}
          {required && <span aria-hidden> *</span>}
        </label>
      )}
      <div className={inputWrapClasses}>
        {leftIcon && (
          <span className="wm-ui-textfield-lefticon" aria-hidden>
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={fieldId}
          className="wm-ui-textfield-input"
          disabled={disabled}
          required={required}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
      </div>
      {error ? (
        <span className="wm-ui-textfield-error" role="alert">{error}</span>
      ) : hint ? (
        <span className="wm-ui-textfield-hint">{hint}</span>
      ) : null}
    </div>
  )
})
