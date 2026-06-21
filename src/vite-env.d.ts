/// <reference types="vite/client" />
import type { WorkMemoryApi } from '../electron/types/ipc'

declare global {
  interface Window {
    workmemory: WorkMemoryApi
  }
}

export {}
