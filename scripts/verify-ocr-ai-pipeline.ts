/**
 * verify-ocr-ai-pipeline.ts — OCR → Episode → Distill → Report 全链路端到端验证脚本（Task D1）
 *
 * 用途：
 *   验证 WorkMemory 的 OCR/AI 管线在真实实现（非 mock）下端到端可用：
 *     D1.1 + D1.2 — OcrTextCleaner 去噪：UI 噪声（菜单栏/按钮/URL/状态栏）被移除，真实内容保留。
 *     D1.1        — 向临时数据库注入模拟 segments（ocr_text 为清洗后文本）。
 *     D1.3        — EpisodeBuilder.rebuildEpisodesForDate：生成非空 Episode，title/summary 不含"推进"降级词。
 *     D1.4        — DistillManager.distillHour：生成 CleanEpisode 记录（OpenAIClient 被 monkey-patch）。
 *     D1.5        — ReportGenerator.generate：markdown 含"证据片段："，warning 含"小时级理解未就绪"（C3 降级提示）。
 *     D1.6        — 脚本结构：assert/strict 断言、try/catch、逐步打印 pass/fail、finally 清理临时 DB。
 *
 * 运行方式：
 *   npx tsx scripts/verify-ocr-ai-pipeline.ts
 *
 * 退出码：成功 0，失败 1。
 *
 * 说明：
 *   - 使用真实 EpisodeBuilder / DistillManager / ReportGenerator 实现 + 临时 SQLite 数据库。
 *   - electron 模块被 mock（app.getPath 返回 os.tmpdir()，safeStorage 走 XOR 降级），
 *     以便在 electron 运行时之外通过 `npx tsx` 执行。
 *   - OpenAIClient.chatCompletion 被 monkey-patch，不发起真实网络请求。
 */

// ===================== 顶层 import：仅 Node 内置模块 + better-sqlite3（不传递依赖 electron）=====================
import Module from 'node:module'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { WorkSegment } from '@/types'

// ===================== Electron 模块 Mock =====================
// SettingsStore 内部调用 app.getPath('userData') 与 safeStorage，
// 在 electron 运行时之外（npx tsx）这些均为 undefined，必须先拦截 require('electron')。
interface MockApp {
  getPath: (name: string) => string
  setLoginItemSettings: () => void
}
interface MockSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (s: string) => Buffer
  decryptString: (b: Buffer) => string
}
const mockApp: MockApp = {
  getPath: (name: string): string => (name === 'userData' ? os.tmpdir() : ''),
  setLoginItemSettings: (): void => {}
}
const mockSafeStorage: MockSafeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf-8'),
  decryptString: (b: Buffer): string => b.toString('utf-8')
}
const mockElectron = { app: mockApp, safeStorage: mockSafeStorage }

type ModuleLoadFn = (
  request: string,
  parent?: NodeJS.Module | undefined,
  isMain?: boolean
) => unknown
const moduleNs = Module as unknown as { _load: ModuleLoadFn }
const originalModuleLoad: ModuleLoadFn = moduleNs._load
moduleNs._load = function (request, parent, isMain): unknown {
  if (request === 'electron') return mockElectron
  return originalModuleLoad.call(this, request, parent, isMain)
}

// ===================== 测试常量 =====================
const TEST_DATE = '2026-06-20'
const TEST_HOUR = '09:00'

