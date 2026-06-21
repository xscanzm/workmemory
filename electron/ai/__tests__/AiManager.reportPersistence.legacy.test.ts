import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

vi.mock('../../db/SettingsStore', () => ({
  SettingsStore: {
    get: vi.fn().mockReturnValue({
      apiBaseUrl: 'https://api.deepseek.example/v1',
      modelName: 'deepseek-v4-flash'
    }),
    getApiKey: vi.fn().mockReturnValue('test-api-key')
  }
}))

vi.mock('../OpenAIClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../OpenAIClient')>()
  return {
    ...actual,
    OpenAIClient: {
      ...actual.OpenAIClient,
      chatCompletion: vi.fn()
    }
  }
})

import type { ReportInputSnapshot, ReportSnapshotItem } from '@/types'
import { resetDatabaseInstance, setDatabaseInstance } from '../../db/database'
import { OpenAiApiError, OpenAIClient } from '../OpenAIClient'
import { AiManager } from '../AiManager'

function createLegacyReportsDb(): DatabaseType {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE reports (
      id              TEXT PRIMARY KEY NOT NULL,
      date            TEXT NOT NULL,
      template_id     TEXT NOT NULL DEFAULT 'enhanced',
      template_name   TEXT NOT NULL DEFAULT '',
      segment_ids     TEXT NOT NULL DEFAULT '[]',
      prompt_snapshot TEXT NOT NULL,
      markdown_content TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'draft',
      report_type     TEXT NOT NULL DEFAULT 'daily'
    );
  `)
  return db as unknown as DatabaseType
}

function makeLongSnapshot(date: string): ReportInputSnapshot {
  const items: ReportSnapshotItem[] = Array.from({ length: 32 }, (_, index) => {
    const n = index + 1
    const repeated = `第 ${n} 段持续记录：用户在 WorkMemory 中整理日报、检查记录连续性、复核 AI 摘要失败后的本地降级策略，并要求保留证据与时间线。`
      .repeat(9)
    return {
      id: `episode-${n}`,
      startTime: `10:${String(index).padStart(2, '0')}:00`,
      endTime: `10:${String(index).padStart(2, '0')}:30`,
      title: `持续记录验证片段 ${n}`,
      summary: repeated,
      project: n % 2 === 0 ? 'WorkMemory' : '',
      topics: ['日报生成', 'DeepSeek兼容', '旧库落库'],
      entities: [{ type: 'project', name: 'WorkMemory', confidence: 0.95 }],
      evidenceRefs: [
        {
          segmentId: `segment-${n}`,
          quote: `证据 ${n}：${repeated.slice(0, 160)}`,
          reason: '12000 字完整链路验证'
        }
      ],
      segmentIds: [`segment-${n}`],
      sourceQuality: 'medium',
      confidence: 0.8
    }
  })

  return {
    date,
    templateId: 'concise',
    userNotes: '请生成简洁客观日报；如果 AI 只返回思考内容，必须本地降级并保存草稿。',
    createdAt: '2026-06-22T00:20:00.000Z',
    sourceType: 'raw_fallback',
    items,
    segmentIds: items.flatMap((item) => item.segmentIds),
    cleanEpisodeIds: [],
    maskedCount: 0
  }
}

describe('AiManager report persistence with legacy prompt_snapshot', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createLegacyReportsDb()
    setDatabaseInstance(db)
    vi.mocked(OpenAIClient.chatCompletion).mockRejectedValue(
      new OpenAiApiError(
        'AI 仅返回了思考内容，最终答案在达到输出上限前未生成。',
        200,
        false,
        { reasonCode: 'reasoning_only', reasoningContent: 'reasoning only' }
      )
    )
  })

  afterEach(() => {
    resetDatabaseInstance()
    db.close()
    vi.mocked(OpenAIClient.chatCompletion).mockReset()
  })

  it('saves a 12000+ char fallback report into old reports.prompt_snapshot and returns the saved draft', async () => {
    const snapshot = makeLongSnapshot('2026-06-22')
    const manager = new AiManager()

    const result = await manager.generateReport({
      date: '2026-06-22',
      templateId: 'concise',
      episodeIds: snapshot.items.map((item) => item.id),
      notes: snapshot.userNotes,
      reportInputSnapshot: snapshot
    })

    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(result.reportId) as {
      id: string
      prompt_snapshot: string
      markdown_content: string
      status: string
      report_type: string
    }

    expect(result.reportId).toBeTruthy()
    expect(result.report.status).toBe('draft')
    expect(result.warning).toContain('AI 未返回最终答案')
    expect(result.aiInputSnapshot.length).toBeGreaterThan(12_000)
    expect(result.markdown).toContain('# 工作日报 2026-06-22')
    expect(result.markdown).toContain('本日报由本地规则基于勾选片段生成')
    expect(row.prompt_snapshot.length).toBe(result.aiInputSnapshot.length)
    expect(row.markdown_content).toBe(result.markdown)
    expect(row.status).toBe('draft')
    expect(row.report_type).toBe('daily')

    console.info(
      JSON.stringify(
        {
          reportId: result.reportId,
          warning: result.warning,
          aiInputSnapshotChars: result.aiInputSnapshot.length,
          markdownChars: result.markdown.length,
          promptSnapshotChars: row.prompt_snapshot.length,
          markdownPreview: result.markdown.slice(0, 240)
        },
        null,
        2
      )
    )
  })
})
