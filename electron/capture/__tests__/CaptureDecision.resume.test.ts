import { describe, expect, it, vi } from 'vitest'
import { CaptureDecision } from '../CaptureDecision'
import type { WindowInfo } from '../WindowWatcher'

const WINDOW_INFO: WindowInfo = {
  hwnd: 1001,
  processName: 'Code.exe',
  processPath: 'C:\\Program Files\\Code\\Code.exe',
  windowTitle: 'main.ts - WorkMemory',
  appName: 'Code'
}

function createDecision(): CaptureDecision {
  const watcher = {
    on: () => undefined,
    removeListener: () => undefined
  }
  const screenshot = {}
  const privacyGuard = {
    isPrivacyMode: () => false
  }

  return new CaptureDecision(
    watcher as never,
    screenshot as never,
    privacyGuard as never
  )
}

describe('CaptureDecision wakeFromActivity', () => {
  it('从 idle 恢复到 recording', () => {
    const decision = createDecision()
    const states: string[] = []

    decision.on('state-change', (payload) => {
      states.push(payload.state)
    })

    decision.start()
    expect(decision.getState()).toBe('recording')

    ;(decision as unknown as { state: string }).state = 'idle'
    decision.wakeFromActivity(null)

    expect(decision.getState()).toBe('recording')
    expect(states.at(-1)).toBe('recording')
  })

  it('手动 paused 时不会被自动唤醒', () => {
    const decision = createDecision()
    decision.start()
    decision.pause()

    decision.wakeFromActivity(WINDOW_INFO)

    expect(decision.getState()).toBe('paused')
  })

  it('进入 idle 时保留当前片段上下文，恢复后可继续合并同一段', () => {
    vi.useFakeTimers()
    try {
      const decision = createDecision()
      const current = decision as unknown as {
        currentSegmentId: string | null
        currentSegmentStart: Date | null
        currentSegmentApp: string
        lastImageHash: string
        resetIdleTimer: () => void
      }

      decision.start()
      current.currentSegmentId = 'segment-1'
      current.currentSegmentStart = new Date('2026-06-21T15:03:00.000Z')
      current.currentSegmentApp = 'Code'
      current.lastImageHash = 'hash-1'

      current.resetIdleTimer()
      vi.advanceTimersByTime(3 * 60 * 1000)

      expect(decision.getState()).toBe('idle')
      expect(current.currentSegmentId).toBe('segment-1')
      expect(current.currentSegmentStart?.toISOString()).toBe('2026-06-21T15:03:00.000Z')
      expect(current.currentSegmentApp).toBe('Code')
      expect(current.lastImageHash).toBe('hash-1')
    } finally {
      vi.useRealTimers()
    }
  })
})
