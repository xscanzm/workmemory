/**
 * PpOcrEngine：PP-OCRv6 本地推理封装
 *
 * 架构完整的可插拔推理后端设计：
 *  - IOcrBackend：OCR 后端抽象接口
 *  - PaddleOcrBackend：通过 child_process.spawn 调用外部 PP-OCRv6 CLI（resources/ocr/ppocr_cli）
 *  - TesseractBackend：通过 child_process 调用 tesseract 命令行（系统降级方案）
 *  - selectBackend()：优先 PaddleOcr → Tesseract → 抛明确错误
 *
 * 性能约束：
 *  - CPU 多线程优化：PaddleOcr 通过 --cpu_threads 控制；Tesseract 通过 OMP_NUM_THREADS 环境变量
 *  - 截图文字较少时单核推理：小图（<200x200）传 cpu_threads=1
 *  - 后台识别加超时保护，避免 OCR 子进程卡死
 *  - 空闲资源管理：release() 释放后端资源
 *
 * 硬约束：不得伪造 OCR 结果。无可用后端时 recognize 抛错，不返回空文本假数据。
 */
import { app, nativeImage } from 'electron'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { OcrModel } from '@/types'
import { logRuntime } from '../runtimeLog'

/** OCR 文本框 */
export interface OcrBox {
  x: number
  y: number
  w: number
  h: number
}

/** OCR 识别结果 */
export interface OcrResult {
  text: string
  boxes: OcrBox[]
  confidence: number
  elapsed: number
}

/** OCR 后端识别选项 */
export interface OcrRecognizeOptions {
  /** CPU 线程数；小图传 1 实现单核推理 */
  cpuThreads?: number
  /** 单次识别超时；不包含 server 冷启动 */
  timeoutMs?: number
}

/** OCR 后端抽象接口 */
export interface IOcrBackend {
  /** 加载模型 */
  loadModel(modelPath: string): Promise<void>
  /** 识别图片，返回真实 OCR 结果；无可用后端时抛错 */
  recognize(imageBuffer: Buffer, options?: OcrRecognizeOptions): Promise<OcrResult>
  /** 释放后端资源（终止子进程、清理临时文件） */
  release(): void
  /** 后端是否可用（CLI/命令存在） */
  isAvailable(): boolean
  /** 后端名称 */
  getName(): string
}

/** OCR 引擎状态 */
export interface OcrEngineStatus {
  backend: string
  model: OcrModel
  loaded: boolean
}

/** 后端类型 */
export type BackendType = 'paddleocr' | 'tesseract' | 'unconfigured'

/** 后端状态：检测当前可用的 OCR 后端类型、模型路径与可用性 */
export interface BackendStatus {
  type: BackendType
  modelPath?: string
  available: boolean
}

/** recognize 总超时（毫秒）：包含首次 server 冷启动保护 */
const RECOGNIZE_TIMEOUT_MS = 130000
/** PP-OCRv6 server 首次冷启动超时（毫秒） */
const SERVER_START_TIMEOUT_MS = 120000
/** PP-OCRv6 server 热识别超时（毫秒） */
const SERVER_RECOGNIZE_TIMEOUT_MS = 20000
/** 小图阈值：宽或高 <200 视为文字较少，使用单核推理 */
const SMALL_IMAGE_THRESHOLD = 200
/** 默认 CPU 线程数：屏幕 OCR 使用 tiny 模型，优先控制资源占用 */
const DEFAULT_CPU_THREADS = 2
/** 子进程超时（毫秒） */
const PROCESS_TIMEOUT_MS = 60000
/** 默认启用 server 模式；仅在显式设置 WORKMEMORY_OCR_SERVER=0 时关闭 */
const PADDLE_SERVER_MODE_ENABLED = process.env.WORKMEMORY_OCR_SERVER !== '0'

function getPaddleOcrEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1'
  }
}

// ===================== 资源路径工具 =====================

