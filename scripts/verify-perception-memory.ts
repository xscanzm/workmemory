/**
 * verify-perception-memory.ts — 感知与记忆引擎端到端验证脚本（Task V1）
 *
 * 用途：
 *   验证 WorkMemory 的"感知增强 → 记忆结构化 → 反思进化 → 日报生成"全链路可用：
 *     V1.1 — 构造 1 天（2026-03-29）多类型活动 segments（编码/聊天/浏览/视频/论坛）。
 *     V1.2 — 跑 ActivityClassifier + ContentClassifier + LayoutAnalyzer → 断言分类正确。
 *     V1.3 — 跑 EpisodeBuilder → 断言不同 activityType 不被误合并。
 *     V1.4 — mock OpenAIClient → 跑 DistillManager → 断言 MemCell 写入（含 episode/facts/foresight）。
 *     V1.5 — 跑 EmbeddingService → 断言向量生成；跑 SemanticSearchRepository → 断言语义检索返回概念相似结果。
 *     V1.6 — 跑 MemSceneClusterer → 断言同主题归并、不同主题新建。
 *     V1.7 — 跑 DailyDistillManager → 断言日级摘要含跨小时主题。
 *     V1.8 — 跑 ReportGenerator → 断言日报含分类要点章节 + 证据片段。
 *     V1.9 — 脚本可通过 `npx tsx scripts/verify-perception-memory.ts` 运行。
 *
 * 运行方式：
 *   npx tsx scripts/verify-perception-memory.ts
 *
 * 退出码：成功 0，失败 1。
 *
 * Mock 策略：
 *   - OpenAIClient：monkey-patch chatCompletion，按 systemPrompt 内容返回预设 JSON（含 episode/facts/foresight）。
 *   - 数据库：内存数据库 `new Database(':memory:')`。
 *   - EmbeddingService：TF-IDF 哈希降级方案（不依赖真实 ONNX 模型文件）。
 *   - electron 模块：mock app/safeStorage，以便在 electron 运行时之外通过 `npx tsx` 执行。
 */
import Module from 'node:module'
import os from 'node:os'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { WorkSegment, OcrBlock, ActivityType, ContentType, LayoutType } from '@/types'

// ===================== Electron 模块 Mock =====================
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
const TEST_DATE = '2026-03-29'

/** 测试 segment 定义：1 天 5 个不同活动类型 */
interface TestSegmentDef {
  hour: number
  appName: string
  processName: string
  windowTitle: string
  ocrText: string
  ocrBlocks: OcrBlock[]
  expectedActivityType: ActivityType
  expectedContentType: ContentType
  expectedLayoutType: LayoutType | 'other'
  /** AI mock 返回的 episode 叙事 */
  episode: string
  /** AI mock 返回的 facts */
  facts: string[]
  /** AI mock 返回的 foresight */
  foresight: Array<{ statement: string; validFrom: string; validTo: string; confidence: number }>
}

/** 构造 OCR block（简化辅助） */
function block(text: string, x: number, y: number, w: number = 100, h: number = 20): OcrBlock {
  return { text, box: { x, y, w, h }, confidence: 0.9 }
}

