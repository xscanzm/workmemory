/**
 * 运行时日志工具：将带 scope 的日志追加写入 userData/runtime.log。
 *
 * 与 main/index.ts 的 logMain 行为一致，但可被任意主进程模块复用（OCR、Capture 等）。
 *
 * 格式：[ISO8601] [scope] message
 * 失败静默忽略，不影响调用方流程。
 */
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 追加一条运行时日志到 userData/runtime.log。
 *
 * @param scope 日志来源模块标识（如 'main'、'ocr'、'capture'）
 * @param message 日志正文
 */
export function logRuntime(scope: string, message: string): void {
  try {
    const filePath = path.join(app.getPath('userData'), 'runtime.log')
    const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`
    fs.appendFileSync(filePath, line, 'utf-8')
  } catch {
    // ignore logging failures
  }
}
