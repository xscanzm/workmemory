/**
 * OcrQueue：OCR 处理队列
 *
 * 与截图队列解耦，串行处理 pending Segments（避免 CPU 抢占）。
 *
 * 职责：
 *  - 队列管理：pending Segments 入队，串行处理
 *  - processNext()：取队首 Segment → 读取临时截图 → OcrEngine.recognize →
 *    更新 Segment（ocr_text, ocr_summary, source_status）→ 删除临时截图 →
 *    触发 EpisodeBuilder 重新聚合
 *  - 空闲资源管理：队列空后启动 10 秒计时器，到期调用 OcrEngine.release()，
 *    新任务到来时重新 loadModel
 *  - 事件：'ocr-completed'(segmentId)、'ocr-failed'(segmentId, error)、
 *    'queue-idle'、'queue-drained'
 *
 * 并发控制：默认单任务串行（CPU OCR 不宜并发），可配置。
 */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import type { WorkSegment } from '@/types'
import { SegmentRepository } from '../db/repositories/SegmentRepository'
import { Screenshot } from '../capture/Screenshot'
import type { PpOcrEngine } from './PpOcrEngine'
import type { OcrResult } from './PpOcrEngine'

/** OcrQueue 配置 */
export interface OcrQueueConfig {
  /** 是否保存截图（true 时 OCR 后不删除临时截图） */
  saveScreenshots: boolean
  /** 并发数（默认 1，CPU OCR 串行） */
  concurrency: number
  /** 空闲释放时长（毫秒，默认 10000） */
  idleReleaseMs: number
}

/** 默认配置 */
const DEFAULT_CONFIG: OcrQueueConfig = {
  saveScreenshots: false,
  concurrency: 1,
  idleReleaseMs: 10000
}

/** ocr_summary 截断长度 */
const OCR_SUMMARY_MAX_LENGTH = 100

/**
 * OcrQueue：OCR 处理队列。
 *
 * 事件：
 *  - 'ocr-completed'：单个 Segment OCR 完成，携带 segmentId
 *  - 'ocr-failed'：单个 Segment OCR 失败，携带 segmentId 和 error
 *  - 'queue-idle'：队列空闲计时器到期，引擎已释放
 *  - 'queue-drained'：队列从非空变为空
 */
export class OcrQueue extends EventEmitter {
  private engine: PpOcrEngine
  private config: OcrQueueConfig

  /** 待处理队列（segmentId 去重） */
  private queue: string[] = []
  /** 正在处理中的 segmentId 集合 */
  private processing: Set<string> = new Set()
  /** 队列是否已启动 */
  private running = false
  /** 空闲释放计时器 */
  private idleTimer: NodeJS.Timeout | null = null
  /** 是否正在处理中（防止 processNext 重入） */
  private processingLock = false

