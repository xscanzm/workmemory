/**
 * 全局记录状态 Store（zustand）
 * 管理：记录状态、隐私模式、右侧上下文面板选中项、数据刷新触发器。
 */
import { create } from 'zustand'
import type { Episode, WorkSegment, RecordingState } from '@/types'

/** 搜索匹配原因 */
export interface MatchReason {
  dimension: 'ocr' | 'project' | 'time' | 'person'
  label: string
  detail: string
  matchedTerms: string[]
}

/** 右侧上下文面板的选中项（判别联合） */
export type ContextPayload =
  | { type: 'episode'; episode: Episode; segments: WorkSegment[] }
  | { type: 'segment'; segment: WorkSegment }
  | { type: 'day'; date: string; summary: string; episodes: Episode[]; hasReport: boolean }
  | { type: 'search-match'; reasons: MatchReason[]; episode: Episode }
  | { type: 'empty' }

interface RecordingStore {
  /** 当前记录状态 */
  recordingState: RecordingState
  /** 是否处于隐私模式 */
  privacyMode: boolean
  /** 右侧上下文面板选中项 */
  contextItem: ContextPayload | null
  /** 数据刷新触发器（变更后递增以触发页面重新查询） */
  refreshTrigger: number

  setRecordingState: (state: RecordingState) => void
  setPrivacyMode: (privacy: boolean) => void
  setContextItem: (item: ContextPayload | null) => void
  triggerRefresh: () => void
}

export const useRecordingStore = create<RecordingStore>((set) => ({
  recordingState: 'idle',
  privacyMode: false,
  contextItem: null,
  refreshTrigger: 0,

  setRecordingState: (state) => set({ recordingState: state }),
  setPrivacyMode: (privacy) => set({ privacyMode: privacy }),
  setContextItem: (item) => set({ contextItem: item }),
  triggerRefresh: () => set((s) => ({ refreshTrigger: s.refreshTrigger + 1 }))
}))
