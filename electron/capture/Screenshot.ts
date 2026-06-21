/**
 * Screenshot：屏幕截图采集 + 感知哈希（dHash）
 *
 * 截图能力：
 *  - captureWindow(hwnd)：通过 Electron desktopCapturer 匹配窗口句柄截图
 *  - captureScreen()：截取整屏（仅供显式整屏降级调用，不自动触发）
 *  - captureActiveWindow(hwnd)：截取指定前台窗口，返回 ScreenshotResult
 *
 * 截图降级策略（V0.4 Trust & Beauty）：
 *  - captureActiveWindow 找不到目标窗口时返回 { status:'failed', reason:'window_not_found' }，
 *    绝不自动调用 captureScreen()。
 *  - 整屏降级需由调用方（CaptureDecision）在用户显式开启 allowFullScreenshotFallback
 *    时主动调用 captureScreen()，并在结果中携带 displayBounds 以明确多屏范围。
 *
 * 临时/持久截图管理：
 *  - saveTempScreenshot(buffer)：保存到系统临时目录，OCR 后由调用方删除
 *  - deleteTempScreenshot(path)：删除临时截图
 *  - saveScreenshot(buffer, date, segmentId)：按设置保存到 userData/screenshots/YYYY-MM-DD/
 *  - cleanExpiredScreenshots(maxDays)：清理过期截图
 *
 * 感知哈希（纯 JS dHash 实现，不依赖外部图像库）：
 *  - calculateImageHash(buffer)：8x8 dHash，缩放到 9x8 灰度，比较相邻像素得 64bit 字符串
 *  - hammingDistance(hash1, hash2)：汉明距离
 *  - isSimilar(hash1, hash2, threshold)：相似度判定
 */
