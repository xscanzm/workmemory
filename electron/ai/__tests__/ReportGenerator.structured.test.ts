/**
 * ReportGenerator 结构化日报测试（Task RP1）
 *
 * 测试内容：
 *  - RP1.8 验证：构造含聊天/网页/视频活动的一天，确认日报含对应分类要点章节
 *  - RP1.4 分类要点生成：基于 segment.contentType 分组（chat/webpage/video/forum/product）
 *  - RP1.5 证据片段：从 MemCell.facts + segment.ocrText 提取，每条 ≤80 字
 *  - RP1.6 优化建议：从 ReflectionEngine 当周报告提取
 *  - RP1.3 MemCell + MemScene + causal_chains 上下文集成
 *  - AI 降级：未配置 API Key 时降级为规则生成
 *  - AI 增强：mock OpenAIClient 返回结构化 JSON
 *  - 渲染：renderStructuredReportToMarkdown 含所有分区标题
 *
 * 运行方式：npx vitest run electron/ai/__tests__/ReportGenerator.structured.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

// Mock electron 模块（database.ts 顶层 import { app } from 'electron'）
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

// Mock SettingsStore（避免 safeStorage / 文件系统依赖）
// 默认未配置 API Key，触发规则降级路径
vi.mock('../../db/SettingsStore', () => ({
  SettingsStore: {
    get: vi.fn().mockReturnValue({
      apiBaseUrl: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      aiAutoDistillEnabled: true,
      aiAutoDistillFirstConsentAt: '2026-06-21T00:00:00.000Z',
      aiDistillLastRunAt: '',
      aiDistillSchedule: 'hourly',
      aiDistillSendScreenshots: false,
      autoStart: false,
      screenshotRetentionDays: 0,
      ocrModel: 'tiny',
      apiKeyMasked: '',
      mascotStyle: 'note',
      saveScreenshots: false,
      allowFullScreenshotFallback: true
    }),
    getApiKey: vi.fn().mockReturnValue(''),
    set: vi.fn()
  }
}))

// Mock OpenAIClient（控制 AI 返回内容）
vi.mock('../OpenAIClient', () => ({
  OpenAIClient: {
    chatCompletion: vi.fn()
  }
}))

import { SCHEMA_SQL } from '../../db/schema'
import { runMigrations } from '../../db/migrations'
import { setDatabaseInstance, resetDatabaseInstance } from '../../db/database'
import { SegmentRepository } from '../../db/repositories/SegmentRepository'
import { MemCellRepository } from '../../db/repositories/MemCellRepository'
import { MemSceneRepository } from '../../db/repositories/MemSceneRepository'
import { CausalChainRepository } from '../../db/repositories/CausalChainRepository'
import { ReflectionReportRepository } from '../../db/repositories/ReflectionReportRepository'
import { ReportGenerator, renderStructuredReportToMarkdown } from '../ReportGenerator'
import type { GenerateReportPayload } from '../ReportGenerator'
import {
  DEFAULT_STRUCTURED_SECTIONS,
  REPORT_SECTION_TITLES,
  type StructuredReport,
  type ReportSection
} from '../templates'
import { OpenAIClient } from '../OpenAIClient'
import { SettingsStore } from '../../db/SettingsStore'
import type { WorkSegment } from '@/types'
import type { MemCell, MemCellMetadata } from '../../memory/MemCell'
import type { MemScene } from '../../memory/MemSceneClusterer'
import type { CausalChain } from '../CausalChainBuilder'

/** 创建内存数据库并运行迁移，返回 Database 实例 */
function createInMemoryDb(): DatabaseType {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  runMigrations(db)
  // 兼容 SegmentRepository.insert：segments 表 schema 未含 created_at/updated_at，
  // 但 SegmentRepository.segmentToParams 与 INSERT SQL 引用这两列。
  // 此处补齐列定义，使测试内存库与 Repository 行为一致。
  const segmentCols = db.prepare("PRAGMA table_info(segments)").all() as Array<{ name: string }>
  if (!segmentCols.some((c) => c.name === 'created_at')) {
    db.exec("ALTER TABLE segments ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
  }
  if (!segmentCols.some((c) => c.name === 'updated_at')) {
    db.exec("ALTER TABLE segments ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''")
  }
  return db as unknown as DatabaseType
}

/** 插入一条最小 clean_episodes 行（满足外键约束） */
function insertCleanEpisode(db: DatabaseType, id: string, date: string): void {
  db.prepare(
    `INSERT INTO clean_episodes (id, date, start_time, end_time) VALUES (?, ?, ?, ?)`
  ).run(id, date, '10:00:00', '11:00:00')
}

/** 构造并插入 MemCell（含 facts 与 contentType 元数据） */
function insertMemCell(
  db: DatabaseType,
  id: string,
  cleanEpisodeId: string,
  createdAt: string,
  episode: string,
  facts: string[],
  contentType?: string
): void {
  void db
  const metadata: MemCellMetadata = {
    segmentIds: [],
    timestamp: createdAt,
    confidence: 0.9,
    contentType
  }
  const memCell: MemCell = {
    id,
    cleanEpisodeId,
    episode,
    facts,
    foresight: [],
    metadata,
    createdAt
  }
  MemCellRepository.insert(memCell)
}

/** 构造并插入 MemScene（含成员 MemCell ID） */
function insertMemScene(
  db: DatabaseType,
  id: string,
  title: string,
  memberCellIds: string[],
  summary = ''
): void {
  void db
  const now = new Date().toISOString()
  const scene: MemScene = {
    id,
    title,
    centroidEmbedding: new Float32Array(1).fill(0.5),
    memberCellIds,
    summary,
    createdAt: now,
    updatedAt: now
  }
  MemSceneRepository.insert(scene)
}

/** 构造并插入 CausalChain */
function insertCausalChain(
  db: DatabaseType,
  id: string,
  causeCellId: string,
  effectCellId: string,
  relation: CausalChain['relation'],
  evidence: string
): void {
  void db
  const chain: CausalChain = {
    id,
    causeCellId,
    effectCellId,
    relation,
    confidence: 0.85,
    evidence,
    createdAt: new Date().toISOString()
  }
  CausalChainRepository.insert(chain)
}

/** 构造并插入 Segment（含 contentType + contentData） */
function insertSegment(
  db: DatabaseType,
  id: string,
  date: string,
  startTime: string,
  endTime: string,
  options: {
    appName?: string
    windowTitle?: string
    ocrText?: string
    ocrSummary?: string
    contentType?: string
    contentData?: Record<string, unknown>
    browserUrl?: string
  }
): WorkSegment {
  void db
  const segment: WorkSegment = {
    id,
    date,
    startTime,
    endTime,
    durationSeconds: 60,
    appName: options.appName ?? 'TestApp',
    processName: options.appName ?? 'TestApp',
    windowTitle: options.windowTitle ?? '',
    ocrText: options.ocrText ?? '',
    ocrSummary: options.ocrSummary ?? '',
    imageHash: '',
    screenshotPath: '',
    isSelectedForReport: true,
    isPrivate: false,
    isImportant: false,
    isDeleted: false,
    sourceStatus: 'ocr_done',
    userTitle: '',
    userSummary: '',
    userNote: '',
    tags: [],
    contentType: options.contentType as WorkSegment['contentType'],
    contentData: options.contentData,
    browserUrl: options.browserUrl
  }
  return SegmentRepository.insert(segment)
}

/** 构造结构化日报生成 payload */
function makePayload(date: string, segmentIds: string[]): GenerateReportPayload {
  return {
    date,
    templateId: 'structured',
    episodeIds: [],
    notes: '',
    reportInputSnapshot: {
      date,
      templateId: 'structured',
      userNotes: '',
      createdAt: new Date().toISOString(),
      sourceType: 'clean_episodes',
      items: [],
      segmentIds,
      cleanEpisodeIds: [],
      maskedCount: 0
    }
  }
}

describe('ReportGenerator 结构化日报（Task RP1）', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createInMemoryDb()
    setDatabaseInstance(db)
    // 重置 mock 状态：默认未配置 API Key，触发规则降级
    vi.mocked(SettingsStore.getApiKey).mockReturnValue('')
    vi.mocked(OpenAIClient.chatCompletion).mockReset()
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
  })

  // ===================== RP1.8 验证：含聊天/网页/视频活动的一天 =====================

  describe('RP1.8 含聊天/网页/视频活动的一天', () => {
    it('日报含对应分类要点章节（chatNotes/webNotes/videoNotes）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)

      // 聊天 segment
      const chatSeg = insertSegment(db, 'seg-chat', date, '10:00:00', '10:05:00', {
        appName: 'WeChat',
        windowTitle: '微信 - 工作群',
        ocrText: '张三: 明天开会\n李四: 收到',
        ocrSummary: '讨论明天会议安排',
        contentType: 'chat',
        contentData: {
          participants: ['张三', '李四'],
          messageCount: 2,
          keyMessages: ['明天开会', '收到'],
          platform: '微信'
        }
      })

      // 网页 segment
      const webSeg = insertSegment(db, 'seg-web', date, '11:00:00', '11:10:00', {
        appName: 'Chrome',
        windowTitle: 'React 文档 - Google Chrome',
        ocrText: 'React 是一个用于构建用户界面的 JavaScript 库\nhttps://react.dev',
        ocrSummary: '查阅 React 官方文档',
        contentType: 'webpage',
        contentData: {
          url: 'https://react.dev',
          pageTitle: 'React 文档',
          domain: 'react.dev',
          keyParagraphs: ['React 是一个用于构建用户界面的 JavaScript 库']
        },
        browserUrl: 'https://react.dev'
      })

      // 视频 segment
      const videoSeg = insertSegment(db, 'seg-video', date, '14:00:00', '14:30:00', {
        appName: 'Chrome',
        windowTitle: 'Bilibili - TypeScript 教程',
        ocrText: '0:39 / 5:23\nTypeScript 类型系统详解',
        ocrSummary: '观看 TypeScript 教程视频',
        contentType: 'video',
        contentData: {
          platform: 'bilibili',
          title: 'TypeScript 教程',
          duration: '5:23',
          subtitles: ['TypeScript 类型系统详解']
        }
      })

      // 插入 MemCell
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, '用户参与了工作群讨论', ['讨论了明天会议安排', '张三确认参加'])

      const payload = makePayload(date, [chatSeg.id, webSeg.id, videoSeg.id])
      const result = await ReportGenerator.generate(payload)

      // 日报 markdown 应含分类要点章节标题
      expect(result.markdown).toContain('## 聊天记录要点')
      expect(result.markdown).toContain('## 网页记录要点')
      expect(result.markdown).toContain('## 视频记录要点')

      // 聊天要点应含参与者与消息
      expect(result.markdown).toContain('张三')
      expect(result.markdown).toContain('微信')

      // 网页要点应含标题与域名
      expect(result.markdown).toContain('React 文档')
      expect(result.markdown).toContain('react.dev')

      // 视频要点应含标题与时长
      expect(result.markdown).toContain('TypeScript 教程')
      expect(result.markdown).toContain('5:23')
    })

    it('日报含管家总结/今日做了什么/今日看了什么/主题归纳/时间线/证据片段章节', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)

      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:30:00', {
        appName: 'VS Code',
        windowTitle: 'main.ts - VS Code',
        ocrText: 'function hello() {\n  return 42\n}',
        ocrSummary: '编写 hello 函数',
        contentType: 'code',
        contentData: { fileName: 'main.ts', language: 'typescript' }
      })

      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, '用户编写了 hello 函数', ['返回值为 42', '函数名 hello'])
      insertMemScene(db, 'scene-1', '编码工作', ['mc-1'], '编写 hello 函数')

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      // 应含所有默认分区标题
      expect(result.markdown).toContain('# 工作日报')
      expect(result.markdown).toContain('## 管家总结')
      expect(result.markdown).toContain('## 今日做了什么')
      expect(result.markdown).toContain('## 主题归纳')
      expect(result.markdown).toContain('## 时间线')
      expect(result.markdown).toContain('## 证据片段')
    })
  })

  // ===================== RP1.4 分类要点生成 =====================

  describe('RP1.4 分类要点生成（contentType 分组）', () => {
    it('chat contentType → chatNotes，含参与者与消息数', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-chat', date, '10:00:00', '10:05:00', {
        appName: 'Slack',
        windowTitle: '#general - Slack',
        contentType: 'chat',
        contentData: {
          participants: ['Alice', 'Bob'],
          messageCount: 5,
          platform: 'Slack'
        }
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 聊天记录要点')
      expect(result.markdown).toContain('Alice')
      expect(result.markdown).toContain('Slack')
      expect(result.markdown).toContain('消息数：5')
    })

    it('webpage contentType → webNotes，含 URL 与域名', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-web', date, '11:00:00', '11:10:00', {
        appName: 'Firefox',
        windowTitle: 'GitHub - Firefox',
        contentType: 'webpage',
        contentData: {
          url: 'https://github.com',
          pageTitle: 'GitHub',
          domain: 'github.com'
        }
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 网页记录要点')
      expect(result.markdown).toContain('github.com')
      expect(result.markdown).toContain('GitHub')
    })

    it('video contentType → videoNotes，含字幕与时长', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-video', date, '14:00:00', '14:30:00', {
        appName: 'YouTube',
        windowTitle: 'Tutorial - YouTube',
        contentType: 'video',
        contentData: {
          platform: 'youtube',
          title: 'Tutorial',
          duration: '10:00',
          subtitles: ['Welcome to the tutorial']
        }
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 视频记录要点')
      expect(result.markdown).toContain('youtube')
      expect(result.markdown).toContain('10:00')
    })

    it('forum contentType → forumNotes，含帖子与作者', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-forum', date, '15:00:00', '15:10:00', {
        appName: 'Chrome',
        windowTitle: 'Discussion - Reddit',
        contentType: 'forum',
        contentData: {
          threadTitle: 'TypeScript vs JavaScript',
          posts: 10,
          authors: ['user1', 'user2']
        }
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 论坛记录要点')
      expect(result.markdown).toContain('TypeScript vs JavaScript')
      expect(result.markdown).toContain('user1')
    })

    it('product contentType → productNotes，含商品名与价格', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-product', date, '16:00:00', '16:05:00', {
        appName: 'Chrome',
        windowTitle: '机械键盘 - 淘宝',
        contentType: 'product',
        contentData: {
          name: '机械键盘',
          price: '¥299',
          source: '淘宝'
        }
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 商品记录要点')
      expect(result.markdown).toContain('机械键盘')
      expect(result.markdown).toContain('¥299')
    })

    it('某 contentType 无对应 segment 时，对应 notes 为空（不输出该章节）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-chat', date, '10:00:00', '10:05:00', {
        appName: 'WeChat',
        contentType: 'chat',
        contentData: { platform: '微信' }
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      // 有聊天要点
      expect(result.markdown).toContain('## 聊天记录要点')
      // 无网页/视频/论坛/商品要点
      expect(result.markdown).not.toContain('## 网页记录要点')
      expect(result.markdown).not.toContain('## 视频记录要点')
      expect(result.markdown).not.toContain('## 论坛记录要点')
      expect(result.markdown).not.toContain('## 商品记录要点')
    })
  })

  // ===================== RP1.5 证据片段 =====================

  describe('RP1.5 证据片段提取', () => {
    it('从 MemCell.facts 提取证据片段', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code',
        ocrText: 'function test() {}'
      })
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, '用户编写了测试', ['使用了 vitest 框架', '测试覆盖率 80%'])

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 证据片段')
      expect(result.markdown).toContain('vitest')
      expect(result.markdown).toContain('测试覆盖率 80%')
    })

    it('从 segment.ocrText 提取含数字/URL 的关键行', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code',
        ocrText: '普通文本行\nhttps://example.com/page\n错误码 404\n普通行'
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 证据片段')
      expect(result.markdown).toContain('https://example.com/page')
      expect(result.markdown).toContain('404')
    })

    it('证据片段每条 ≤80 字（超长截断）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const longFact = 'a'.repeat(120) // 120 字，超过 80 字限制
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code',
        ocrText: ''
      })
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, '用户操作', [longFact])

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      // 截断后应为 80 字
      expect(result.markdown).toContain('a'.repeat(80))
      expect(result.markdown).not.toContain('a'.repeat(81))
    })
  })

  // ===================== RP1.6 优化建议 =====================

  describe('RP1.6 优化建议（从 ReflectionReport 提取）', () => {
    it('当周 ReflectionReport 存在时，从 suggestions 提取', async () => {
      const date = '2026-06-21' // 周日，weekStart = 2026-06-15
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code'
      })

      // 插入当周 ReflectionReport
      const weekStart = '2026-06-15'
      ReflectionReportRepository.upsert({
        weekStart,
        patterns: [],
        suggestions: [
          {
            title: '在 14:00 设置专注模式',
            rationale: '下午碎片化严重',
            action: '关闭通知，设置 25 分钟番茄钟'
          }
        ],
        trends: [],
        createdAt: new Date().toISOString()
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('## 优化建议')
      expect(result.markdown).toContain('专注模式')
      expect(result.markdown).toContain('番茄钟')
    })

    it('当周无 ReflectionReport 时，suggestions 为空（不输出该章节）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code'
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      // 无优化建议章节
      expect(result.markdown).not.toContain('## 优化建议')
    })
  })

  // ===================== RP1.3 MemCell + MemScene + causal_chains 上下文 =====================

  describe('RP1.3 上下文集成', () => {
    it('MemCell 上下文进入 whatIDid 与 themes', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code'
      })
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, '用户实现了登录功能', ['使用 JWT 鉴权'])
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, '用户编写了单元测试', ['覆盖率 90%'])
      insertMemScene(db, 'scene-1', '登录功能开发', ['mc-1', 'mc-2'], '实现登录与测试')

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      // whatIDid 应含 MemCell episode
      expect(result.markdown).toContain('## 今日做了什么')
      expect(result.markdown).toContain('登录功能')
      expect(result.markdown).toContain('单元测试')

      // themes 应含 MemScene title
      expect(result.markdown).toContain('## 主题归纳')
      expect(result.markdown).toContain('登录功能开发')
    })

    it('causal_chains 不影响日报生成（仅作为 AI 上下文）', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code'
      })
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, '用户查阅文档', ['阅读 API 文档'])
      insertMemCell(db, 'mc-2', 'ce-1', `${date}T11:00:00.000Z`, '用户实现功能', ['调用 API'])
      insertCausalChain(db, 'chain-1', 'mc-1', 'mc-2', 'enables', '查阅文档使实现功能成为可能')

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      // 日报应正常生成（不抛异常）
      expect(result.markdown).toContain('# 工作日报')
      expect(result.warning).toBe('AI 不可用，使用规则生成结构化日报')
    })
  })

  // ===================== AI 降级与增强 =====================

  describe('AI 降级（未配置 API Key）', () => {
    it('未配置 API Key 时降级为规则生成，warning 含提示', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code',
        ocrText: 'const x = 42'
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.warning).toBe('AI 不可用，使用规则生成结构化日报')
      expect(result.usage.totalTokens).toBe(0)
      // 仍应生成结构化 markdown
      expect(result.markdown).toContain('# 工作日报')
      expect(result.markdown).toContain('## 时间线')
    })
  })

  describe('AI 增强（mock OpenAIClient）', () => {
    it('AI 返回结构化 JSON 时覆盖规则结果', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code'
      })

      // 配置 API Key
      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: JSON.stringify({
          butlerSummary: 'AI 生成的管家总结',
          whatIDid: ['AI 做了任务 A', 'AI 做了任务 B'],
          whatISaw: ['AI 看了文档'],
          themes: ['AI 主题'],
          timeline: [
            { time: '10:00 ~ 10:30', title: 'AI 时间线', detail: 'AI 细节' }
          ],
          chatNotes: [{ title: 'AI 聊天', details: ['AI 消息'] }],
          webNotes: [],
          forumNotes: [],
          videoNotes: [],
          productNotes: [],
          evidence: ['AI 证据'],
          suggestions: ['AI 建议']
        }),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: 'stop'
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.markdown).toContain('AI 生成的管家总结')
      expect(result.markdown).toContain('AI 做了任务 A')
      expect(result.markdown).toContain('AI 主题')
      expect(result.markdown).toContain('AI 时间线')
      expect(result.markdown).toContain('AI 证据')
      expect(result.markdown).toContain('AI 建议')
      expect(result.usage.totalTokens).toBe(150)
      expect(result.warning).toBe('')
    })

    it('AI 返回不可解析 JSON 时降级为规则生成', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code',
        ocrText: 'const x = 42'
      })

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockResolvedValueOnce({
        content: '这不是 JSON',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop'
      })

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      // 降级为规则生成
      expect(result.warning).toBe('AI 不可用，使用规则生成结构化日报')
      expect(result.markdown).toContain('# 工作日报')
    })

    it('AI 调用失败时降级为规则生成', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code'
      })

      vi.mocked(SettingsStore.getApiKey).mockReturnValue('test-api-key')
      vi.mocked(OpenAIClient.chatCompletion).mockRejectedValueOnce(new Error('网络错误'))

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      expect(result.warning).toBe('AI 不可用，使用规则生成结构化日报')
      expect(result.markdown).toContain('# 工作日报')
    })
  })

  // ===================== 渲染：renderStructuredReportToMarkdown =====================

  describe('renderStructuredReportToMarkdown 渲染', () => {
    it('含所有默认分区标题', () => {
      const report: StructuredReport = {
        date: '2026-06-21',
        butlerSummary: '今日总结',
        whatIDid: ['做了任务 A'],
        whatISaw: ['看了文档'],
        themes: ['主题 A'],
        timeline: [{ time: '10:00 ~ 10:30', title: '时间线项' }],
        chatNotes: [{ title: '聊天', details: ['消息'] }],
        webNotes: [{ title: '网页', details: ['内容'] }],
        forumNotes: [{ title: '论坛', details: ['帖子'] }],
        videoNotes: [{ title: '视频', details: ['字幕'] }],
        productNotes: [{ title: '商品', details: ['价格'] }],
        evidence: ['证据 1'],
        suggestions: ['建议 1']
      }

      const markdown = renderStructuredReportToMarkdown(report)

      expect(markdown).toContain('# 工作日报 2026-06-21')
      for (const section of DEFAULT_STRUCTURED_SECTIONS) {
        expect(markdown).toContain(`## ${REPORT_SECTION_TITLES[section]}`)
      }
    })

    it('空数组分区不输出对应章节', () => {
      const report: StructuredReport = {
        date: '2026-06-21',
        butlerSummary: '今日总结',
        whatIDid: [],
        whatISaw: [],
        themes: [],
        timeline: [],
        chatNotes: [],
        webNotes: [],
        forumNotes: [],
        videoNotes: [],
        productNotes: [],
        evidence: [],
        suggestions: []
      }

      const markdown = renderStructuredReportToMarkdown(report)

      expect(markdown).toContain('# 工作日报 2026-06-21')
      expect(markdown).toContain('## 管家总结')
      // 空数组分区不输出
      expect(markdown).not.toContain('## 今日做了什么')
      expect(markdown).not.toContain('## 证据片段')
    })

    it('自定义 sections 子集只输出指定分区', () => {
      const report: StructuredReport = {
        date: '2026-06-21',
        butlerSummary: '今日总结',
        whatIDid: ['做了任务 A'],
        whatISaw: [],
        themes: [],
        timeline: [],
        chatNotes: [],
        webNotes: [],
        forumNotes: [],
        videoNotes: [],
        productNotes: [],
        evidence: [],
        suggestions: []
      }

      const sections: ReportSection[] = ['butler_summary', 'what_i_did']
      const markdown = renderStructuredReportToMarkdown(report, sections)

      expect(markdown).toContain('## 管家总结')
      expect(markdown).toContain('## 今日做了什么')
      expect(markdown).not.toContain('## 证据片段')
      expect(markdown).not.toContain('## 优化建议')
    })

    it('时间线含 detail/quote/evidence 子项', () => {
      const report: StructuredReport = {
        date: '2026-06-21',
        butlerSummary: '',
        whatIDid: [],
        whatISaw: [],
        themes: [],
        timeline: [
          {
            time: '10:00 ~ 10:30',
            title: '编码',
            detail: '编写函数',
            quote: '金句',
            evidence: '证据行'
          }
        ],
        chatNotes: [],
        webNotes: [],
        forumNotes: [],
        videoNotes: [],
        productNotes: [],
        evidence: [],
        suggestions: []
      }

      const markdown = renderStructuredReportToMarkdown(report, ['timeline'])

      expect(markdown).toContain('10:00 ~ 10:30')
      expect(markdown).toContain('编码')
      expect(markdown).toContain('细节：编写函数')
      expect(markdown).toContain('金句：金句')
      expect(markdown).toContain('证据：证据行')
    })
  })

  // ===================== aiInputSnapshot 审计 =====================

  describe('aiInputSnapshot 审计', () => {
    it('aiInputSnapshot 含 structuredReport 与上下文计数', async () => {
      const date = '2026-06-21'
      insertCleanEpisode(db, 'ce-1', date)
      const seg = insertSegment(db, 'seg-1', date, '10:00:00', '10:05:00', {
        contentType: 'code'
      })
      insertMemCell(db, 'mc-1', 'ce-1', `${date}T10:00:00.000Z`, '用户操作', ['事实 1'])

      const payload = makePayload(date, [seg.id])
      const result = await ReportGenerator.generate(payload)

      const snapshot = JSON.parse(result.aiInputSnapshot)
      expect(snapshot.templateId).toBe('structured')
      expect(snapshot.date).toBe(date)
      expect(snapshot.memCellCount).toBe(1)
      expect(snapshot.segmentCount).toBe(1)
      expect(snapshot.structuredReport).toBeDefined()
      expect(snapshot.structuredReport.date).toBe(date)
    })
  })
})