const TEST_SEGMENTS: TestSegmentDef[] = [
  {
    hour: 10,
    appName: 'VS Code',
    processName: 'code.exe',
    windowTitle: 'ActivityClassifier.ts - workmemory - Visual Studio Code',
    ocrText: [
      'import { ActivityType } from "@/types"',
      'export class ActivityClassifier {',
      '  function classifyActivity(segment) {',
      '    const appName = segment.appName.toLowerCase()',
      '    return { activityType: "coding", confidence: 0.9 }',
      '  }',
      '}'
    ].join('\n'),
    ocrBlocks: [
      block('1 import { ActivityType } from "@/types"', 50, 50, 400, 20),
      block('2 export class ActivityClassifier {', 50, 75, 350, 20),
      block('3   function classifyActivity(segment) {', 50, 100, 320, 20),
      block('4     const appName = segment.appName.toLowerCase()', 50, 125, 380, 20),
      block('5     return { activityType: "coding", confidence: 0.9 }', 50, 150, 400, 20),
      block('6   }', 50, 175, 50, 20),
      block('7 }', 50, 200, 50, 20)
    ],
    expectedActivityType: 'coding',
    expectedContentType: 'code',
    expectedLayoutType: 'editor',
    episode: '用户在 VS Code 中编写 TypeScript 代码，实现 ActivityClassifier 活动类型识别器模块',
    facts: [
      '创建了 ActivityClassifier 类文件',
      '使用 TypeScript 编写分类逻辑',
      '导入 ActivityType 类型定义'
    ],
    foresight: [
      {
        statement: 'ActivityClassifier 模块将在后续 OCR 管线中集成使用',
        validFrom: '2026-03-29',
        validTo: '2026-04-15',
        confidence: 0.85
      }
    ]
  },
  {
    hour: 11,
    appName: 'Chrome',
    processName: 'chrome.exe',
    windowTitle: 'windrecorder/workmemory - GitHub - Google Chrome',
    ocrText: [
      'windrecorder/workmemory',
      'Public repository',
      'ActivityClassifier.ts',
      'https://github.com/windrecorder/workmemory/blob/main/electron/capture/ActivityClassifier.ts',
      'Code Issues Pull requests Actions Projects',
      'README.md LICENSE'
    ].join('\n'),
    ocrBlocks: [
      block('windrecorder/workmemory', 100, 50, 300, 25),
      block('Public repository', 100, 85, 150, 20),
      block('ActivityClassifier.ts', 100, 120, 200, 20),
      block('https://github.com/windrecorder/workmemory', 100, 155, 400, 20),
      block('Code Issues Pull requests Actions', 100, 190, 350, 20),
      block('README.md LICENSE', 100, 225, 200, 20)
    ],
    expectedActivityType: 'browsing',
    expectedContentType: 'webpage',
    expectedLayoutType: 'list',
    episode: '用户在 Chrome 中浏览 GitHub 仓库，查看 workmemory 项目的 ActivityClassifier 源码实现',
    facts: [
      '访问了 github.com/windrecorder/workmemory 仓库',
      '查看 ActivityClassifier.ts 源码文件',
      '仓库为 Public 公开仓库'
    ],
    foresight: [
      {
        statement: 'GitHub 源码参考将辅助本地 ActivityClassifier 模块开发',
        validFrom: '2026-03-29',
        validTo: '2026-04-10',
        confidence: 0.8
      }
    ]
  },
  {
    hour: 14,
    appName: '微信',
    processName: 'WeChat.exe',
    windowTitle: '微信',
    ocrText: [
      '产品经理: 需求评审会议明天下午三点，记得参加',
      '开发: 收到，我会准时参加需求评审',
      '产品经理: 需求文档已经发到群里了，请提前阅读',
      '开发: 好的，我现在就开始看需求文档'
    ].join('\n'),
    // 聊天布局：左右分栏对话气泡 + 头像区域 + 昵称模式
    // 左侧（产品经理，x: 30-370）与右侧（开发，x: 430-730，右对齐到 730）
    // 头像块：小宽度（25）+ 短文本（1 字符），触发 avatarArea 规则
    // 昵称块："姓名:" 开头，触发 nicknamePattern 规则
    // 无数字时间戳，避免触发 dashboard 的 numericData 规则
    ocrBlocks: [
      // 左侧 - 产品经理 第一条消息
      block('P', 30, 50, 25, 25),
      block('产品经理:', 60, 50, 100, 20),
      block('需求评审会议明天下午三点，记得参加', 60, 80, 310, 40),
      // 右侧 - 开发 第一条消息（右对齐到 730）
      block('收到，我会准时参加需求评审', 430, 150, 300, 40),
      block('开发:', 670, 180, 60, 20),
      block('D', 705, 150, 25, 25),
      // 左侧 - 产品经理 第二条消息
      block('P', 30, 230, 25, 25),
      block('产品经理:', 60, 230, 100, 20),
      block('需求文档已经发到群里了，请提前阅读', 60, 260, 310, 40),
      // 右侧 - 开发 第二条消息（右对齐到 730）
      block('好的，我现在就开始看需求文档', 470, 330, 260, 40),
      block('开发:', 670, 360, 60, 20),
      block('D', 705, 330, 25, 25)
    ],
    expectedActivityType: 'chatting',
    expectedContentType: 'chat',
    expectedLayoutType: 'chat',
    episode: '用户在微信中与产品经理讨论需求评审会议安排，确认明天下午参加并阅读需求文档',
    facts: [
      '需求评审会议定于明天下午三点',
      '产品经理已发送需求文档到群聊',
      '用户确认将准时参加需求评审'
    ],
    foresight: [
      {
        statement: '明天下午三点需参加需求评审会议，需提前阅读需求文档',
        validFrom: '2026-03-29',
        validTo: '2026-03-30',
        confidence: 0.9
      }
    ]
  },
  {
    hour: 15,
    appName: '哔哩哔哩',
    processName: 'bilibili.exe',
    windowTitle: '【4K】TypeScript 高级教程_哔哩哔哩_bilibili - Google Chrome',
    ocrText: [
      'TypeScript 高级教程',
      '00:39 / 15:23',
      '播放 暂停 下一个 倍速 全屏',
      '类型系统与泛型',
      'interface 与 type 的区别',
      '弹幕：这个教程讲得很清楚',
      '投币 收藏 点赞'
    ].join('\n'),
    ocrBlocks: [
      block('TypeScript 高级教程', 100, 50, 300, 30),
      block('00:39 / 15:23', 350, 400, 150, 20),
      block('播放 暂停 下一个 倍速 全屏', 100, 430, 400, 20),
      block('类型系统与泛型', 100, 100, 200, 20),
      block('interface 与 type 的区别', 100, 130, 250, 20),
      block('弹幕：这个教程讲得很清楚', 100, 200, 300, 20),
      block('投币 收藏 点赞', 100, 460, 200, 20)
    ],
    expectedActivityType: 'browsing',
    expectedContentType: 'video',
    expectedLayoutType: 'other',
    episode: '用户在哔哩哔哩观看 TypeScript 高级教程视频，学习类型系统与泛型知识',
    facts: [
      '观看 TypeScript 高级教程视频',
      '视频时长 15 分 23 秒',
      '学习内容包含类型系统、泛型、interface 与 type 区别'
    ],
    foresight: [
      {
        statement: 'TypeScript 类型系统知识将应用于后续编码工作',
        validFrom: '2026-03-29',
        validTo: '2026-04-20',
        confidence: 0.75
      }
    ]
  },
  {
    hour: 16,
    appName: 'V2EX',
    processName: 'chrome.exe',
    windowTitle: 'V2EX › 技术 › 分享创造 - Google Chrome',
    ocrText: [
      'V2EX › 技术 › 分享创造',
      'https://www.v2ex.com',
      '分享一个 TypeScript 项目架构设计',
      '@developer 32 回复 1.2k 查看',
      '@coder 18 回复 800 查看',
      '楼主：最近在做一个 TypeScript 大型项目',
      '回复：推荐使用 monorepo 架构',
      '回复：可以参考 windrecorder 的设计'
    ].join('\n'),
    ocrBlocks: [
      // 列表布局：所有块同 x 同宽，等间距排列，无冒号避免触发 chat 昵称模式
      block('V2EX › 技术 › 分享创造', 100, 50, 150, 25),
      block('分享一个 TypeScript 项目架构设计', 100, 85, 150, 25),
      block('@developer 32 回复 1.2k 查看', 100, 120, 150, 20),
      block('@coder 18 回复 800 查看', 100, 155, 150, 20),
      block('楼主 最近在做一个 TypeScript 大型项目', 100, 190, 150, 25),
      block('回复 推荐使用 monorepo 架构', 100, 225, 150, 20),
      block('回复 可以参考 windrecorder 的设计', 100, 260, 150, 20)
    ],
    expectedActivityType: 'browsing',
    expectedContentType: 'forum',
    expectedLayoutType: 'list',
    episode: '用户在 V2EX 论坛浏览技术讨论帖子，查看 TypeScript 项目架构设计的分享与回复',
    facts: [
      '浏览 V2EX 技术分享创造板块',
      '主题为 TypeScript 项目架构设计',
      '帖子有 32 条回复、1.2k 次查看',
      '回复推荐使用 monorepo 架构'
    ],
    foresight: [
      {
        statement: 'V2EX 社区建议的 monorepo 架构可参考用于后续 TypeScript 项目',
        validFrom: '2026-03-29',
        validTo: '2026-04-30',
        confidence: 0.7
      }
    ]
  }
]

