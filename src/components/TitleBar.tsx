import { useEffect, useState } from 'react'
import { IconButton, Minus, Square, X } from '@/ui'
import styles from './TitleBar.module.css'

/**
 * 自定义标题栏：可拖拽区域 + 最小化/最大化/关闭按钮（6px 圆角）。
 * 通过 -webkit-app-region: drag 实现窗口拖拽，按钮区域设为 no-drag。
 */
export function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState<boolean>(false)

  useEffect(() => {
    const dispose = window.workmemory.window.onMaximizeChange(setMaximized)
    void window.workmemory.window
      .isMaximized()
      .then(setMaximized)
      .catch(() => setMaximized(false))
    return dispose
  }, [])

  const handleMinimize = (): void => {
    void window.workmemory.window.minimize()
  }
  const handleMaximize = (): void => {
    void window.workmemory.window.maximize()
  }
  const handleClose = (): void => {
    void window.workmemory.window.close()
  }

  return (
    <div className={styles.titlebar}>
      <div className={styles.drag}>
        <span className={styles.logo}>WorkMemory</span>
        <span className={styles.sub}>今日记忆</span>
      </div>
      <div className={styles.actions}>
        <IconButton
          label="最小化"
          size="sm"
          variant="ghost"
          icon={<Minus size={12} />}
          onClick={handleMinimize}
        />
        <IconButton
          label={maximized ? '还原' : '最大化'}
          size="sm"
          variant="ghost"
          icon={<Square size={11} />}
          onClick={handleMaximize}
        />
        <IconButton
          label="关闭"
          size="sm"
          variant="ghost"
          className={styles.closeBtn}
          icon={<X size={12} />}
          onClick={handleClose}
        />
      </div>
    </div>
  )
}
