/**
 * OcrManager：OCR 编排层单例
 *
 * 整合 OcrEngine + OcrQueue，提供统一入口。
 *
 * 职责：
 *  - initialize()：app ready 后调用，创建引擎与队列，监听 CaptureManager 事件
 *  - 监听 CaptureManager 的 'segment-created' 事件，自动 enqueue 新 pending Segment
 *  - setModel(tiny|small)：切换模型
 *  - 暴露 IPC：ocr:getStatus、ocr:setModel、ocr:reprocess
 *  - setSaveScreenshots(enabled)：联动截图保存设置
 *
 * 单例导出 getOcrManager()。
 */
import type { OcrModel, WorkSegment } from '@/types'
import { PpOcrEngine, getBackendStatus, type BackendStatus } from './PpOcrEngine'
import { OcrQueue } from './OcrQueue'
import { getCaptureManager } from '../capture/CaptureManager'
import { SegmentRepository } from '../db/repositories/SegmentRepository'

/** OCR 管理器状态 */
export interface OcrManagerStatus {
  backend: string
  model: OcrModel
  loaded: boolean
  queueSize: number
  running: boolean
  configured: boolean
}

/**
 * OcrManager：OCR 编排层。
 *
 * 不直接 emit 事件，事件由 OcrQueue 转发（ocr-completed、ocr-failed 等）。
 */
export class OcrManager {
  private engine: PpOcrEngine
  private queue: OcrQueue
  private initialized = false
  private running = false
  private configured = false
  private saveScreenshots = false

  constructor() {
    this.engine = new PpOcrEngine()
    this.queue = new OcrQueue(this.engine, {
      saveScreenshots: false,
      concurrency: 1,
      idleReleaseMs: 5 * 60 * 1000
    })
  }

  /**
   * 初始化：app ready 后调用。
   * 创建引擎、启动队列、监听 CaptureManager 事件。
   * 无可用后端时进入"未配置"状态：记录警告日志，不抛未捕获异常，
   * OCR 队列暂停（不 enqueue、不处理），segment.source_status 停留 'pending'，
   * CaptureManager 仍可运行（截图照常，只是不 OCR）。
   */
  async initialize(model: OcrModel = 'tiny'): Promise<void> {
    if (this.initialized) return

    // 尝试初始化引擎（无可用后端时进入"未配置"状态，不抛错）
    try {
      await this.engine.initialize(model)
    } catch (e) {
      console.warn('[OcrManager] OCR 引擎初始化异常:', e instanceof Error ? e.message : String(e))
    }

    // 检测是否已配置后端
    this.configured = this.engine.isLoaded()
    if (!this.configured) {
      console.warn('[OcrManager] OCR 后端未配置，OCR 队列暂停。截图功能正常，segment 将保持 pending 状态。')
    }

    // 启动队列（队列内部会检测引擎是否可用，无后端时不处理）
    this.queue.start()
    this.running = true

    // 监听 CaptureManager 的 segment-created 事件
    const captureManager = getCaptureManager()
    captureManager.on('segment-created', (segment: WorkSegment) => {
      this.onSegmentCreated(segment)
    })

    this.initialized = true
    if (this.configured) {
      console.log('[OcrManager] 初始化完成')
    } else {
      console.log('[OcrManager] 初始化完成（未配置 OCR 后端）')
    }
  }

  /** CaptureManager segment-created 回调：自动 enqueue pending Segment */
  private onSegmentCreated(segment: WorkSegment): void {
    // OCR 后端未配置时不入队，segment 保持 pending 状态
    if (!this.configured) {
      return
    }
    // 仅入队 pending 状态的 Segment（非隐私占位）
    if (segment.sourceStatus === 'pending' && !segment.isPrivate && !segment.isDeleted) {
      this.queue.enqueue(segment.id)
    }
  }

  /** 获取 OcrQueue 实例（供 EpisodeManager 订阅事件） */
  getQueue(): OcrQueue {
    return this.queue
  }

