/// <reference types="vite/client" />
import type { WorkMemoryApi } from './types/ipc'

declare global {
  interface Window {
    workmemory: WorkMemoryApi
  }
}

export {}
