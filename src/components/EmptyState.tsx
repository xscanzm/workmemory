/**
 * 空状态占位组件
 * 用于无数据时真实展示（带图标 + 文案 + 可选操作按钮）。
 */
import { Card, FileText } from '@/ui'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  icon?: JSX.Element
  title: string
  description?: string
  action?: JSX.Element
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps): JSX.Element {
  return (
    <Card variant="solid" padding="lg" className={styles.state}>
      <div className={styles.icon}>{icon ?? <FileText size={48} />}</div>
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.desc}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </Card>
  )
}
