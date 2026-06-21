/**
 * 记录状态条
 * 显示"正在记录/已暂停/已保护"状态点（绿色/黄色/紫色）+ 文字 + 一键暂停/隐私模式按钮。
 */
import { useRecordingStore } from '../store/recordingStore'
import type { RecordingState } from '@/types'
import { Badge, Button, Pause, Play, Shield, type BadgeVariant } from '@/ui'
import styles from './StatusBar.module.css'

interface StatusBarProps {
  onTogglePause: () => void
  onTogglePrivacy: () => void
}

interface StateConfig {
  label: string
  color: string
  bg: string
  badgeVariant: BadgeVariant
}

const STATE_CONFIG: Record<RecordingState, StateConfig> = {
  recording: { label: '正在记录', color: '#22b56a', bg: 'rgba(34, 181, 106, 0.1)', badgeVariant: 'success' },
  paused: { label: '已暂停', color: '#f5a623', bg: 'rgba(245, 166, 35, 0.1)', badgeVariant: 'warning' },
  idle: { label: '空闲', color: '#8a98aa', bg: 'rgba(138, 152, 170, 0.1)', badgeVariant: 'default' },
  privacy: { label: '已保护', color: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.1)', badgeVariant: 'privacy' }
}

export function StatusBar({ onTogglePause, onTogglePrivacy }: StatusBarProps): JSX.Element {
  const recordingState = useRecordingStore((s) => s.recordingState)
  const privacyMode = useRecordingStore((s) => s.privacyMode)

  const effectiveState: RecordingState = privacyMode ? 'privacy' : recordingState
  const config = STATE_CONFIG[effectiveState]
  const isPaused = recordingState === 'paused'

  return (
    <div className={styles.bar} style={{ background: config.bg }}>
      <div className={styles.indicator}>
        <span className={styles.dot} style={{ background: config.color }}>
          {effectiveState === 'recording' && (
            <span className={styles.pulse} style={{ borderColor: config.color }} />
          )}
        </span>
        <Badge variant={config.badgeVariant} size="md" dot>
          {config.label}
        </Badge>
      </div>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={isPaused ? <Play size={14} /> : <Pause size={14} />}
          onClick={onTogglePause}
          disabled={privacyMode}
        >
          {isPaused ? '恢复记录' : '暂停记录'}
        </Button>
        <Button
          variant={privacyMode ? 'primary' : 'secondary'}
          size="sm"
          leftIcon={<Shield size={14} />}
          onClick={onTogglePrivacy}
        >
          {privacyMode ? '退出隐私模式' : '隐私模式'}
        </Button>
      </div>
    </div>
  )
}
