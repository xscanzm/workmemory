/**
 * OcrRuntimeManager：OCR runtime 管理与健康检查
 *
 * 职责：
 *  - getRuntimeStatus()：检测当前后端类型（PP-OCRv6/Tesseract/未配置）、模型路径、可用性
 *  - healthCheck()：检测可执行文件/命令是否存在，返回结构化健康状态
 *  - testRecognize(imagePath)：用当前后端识别指定图片，返回 { ok, text?, elapsedMs?, error? }
 *  - openInstallDir()：用 Electron shell.openPath 打开 resources/ocr 资源目录（若不存在则创建）
 *
 * 设计约束：
 *  - 无后端时 testRecognize 返回 { ok: false, error: '未配置 OCR 后端' }，不伪造结果
 *  - 保留 V0.3 的 ≤300ms 超时与空闲 10s 释放约束（由 PpOcrEngine 内部保证）
 *  - testRecognize 使用独立的 PpOcrEngine 实例，不干扰 OcrManager 的运行时状态
 */
import { app, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { OcrModel } from '@/types'
import {
  PpOcrEngine,
  getBackendStatus,
  getOcrResourcesPath,
  getPaddleOcrCliPath,
  type BackendStatus,
  type BackendType
} from './PpOcrEngine'
import { SettingsStore } from '../db/SettingsStore'

/** OCR runtime 状态（与 BackendStatus 一致） */
export type OcrRuntimeStatus = BackendStatus

/** 健康检查结果 */
export interface OcrHealthCheckResult {
  ok: boolean
  backend: BackendType
  modelPath?: string
  error?: string
}

/** 测试识别结果 */
export interface OcrTestRecognizeResult {
  ok: boolean
  text?: string
  elapsedMs?: number
  error?: string
}

/** 打开安装目录结果 */
export interface OcrOpenInstallDirResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * OcrRuntimeManager：OCR runtime 管理器。
 *
 * 无状态管理器，所有方法独立检测后端状态。
 * 单例导出 getOcrRuntimeManager()。
 */
export class OcrRuntimeManager {
  /**
   * 获取当前 OCR runtime 状态。
   * 检测当前后端类型（PP-OCRv6/Tesseract/未配置）、模型路径、可用性。
   */
  getRuntimeStatus(): OcrRuntimeStatus {
    const model = this.getCurrentModel()
    return getBackendStatus(model)
  }

  /**
   * 健康检查：检测可执行文件/命令是否存在。
   * 返回 { ok, backend, modelPath?, error? }。
   */
  healthCheck(): OcrHealthCheckResult {
    const model = this.getCurrentModel()
    const status = getBackendStatus(model)

    if (!status.available) {
      return {
        ok: false,
        backend: status.type,
        modelPath: status.modelPath,
        error: '未找到可用的 OCR 后端，请检查内置 PP-OCRv6 runtime 或系统 Tesseract。'
      }
    }

    // PaddleOcr：验证 CLI 可执行文件存在
    if (status.type === 'paddleocr') {
      const cliPath = getPaddleOcrCliPath()
      if (!fs.existsSync(cliPath)) {
        return {
          ok: false,
          backend: status.type,
          modelPath: status.modelPath,
          error: `PP-OCRv6 CLI 不存在：${cliPath}`
        }
      }
      // 验证模型目录存在（若配置了 modelPath）
      if (status.modelPath && !fs.existsSync(status.modelPath)) {
        return {
          ok: false,
          backend: status.type,
          modelPath: status.modelPath,
          error: `模型目录不存在：${status.modelPath}`
        }
      }
    }

    return {
      ok: true,
      backend: status.type,
      modelPath: status.modelPath
    }
  }

  /**
   * 测试识别：用当前后端识别指定图片。
   * 返回 { ok, text?, elapsedMs?, error? }。
   * 无后端时返回 { ok: false, error: '未配置 OCR 后端' }，不伪造结果。
   */
  async testRecognize(imagePath: string): Promise<OcrTestRecognizeResult> {
    const model = this.getCurrentModel()
    const status = getBackendStatus(model)

    if (!status.available) {
      return { ok: false, error: '未配置 OCR 后端' }
    }

    if (!fs.existsSync(imagePath)) {
      return { ok: false, error: `图片文件不存在: ${imagePath}` }
    }

    // 使用独立的 PpOcrEngine 实例进行测试，不干扰 OcrManager 的运行时状态
    const engine = new PpOcrEngine()
    try {
      await engine.initialize(model)
      if (!engine.isLoaded()) {
        return { ok: false, error: 'OCR 引擎初始化失败：后端不可用' }
      }

      const imageBuffer = fs.readFileSync(imagePath)
      const result = await engine.recognize(imageBuffer)
      return {
        ok: true,
        text: result.text,
        elapsedMs: result.elapsed
      }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      }
    } finally {
      engine.release()
    }
  }

  /**
   * 打开 OCR 资源目录（resources/ocr）。
   * 若目录不存在则创建后打开。
   * 使用 Electron shell.openPath。
   */
  async openInstallDir(): Promise<OcrOpenInstallDirResult> {
    try {
      const dir = this.getInstallDir()
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const errorMessage = await shell.openPath(dir)
      if (errorMessage) {
        return { ok: false, path: dir, error: errorMessage }
      }
      return { ok: true, path: dir }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // ===================== 内部方法 =====================

  /** 获取当前设置的 OCR 模型 */
  private getCurrentModel(): OcrModel {
    try {
      return SettingsStore.get().ocrModel
    } catch {
      return 'tiny'
    }
  }

  /** 获取 OCR 安装目录路径 */
  private getInstallDir(): string {
    // 优先使用 PpOcrEngine 的资源路径（与实际检测路径一致）
    try {
      return getOcrResourcesPath()
    } catch {
      // app 未 ready 时 fallback
      const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
      return path.join(base, 'resources', 'ocr')
    }
  }
}

// ===================== 单例 =====================

let runtimeManagerInstance: OcrRuntimeManager | null = null

/** 获取 OcrRuntimeManager 单例 */
export function getOcrRuntimeManager(): OcrRuntimeManager {
  if (!runtimeManagerInstance) {
    runtimeManagerInstance = new OcrRuntimeManager()
  }
  return runtimeManagerInstance
}

/** 重置单例（仅供测试） */
export function resetOcrRuntimeManager(): void {
  runtimeManagerInstance = null
}
