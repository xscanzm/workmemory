/**
 * Toast 全局通知
 * 基于 zustand store + React portal 实现的右上角堆叠通知系统。
 * 导出 useToastStore 状态、ToastContainer 渲染容器、toast 命令式助手。
 * 每条通知按 variant 着色左边框与图标，默认 3000ms 自动消失。
 */
import * as React from 'react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { AlertCircle, CheckCircle, Info, X, XCircle } from './icons'

export type ToastVariant = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  variant: ToastVariant
  title: string
  description?: string
  duration?: number
}

interface ToastState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'>) => string
  remove: (id: string) => void
}

// Toast.tsx 需同时导出组件（ToastContainer）与命令式助手（useToastStore/toast），
// 此处刻意放宽 react-refresh 规则：store 与 helper 为稳定单例，不影响热更新正确性。
// eslint-disable-next-line react-refresh/only-export-components
export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = `wm-toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    return id
  },
  remove: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
}))

const VARIANT_ICON: Record<ToastVariant, React.ReactNode> = {
  info: <Info size={16} />,
  success: <CheckCircle size={16} />,
  warning: <AlertCircle size={16} />,
  error: <XCircle size={16} />
}

interface ToastItemProps {
  toast: Toast
  remove: (id: string) => void
}

const ToastItem: React.FC<ToastItemProps> = ({ toast, remove }) => {
  useEffect(() => {
    const duration = toast.duration ?? 3000
    const timer = window.setTimeout(() => remove(toast.id), duration)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.duration, remove])

  return (
    <div className={`wm-ui-toast wm-ui-toast--${toast.variant}`} role="status">
      <span className={`wm-ui-toast-icon wm-ui-toast-icon--${toast.variant}`} aria-hidden>
        {VARIANT_ICON[toast.variant]}
      </span>
      <div className="wm-ui-toast-body">
        <span className="wm-ui-toast-title">{toast.title}</span>
        {toast.description && <span className="wm-ui-toast-desc">{toast.description}</span>}
      </div>
      <button
        type="button"
        className="wm-ui-toast-close"
        onClick={() => remove(toast.id)}
        aria-label="关闭通知"
      >
        <X size={14} />
      </button>
    </div>
  )
}

/** ToastContainer：渲染到 document.body 的通知堆叠容器，全局放置一次即可。 */
export const ToastContainer: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts)
  const remove = useToastStore((s) => s.remove)

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="wm-ui-toast-viewport" role="region" aria-label="通知">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} remove={remove} />
      ))}
    </div>,
    document.body
  )
}

/** toast 命令式助手：可在任意位置（组件内外）调用以弹出通知。 */
// eslint-disable-next-line react-refresh/only-export-components
export const toast = {
  info: (title: string, description?: string): string =>
    useToastStore.getState().push({ variant: 'info', title, description }),
  success: (title: string, description?: string): string =>
    useToastStore.getState().push({ variant: 'success', title, description }),
  warning: (title: string, description?: string): string =>
    useToastStore.getState().push({ variant: 'warning', title, description }),
  error: (title: string, description?: string): string =>
    useToastStore.getState().push({ variant: 'error', title, description })
}