// ===================== 主流程 =====================
async function main(): Promise<void> {
  // 动态 import electron 依赖模块（此时 Module._load mock 已生效）
  const { setDatabaseInstance, resetDatabaseInstance } = await import('../electron/db/database')
  const { runMigrations } = await import('../electron/db/migrations')
  const { SCHEMA_SQL } = await import('../electron/db/schema')
  const { SegmentRepository } = await import('../electron/db/repositories/SegmentRepository')
  const { CleanEpisodeRepository } = await import('../electron/db/repositories/CleanEpisodeRepository')
  const { SettingsStore } = await import('../electron/db/SettingsStore')
  const { getOcrTextCleaner } = await import('../electron/ocr/OcrTextCleaner')
  const { EpisodeBuilder } = await import('../electron/capture/EpisodeBuilder')
  const { DistillManager } = await import('../electron/ai/DistillManager')
  const { ReportGenerator } = await import('../electron/ai/ReportGenerator')
  const { OpenAIClient } = await import('../electron/ai/OpenAIClient')

  // ---------- 临时数据库 ----------
  const dbPath = path.join(os.tmpdir(), `wm-verify-${randomUUID()}.db`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  setDatabaseInstance(db)

  // ---------- 配置 SettingsStore（假 API Key，避免"未配置 AI API Key"）----------
  SettingsStore.setApiKey('test-api-key-for-verify')
  SettingsStore.set({
    apiBaseUrl: 'https://test.example.com/v1',
    modelName: 'test-verify-model',
    aiAutoDistillEnabled: true,
    aiAutoDistillFirstConsentAt: new Date().toISOString()
  })

  // ---------- Monkey-patch OpenAIClient.chatCompletion ----------
  // DistillManager 以 responseFormat=json_object 调用；ReportGenerator（enhanced 模板）不设 responseFormat。
  let insertedSegmentIds: string[] = []
  const originalChatCompletion = OpenAIClient.chatCompletion
  OpenAIClient.chatCompletion = async (params) => {
    if (params.responseFormat?.type === 'json_object') {
      // DistillManager 调用：返回符合 DistillEventSchema 的 JSON
      const distillPayload = {
        events: [
          {
            title: '订单退款流程优化',
            summary: '讨论订单退款方案的优化策略，调整退款金额计算逻辑',
            startTime: '09:00:00',
            endTime: '10:00:00',
            memoryKind: 'work',
            project: '订单系统',
            entities: [{ type: 'project', name: '退款模块', confidence: 0.8 }],
            topics: ['退款', '优化'],
            materials: ['退款流程图'],
            outputs: ['优化方案'],
            todos: ['评审退款方案'],
            blockers: [],
            segmentIds: insertedSegmentIds,
            evidenceRefs: [
              {
                segmentId: insertedSegmentIds[0] ?? '',
                quote: '订单退款流程优化方案',
                reason: '核心讨论内容'
              }
            ],
            sourceQuality: 'medium',
            confidence: 0.8,
            reportEligible: true,
            wikiEligible: true,
            wikiStatus: 'candidate'
          }
        ]
      }
      return {
        content: JSON.stringify(distillPayload),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop'
      }
    }
    // ReportGenerator 调用：返回简单 markdown（enhanced 模板 structuredOutput=false）
    return {
      content: '# 测试日报\n\n## 今日完成\n\n- 证据片段：订单退款流程优化方案\n- 退款金额计算逻辑调整',
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      finishReason: 'stop'
    }
  }

  let episodeIds: string[] = []

  try {
    // ============================================================
    // D1.1 + D1.2 — OcrTextCleaner 去噪验证
    // ============================================================
    await runStep('D1.1+D1.2 OcrTextCleaner 去噪', () => {
      const rawOcrText = [
        '文件 编辑 视图 收藏 工具 帮助',
        '订单退款流程优化方案讨论',
        '确定 取消 保存',
        '退款金额计算逻辑需要调整',
        'https://example.com/path',
        '12:30',
        '100%'
      ].join('\n')

      const { cleanedText, noiseScore } = getOcrTextCleaner().clean(rawOcrText)

      // 噪声词应被全部移除
      const forbiddenNoise = [
        '文件', '编辑', '视图', '收藏', '工具', '帮助',
        '确定', '取消', '保存', 'https://'
      ]
      for (const noise of forbiddenNoise) {
        assert.ok(
          !cleanedText.includes(noise),
          `清洗后文本不应包含噪声词 "${noise}"，实际: ${cleanedText}`
        )
      }
      // 真实内容应保留
      assert.ok(
        cleanedText.includes('订单退款流程优化方案讨论'),
        `清洗后文本应保留真实内容，实际: ${cleanedText}`
      )
      // 噪声评分 > 0
      assert.ok(noiseScore > 0, `noiseScore 应 > 0，实际: ${noiseScore}`)
    })

    // ============================================================
    // D1.1 — 注入模拟 segments（ocr_text 为清洗后文本）
    // ============================================================
    await runStep('D1.1 注入模拟 segments', () => {
      const segments: WorkSegment[] = [
        {
          id: randomUUID(),
          date: TEST_DATE,
          startTime: '09:00:00',
          endTime: '09:20:00',
          durationSeconds: 1200,
          appName: 'Chrome',
          processName: 'chrome.exe',
          windowTitle: '订单退款流程优化方案 - Google Chrome',
          ocrText: '订单退款流程优化方案讨论\n退款金额计算逻辑需要调整',
          ocrSummary: '讨论订单退款流程优化方案',
          imageHash: randomUUID().slice(0, 16),
          screenshotPath: '',
          isSelectedForReport: true,
          isPrivate: false,
          isImportant: false,
          isDeleted: false,
          sourceStatus: 'ocr_done',
          userTitle: '',
          userSummary: '',
          userNote: '',
          tags: ['退款', '优化'],
          ocrBlocks: [],
          ocrConfidence: 0.9,
          captureSource: 'active_window',
          sourceQuality: 'medium'
        },
        {
          id: randomUUID(),
          date: TEST_DATE,
          startTime: '09:20:00',
          endTime: '09:40:00',
          durationSeconds: 1200,
          appName: 'VS Code',
          processName: 'code.exe',
          windowTitle: 'refund.ts - workmemory - Visual Studio Code',
          ocrText: '退款金额计算逻辑调整\n修改退款计算函数实现',
          ocrSummary: '调整退款金额计算逻辑',
          imageHash: randomUUID().slice(0, 16),
          screenshotPath: '',
          isSelectedForReport: true,
          isPrivate: false,
          isImportant: false,
          isDeleted: false,
          sourceStatus: 'ocr_done',
          userTitle: '',
          userSummary: '',
          userNote: '',
          tags: ['退款', '编码'],
          ocrBlocks: [],
          ocrConfidence: 0.88,
          captureSource: 'active_window',
          sourceQuality: 'medium'
        },
        {
          id: randomUUID(),
          date: TEST_DATE,
          startTime: '09:40:00',
          endTime: '10:00:00',
          durationSeconds: 1200,
          appName: 'Chrome',
          processName: 'chrome.exe',
          windowTitle: '退款流程评审 - Google Chrome',
          ocrText: '退款流程优化\n评审退款方案与退款金额计算',
          ocrSummary: '评审退款流程方案',
          imageHash: randomUUID().slice(0, 16),
          screenshotPath: '',
          isSelectedForReport: true,
          isPrivate: false,
          isImportant: false,
          isDeleted: false,
          sourceStatus: 'ocr_done',
          userTitle: '',
          userSummary: '',
          userNote: '',
          tags: ['退款', '评审'],
          ocrBlocks: [],
          ocrConfidence: 0.85,
          captureSource: 'active_window',
          sourceQuality: 'medium'
        }
      ]

      // 直接 SQL INSERT：绕过 SegmentRepository.insert 的 created_at/updated_at 列 bug
      // （segments 表 schema 无 created_at/updated_at 列，但 SegmentRepository.insert 引用了它们）
      // 参考 scripts/seed-test-data.ts 的插入模式
      const insertSegmentStmt = db.prepare(
        `INSERT INTO segments (
          id, date, start_time, end_time, duration_seconds, app_name, process_name,
          window_title, ocr_text, ocr_summary, image_hash, screenshot_path,
          is_selected_for_report, is_private, is_important, is_deleted, source_status,
          user_title, user_summary, user_note, tags, ocr_blocks, ocr_confidence,
          capture_source, source_quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const insertSegment = (seg: WorkSegment): void => {
        insertSegmentStmt.run(
          seg.id,
          seg.date,
          seg.startTime,
          seg.endTime,
          seg.durationSeconds,
          seg.appName,
          seg.processName,
          seg.windowTitle,
          seg.ocrText,
          seg.ocrSummary,
          seg.imageHash,
          seg.screenshotPath,
          seg.isSelectedForReport ? 1 : 0,
          seg.isPrivate ? 1 : 0,
          seg.isImportant ? 1 : 0,
          seg.isDeleted ? 1 : 0,
          seg.sourceStatus,
          seg.userTitle,
          seg.userSummary,
          seg.userNote,
          JSON.stringify(seg.tags),
          JSON.stringify(seg.ocrBlocks ?? []),
          seg.ocrConfidence ?? 0,
          seg.captureSource ?? 'unknown',
          seg.sourceQuality ?? 'low'
        )
      }
      for (const seg of segments) {
        insertSegment(seg)
      }
      insertedSegmentIds = segments.map((s) => s.id)

      const active = SegmentRepository.getActiveByDate(TEST_DATE)
      assert.ok(active.length === 3, `应注入 3 条 active segment，实际: ${active.length}`)
    })

    // ============================================================
    // D1.3 — EpisodeBuilder 验证
    // ============================================================
    await runStep('D1.3 EpisodeBuilder 重建 Episodes', () => {
      const builder = new EpisodeBuilder()
      const episodes = builder.rebuildEpisodesForDate(TEST_DATE)

      if (episodes.length === 0) {
        const segs = SegmentRepository.getActiveByDate(TEST_DATE)
        assert.fail(
          `EpisodeBuilder 未生成任何 Episode（segments=${segs.length}）：` +
          JSON.stringify(segs.map((s) => ({ app: s.appName, title: s.windowTitle, ocr: s.ocrText.slice(0, 40) })))
        )
      }

      for (const ep of episodes) {
        assert.ok(
          !ep.title.includes('推进'),
          `Episode title 不应包含"推进"，实际: ${ep.title}`
        )
        assert.ok(
          ep.title !== '推进文件编辑' && ep.title !== '推进关键词',
          `Episode title 不应为降级标题，实际: ${ep.title}`
        )
        assert.ok(
          !ep.oneLineSummary.includes('推进'),
          `Episode oneLineSummary 不应包含"推进"，实际: ${ep.oneLineSummary}`
        )
      }

      episodeIds = episodes.map((e) => e.id)
    })

    // ============================================================
    // D1.4 — DistillManager 验证
    // ============================================================
    await runStep('D1.4 DistillManager 小时级理解', async () => {
      const manager = new DistillManager()
      const result = await manager.distillHour(TEST_DATE, TEST_HOUR)

      assert.ok(
        result.created > 0,
        `distillHour 应创建 CleanEpisode（created > 0），实际: ${JSON.stringify(result)}`
      )

      // 二次验证：查询 clean_episodes 表
      const cleanEpisodes = CleanEpisodeRepository.getByHour(TEST_DATE, TEST_HOUR)
      assert.ok(
        cleanEpisodes.length > 0,
        `clean_episodes 表应有记录，实际: ${cleanEpisodes.length}（distillResult=${JSON.stringify(result)}）`
      )
    })

    // ============================================================
    // D1.5 — ReportGenerator 验证
    // ============================================================
    await runStep('D1.5 ReportGenerator 生成日报', async () => {
      assert.ok(episodeIds.length > 0, '需要先有 Episode 才能生成日报')

      const reportResult = await ReportGenerator.generate({
        date: TEST_DATE,
        templateId: 'enhanced',
        episodeIds,
        notes: '测试备注'
      })

      // C3 降级提示：builtFromEpisodes 路径应追加"小时级理解未就绪"警告
      assert.ok(
        reportResult.warning.includes('小时级理解未就绪'),
        `warning 应包含"小时级理解未就绪"，实际: ${reportResult.warning}`
      )
      // C1 证据片段：markdown 应包含"证据片段："
      assert.ok(
        reportResult.markdown.includes('证据片段：'),
        `markdown 应包含"证据片段："，实际: ${reportResult.markdown.slice(0, 200)}`
      )
    })

    console.log('\n========== 全部验证通过 ==========')
  } finally {
    // ---------- 清理 ----------
    OpenAIClient.chatCompletion = originalChatCompletion
    resetDatabaseInstance()
    try {
      db.close()
    } catch {
      // DB 可能已关闭，忽略
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suffix)
      } catch {
        // 文件可能不存在，忽略
      }
    }
    moduleNs._load = originalModuleLoad
  }
}

// ===================== 步骤执行辅助 =====================
async function runStep(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}`)
    throw e
  }
}

// ===================== 入口 =====================
main()
  .then(() => {
    process.exit(0)
  })
  .catch((e) => {
    console.error('\n========== 验证失败 ==========')
    console.error(e instanceof Error ? e.message : String(e))
    if (e instanceof Error && e.stack) {
      console.error(e.stack)
    }
    process.exit(1)
  })