  constructor(engine: PpOcrEngine, config?: Partial<OcrQueueConfig>) {
    super()
    this.engine = engine
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 更新配置 */
  updateConfig(patch: Partial<OcrQueueConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  /** 启动队列 */
  start(): void {
    this.running = true
    // 启动时处理已有任务
    this.scheduleProcess()
  }

  /** 停止队列 */
  stop(): void {
    this.running = false
    this.cancelIdleTimer()
  }

  /** 入队一个 Segment */
  enqueue(segmentId: string): void {
    if (this.queue.includes(segmentId) || this.processing.has(segmentId)) {
      return
    }
    this.queue.push(segmentId)
    // 新任务到来，取消空闲释放计时器
    this.cancelIdleTimer()
    if (this.running) {
      this.scheduleProcess()
    }
  }

  /** 获取队列大小（待处理 + 处理中） */
  getQueueSize(): number {
    return this.queue.length + this.processing.size
  }

  /** 队列是否为空 */
  isEmpty(): boolean {
    return this.queue.length === 0 && this.processing.size === 0
  }

  // ===================== 内部处理 =====================

  /** 调度处理下一批任务（受并发数限制） */
  private scheduleProcess(): void {
    if (!this.running) return
    if (this.processingLock) return

    const availableSlots = this.config.concurrency - this.processing.size
    for (let i = 0; i < availableSlots && this.queue.length > 0; i++) {
      const segmentId = this.queue.shift()!
      this.processing.add(segmentId)
      void this.processSegment(segmentId)
    }
  }

  /** 处理单个 Segment */
  private async processSegment(segmentId: string): Promise<void> {
    try {
      await this.processNext(segmentId)
    } catch (e) {
      console.error(`[OcrQueue] 处理 Segment ${segmentId} 异常:`, e instanceof Error ? e.message : String(e))
      this.emit('ocr-failed', segmentId, e instanceof Error ? e : new Error(String(e)))
    } finally {
      this.processing.delete(segmentId)
      this.onTaskCompleted()
    }
  }

  /**
   * processNext：取队首 Segment → 读取临时截图 → OcrEngine.recognize →
   * 更新 Segment → 删除临时截图 → 触发 EpisodeBuilder 重新聚合
   */
  private async processNext(segmentId: string): Promise<void> {
    // 1. 读取 Segment
    const segment = SegmentRepository.getById(segmentId)
    if (!segment) {
      console.warn(`[OcrQueue] Segment ${segmentId} 不存在，跳过`)
      return
    }

    // 已删除的 Segment 跳过
    if (segment.isDeleted) {
      return
    }

    // 非 pending 状态跳过（已处理过）
    if (segment.sourceStatus !== 'pending') {
      return
    }

    // 2. 读取临时截图
    const screenshotPath = segment.screenshotPath
    if (!screenshotPath || !fs.existsSync(screenshotPath)) {
      // 无截图文件，标记为 ocr_failed
      SegmentRepository.update(segmentId, {
        sourceStatus: 'ocr_failed',
        ocrText: '',
        ocrSummary: ''
      })
      this.emit('ocr-failed', segmentId, new Error(`截图文件不存在: ${screenshotPath}`))
      return
    }

    // 3. 确保引擎已加载
    if (!this.engine.isLoaded()) {
      try {
        await this.engine.initialize()
      } catch (e) {
        // 引擎初始化失败（无可用后端），标记为 ocr_failed
        SegmentRepository.update(segmentId, {
          sourceStatus: 'ocr_failed',
          ocrText: '',
          ocrSummary: ''
        })
        this.emit('ocr-failed', segmentId, e instanceof Error ? e : new Error(String(e)))
        return
      }
    }

    // 初始化后仍未加载（无可用后端，进入"未配置"状态）：
    // 保持 segment 为 pending 状态，不标记 ocr_failed
    if (!this.engine.isLoaded()) {
      console.warn(`[OcrQueue] OCR 后端未配置，Segment ${segmentId} 保持 pending 状态`)
      return
    }

    // 4. 读取截图 Buffer 并执行 OCR
    let imageBuffer: Buffer
    try {
      imageBuffer = fs.readFileSync(screenshotPath)
    } catch (e) {
      SegmentRepository.update(segmentId, {
        sourceStatus: 'ocr_failed',
        ocrText: '',
        ocrSummary: ''
      })
      this.emit('ocr-failed', segmentId, new Error(`读取截图文件失败: ${e instanceof Error ? e.message : String(e)}`))
      return
    }

    try {
      const result = await this.engine.recognize(imageBuffer)
      this.onOcrSuccess(segment, result)
    } catch (e) {
      this.onOcrFailure(segment, e instanceof Error ? e : new Error(String(e)))
    }
  }

  /** OCR 成功回调 */
  private onOcrSuccess(segment: WorkSegment, result: OcrResult): void {
    const trimmedText = result.text.trim()
    const summary = trimmedText.slice(0, OCR_SUMMARY_MAX_LENGTH)

    // 判断状态：有文本 → ocr_done，无文本 → no_text
    const sourceStatus = trimmedText.length > 0 ? 'ocr_done' : 'no_text'
    const sourceQuality =
      sourceStatus === 'ocr_done'
        ? result.confidence >= 0.85
          ? 'high'
          : result.confidence >= 0.55
            ? 'medium'
            : 'low'
        : 'low'

    SegmentRepository.update(segment.id, {
      ocrText: trimmedText,
      ocrSummary: summary,
      sourceStatus,
      ocrBlocks: result.boxes.map((box) => ({
        text: '',
        box,
        confidence: result.confidence
      })),
      ocrConfidence: result.confidence,
      sourceQuality
    })

    // 删除临时截图（若未开启保存）
    if (!this.config.saveScreenshots && segment.screenshotPath) {
      Screenshot.deleteTempScreenshot(segment.screenshotPath)
    }

    this.emit('ocr-completed', segment.id)
  }

  /** OCR 失败回调 */
  private onOcrFailure(segment: WorkSegment, error: Error): void {
    console.error(`[OcrQueue] Segment ${segment.id} OCR 失败:`, error.message)
    SegmentRepository.update(segment.id, {
      sourceStatus: 'ocr_failed',
      ocrText: '',
      ocrSummary: '',
      ocrBlocks: [],
      ocrConfidence: 0,
      sourceQuality: 'failed'
    })

    // 失败也删除临时截图（若未开启保存）
    if (!this.config.saveScreenshots && segment.screenshotPath) {
      Screenshot.deleteTempScreenshot(segment.screenshotPath)
    }

    this.emit('ocr-failed', segment.id, error)
  }

  /** 单个任务完成后的处理 */
  private onTaskCompleted(): void {
    // 尝试处理更多任务
    if (this.queue.length > 0) {
      this.scheduleProcess()
      return
    }

    // 队列已空
    if (this.isEmpty()) {
      this.emit('queue-drained')
      this.startIdleTimer()
    }
  }

  // ===================== 空闲资源管理 =====================

  /** 启动空闲释放计时器 */
  private startIdleTimer(): void {
    this.cancelIdleTimer()
    this.idleTimer = setTimeout(() => {
      if (this.isEmpty()) {
        this.engine.release()
        this.emit('queue-idle')
      }
      this.idleTimer = null
    }, this.config.idleReleaseMs)
  }

  /** 取消空闲释放计时器 */
  private cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