import { app, desktopCapturer, nativeImage, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 屏幕范围（display bounds），整屏降级时记录以明确多屏范围 */
export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 截图来源：窗口截图或整屏降级截图 */
export type ScreenshotSource = 'window' | 'screen'

/** 截图失败原因 */
export type ScreenshotFailureReason = 'window_not_found' | 'capture_error' | 'empty_image'

/** 截图成功结果 */
export interface ScreenshotSuccess {
  status: 'ok'
  buffer: Buffer
  width: number
  height: number
  /** 截图来源：window=活跃窗口，screen=整屏降级 */
  source: ScreenshotSource
  /** 屏幕范围，仅整屏降级（source='screen'）时携带，用于多屏范围明确 */
  displayBounds?: DisplayBounds
}

/** 截图失败结果 */
export interface ScreenshotFailure {
  status: 'failed'
  reason: ScreenshotFailureReason
  /** 可选错误描述（capture_error 时携带） */
  error?: string
}

/** 截图结果（判别联合）：成功携带画面，失败携带原因，调用方据此决定跳过或显式整屏降级 */
export type ScreenshotResult = ScreenshotSuccess | ScreenshotFailure

/** 临时截图目录名 */
const TEMP_DIR_NAME = 'workmemory-screenshots'
/** dHash 宽度（9 列，比较 8 对相邻像素） */
const DHASH_WIDTH = 9
/** dHash 高度（8 行） */
const DHASH_HEIGHT = 8
/** 默认相似度阈值 */
const DEFAULT_SIMILARITY_THRESHOLD = 10

/**
 * Screenshot 模块：封装截图采集与图像哈希计算。
 * 所有方法为静态方法，在主进程（Node 环境）中运行。
 */
export class Screenshot {
  /**
   * 截取指定窗口区域。通过 desktopCapturer.getSources({types:['window']}) 匹配 hwnd。
   * Electron 源 ID 格式为 "window:{hwnd}:{index}"，从中解析 hwnd 进行匹配。
   *
   * 失败语义（V0.4 截图降级策略）：
   *  - hwnd 为 0 或匹配不到目标窗口 → { status:'failed', reason:'window_not_found' }
   *  - 缩略图为空 → { status:'failed', reason:'empty_image' }
   *  - 异常 → { status:'failed', reason:'capture_error', error }
   *  本方法绝不自动调用 captureScreen()，整屏降级由调用方显式决策。
   */
  static async captureWindow(hwnd: number): Promise<ScreenshotResult> {
    if (!hwnd) {
      return { status: 'failed', reason: 'window_not_found' }
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: Screenshot.getCaptureThumbnailSize()
      })
      const target = sources.find(s => {
        // 从 source.id 解析 hwnd：格式 "window:{hwnd}:{index}"
        const parts = s.id.split(':')
        if (parts.length >= 2) {
          const sourceHwnd = parseInt(parts[1], 10)
          if (sourceHwnd === hwnd) return true
        }
        return false
      })
      if (!target) {
        return { status: 'failed', reason: 'window_not_found' }
      }
      const success = Screenshot.nativeImageToSuccess(target.thumbnail)
      if (!success) {
        return { status: 'failed', reason: 'empty_image' }
      }
      return { status: 'ok', source: 'window', ...success }
    } catch (e) {
      console.warn('[Screenshot] captureWindow 失败:', e instanceof Error ? e.message : String(e))
      return {
        status: 'failed',
        reason: 'capture_error',
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  /**
   * 截取整屏。
   * 仅供显式整屏降级调用（CaptureDecision 在 allowFullScreenshotFallback=true 时主动调用），
   * 不由 captureActiveWindow 自动触发。
   *
   * 成功结果携带 displayBounds（匹配 source.display_id 到 screen.getAllDisplays()，
   * 匹配不到时回退到主屏 bounds），用于多屏范围明确与日志审计。
   */
  static async captureScreen(): Promise<ScreenshotResult> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: Screenshot.getCaptureThumbnailSize()
      })
      if (sources.length === 0) {
        return { status: 'failed', reason: 'capture_error', error: 'No screen source available' }
      }
      const source = sources[0]
      const success = Screenshot.nativeImageToSuccess(source.thumbnail)
      if (!success) {
        return { status: 'failed', reason: 'empty_image' }
      }
      const displayBounds = Screenshot.resolveDisplayBounds(source.display_id)
      return { status: 'ok', source: 'screen', displayBounds, ...success }
    } catch (e) {
      console.warn('[Screenshot] captureScreen 失败:', e instanceof Error ? e.message : String(e))
      return {
        status: 'failed',
        reason: 'capture_error',
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  /**
   * 截取指定前台窗口画面（通过 hwnd 匹配）。
   * 找不到目标窗口时返回 { status:'failed', reason:'window_not_found' }，
   * **不**调用 captureScreen()——整屏降级需由调用方在用户显式开启后主动决策。
   */
  static async captureActiveWindow(hwnd: number): Promise<ScreenshotResult> {
    return Screenshot.captureWindow(hwnd)
  }

  /**
   * 保存临时截图到系统临时目录。返回文件绝对路径。
   * OCR 完成后由调用方调用 deleteTempScreenshot 删除。
   */
  static saveTempScreenshot(buffer: Buffer): string {
    const tempDir = path.join(os.tmpdir(), TEMP_DIR_NAME)
    Screenshot.ensureDir(tempDir)
    const fileName = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    const filePath = path.join(tempDir, fileName)
    fs.writeFileSync(filePath, buffer)
    return filePath
  }

  /**
   * 删除临时截图文件。文件不存在时静默忽略。
   */
  static deleteTempScreenshot(filePath: string): void {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (e) {
      console.warn('[Screenshot] 删除临时截图失败:', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 计算图像的 dHash（difference hash）。
   *
   * 算法：
   *  1. 使用 Electron nativeImage 将图像缩放到 9x8
   *  2. 获取位图原始像素数据
   *  3. 转为灰度（RGB 三通道平均值，通道顺序无关）
   *  4. 逐行比较相邻像素亮度：左 > 右 记 1，否则记 0
   *  5. 得到 64 bit 哈希字符串
   *
   * 纯 JS 实现，不依赖外部图像处理库。
   */
  static calculateImageHash(buffer: Buffer): string {
    try {
      const image = nativeImage.createFromBuffer(buffer)
      if (image.isEmpty()) return ''
      const resized = image.resize({ width: DHASH_WIDTH, height: DHASH_HEIGHT })
      const bitmap = resized.toBitmap()
      // toBitmap 返回 RGBA 或 BGRA 格式（4 字节/像素），通道顺序不影响灰度平均值
      const grayValues: number[] = []
      const bytesPerPixel = 4
      for (let y = 0; y < DHASH_HEIGHT; y++) {
        for (let x = 0; x < DHASH_WIDTH; x++) {
          const offset = (y * DHASH_WIDTH + x) * bytesPerPixel
          const r = bitmap[offset]
          const g = bitmap[offset + 1]
          const b = bitmap[offset + 2]
          // 简单平均灰度（通道顺序无关，保证跨平台一致性）
          grayValues.push((r + g + b) / 3)
        }
      }
      // dHash：逐行比较相邻像素
      let hash = ''
      for (let y = 0; y < DHASH_HEIGHT; y++) {
        for (let x = 0; x < DHASH_WIDTH - 1; x++) {
          const idx = y * DHASH_WIDTH + x
          hash += grayValues[idx] > grayValues[idx + 1] ? '1' : '0'
        }
      }
      return hash
    } catch (e) {
      console.warn('[Screenshot] calculateImageHash 失败:', e instanceof Error ? e.message : String(e))
      return ''
    }
  }

  /**
   * 计算两个 dHash 字符串的汉明距离。
   * 长度不一致或为空时返回最大距离（64）。
   */
  static hammingDistance(hash1: string, hash2: string): number {
    if (!hash1 || !hash2 || hash1.length !== hash2.length) return 64
    let distance = 0
    for (let i = 0; i < hash1.length; i++) {
      if (hash1[i] !== hash2[i]) distance++
    }
    return distance
  }

  /**
   * 判断两个哈希是否相似。距离 <= threshold 视为相似。
   */
  static isSimilar(hash1: string, hash2: string, threshold: number = DEFAULT_SIMILARITY_THRESHOLD): boolean {
    if (!hash1 || !hash2) return false
    return Screenshot.hammingDistance(hash1, hash2) <= threshold
  }

  /**
   * 按设置保存截图到 userData/screenshots/YYYY-MM-DD/。
   * 返回保存路径；保存失败返回空字符串。
   */
  static saveScreenshot(buffer: Buffer, date: string, segmentId: string): string {
    try {
      const dir = path.join(app.getPath('userData'), 'screenshots', date)
      Screenshot.ensureDir(dir)
      const fileName = `${segmentId}.png`
      const filePath = path.join(dir, fileName)
      fs.writeFileSync(filePath, buffer)
      return filePath
    } catch (e) {
      console.warn('[Screenshot] saveScreenshot 失败:', e instanceof Error ? e.message : String(e))
      return ''
    }
  }

  /**
   * 清理过期截图。删除早于 maxDays 天的 screenshots/YYYY-MM-DD/ 目录。
   */
  static cleanExpiredScreenshots(maxDays: number): void {
    if (maxDays <= 0) return
    try {
      const root = path.join(app.getPath('userData'), 'screenshots')
      if (!fs.existsSync(root)) return
      const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000
      const entries = fs.readdirSync(root)
      for (const entry of entries) {
        const fullPath = path.join(root, entry)
        const stat = fs.statSync(fullPath)
        if (stat.isDirectory()) {
          // entry 格式 YYYY-MM-DD
          const dirTime = new Date(entry).getTime()
          if (!isNaN(dirTime) && dirTime < cutoff) {
            fs.rmSync(fullPath, { recursive: true, force: true })
          }
        }
      }
    } catch (e) {
      console.warn('[Screenshot] cleanExpiredScreenshots 失败:', e instanceof Error ? e.message : String(e))
    }
  }

  // ===================== 内部工具 =====================

  /** 将 NativeImage 转换为成功结果的画面字段（buffer/width/height），空图返回 null */
  private static nativeImageToSuccess(
    image: Electron.NativeImage
  ): { buffer: Buffer; width: number; height: number } | null {
    if (image.isEmpty()) return null
    const size = image.getSize()
    const buffer = image.toPNG()
    return { buffer, width: size.width, height: size.height }
  }

  /**
   * 解析整屏截图所对应的 display bounds（多屏范围明确）。
   * 优先按 display_id 匹配 screen.getAllDisplays()；匹配不到时回退到主屏 bounds；
   * screen API 异常时返回零值 bounds（不阻断降级流程，仅日志缺失范围）。
   */
  private static resolveDisplayBounds(displayId: string): DisplayBounds {
    try {
      const displays = screen.getAllDisplays()
      if (displayId) {
        const matched = displays.find(d => d.id.toString() === displayId)
        if (matched) return { ...matched.bounds }
      }
      const primary = screen.getPrimaryDisplay()
      return { ...primary.bounds }
    } catch (e) {
      console.warn(
        '[Screenshot] resolveDisplayBounds 失败，回退零值 bounds:',
        e instanceof Error ? e.message : String(e)
      )
      return { x: 0, y: 0, width: 0, height: 0 }
    }
  }

  /**
   * 获取截图请求尺寸。
   * Electron 的 display.bounds 是 DIP 坐标，scaleFactor 才是物理像素比例。
   * OCR 需要尽量保留屏幕文字像素，不能在 2K/4K 或 125%/150% 缩放下固定压到 1080p。
   */
  private static getCaptureThumbnailSize(): { width: number; height: number } {
    try {
      const displays = screen.getAllDisplays()
      if (displays.length === 0) {
        return { width: 1920, height: 1080 }
      }

      let width = 0
      let height = 0
      let minX = Number.POSITIVE_INFINITY
      let minY = Number.POSITIVE_INFINITY
      let maxRight = Number.NEGATIVE_INFINITY
      let maxBottom = Number.NEGATIVE_INFINITY
      let maxScaleFactor = 1
      for (const display of displays) {
        width = Math.max(width, Math.ceil(display.bounds.width * display.scaleFactor))
        height = Math.max(height, Math.ceil(display.bounds.height * display.scaleFactor))
        minX = Math.min(minX, display.bounds.x)
        minY = Math.min(minY, display.bounds.y)
        maxRight = Math.max(maxRight, display.bounds.x + display.bounds.width)
        maxBottom = Math.max(maxBottom, display.bounds.y + display.bounds.height)
        maxScaleFactor = Math.max(maxScaleFactor, display.scaleFactor)
      }

      const virtualWidth = Math.ceil((maxRight - minX) * maxScaleFactor)
      const virtualHeight = Math.ceil((maxBottom - minY) * maxScaleFactor)

      return {
        width: Math.max(width, virtualWidth, 1920),
        height: Math.max(height, virtualHeight, 1080)
      }
    } catch {
      return { width: 1920, height: 1080 }
    }
  }

  /** 确保目录存在 */
  private static ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
}
