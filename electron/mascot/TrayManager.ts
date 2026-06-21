/**
 * TrayManager：系统托盘管理
 *
 * 功能：
 *  - 创建 Tray（用 nativeImage 绘制简易托盘图标：纯色圆形+小点）
 *  - 托盘图标颜色随状态变化（绿=recording/黄=paused/紫=privacy）
 *  - 托盘右键菜单：打开主窗口、暂停/恢复记录、隐私模式、生成日报、设置、退出
 *  - 双击托盘：显示主窗口
 *  - updateIcon(state)：更新托盘图标颜色
 *
 * 图标通过纯代码生成 PNG buffer（无外部图片依赖）。
 */
import { Tray, Menu, nativeImage, app } from 'electron'
import type { MascotState } from '@/types'
import { showMainWindow as showAppMainWindow } from '../main/window'
import { getCaptureManager } from '../capture/CaptureManager'
import zlib from 'node:zlib'

/** 托盘图标尺寸 */
const ICON_SIZE = 16

/** 状态颜色映射（RGB） */
const STATE_COLORS: Record<MascotState, [number, number, number]> = {
  recording: [34, 181, 106], // 绿色 #22b56a
  paused: [245, 166, 35], // 黄色 #f5a623
  privacy: [139, 92, 246], // 紫色 #8b5cf6
  ocr_scanning: [34, 197, 216], // 青色 #22c5d8
  report_ready: [43, 127, 255] // 蓝色 #2b7fff
}

/**
 * TrayManager：系统托盘管理器。
 */
export class TrayManager {
  private tray: Tray | null = null
  private currentState: MascotState = 'recording'

  /** 回调：打开主窗口并导航到指定页面 */
  onNavigate?: (page: string) => void
  /** 回调：生成今日日报 */
  onGenerateReport?: () => void

  /** 创建系统托盘 */
  create(): void {
    if (this.tray) return

    const icon = this.createIcon(this.currentState)
    this.tray = new Tray(icon)
    this.tray.setToolTip('WorkMemory 今日记忆')
    this.updateContextMenu()
    this.tray.on('double-click', () => {
      this.showMainWindow()
    })
  }

  /** 更新托盘图标颜色 */
  updateIcon(state: MascotState): void {
    this.currentState = state
    if (!this.tray) return
    const icon = this.createIcon(state)
    this.tray.setImage(icon)
  }

  /** 更新右键菜单 */
  updateContextMenu(): void {
    if (!this.tray) return

    const captureManager = getCaptureManager()
    const recordingState = captureManager.getRecordingState()
    const isPaused = recordingState === 'paused'

    const menu = Menu.buildFromTemplate([
      {
        label: '打开主窗口',
        click: (): void => {
          this.showMainWindow()
        }
      },
      { type: 'separator' },
      {
        label: isPaused ? '恢复记录' : '暂停记录',
        click: (): void => {
          if (isPaused) {
            captureManager.resumeCapture()
          } else {
            captureManager.pauseCapture()
          }
          this.updateContextMenu()
        }
      },
      {
        label: '生成今日日报',
        click: (): void => {
          if (this.onGenerateReport) {
            this.onGenerateReport()
          } else {
            this.showMainWindow()
            this.onNavigate?.('reports')
          }
        }
      },
      { type: 'separator' },
      {
        label: '设置',
        click: (): void => {
          this.showMainWindow()
          this.onNavigate?.('settings')
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: (): void => {
          app.quit()
        }
      }
    ])

    this.tray.setContextMenu(menu)
  }

  /** 显示主窗口 */
  showMainWindow(): void {
    showAppMainWindow()
  }

  /** 获取托盘实例 */
  getTray(): Tray | null {
    return this.tray
  }

  /** 销毁托盘 */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
  }

  // ===================== 图标生成 =====================

  /**
   * 创建托盘图标（纯色圆形+中心白点）。
   * 通过纯代码生成 PNG buffer，无外部图片依赖。
   */
  private createIcon(state: MascotState): Electron.NativeImage {
    const color = STATE_COLORS[state] ?? STATE_COLORS.recording
    const pngBuffer = this.createCirclePng(ICON_SIZE, ICON_SIZE, color)
    return nativeImage.createFromBuffer(pngBuffer)
  }

  /**
   * 生成圆形图标的 PNG buffer。
   * 中心为白色小点，外围为状态颜色圆，背景透明。
   */
  private createCirclePng(
    width: number,
    height: number,
    color: [number, number, number]
  ): Buffer {
    const [r, g, b] = color
    const centerX = width / 2
    const centerY = height / 2
    const outerRadius = Math.min(width, height) / 2 - 1
    const dotRadius = Math.max(1.5, outerRadius * 0.3)

    /** 获取像素颜色 RGBA */
    const getPixel = (x: number, y: number): [number, number, number, number] => {
      const dx = x - centerX + 0.5
      const dy = y - centerY + 0.5
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist <= dotRadius) {
        // 中心白点
        return [255, 255, 255, 255]
      }
      if (dist <= outerRadius) {
        // 状态颜色圆
        // 边缘抗锯齿
        const edgeAlpha = dist > outerRadius - 1 ? (outerRadius - dist) : 1
        return [r, g, b, Math.round(255 * Math.max(0, Math.min(1, edgeAlpha)))]
      }
      // 透明背景
      return [0, 0, 0, 0]
    }

    return this.encodePng(width, height, getPixel)
  }

  /**
   * 最小 PNG 编码器。
   * 生成 RGBA 8-bit PNG，使用 zlib deflate 压缩。
   */
  private encodePng(
    width: number,
    height: number,
    getPixel: (x: number, y: number) => [number, number, number, number]
  ): Buffer {
    // PNG 签名
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

    // IHDR 数据
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // color type: RGBA
    ihdr[10] = 0 // compression method
    ihdr[11] = 0 // filter method
    ihdr[12] = 0 // interlace method

    // 原始像素数据（每行前加 filter type 字节）
    const rowSize = 1 + width * 4
    const rawData = Buffer.alloc(height * rowSize)
    for (let y = 0; y < height; y++) {
      const rowOffset = y * rowSize
      rawData[rowOffset] = 0 // filter type: none
      for (let x = 0; x < width; x++) {
        const [r, g, b, a] = getPixel(x, y)
        const pixelOffset = rowOffset + 1 + x * 4
        rawData[pixelOffset] = r
        rawData[pixelOffset + 1] = g
        rawData[pixelOffset + 2] = b
        rawData[pixelOffset + 3] = a
      }
    }

    // zlib 压缩
    const compressedData = zlib.deflateSync(rawData)

    // 组装 PNG chunks
    return Buffer.concat([
      signature,
      this.createChunk('IHDR', ihdr),
      this.createChunk('IDAT', compressedData),
      this.createChunk('IEND', Buffer.alloc(0))
    ])
  }

  /** 创建 PNG chunk */
  private createChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typeBuffer = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(this.crc32(Buffer.concat([typeBuffer, data])), 0)
    return Buffer.concat([length, typeBuffer, data, crc])
  }

  /** CRC32 计算（PNG 标准） */
  private crc32(buf: Buffer): number {
    const table = this.getCrc32Table()
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  /** CRC32 查找表（懒加载缓存） */
  private crc32Table: Uint32Array | null = null

  private getCrc32Table(): Uint32Array {
    if (this.crc32Table) return this.crc32Table
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) {
        if (c & 1) {
          c = 0xedb88320 ^ (c >>> 1)
        } else {
          c = c >>> 1
        }
      }
      table[n] = c
    }
    this.crc32Table = table
    return table
  }
}