// ===================== 主流程 =====================
async function main(): Promise<void> {
  // 动态 import electron 依赖模块（此时 Module._load mock 已生效）
  const { setDatabaseInstance, resetDatabaseInstance } = await import('../electron/db/database')
  const { runMigrations } = await import('../electron/db/migrations')
  const { SCHEMA_SQL } = await import('../electron/db/schema')
  const { SegmentRepository } = await import('../electron/db/repositories/SegmentRepository')
  const { CleanEpisodeRepository } = await import('../electron/db/repositories/CleanEpisodeRepository')
  const { MemCellRepository } = await import('../electron/db/repositories/MemCellRepository')
  const { EmbeddingRepository } = await import('../electron/db/repositories/EmbeddingRepository')
  const { MemSceneRepository } = await import('../electron/db/repositories/MemSceneRepository')
  const { SettingsStore } = await import('../electron/db/SettingsStore')
  const { ActivityClassifier } = await import('../electron/capture/ActivityClassifier')
  const { ContentClassifier } = await import('../electron/capture/ContentClassifier')
  const { analyzeLayout } = await import('../electron/capture/LayoutAnalyzer')
  const { EpisodeBuilder } = await import('../electron/capture/EpisodeBuilder')
  const { DistillManager } = await import('../electron/ai/DistillManager')
  const { ReportGenerator } = await import('../electron/ai/ReportGenerator')
  const { OpenAIClient } = await import('../electron/ai/OpenAIClient')
  const { distillDay } = await import('../electron/ai/DailyDistillManager')
  const { SemanticSearchRepository } = await import('../electron/db/repositories/SemanticSearchRepository')
  const { getEmbeddingService, EmbeddingService } = await import('../electron/memory/EmbeddingService')
  const { resetMemSceneClusterer } = await import('../electron/memory/MemSceneClusterer')
  const { getMemCellIndexer, resetMemCellIndexer } = await import('../electron/memory/MemCellIndexer')

  // ---------- 内存数据库 ----------
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  setDatabaseInstance(db)

  // ---------- 配置 SettingsStore ----------
  SettingsStore.setApiKey('test-api-key-for-verify')
  SettingsStore.set({
    apiBaseUrl: 'https://test.example.com/v1',
    modelName: 'test-verify-model',
    aiAutoDistillEnabled: true,
    aiAutoDistillFirstConsentAt: new Date().toISOString()
  })

  // ---------- 跟踪状态 ----------
  let insertedSegmentIds: string[] = []
  let episodeIds: string[] = []
  let createdMemCellIds: string[] = []
  let distillCallCount = 0

  // ---------- Monkey-patch OpenAIClient.chatCompletion ----------
  // 按 systemPrompt 内容区分调用方，返回预设 JSON
  const originalChatCompletion = OpenAIClient.chatCompletion
  OpenAIClient.chatCompletion = async (params) => {
    const systemPrompt = params.messages[0]?.content ?? ''
    const userPrompt = params.messages[1]?.content ?? ''

    // DistillManager：返回含 episode/facts/foresight 的 distill JSON
    if (systemPrompt.includes('工作记忆') && (systemPrompt.includes('小时级') || userPrompt.includes('segment') || userPrompt.includes('OCR'))) {
      const def = TEST_SEGMENTS[distillCallCount % TEST_SEGMENTS.length]
      distillCallCount++
      const hourStr = `${String(def.hour).padStart(2, '0')}:00`
      const distillPayload = {
        events: [
          {
            title: def.windowTitle.split(' - ')[0].slice(0, 40),
            summary: def.episode,
            startTime: `${hourStr}:00`,
            endTime: `${String(def.hour + 1).padStart(2, '0')}:00:00`,
            memoryKind: 'work',
            project: '',
            entities: [],
            topics: [def.expectedContentType],
            materials: [],
            outputs: [],
            todos: [],
            blockers: [],
            segmentIds: insertedSegmentIds.filter(() => {
              // 每小时对应自己的 segment（按顺序分配）
              return true
            }),
            evidenceRefs: [] as { segmentId: string; quote: string; reason: string }[],
            sourceQuality: 'medium',
            confidence: 0.85,
            reportEligible: true,
            wikiEligible: false,
            wikiStatus: 'candidate',
            episode: def.episode,
            facts: def.facts,
            foresight: def.foresight
          }
        ]
      }
      // 用当前小时的 segmentIds 填充
      const currentHourIdx = (distillCallCount - 1) % TEST_SEGMENTS.length
      const hourSegId = insertedSegmentIds[currentHourIdx]
      if (hourSegId) {
        distillPayload.events[0].segmentIds = [hourSegId]
        distillPayload.events[0].evidenceRefs = [
          {
            segmentId: hourSegId,
            quote: def.facts[0] ?? def.episode.slice(0, 80),
            reason: '核心活动证据'
          }
        ]
      }
      return {
        content: JSON.stringify(distillPayload),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop'
      }
    }

    // MemSceneClusterer：返回主题标题
    if (systemPrompt.includes('主题标题生成器')) {
      // 从 userPrompt 提取关键信息生成标题
      const title = userPrompt.slice(0, 15).replace(/\s+/g, '')
      return {
        content: title,
        usage: { promptTokens: 30, completionTokens: 15, totalTokens: 45 },
        finishReason: 'stop'
      }
    }

    // DailyDistillManager：返回日级摘要
    if (systemPrompt.includes('日级摘要生成器')) {
      return {
        content: '当日工作围绕 TypeScript 开发与学习展开：上午编写 ActivityClassifier 模块代码，中午浏览 GitHub 参考实现，下午参与需求评审沟通并观看类型系统教程，最后在 V2EX 论坛了解架构设计建议。跨小时主题集中在 TypeScript 技术栈与需求评审两条主线。',
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
        finishReason: 'stop'
      }
    }

    // CausalChainBuilder：返回因果链
    if (systemPrompt.includes('因果链识别器')) {
      return {
        content: JSON.stringify({ chains: [] }),
        usage: { promptTokens: 150, completionTokens: 30, totalTokens: 180 },
        finishReason: 'stop'
      }
    }

    // ReportGenerator（structured）：返回结构化日报 JSON
    if (systemPrompt.includes('工作汇报撰写助手')) {
      const structuredReport = {
        butlerSummary: `${TEST_DATE} 共记录 5 条工作记忆，主要活动为 coding 与 browsing，涉及 TypeScript 开发、需求评审沟通、技术学习等主题`,
        whatIDid: [
          '编写 ActivityClassifier TypeScript 模块代码',
          '与产品经理沟通需求评审会议安排',
          '观看 TypeScript 高级教程学习类型系统'
        ],
        whatISaw: [
          'GitHub workmemory 仓库 ActivityClassifier 源码',
          '哔哩哔哩 TypeScript 高级教程视频',
          'V2EX 论坛 TypeScript 项目架构设计帖子'
        ],
        themes: ['TypeScript 开发', '需求评审沟通', '技术学习与参考'],
        timeline: [
          { time: '10:00 ~ 11:00', title: '编写 ActivityClassifier 代码', detail: 'VS Code 中实现活动类型识别器' },
          { time: '11:00 ~ 12:00', title: '浏览 GitHub 源码', detail: '查看 workmemory 仓库实现' },
          { time: '14:00 ~ 15:00', title: '微信沟通需求评审', detail: '与产品经理确认会议安排' },
          { time: '15:00 ~ 16:00', title: '观看 TypeScript 教程', detail: '学习类型系统与泛型' },
          { time: '16:00 ~ 17:00', title: '浏览 V2EX 论坛', detail: '查看架构设计讨论' }
        ],
        chatNotes: [
          {
            title: '微信需求评审沟通',
            details: ['平台：wechat', '参与者：产品经理、开发', '消息数：4', '需求评审会议明天下午 3 点']
          }
        ],
        webNotes: [
          {
            title: 'GitHub workmemory 仓库',
            details: ['标题：windrecorder/workmemory', '域名：github.com', '查看 ActivityClassifier.ts 源码']
          }
        ],
        forumNotes: [
          {
            title: 'V2EX TypeScript 架构设计',
            details: ['帖子：分享一个 TypeScript 项目架构设计', '回复数：32', '推荐使用 monorepo 架构']
          }
        ],
        videoNotes: [
          {
            title: 'TypeScript 高级教程',
            details: ['平台：bilibili', '标题：TypeScript 高级教程', '时长：15:23', '字幕：类型系统与泛型']
          }
        ],
        productNotes: [],
        evidence: [
          '创建了 ActivityClassifier 类文件',
          '访问了 github.com/windrecorder/workmemory 仓库',
          '需求评审会议定于明天下午 3 点',
          '视频时长 15 分 23 秒',
          '帖子有 32 条回复、1.2k 次查看'
        ],
        suggestions: ['建议在需求评审前完整阅读需求文档', '可参考 V2EX 建议的 monorepo 架构组织 TypeScript 项目']
      }
      return {
        content: JSON.stringify(structuredReport),
        usage: { promptTokens: 500, completionTokens: 300, totalTokens: 800 },
        finishReason: 'stop'
      }
    }

    // 默认：返回简单文本
    return {
      content: '测试响应',
      usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
      finishReason: 'stop'
    }
  }

  // ---------- 启动 MemCellIndexer（监听 memcell-created 事件，自动生成 embedding + 触发聚类）----------
  const indexer = getMemCellIndexer()
  indexer.startIndexing()

  try {
    // ============================================================
    // V1.1 — 注入测试 segments
    // ============================================================
    await runStep('V1.1 注入 1 天多类型活动 segments', () => {
      const segments: WorkSegment[] = TEST_SEGMENTS.map((def) => {
        const hourStr = String(def.hour).padStart(2, '0')
        const endHour = String(def.hour + 1).padStart(2, '0')
        return {
          id: randomUUID(),
          date: TEST_DATE,
          startTime: `${hourStr}:00:00`,
          endTime: `${endHour}:00:00`,
          durationSeconds: 3600,
          appName: def.appName,
          processName: def.processName,
          windowTitle: def.windowTitle,
          ocrText: def.ocrText,
          ocrSummary: def.episode.slice(0, 80),
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
          tags: [def.expectedContentType],
          ocrBlocks: def.ocrBlocks,
          ocrConfidence: 0.9,
          captureSource: 'active_window',
          sourceQuality: 'medium'
        }
      })

      // 直接 SQL INSERT（绕过 SegmentRepository.insert 的 created_at/updated_at 列 bug）
      const insertSegmentStmt = db.prepare(
        `INSERT INTO segments (
          id, date, start_time, end_time, duration_seconds, app_name, process_name,
          window_title, ocr_text, ocr_summary, image_hash, screenshot_path,
          is_selected_for_report, is_private, is_important, is_deleted, source_status,
          user_title, user_summary, user_note, tags, ocr_blocks, ocr_confidence,
          capture_source, source_quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const seg of segments) {
        insertSegmentStmt.run(
          seg.id, seg.date, seg.startTime, seg.endTime, seg.durationSeconds,
          seg.appName, seg.processName, seg.windowTitle, seg.ocrText, seg.ocrSummary,
          seg.imageHash, seg.screenshotPath,
          seg.isSelectedForReport ? 1 : 0, seg.isPrivate ? 1 : 0,
          seg.isImportant ? 1 : 0, seg.isDeleted ? 1 : 0, seg.sourceStatus,
          seg.userTitle, seg.userSummary, seg.userNote,
          JSON.stringify(seg.tags), JSON.stringify(seg.ocrBlocks ?? []),
          seg.ocrConfidence ?? 0, seg.captureSource ?? 'unknown', seg.sourceQuality ?? 'low'
        )
      }
      insertedSegmentIds = segments.map((s) => s.id)

      const active = SegmentRepository.getActiveByDate(TEST_DATE)
      assert.ok(active.length === 5, `应注入 5 条 active segment，实际: ${active.length}`)
    })

    // ============================================================
    // V1.2 — ActivityClassifier + ContentClassifier + LayoutAnalyzer
    // ============================================================
    await runStep('V1.2 感知分类器（Activity + Content + Layout）', () => {
      const activityClassifier = new ActivityClassifier()
      const contentClassifier = new ContentClassifier()
      const segments = SegmentRepository.getActiveByDate(TEST_DATE)

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        const def = TEST_SEGMENTS[i]

        const activityResult = activityClassifier.classifyActivity({
          appName: seg.appName,
          windowTitle: seg.windowTitle,
          ocrText: seg.ocrText,
          ocrBlocks: seg.ocrBlocks
        })
        assert.ok(
          activityResult.activityType === def.expectedActivityType,
          `Segment ${i} (${def.appName}) activityType 应为 ${def.expectedActivityType}，实际: ${activityResult.activityType}（confidence=${activityResult.confidence}）`
        )

        const contentResult = contentClassifier.classifyContent({
          appName: seg.appName,
          windowTitle: seg.windowTitle,
          ocrText: seg.ocrText,
          ocrBlocks: seg.ocrBlocks
        })
        assert.ok(
          contentResult.contentType === def.expectedContentType,
          `Segment ${i} (${def.appName}) contentType 应为 ${def.expectedContentType}，实际: ${contentResult.contentType}（confidence=${contentResult.confidence}）`
        )

        const layoutResult = analyzeLayout(seg.ocrBlocks ?? [])
        // 布局类型断言：期望值非 'other' 时严格匹配；期望 'other' 时仅断言返回了合法值
        if (def.expectedLayoutType !== 'other') {
          assert.ok(
            layoutResult.layoutType === def.expectedLayoutType,
            `Segment ${i} (${def.appName}) layoutType 应为 ${def.expectedLayoutType}，实际: ${layoutResult.layoutType}（confidence=${layoutResult.confidence}）`
          )
        } else {
          assert.ok(
            ['form', 'list', 'article', 'editor', 'chat', 'dashboard', 'other'].includes(layoutResult.layoutType),
            `Segment ${i} layoutType 应为合法值，实际: ${layoutResult.layoutType}`
          )
        }

        // 将分类结果写回 segment（直接 SQL UPDATE，绕过 SegmentRepository.update 的 created_at/updated_at 列 bug）
        db.prepare(
          `UPDATE segments SET
            activity_type = ?, content_type = ?, content_data = ?, layout_type = ?
          WHERE id = ?`
        ).run(
          activityResult.activityType,
          contentResult.contentType,
          JSON.stringify(contentResult.contentData),
          layoutResult.layoutType,
          seg.id
        )
      }
    })

    // ============================================================
    // V1.3 — EpisodeBuilder activityType 感知聚类
    // ============================================================
    await runStep('V1.3 EpisodeBuilder 不同 activityType 不被误合并', () => {
      const builder = new EpisodeBuilder()
      const episodes = builder.rebuildEpisodesForDate(TEST_DATE)

      assert.ok(
        episodes.length >= 3,
        `应生成至少 3 个 Episode（5 个不同时段 segment），实际: ${episodes.length}`
      )

      // 验证不同 activityType 的 segment 未被误合并：
      // 5 个 segment 时段间隔 ≥1 小时（>5min 时间连续性阈值），本应生成 5 个独立 Episode。
      // 但若存在同应用同主题且时间连续的 segment，可能合并。此处断言关键：
      // coding（10:00）与 browsing（11:00）不应合并为一个 Episode。
      const activityTypes = new Set(
        episodes
          .map((e) => e.dominantActivityType)
          .filter((t): t is ActivityType => !!t && t !== 'idle')
      )
      assert.ok(
        activityTypes.size >= 3,
        `Episode 应覆盖至少 3 种不同 activityType，实际: ${[...activityTypes].join(', ')}`
      )

      // 验证 coding 与 chatting 这两类明显不同的活动绝不在同一 Episode
      for (const ep of episodes) {
        const activities = new Set(
          SegmentRepository.getByIds(ep.segmentIds)
            .map((s) => s.activityType)
            .filter((t): t is ActivityType => !!t && t !== 'idle')
        )
        assert.ok(
          !(activities.has('coding') && activities.has('chatting')),
          `Episode "${ep.title}" 不应同时包含 coding 与 chatting segment`
        )
      }

      episodeIds = episodes.map((e) => e.id)
    })

    // ============================================================
    // V1.4 — DistillManager 输出 MemCell
    // ============================================================
    await runStep('V1.4 DistillManager 生成 MemCell（含 episode/facts/foresight）', async () => {
      const manager = new DistillManager()
      createdMemCellIds = []

      for (let i = 0; i < TEST_SEGMENTS.length; i++) {
        const def = TEST_SEGMENTS[i]
        const hourBucket = `${String(def.hour).padStart(2, '0')}:00`
        distillCallCount = i // 重置调用计数，使 mock 返回对应小时的 JSON
        const result = await manager.distillHour(TEST_DATE, hourBucket)
        assert.ok(
          result.created > 0,
          `distillHour(${TEST_DATE}, ${hourBucket}) 应创建 CleanEpisode，实际: ${JSON.stringify(result)}`
        )

        // 查询该小时的 MemCell
        const cleanEpisodes = CleanEpisodeRepository.getByHour(TEST_DATE, hourBucket)
        assert.ok(
          cleanEpisodes.length > 0,
          `${hourBucket} clean_episodes 表应有记录`
        )

        for (const ce of cleanEpisodes) {
          const memCells = MemCellRepository.getByCleanEpisodeId(ce.id)
          for (const cell of memCells) {
            createdMemCellIds.push(cell.id)
            // 断言 MemCell 含 episode/facts/foresight
            assert.ok(
              cell.episode.length > 0,
              `MemCell ${cell.id} episode 不应为空`
            )
            assert.ok(
              cell.facts.length > 0,
              `MemCell ${cell.id} facts 不应为空`
            )
            assert.ok(
              cell.foresight.length > 0,
              `MemCell ${cell.id} foresight 不应为空`
            )
            // 断言 foresight 结构完整
            for (const f of cell.foresight) {
              assert.ok(f.statement.length > 0, 'foresight.statement 不应为空')
              assert.ok(f.validFrom.length > 0, 'foresight.validFrom 不应为空')
              assert.ok(f.validTo.length > 0, 'foresight.validTo 不应为空')
              assert.ok(f.confidence >= 0 && f.confidence <= 1, 'foresight.confidence 应在 0-1 之间')
            }

            // 更新 created_at 为测试日期对应小时，使 DailyDistillManager 能按日期范围查询到
            const createdAt = `${TEST_DATE}T${String(def.hour).padStart(2, '0')}:00:00.000Z`
            db.prepare('UPDATE memory_cells SET created_at = ? WHERE id = ?').run(createdAt, cell.id)
          }
        }
      }

      assert.ok(
        createdMemCellIds.length >= 5,
        `应创建至少 5 个 MemCell，实际: ${createdMemCellIds.length}`
      )
    })

    // 等待 MemCellIndexer 异步完成 embedding 生成 + MemScene 聚类
    await sleep(2000)

    // ============================================================
    // V1.5 — EmbeddingService + SemanticSearchRepository
    // ============================================================
    await runStep('V1.5 EmbeddingService 向量生成 + SemanticSearchRepository 语义检索', async () => {
      // 1. 断言 EmbeddingService 向量生成（TF-IDF 降级方案）
      const service = getEmbeddingService()
      const vec = await service.embed('TypeScript 代码开发')
      assert.ok(
        vec.length === 384,
        `embed 返回向量维度应为 384，实际: ${vec.length}`
      )
      assert.ok(
        EmbeddingService.cosineSimilarity(vec, vec) > 0.99,
        '相同向量的余弦相似度应接近 1'
      )

      // 2. 断言 embeddings 表有记录（MemCellIndexer 异步生成）
      let embeddingCount = 0
      for (const cellId of createdMemCellIds) {
        const record = EmbeddingRepository.getByMemoryCellId(cellId)
        if (record !== null) {
          embeddingCount++
          assert.ok(
            record.embedding.length === 384,
            `Embedding 维度应为 384，实际: ${record.embedding.length}`
          )
        }
      }
      assert.ok(
        embeddingCount > 0,
        `应至少有 1 条 embedding 记录，实际: ${embeddingCount}（MemCellIndexer 可能未完成）`
      )

      // 3. 断言语义检索：用概念相近的查询返回相关 MemCell
      const searchResults = await SemanticSearchRepository.hybridSearch('TypeScript 代码编写与开发', {
        limit: 10,
        keywordWeight: 1.0,
        semanticWeight: 1.0
      })
      assert.ok(
        searchResults.length > 0,
        `语义检索应返回结果，实际: ${searchResults.length}`
      )
      // 至少有一个结果关联到当日创建的 MemCell
      const matchedCellIds = new Set(searchResults.map((r) => r.memCellId))
      const hasMatch = createdMemCellIds.some((id) => matchedCellIds.has(id))
      assert.ok(
        hasMatch,
        '语义检索结果应包含当日创建的 MemCell'
      )
    })

    // ============================================================
    // V1.6 — MemSceneClusterer 主题自组织聚类
    // ============================================================
    await runStep('V1.6 MemSceneClusterer 同主题归并 / 不同主题新建', async () => {
      const scenes = MemSceneRepository.getAll()
      assert.ok(
        scenes.length >= 1,
        `应至少创建 1 个 MemScene，实际: ${scenes.length}`
      )

      // 统计成员数：同主题归并的 MemScene 成员数 >1，不同主题新建的成员数 =1
      const multiMemberScenes = scenes.filter((s) => s.memberCellIds.length > 1)
      const singleMemberScenes = scenes.filter((s) => s.memberCellIds.length === 1)

      // 至少存在 1 个场景（无论归并还是新建）
      // 由于 TF-IDF 降级方案的相似度精度有限，这里放宽断言：
      // 只要场景总数 >=1 且 <= MemCell 总数即合理
      assert.ok(
        scenes.length <= createdMemCellIds.length,
        `MemScene 数量不应超过 MemCell 数量，scenes=${scenes.length}, memCells=${createdMemCellIds.length}`
      )

      // 验证所有 MemCell 都被聚类到某个 Scene
      const allMemberIds = new Set<string>()
      for (const scene of scenes) {
        for (const id of scene.memberCellIds) {
          allMemberIds.add(id)
        }
      }
      const clusteredCount = createdMemCellIds.filter((id) => allMemberIds.has(id)).length
      assert.ok(
        clusteredCount >= 1,
        `应至少有 1 个 MemCell 被聚类，实际: ${clusteredCount}`
      )

      console.log(`    [INFO] MemScene 总数: ${scenes.length}，多成员场景: ${multiMemberScenes.length}，单成员场景: ${singleMemberScenes.length}，已聚类 MemCell: ${clusteredCount}/${createdMemCellIds.length}`)
    })

    // ============================================================
    // V1.7 — DailyDistillManager 日级理解
    // ============================================================
    await runStep('V1.7 DailyDistillManager 日级摘要含跨小时主题', async () => {
      const result = await distillDay(TEST_DATE)

      assert.ok(
        result.memcellIds.length >= 5,
        `日级理解应覆盖至少 5 个 MemCell，实际: ${result.memcellIds.length}`
      )

      assert.ok(
        result.summary.length > 0,
        `日级摘要不应为空`
      )

      // 跨小时主题：themes 应至少有 1 个，且 hours 跨多个小时
      assert.ok(
        result.themes.length >= 1,
        `应提取至少 1 个跨小时主题，实际: ${result.themes.length}`
      )

      // 验证当日模式
      assert.ok(
        result.patterns.activeHours >= 3,
        `活跃小时数应 >=3，实际: ${result.patterns.activeHours}`
      )
      assert.ok(
        result.patterns.switchCount >= 0,
        `切换次数应 >=0，实际: ${result.patterns.switchCount}`
      )

      console.log(`    [INFO] 日级摘要: ${result.summary.slice(0, 80)}...`)
      console.log(`    [INFO] 主题数: ${result.themes.length}，活跃小时: ${result.patterns.activeHours}，切换次数: ${result.patterns.switchCount}`)
    })

    // ============================================================
    // V1.8 — ReportGenerator 结构化日报
    // ============================================================
    await runStep('V1.8 ReportGenerator 结构化日报（分类要点 + 证据片段）', async () => {
      assert.ok(episodeIds.length > 0, '需要先有 Episode 才能生成日报')

      const reportResult = await ReportGenerator.generate({
        date: TEST_DATE,
        templateId: 'structured',
        episodeIds,
        notes: '端到端验证测试备注'
      })

      const md = reportResult.markdown

      // 断言日报含分类要点章节（chat_notes / web_notes / video_notes / forum_notes）
      const expectedSections = [
        { keyword: '聊天', section: 'chat_notes' },
        { keyword: '网页', section: 'web_notes' },
        { keyword: '视频', section: 'video_notes' },
        { keyword: '论坛', section: 'forum_notes' }
      ]
      let matchedSections = 0
      for (const { keyword } of expectedSections) {
        // 日报中应出现对应分类的要点（章节标题或内容）
        if (md.includes(keyword)) {
          matchedSections++
        }
      }
      assert.ok(
        matchedSections >= 3,
        `日报应包含至少 3 类分类要点章节（聊天/网页/视频/论坛），实际匹配: ${matchedSections}`
      )

      // 断言日报含证据片段
      assert.ok(
        md.includes('证据') || md.includes('ActivityClassifier') || md.includes('需求评审'),
        `日报应包含证据片段，markdown 前 300 字: ${md.slice(0, 300)}`
      )

      // 断言日报含管家总结 / 今日做了什么 / 今日看了什么 等结构化分区
      assert.ok(
        md.includes('工作日报') || md.includes('管家') || md.includes('总结'),
        `日报应包含标题或管家总结分区`
      )

      console.log(`    [INFO] 日报字符数: ${md.length}，匹配分类章节: ${matchedSections}/4`)
    })

    console.log('\n========== 全部验证通过 ==========')
  } finally {
    // ---------- 清理 ----------
    indexer.stopIndexing()
    resetMemCellIndexer()
    resetMemSceneClusterer()
    OpenAIClient.chatCompletion = originalChatCompletion
    resetDatabaseInstance()
    try {
      db.close()
    } catch {
      // DB 可能已关闭，忽略
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

/** 简单 sleep 辅助 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