/** 获取 OCR 资源根目录 */
export function getOcrResourcesPath(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return path.join(base, 'resources', 'ocr')
}

/** 获取模型目录路径 */
export function getModelPath(model: OcrModel): string {
  return path.join(getOcrResourcesPath(), 'models', model)
}

/** 获取 PaddleOcr CLI 可执行文件路径 */
export function getPaddleOcrCliPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const runtimePath = path.join(getOcrResourcesPath(), 'runtime', `ppocr_cli${ext}`)
  if (fs.existsSync(runtimePath)) return runtimePath
  return path.join(getOcrResourcesPath(), `ppocr_cli${ext}`)
}

// ===================== 临时文件管理 =====================

/** OCR 临时图片目录 */
const OCR_TEMP_DIR = path.join(os.tmpdir(), 'workmemory-ocr')

function ensureOcrTempDir(): string {
  if (!fs.existsSync(OCR_TEMP_DIR)) {
    fs.mkdirSync(OCR_TEMP_DIR, { recursive: true })
  }
  return OCR_TEMP_DIR
}

/** 将图片 Buffer 写入临时文件，返回路径 */
function writeTempImage(buffer: Buffer): string {
  const dir = ensureOcrTempDir()
  const fileName = `ocr-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

/** 安全删除临时文件 */
function safeDeleteFile(filePath: string): void {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // 静默忽略删除失败
  }
}

function decodePaddleCliBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gb18030').decode(buffer)
  } catch {
    return utf8
  }
}

// ===================== 图片尺寸估算 =====================

/** 使用 nativeImage 获取图片尺寸，用于判断是否为小图 */
function getImageSize(buffer: Buffer): { width: number; height: number } {
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return { width: 0, height: 0 }
    const size = image.getSize()
    return { width: size.width, height: size.height }
  } catch {
    return { width: 0, height: 0 }
  }
}

/** 判断是否为小图（文字较少），决定是否使用单核推理 */
function isSmallImage(buffer: Buffer): boolean {
  const { width, height } = getImageSize(buffer)
  if (width === 0 || height === 0) return false
  return width < SMALL_IMAGE_THRESHOLD || height < SMALL_IMAGE_THRESHOLD
}

// ===================== PaddleOcrBackend =====================

/**
 * PaddleOcrBackend：通过 child_process.spawn 调用外部 PP-OCRv6 CLI。
 *
 * CLI 接口约定：
 *  ppocr_cli --image_path <path> --cpu_threads <N> --model_path <dir> --output json
 *
 * stdout 输出 JSON：
 *  { "text": "...", "boxes": [{"x":0,"y":0,"w":100,"h":50}], "confidence": 0.95, "elapsed": 120 }
 *
 * PP-OCRv6 tiny runtime 随安装包放置到 resources/ocr/runtime。
 */
export class PaddleOcrBackend implements IOcrBackend {
  private cliPath: string
  private modelPath = ''
  private available: boolean | null = null
  private serverUnsupported = false
  private server: ChildProcessWithoutNullStreams | null = null
  private serverStarting: Promise<void> | null = null
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private jsonWaiters: Array<{
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []
  private requestChain: Promise<void> = Promise.resolve()

  constructor() {
    this.cliPath = getPaddleOcrCliPath()
  }

  getName(): string {
    return 'PaddleOcr'
  }

  isAvailable(): boolean {
    if (this.available !== null) return this.available
    try {
      this.available = fs.existsSync(this.cliPath)
    } catch {
      this.available = false
    }
    return this.available
  }

  async loadModel(modelPath: string): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error(`PaddleOcrBackend 不可用：CLI 不存在于 ${this.cliPath}`)
    }
    this.modelPath = modelPath
    // 验证模型目录存在
    if (modelPath && !fs.existsSync(modelPath)) {
      throw new Error(`PaddleOcrBackend 模型目录不存在：${modelPath}`)
    }
  }

  recognize(imageBuffer: Buffer, options?: OcrRecognizeOptions): Promise<OcrResult> {
    if (!this.isAvailable()) {
      return Promise.reject(new Error('PaddleOcrBackend 不可用：CLI 不存在'))
    }
    if (!PADDLE_SERVER_MODE_ENABLED) {
      return this.runOneShotCli(imageBuffer, options)
    }
    if (this.serverUnsupported) {
      return this.runOneShotCli(imageBuffer, options)
    }
    const timeoutMs = options?.timeoutMs ?? SERVER_RECOGNIZE_TIMEOUT_MS
    const run = this.requestChain
      .catch(() => undefined)
      .then(() => this.runServerRequest(imageBuffer, timeoutMs))
    this.requestChain = run.then(() => undefined, () => undefined)
    return run
  }

  private async runServerRequest(imageBuffer: Buffer, timeoutMs: number): Promise<OcrResult> {
    try {
      await this.ensureServer()
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      if (this.isServerUnsupportedError(error)) {
        this.serverUnsupported = true
      }
      logRuntime('ocr', `[PaddleOcrBackend] server 不可用，回退单次 CLI: ${error.message}`)
      return this.runOneShotCli(imageBuffer, { timeoutMs: PROCESS_TIMEOUT_MS })
    }

    let tempPath = ''
    const startTime = Date.now()
    try {
      tempPath = writeTempImage(imageBuffer)
      const response = await this.sendServerRequest({ image_path: tempPath }, timeoutMs)
      if (typeof response.error === 'string') {
        throw new Error(response.error)
      }
      const result = parsePaddleOcrJson(response, Date.now() - startTime)
      if (result === null) {
        throw new Error(`PaddleOcrBackend server 输出解析失败: ${JSON.stringify(response).slice(0, 200)}`)
      }
      return result
    } catch (e) {
      this.restartServerAfterFailure()
      throw e
    } finally {
      safeDeleteFile(tempPath)
    }
  }

  private ensureServer(): Promise<void> {
    if (this.server && !this.server.killed) return Promise.resolve()
    if (this.serverStarting) return this.serverStarting

    const starting = new Promise<void>((resolve, reject) => {
      const args = [
        '--server',
        '--cpu_threads', String(DEFAULT_CPU_THREADS),
        '--output', 'json'
      ]
      if (this.modelPath) {
        args.push('--model_path', this.modelPath)
      }

      const child = spawn(this.cliPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: getPaddleOcrEnv()
      })
      this.server = child
      this.stdoutBuffer = ''
      this.stderrBuffer = ''

      const timer = setTimeout(() => {
        this.killServer()
        reject(new Error('PaddleOcrBackend server 启动超时'))
      }, SERVER_START_TIMEOUT_MS)

      this.waitForJsonLine(SERVER_START_TIMEOUT_MS)
        .then((ready) => {
          clearTimeout(timer)
          if (ready.ready === true) {
            resolve(undefined)
            return
          }
          reject(new Error(typeof ready.error === 'string' ? ready.error : 'PaddleOcrBackend server 启动失败'))
        })
        .catch((error) => {
          clearTimeout(timer)
          reject(error)
        })

      child.stdout.on('data', (chunk: Buffer) => this.handleServerStdout(chunk))
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderrBuffer += chunk.toString('utf8')
        if (this.stderrBuffer.length > 4000) this.stderrBuffer = this.stderrBuffer.slice(-4000)
      })
      child.on('error', (err) => {
        this.rejectAllWaiters(new Error(`PaddleOcrBackend server 启动失败: ${err.message}`))
      })
      child.on('close', (code) => {
        const stderr = this.stderrBuffer.trim()
      this.server = null
      this.serverStarting = null
      this.rejectAllWaiters(new Error(`PaddleOcrBackend server 已退出，退出码 ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`))
      })
    }).finally(() => {
      this.serverStarting = null
    })
    this.serverStarting = starting

    return starting
  }

  private sendServerRequest(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.server || this.server.killed || !this.server.stdin.writable) {
      return Promise.reject(new Error('PaddleOcrBackend server 不可用'))
    }

    const normalizedPayload = { ...payload }
    if (typeof normalizedPayload.image_path === 'string') {
      normalizedPayload.image_path = normalizedPayload.image_path.replaceAll('\\', '/')
    }
    const linePromise = this.waitForJsonLine(timeoutMs)
    this.server.stdin.write(`${JSON.stringify(normalizedPayload)}\n`, 'utf8')
    return linePromise
  }

  private waitForJsonLine(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.jsonWaiters.findIndex(waiter => waiter.resolve === resolve)
        if (index >= 0) this.jsonWaiters.splice(index, 1)
        reject(new Error('PaddleOcrBackend server 响应超时'))
      }, timeoutMs)
      this.jsonWaiters.push({ resolve, reject, timer })
    })
  }

  private handleServerStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8')
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line.startsWith('{') && line.endsWith('}')) {
        const waiter = this.jsonWaiters.shift()
        if (waiter) {
          clearTimeout(waiter.timer)
          try {
            waiter.resolve(JSON.parse(line) as Record<string, unknown>)
          } catch {
            waiter.reject(new Error(`PaddleOcrBackend server JSON 解析失败: ${line.slice(0, 200)}`))
          }
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private rejectAllWaiters(error: Error): void {
    const waiters = this.jsonWaiters.splice(0)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }

  private restartServerAfterFailure(): void {
    this.killServer()
  }

  private killServer(): void {
    if (this.server) {
      try { this.server.kill('SIGKILL') } catch { /* ignore */ }
    }
    this.server = null
    this.serverStarting = null
    this.stdoutBuffer = ''
    this.stderrBuffer = ''
    this.rejectAllWaiters(new Error('PaddleOcrBackend server 已停止'))
  }

  release(): void {
    this.killServer()
    this.modelPath = ''
  }

  private isServerUnsupportedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /unrecognized arguments|unknown option|--server|image_path.*required|required.*image_path/i.test(message)
  }

  private runOneShotCli(imageBuffer: Buffer, options?: OcrRecognizeOptions): Promise<OcrResult> {
    const cpuThreads = options?.cpuThreads ?? DEFAULT_CPU_THREADS
    const timeoutMs = options?.timeoutMs ?? PROCESS_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      let tempPath = ''
      const startTime = Date.now()

      try {
        tempPath = writeTempImage(imageBuffer)
      } catch (e) {
        reject(new Error(`PaddleOcrBackend 写入临时图片失败: ${e instanceof Error ? e.message : String(e)}`))
        return
      }

      const args = [
        '--image_path', tempPath,
        '--cpu_threads', String(cpuThreads),
        '--output', 'json'
      ]
      if (this.modelPath) {
        args.push('--model_path', this.modelPath)
      }

      const child = spawn(this.cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: getPaddleOcrEnv()
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          safeDeleteFile(tempPath)
          reject(new Error('PaddleOcrBackend CLI 执行超时'))
        }
      }, timeoutMs)

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutChunks.push(chunk)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk)
      })

      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          safeDeleteFile(tempPath)
          reject(new Error(`PaddleOcrBackend 启动失败: ${err.message}`))
        }
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        safeDeleteFile(tempPath)

        const elapsed = Date.now() - startTime
        const stdout = decodePaddleCliBuffer(Buffer.concat(stdoutChunks))
        const stderr = decodePaddleCliBuffer(Buffer.concat(stderrChunks))
        if (code !== 0) {
          reject(new Error(`PaddleOcrBackend 退出码 ${code}: ${stderr.trim() || '未知错误'}`))
          return
        }

        const result = parsePaddleOcrOutput(stdout, elapsed)
        if (!result) {
          reject(new Error(`PaddleOcrBackend 输出解析失败: ${stdout.slice(0, 200)}`))
          return
        }
        resolve(result)
      })
    })
  }
}

/** 解析 PaddleOcr CLI 的 JSON 输出 */
function parsePaddleOcrOutput(stdout: string, elapsed: number): OcrResult | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null

  // 尝试直接解析 JSON
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const text = typeof parsed.text === 'string' ? parsed.text : ''
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 1.0
    const boxes = Array.isArray(parsed.boxes) ? parseBoxes(parsed.boxes) : []
    return { text, boxes, confidence, elapsed }
  } catch {
    // JSON 解析失败，尝试从输出中提取 JSON 行
  }

  // 尝试逐行查找 JSON 对象
  const lines = trimmed.split('\n')
  for (const line of lines) {
    const lineTrimmed = line.trim()
    if (lineTrimmed.startsWith('{') && lineTrimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(lineTrimmed) as Record<string, unknown>
        const text = typeof parsed.text === 'string' ? parsed.text : ''
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 1.0
        const boxes = Array.isArray(parsed.boxes) ? parseBoxes(parsed.boxes) : []
        return { text, boxes, confidence, elapsed }
      } catch {
        // 继续尝试下一行
      }
    }
  }

  // 如果输出不是 JSON 但包含文本，将其作为纯文本结果
  if (trimmed.length > 0) {
    return { text: trimmed, boxes: [], confidence: 0.5, elapsed }
  }

  return null
}

function parsePaddleOcrJson(parsed: Record<string, unknown>, elapsed: number): OcrResult | null {
  const text = typeof parsed.text === 'string' ? parsed.text : ''
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 1.0
  const boxes = Array.isArray(parsed.boxes) ? parseBoxes(parsed.boxes) : []
  const cliElapsed = typeof parsed.elapsed === 'number' ? parsed.elapsed : elapsed
  return { text, boxes, confidence, elapsed: cliElapsed }
}

/** 解析 boxes 数组 */
function parseBoxes(raw: unknown[]): OcrBox[] {
  const boxes: OcrBox[] = []
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const x = typeof obj.x === 'number' ? obj.x : 0
      const y = typeof obj.y === 'number' ? obj.y : 0
      const w = typeof obj.w === 'number' ? obj.w : 0
      const h = typeof obj.h === 'number' ? obj.h : 0
      boxes.push({ x, y, w, h })
    }
  }
  return boxes
}

// ===================== TesseractBackend =====================

/**
 * TesseractBackend：通过 child_process 调用 tesseract 命令行。
 *
 * 命令：tesseract <img> stdout -l chi_sim+eng --psm 6
 * 线程控制：OMP_NUM_THREADS 环境变量
 *
 * 这是真实可用的降级方案，非 mock。多数系统可通过包管理器安装 tesseract。
 */
export class TesseractBackend implements IOcrBackend {
  private available: boolean | null = null

  getName(): string {
    return 'Tesseract'
  }

  isAvailable(): boolean {
    if (this.available !== null) return this.available
    // 检测 tesseract 命令是否可用（同步尝试 --version）
    try {
      const result = spawnSync('tesseract', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 5000
      })
      this.available = result.status === 0 || (result.stdout && result.stdout.toString().includes('tesseract'))
    } catch {
      this.available = false
    }
    return this.available
  }

  async loadModel(_modelPath: string): Promise<void> {
    if (!this.isAvailable()) {
      throw new Error('TesseractBackend 不可用：tesseract 命令未找到，请安装 tesseract-ocr')
    }
    // Tesseract 使用系统安装的语言包，modelPath 不影响其行为
    // 但验证 chi_sim 语言包是否可用
    const langs = this.getAvailableLangs()
    if (!langs.includes('chi_sim')) {
      console.warn('[TesseractBackend] chi_sim 语言包未安装，将仅使用 eng。建议安装 tesseract-ocr-chi-sim')
    }
  }

  /** 获取已安装的语言包列表 */
  private getAvailableLangs(): string[] {
    try {
      const result = spawnSync('tesseract', ['--list-langs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: 5000
      })
      if (result.status !== 0 || !result.stdout) return ['eng']
      const output = result.stdout.toString('utf8')
      const langs = output.split('\n').map(l => l.trim()).filter(l => l && l !== 'List of available languages')
      return langs.length > 0 ? langs : ['eng']
    } catch {
      return ['eng']
    }
  }

  recognize(imageBuffer: Buffer, options?: OcrRecognizeOptions): Promise<OcrResult> {
    if (!this.isAvailable()) {
      return Promise.reject(new Error('TesseractBackend 不可用：tesseract 命令未找到'))
    }
    const cpuThreads = options?.cpuThreads ?? DEFAULT_CPU_THREADS
    return this.runTesseract(imageBuffer, cpuThreads)
  }

  private runTesseract(imageBuffer: Buffer, cpuThreads: number): Promise<OcrResult> {
    return new Promise((resolve, reject) => {
      let tempPath = ''
      const startTime = Date.now()

      try {
        tempPath = writeTempImage(imageBuffer)
      } catch (e) {
        reject(new Error(`TesseractBackend 写入临时图片失败: ${e instanceof Error ? e.message : String(e)}`))
        return
      }

      // 确定语言包
      const langs = this.getAvailableLangs()
      const langArg = langs.includes('chi_sim') ? 'chi_sim+eng' : 'eng'

      // 通过 OMP_NUM_THREADS 环境变量控制线程数
      const env = { ...process.env, OMP_NUM_THREADS: String(cpuThreads) }

      const child = spawn('tesseract', [tempPath, 'stdout', '-l', langArg, '--psm', '6'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          safeDeleteFile(tempPath)
          reject(new Error('TesseractBackend 执行超时'))
        }
      }, PROCESS_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })

      child.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          safeDeleteFile(tempPath)
          reject(new Error(`TesseractBackend 启动失败: ${err.message}`))
        }
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        safeDeleteFile(tempPath)

        const elapsed = Date.now() - startTime

        if (code !== 0) {
          reject(new Error(`TesseractBackend 退出码 ${code}: ${stderr.trim() || '未知错误'}`))
          return
        }

        // Tesseract 输出纯文本，无 boxes 和 confidence
        const text = stdout.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
        resolve({ text, boxes: [], confidence: 1.0, elapsed })
      })
    })
  }

  release(): void {
    // Tesseract CLI 模式下无需额外释放
  }
}

// ===================== 后端选择 =====================

/**
 * 选择可用的 OCR 后端。
 * 优先 PaddleOcrBackend（检测 CLI 存在），否则 TesseractBackend（检测命令可用），
 * 否则返回 null（进入"未配置"状态，不抛错）。
 */
export function selectBackend(): IOcrBackend | null {
  const paddle = new PaddleOcrBackend()
  if (paddle.isAvailable()) {
    return paddle
  }

  const tesseract = new TesseractBackend()
  if (tesseract.isAvailable()) {
    return tesseract
  }

  return null
}

/**
 * 检测当前可用的 OCR 后端状态。
 * 返回后端类型（paddleocr/tesseract/unconfigured）、模型路径与可用性。
 * 不抛错，无后端时返回 { type: 'unconfigured', available: false }。
 */
export function getBackendStatus(model: OcrModel = 'tiny'): BackendStatus {
  const paddle = new PaddleOcrBackend()
  if (paddle.isAvailable()) {
    return {
      type: 'paddleocr',
      modelPath: getModelPath(model),
      available: true
    }
  }

  const tesseract = new TesseractBackend()
  if (tesseract.isAvailable()) {
    return {
      type: 'tesseract',
      available: true
    }
  }

  return {
    type: 'unconfigured',
    available: false
  }
}

// ===================== PpOcrEngine =====================

/**
 * PpOcrEngine：OCR 引擎封装层。
 *
 * 职责：
 *  - 管理后端选择与模型加载
 *  - recognize 加超时保护（Promise.race）
 *  - 根据图片尺寸自动调整 cpu_threads（小图单核）
 *  - release 释放后端资源
 */
export class PpOcrEngine {
  private backend: IOcrBackend | null = null
  private model: OcrModel = 'tiny'
  private loaded = false
  private configured = false

  /** 获取当前后端名称 */
  getBackendName(): string {
    return this.backend?.getName() ?? 'none'
  }

  /** 获取当前模型 */
  getModel(): OcrModel {
    return this.model
  }

  /** 是否已加载 */
  isLoaded(): boolean {
    return this.loaded && this.backend !== null
  }

  /** 是否已配置（有可用后端） */
  isConfigured(): boolean {
    return this.configured
  }

  /** 获取引擎状态 */
  getStatus(): OcrEngineStatus {
    return {
      backend: this.backend?.getName() ?? 'none',
      model: this.model,
      loaded: this.loaded
    }
  }

  /**
   * 初始化引擎：选择后端并加载模型。
   * 若无可用后端则进入"未配置"状态（loaded=false, configured=false），不抛错。
   */
  async initialize(model: OcrModel = 'tiny'): Promise<void> {
    this.model = model
    if (this.backend && this.loaded) {
      // 已加载，若模型未变则跳过
      return
    }
    this.backend = selectBackend()
    if (!this.backend) {
      // 无可用后端：进入"未配置"状态，不抛错
      this.loaded = false
      this.configured = false
      logRuntime('ocr', '[PpOcrEngine] 未找到可用的 OCR 后端，进入未配置状态。请检查内置 PP-OCRv6 runtime 或系统 Tesseract。')
      return
    }
    this.configured = true
    const modelPath = getModelPath(this.model)
    await this.backend.loadModel(modelPath)
    this.loaded = true
    logRuntime('ocr', `[PpOcrEngine] 初始化完成，后端=${this.backend.getName()} 模型=${this.model} serverMode=${PADDLE_SERVER_MODE_ENABLED ? 'on' : 'off'}`)
  }

  /**
   * 切换模型（tiny / small）。
   * 释放当前后端后重新加载新模型。
   */
  async setModel(model: OcrModel): Promise<void> {
    if (this.model === model && this.loaded) return
    this.release()
    this.model = model
    await this.initialize(model)
  }

  /**
   * 识别图片文本。
   * - 根据图片尺寸自动调整 cpu_threads（小图 <200x200 使用单核）
   * - 超时保护（Promise.race），避免 OCR 子进程卡死
   * - 无可用后端时抛错，不返回伪造数据
   */
  async recognize(imageBuffer: Buffer): Promise<OcrResult> {
    if (!this.backend || !this.loaded) {
      throw new Error('PpOcrEngine 未初始化，请先调用 initialize()')
    }

    // 根据图片尺寸估算文字量，决定 cpu_threads
    const small = isSmallImage(imageBuffer)
    const cpuThreads = small ? 1 : DEFAULT_CPU_THREADS

    // 超时保护
    const recognizePromise = this.backend.recognize(imageBuffer, { cpuThreads })
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`OCR 识别超时（${RECOGNIZE_TIMEOUT_MS}ms）`))
      }, RECOGNIZE_TIMEOUT_MS)
    })

    return Promise.race([recognizePromise, timeoutPromise])
  }

  /** 释放后端资源 */
  release(): void {
    if (this.backend) {
      try {
        this.backend.release()
      } catch (e) {
        logRuntime('ocr', `[PpOcrEngine] 释放后端资源失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    this.loaded = false
    this.configured = false
    this.backend = null
  }
}