  /** 获取 OcrEngine 实例 */
  getEngine(): PpOcrEngine {
    return this.engine
  }

  /** 获取当前状态 */
  getStatus(): OcrManagerStatus {
    return {
      backend: this.engine.getBackendName(),
      model: this.engine.getModel(),
      loaded: this.engine.isLoaded(),
      queueSize: this.queue.getQueueSize(),
      running: this.running,
      configured: this.configured
    }
  }

  /** 获取当前模型 */
  getModel(): OcrModel {
    return this.engine.getModel()
  }

  /**
   * 获取 OCR runtime 状态：后端类型（paddleocr/tesseract/unconfigured）、模型路径、可用性。
   * 供 IPC ocr:getRuntimeStatus 与设置页展示使用。
   */
  getRuntimeStatus(): BackendStatus {
    return getBackendStatus(this.engine.getModel())
  }

  /**
   * 切换模型（tiny / small）。
   * 释放当前引擎后重新加载新模型。
   * 无可用后端时返回 false。
   */
  async setModel(model: OcrModel): Promise<boolean> {
    try {
      await this.engine.setModel(model)
      const loaded = this.engine.isLoaded()
      this.configured = loaded
      return loaded
    } catch (e) {
      console.error('[OcrManager] 切换模型失败:', e instanceof Error ? e.message : String(e))
      this.configured = this.engine.isLoaded()
      return false
    }
  }

  /**
   * 重新处理指定 Segment。
   * 将 Segment 重置为 pending 状态并重新入队。
   * OCR 后端未配置时返回 false（segment 保持 pending 但不入队）。
   */
  reprocess(segmentId: string): boolean {
    const segment = SegmentRepository.getById(segmentId)
    if (!segment) {
      return false
    }
    // 重置为 pending 状态
    SegmentRepository.update(segmentId, {
      sourceStatus: 'pending',
      ocrText: '',
      ocrSummary: ''
    })
    // OCR 后端未配置时不入队，segment 保持 pending
    if (!this.configured) {
      return false
    }
    this.queue.enqueue(segmentId)
    return true
  }

  /** 设置是否保存截图（联动 OcrQueue） */
  setSaveScreenshots(enabled: boolean): void {
    this.saveScreenshots = enabled
    this.queue.updateConfig({ saveScreenshots: enabled })
  }

  /** 手动入队 Segment（OCR 后端未配置时忽略） */
  enqueue(segmentId: string): void {
    if (!this.configured) {
      return
    }
    this.queue.enqueue(segmentId)
  }

  /**
   * 直接识别指定图片路径的文本（绕过队列，供 IPC ocr:recognize 使用）。
   * 读取图片文件为 Buffer，调用引擎识别，返回识别文本。
   * 无可用后端或读取失败时抛错，不返回伪造数据。
   */
  async recognizeImagePath(imagePath: string): Promise<string> {
    if (!this.configured) {
      throw new Error('未配置 OCR 后端，请先安装 PP-OCRv6 或 Tesseract')
    }
    const fs = await import('node:fs')
    if (!fs.existsSync(imagePath)) {
      throw new Error(`图片文件不存在: ${imagePath}`)
    }
    // 确保引擎已加载（可能因空闲释放而 unloaded）
    if (!this.engine.isLoaded()) {
      await this.engine.initialize()
    }
    const imageBuffer = fs.readFileSync(imagePath)
    const result = await this.engine.recognize(imageBuffer)
    return result.text
  }

  /** 停止管理器 */
  stop(): void {
    this.queue.stop()
    this.engine.release()
    this.running = false
  }
}

// ===================== 单例 =====================

let managerInstance: OcrManager | null = null

/** 获取 OcrManager 单例 */
export function getOcrManager(): OcrManager {
  if (!managerInstance) {
    managerInstance = new OcrManager()
  }
  return managerInstance
}

/** 重置单例（仅供测试） */
export function resetOcrManager(): void {
  if (managerInstance) {
    managerInstance.stop()
    managerInstance = null
  }
}
