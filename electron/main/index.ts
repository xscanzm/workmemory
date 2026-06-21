/**
 * Electron 主进程入口
 * - app ready 后初始化数据库（执行迁移）
 * - 初始化 PrivacyGuard 默认规则 + CaptureManager 单例
 * - 初始化 OcrManager（本地识别层）+ EpisodeManager（语义降噪层）
 * - 初始化 WikiIngestManager（认知资产化层）+ InsightsManager（主动洞察层）
 * - 初始化 MascotManager（桌面伙伴层）+ TrayManager（系统托盘）
 * - 创建无边框主窗口
 * - 注册 IPC 处理器
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { createMainWindow } from './window'
import { initDatabase, closeDatabase } from '../db/database'
import { registerIpcHandlers } from './ipc'
import { getCaptureManager } from '../capture/CaptureManager'
import { getOcrManager } from '../ocr/OcrManager'
import { getEpisodeManager } from '../capture/EpisodeManager'
import { getWikiIngestManager } from '../wiki/WikiIngestManager'
import { getInsightsManager } from '../insights/InsightsManager'
import { getMascotManager } from '../mascot/MascotManager'
import { SettingsStore } from '../db/SettingsStore'
import { getDistillManager } from '../ai/DistillManager'

function logMain(message: string): void {
  try {
    const filePath = path.join(app.getPath('userData'), 'runtime.log')
    fs.appendFileSync(filePath, `[${new Date().toISOString()}] [main] ${message}\n`, 'utf-8')
  } catch {
    // ignore logging failures
  }
}

async function bootstrap(): Promise<void> {
  logMain('bootstrap start')
  initDatabase()
  logMain('database initialized')

  // 初始化隐私防护中心：seed 默认规则到 privacy_rules 表
  const captureManager = getCaptureManager()
  captureManager.getPrivacyGuard().seedDefaultRules()

  // 启动时同步截图降级策略。默认值为 true，保证安装后默认即可记录；
  // 用户在设置页关闭后仍然会按持久化设置生效。
  captureManager.setAllowFullScreenshotFallback(
    SettingsStore.get().allowFullScreenshotFallback
  )

  registerIpcHandlers()
  logMain('ipc registered')
  createMainWindow()
  logMain('main window requested')

  // 初始化本地识别层（OcrManager）：选择后端 + 启动队列 + 监听 segment-created
  const ocrManager = getOcrManager()
  await ocrManager.initialize()
  logMain('ocr initialized')

  // 初始化语义降噪层（EpisodeManager）：监听 ocr-completed + segment-merged
  const episodeManager = getEpisodeManager()
  episodeManager.initialize()
  logMain('episode manager initialized')

  // 初始化认知资产化层（WikiIngestManager）：定时扫描 + 监听 episodes-rebuilt
  const distillManager = getDistillManager()
  distillManager.initialize()
  logMain('distill manager initialized')

  // 初始化认知资产化层（WikiIngestManager）：定时扫描 + 监听工作记忆事件
  const wikiIngestManager = getWikiIngestManager()
  wikiIngestManager.initialize()
  logMain('wiki ingest initialized')

  // 初始化主动洞察层（InsightsManager）：启动 ReminderScheduler
  const insightsManager = getInsightsManager()
  insightsManager.initialize()
  logMain('insights initialized')

  // 初始化桌面伙伴层（MascotManager）：创建 Mascot 窗口 + 托盘 + 状态联动
  // 注入到 ReminderScheduler 替换 SafeMascotNotifier（须在 InsightsManager.initialize 之后）
  const mascotManager = getMascotManager()
  mascotManager.initialize()
  logMain('mascot initialized')

  // 默认进入记录状态。必须放在 OCR/Episode 监听初始化之后，
  // 确保安装后首次产生的片段也会进入 OCR 队列和事件聚合链路。
  captureManager.startCapture()
  logMain('capture started')
}

app.whenReady().then(() => {
  void bootstrap().catch((e) => {
    logMain(`bootstrap failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    try {
      createMainWindow()
    } catch (inner) {
      logMain(`fallback createMainWindow failed: ${inner instanceof Error ? inner.stack ?? inner.message : String(inner)}`)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

process.on('uncaughtException', (e) => {
  logMain(`uncaughtException: ${e.stack ?? e.message}`)
})

process.on('unhandledRejection', (reason) => {
  logMain(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
})

app.on('window-all-closed', () => {
  // 停止捕获与 OCR，释放资源
  try {
    getMascotManager().stop()
    getInsightsManager().stop()
    getWikiIngestManager().stop()
    getDistillManager().stop()
    getEpisodeManager().stop()
    getOcrManager().stop()
    getCaptureManager().stopCapture()
  } catch (e) {
    console.warn('[Main] 停止服务失败:', e)
  }
  closeDatabase()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  try {
    getMascotManager().stop()
    getInsightsManager().stop()
    getWikiIngestManager().stop()
    getDistillManager().stop()
    getEpisodeManager().stop()
    getOcrManager().stop()
    getCaptureManager().stopCapture()
  } catch (e) {
    console.warn('[Main] before-quit 停止服务失败:', e)
  }
  closeDatabase()
})
