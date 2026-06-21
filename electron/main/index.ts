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
import { distillDay } from '../ai/DailyDistillManager'
import { detectPatterns } from '../ai/WeeklyPatternDetector'
import { reflect } from '../ai/ReflectionEngine'
import { evolveSkills } from '../ai/SkillEvolver'
import { DailyDistillRepository } from '../db/repositories/DailyDistillRepository'
import { WeeklyPatternRepository } from '../db/repositories/WeeklyPatternRepository'
import { ReflectionReportRepository } from '../db/repositories/ReflectionReportRepository'
import { getMemCellIndexer } from '../memory/MemCellIndexer'
import { evolveProfile } from '../memory/UserProfileEvolver'

function logMain(message: string): void {
  try {
    const filePath = path.join(app.getPath('userData'), 'runtime.log')
    fs.appendFileSync(filePath, `[${new Date().toISOString()}] [main] ${message}\n`, 'utf-8')
  } catch {
    // ignore logging failures
  }
}

/**
 * 获取昨日日期字符串（YYYY-MM-DD，UTC）。
 * 每日首次启动时调用 evolveProfile(yesterday)，从昨日 MemScene 摘要提取用户画像。
 */
function getYesterdayDate(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * 获取上周一的日期字符串（YYYY-MM-DD，UTC）。
 * 周级模式发现（Task H2）：每周一首次启动时检测上周的工作模式。
 * 计算逻辑：先取本周一（含今天若为周一），再回退 7 天得到上周一。
 * 即使非周一启动，若上周模式尚未生成也会补生成。
 */
function getLastWeekMonday(): string {
  const now = new Date()
  const dayOfWeek = now.getUTCDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const thisMonday = new Date(now)
  thisMonday.setUTCDate(now.getUTCDate() - daysSinceMonday)
  thisMonday.setUTCDate(thisMonday.getUTCDate() - 7)
  return thisMonday.toISOString().slice(0, 10)
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

  // 初始化 MemCell 向量索引（Task M4）：监听 memcell-created 事件，异步生成 embedding
  // 必须在 DistillManager.initialize 之后启动，确保事件发射时监听器已就绪
  const memCellIndexer = getMemCellIndexer()
  memCellIndexer.startIndexing()
  logMain('memcell indexer started')

  // 用户画像演进（Task M7）：每日启动时从昨日 MemScene 摘要提取画像。
  // evolveProfile 内部对 stable 画像做了同日幂等处理，重复调用不会过拟合置信度。
  // 异步执行，不阻塞主启动流程；失败仅记录日志。
  void evolveProfile(getYesterdayDate()).catch((e) => {
    logMain(
      `profile evolve failed: ${e instanceof Error ? e.message : String(e)}`
    )
  })
  logMain('profile evolve triggered')

  // 日级理解（Task H1）：每日首次启动时检查昨日的 daily_distills 是否存在，
  // 不存在则调用 distillDay(yesterday) 生成日级摘要 + 跨小时主题 + 当日模式。
  // 异步执行，不阻塞主启动流程；失败仅记录日志。
  void (async () => {
    try {
      const yesterday = getYesterdayDate()
      const existing = DailyDistillRepository.getByDate(yesterday)
      if (existing === null) {
        await distillDay(yesterday)
        logMain('daily distill completed')
      } else {
        logMain('daily distill skipped: already exists')
      }
    } catch (e) {
      logMain(
        `daily distill failed: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  })()
  logMain('daily distill triggered')

  // 周级模式发现（Task H2）+ 周级反思（Task R1）：启动时检查上周的 weekly_patterns 是否存在，
  // 不存在则调用 detectPatterns(lastWeekMonday) 发现周级工作模式
  // （深度工作时段/碎片化时段/常用应用组合/效率趋势/注意力热点）。
  // 每周一首次启动时触发，非周一启动时补生成上周未生成的模式。
  // 模式发现完成后触发 reflect 生成反思报告（模式识别 + 改进建议 + 趋势分析），
  // 反思报告已存在时跳过，避免重复生成。
  // 异步执行，不阻塞主启动流程；失败仅记录日志。
  void (async () => {
    try {
      const lastWeekMonday = getLastWeekMonday()
      const existing = WeeklyPatternRepository.getByWeekStart(lastWeekMonday)
      if (existing === null) {
        await detectPatterns(lastWeekMonday)
        logMain('weekly pattern detection completed')
      } else {
        logMain('weekly pattern detection skipped: already exists')
      }

      // 周级反思：WeeklyPatternDetector 完成后触发（Task R1）
      // 仅在反思报告不存在时生成，避免重复消耗 AI 资源
      const existingReport = ReflectionReportRepository.getByWeekStart(lastWeekMonday)
      if (existingReport === null) {
        await reflect(lastWeekMonday)
        logMain('reflection report generated')
      } else {
        logMain('reflection report skipped: already exists')
      }

      // 技能进化（Task R2）：ReflectionEngine 完成后触发
      // 从重复出现的 MemScene 主题（成员 ≥3）中提炼技能卡（SOP 步骤/陷阱/洞察）。
      // evolveSkills 内部按 title 去重，已存在的技能卡不会重复生成。
      // 异步执行不阻塞主流程；失败仅记录日志。
      try {
        const skills = await evolveSkills()
        logMain(`skill evolution completed: ${skills.length} new skill(s)`)
      } catch (e) {
        logMain(
          `skill evolution failed: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    } catch (e) {
      logMain(
        `weekly pattern detection / reflection failed: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  })()
  logMain('weekly pattern detection triggered')

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
    getMemCellIndexer().stopIndexing()
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
    getMemCellIndexer().stopIndexing()
    getDistillManager().stop()
    getEpisodeManager().stop()
    getOcrManager().stop()
    getCaptureManager().stopCapture()
  } catch (e) {
    console.warn('[Main] before-quit 停止服务失败:', e)
  }
  closeDatabase()
})
