/**
 * OcrQueue 感知增强集成测试（Task P7）
 *
 * 验证 OcrQueue.onOcrSuccess 集成 5 个感知增强分类器后，
 * 分类结果（activityType / contentType / contentData / browserUrl / layoutType / actionFlow）
 * 正确写入 SegmentRepository.update 的 patch。
 *
 * 覆盖场景：
 *  - 代码 segment：VS Code + 代码 OCR → coding / code / contentData
 *  - 聊天 segment：微信 + 聊天 OCR → chatting / chat / participants
 *  - 网页 segment：Chrome + 网页 OCR → browsing / webpage / browserUrl
 *  - ActionFlow：同窗口两个 segment → 第二个 segment 有 actionFlow
 *
 * 运行方式：npx vitest run electron/ocr/__tests__/OcrQueue.perception.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock SegmentRepository（避免数据库依赖）
vi.mock('../../db/repositories/SegmentRepository', () => ({
  SegmentRepository: {
    getById: vi.fn(),
    update: vi.fn().mockReturnValue(null)
  }
}))

// Mock Screenshot（避免文件删除副作用）
vi.mock('../../capture/Screenshot', () => ({
  Screenshot: {
    deleteTempScreenshot: vi.fn()
  }
}))

import { OcrQueue } from '../OcrQueue'
import type { OcrResult, PpOcrEngine } from '../PpOcrEngine'
import type { WorkSegment } from '@/types'
import { SegmentRepository } from '../../db/repositories/SegmentRepository'

/**
 * 创建 fake OCR 引擎：isLoaded 恒真，recognize 返回预设结果。
 * recognize 使用 mockResolvedValueOnce 支持多次调用返回不同结果。
 */
function createFakeEngine(results: OcrResult[]): PpOcrEngine {
  const recognizeMock = vi.fn()
  for (const r of results) {
    recognizeMock.mockResolvedValueOnce(r)
  }
  // 兜底：超出预设次数时返回最后一个结果
  recognizeMock.mockResolvedValue(results[results.length - 1])
  return {
    isLoaded: () => true,
    initialize: vi.fn().mockResolvedValue(undefined),
    recognize: recognizeMock,
    release: vi.fn()
  } as unknown as PpOcrEngine
}

/** 创建测试 segment（sourceStatus='pending'，含截图路径） */
function makeSegment(overrides: Partial<WorkSegment> & { id: string }): WorkSegment {
  return {
    date: '2026-06-21',
    startTime: '10:30:00',
    endTime: '10:30:30',
    durationSeconds: 30,
    appName: 'Visual Studio Code',
    processName: 'Code.exe',
    windowTitle: 'main.ts - WorkMemory - Code',
    ocrText: '',
    ocrSummary: '',
    imageHash: '',
    screenshotPath: '',
    isSelectedForReport: false,
    isPrivate: false,
    isImportant: false,
    isDeleted: false,
    sourceStatus: 'pending',
    userTitle: '',
    userSummary: '',
    userNote: '',
    tags: [],
    ...overrides
  }
}

/**
 * 处理单个 segment 并捕获 SegmentRepository.update 的 patch。
 * 返回 Promise，在 'ocr-completed' 事件触发时 resolve。
 */
async function processOneSegment(
  queue: OcrQueue,
  segment: WorkSegment
): Promise<Partial<WorkSegment>> {
  const capturedPatch: Partial<WorkSegment> = {}

  vi.mocked(SegmentRepository.getById).mockReturnValue(segment)
  vi.mocked(SegmentRepository.update).mockImplementation((_id, patch) => {
    Object.assign(capturedPatch, patch)
    return null
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for ocr-completed event'))
    }, 5000)

    const onCompleted = (): void => {
      clearTimeout(timeout)
      queue.off('ocr-failed', onFailed)
      resolve(capturedPatch)
    }

    const onFailed = (_id: string, error: Error): void => {
      clearTimeout(timeout)
      queue.off('ocr-completed', onCompleted)
      reject(error)
    }

    queue.once('ocr-completed', onCompleted)
    queue.once('ocr-failed', onFailed)

    queue.enqueue(segment.id)
    queue.start()
  })
}

describe('OcrQueue 感知增强集成', () => {
  let tmpDir: string
  let screenshotPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrqueue-perception-'))
    screenshotPath = path.join(tmpDir, 'screenshot.png')
    fs.writeFileSync(screenshotPath, Buffer.from('fake-image'))
    vi.mocked(SegmentRepository.update).mockReturnValue(null)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  // ===================== 代码 segment =====================

  describe('代码 segment 感知增强', () => {
    it('VS Code + 代码 OCR → activityType=coding, contentType=code, contentData 含 fileName/language', async () => {
      const segment = makeSegment({
        id: 'code-seg-1',
        appName: 'Visual Studio Code',
        processName: 'Code.exe',
        windowTitle: 'OcrQueue.ts - WorkMemory - Code',
        screenshotPath
      })
      const ocrResult: OcrResult = {
        text: [
          'export class OcrQueue {',
          '  private onOcrSuccess(segment: WorkSegment, result: OcrResult): void {',
          '    const cleanedText = getOcrTextCleaner().clean(result.text)',
          '    return cleanedText',
          '  }',
          '}',
          'import { EventEmitter } from "node:events"'
        ].join('\n'),
        boxes: [],
        confidence: 0.9,
        elapsed: 100
      }
      const engine = createFakeEngine([ocrResult])
      const queue = new OcrQueue(engine)

      try {
        const patch = await processOneSegment(queue, segment)

        // 基础 OCR 字段
        expect(patch.sourceStatus).toBe('ocr_done')
        expect(patch.ocrText).toContain('export class OcrQueue')

        // 感知增强字段
        expect(patch.activityType).toBe('coding')
        expect(patch.contentType).toBe('code')
        expect(patch.contentData).toBeDefined()
        const data = patch.contentData as Record<string, unknown>
        expect(data.fileName).toBe('OcrQueue.ts')
        expect(data.language).toBe('typescript')
        expect(patch.layoutType).toBeDefined()
        // 非浏览器进程，browserUrl 不应设置
        expect(patch.browserUrl).toBeUndefined()
        // 首个 segment 无前驱，actionFlow 不应设置
        expect(patch.actionFlow).toBeUndefined()
      } finally {
        queue.stop()
      }
    })
  })

  // ===================== 聊天 segment =====================

  describe('聊天 segment 感知增强', () => {
    it('微信 + 聊天 OCR → activityType=chatting, contentType=chat, contentData 含 participants', async () => {
      const segment = makeSegment({
        id: 'chat-seg-1',
        appName: '微信',
        processName: 'WeChat.exe',
        windowTitle: '工作群 - 微信',
        screenshotPath
      })
      const ocrResult: OcrResult = {
        text: [
          '张三: 这个需求我们今天讨论一下会议时间',
          '李四: 好的，我准备一下材料',
          '[微笑]'
        ].join('\n'),
        boxes: [],
        confidence: 0.85,
        elapsed: 100
      }
      const engine = createFakeEngine([ocrResult])
      const queue = new OcrQueue(engine)

      try {
        const patch = await processOneSegment(queue, segment)

        expect(patch.sourceStatus).toBe('ocr_done')
        expect(patch.activityType).toBe('chatting')
        expect(patch.contentType).toBe('chat')
        expect(patch.contentData).toBeDefined()
        const data = patch.contentData as { participants: string[]; platform: string }
        expect(data.participants).toContain('张三')
        expect(data.participants).toContain('李四')
        expect(data.platform).toBe('wechat')
        expect(patch.layoutType).toBeDefined()
        expect(patch.browserUrl).toBeUndefined()
        expect(patch.actionFlow).toBeUndefined()
      } finally {
        queue.stop()
      }
    })
  })

  // ===================== 网页 segment =====================

  describe('网页 segment 感知增强', () => {
    it('Chrome + 网页 OCR → activityType=browsing, contentType=webpage, browserUrl 含 github.com', async () => {
      const segment = makeSegment({
        id: 'webpage-seg-1',
        appName: 'Google Chrome',
        processName: 'chrome.exe',
        windowTitle: 'WorkMemory - github.com - Google Chrome',
        screenshotPath
      })
      const ocrResult: OcrResult = {
        text: [
          'Code Issues Pull requests',
          'Sign in',
          'WorkMemory is a screen memory system that helps track work.'
        ].join('\n'),
        boxes: [],
        confidence: 0.88,
        elapsed: 100
      }
      const engine = createFakeEngine([ocrResult])
      const queue = new OcrQueue(engine)

      try {
        const patch = await processOneSegment(queue, segment)

        expect(patch.sourceStatus).toBe('ocr_done')
        expect(patch.activityType).toBe('browsing')
        expect(patch.contentType).toBe('webpage')
        expect(patch.contentData).toBeDefined()
        const data = patch.contentData as { domain: string; pageTitle: string }
        expect(data.domain).toBe('github.com')
        expect(data.pageTitle).toContain('WorkMemory')
        // BrowserContextCollector 从标题中提取域名 → browserUrl
        expect(patch.browserUrl).toBe('https://github.com')
        expect(patch.layoutType).toBeDefined()
        expect(patch.actionFlow).toBeUndefined()
      } finally {
        queue.stop()
      }
    })
  })

  // ===================== ActionFlow 操作流推断 =====================

  describe('ActionFlow 操作流推断', () => {
    it('同窗口两个 segment → 首个无 actionFlow，第二个有 actionFlow=copy-paste', async () => {
      const prevSegment = makeSegment({
        id: 'flow-seg-1',
        appName: 'Visual Studio Code',
        processName: 'Code.exe',
        windowTitle: 'main.ts - WorkMemory - Code',
        startTime: '10:30:00',
        endTime: '10:30:30',
        screenshotPath
      })
      const prevOcrResult: OcrResult = {
        text: [
          'const config = loadConfig()',
          'export function main() {',
          '  return config',
          '}'
        ].join('\n'),
        boxes: [],
        confidence: 0.9,
        elapsed: 100
      }

      const currSegment = makeSegment({
        id: 'flow-seg-2',
        appName: 'Visual Studio Code',
        processName: 'Code.exe',
        windowTitle: 'main.ts - WorkMemory - Code',
        startTime: '10:30:45',
        endTime: '10:31:00',
        screenshotPath
      })
      const currOcrResult: OcrResult = {
        text: [
          'const config = loadConfig()',
          'export function main() {',
          '  return config',
          '}',
          'const result = main()'
        ].join('\n'),
        boxes: [],
        confidence: 0.9,
        elapsed: 100
      }

      // 使用同一 queue 实例（lastSegmentMap 在 queue 内维护）
      const engine = createFakeEngine([prevOcrResult, currOcrResult])
      const queue = new OcrQueue(engine)

      try {
        // 处理第一个 segment
        const prevPatch = await processOneSegment(queue, prevSegment)
        // 首个 segment 无前驱 → actionFlow 未设置
        expect(prevPatch.actionFlow).toBeUndefined()
        // 但其他感知增强字段应正常写入
        expect(prevPatch.activityType).toBe('coding')
        expect(prevPatch.contentType).toBe('code')

        // 处理第二个 segment（同窗口，有前驱）
        const currPatch = await processOneSegment(queue, currSegment)
        // prev 中的代码行出现在 curr 中，时间间隔 <2min → copy-paste
        expect(currPatch.actionFlow).toBe('copy-paste')
        // 其他感知增强字段仍正常
        expect(currPatch.activityType).toBe('coding')
        expect(currPatch.contentType).toBe('code')
      } finally {
        queue.stop()
      }
    })
  })

  // ===================== 错误隔离验证 =====================

  describe('错误隔离', () => {
    it('OCR 主流程字段（ocrText/sourceStatus）始终写入，不受感知增强影响', async () => {
      const segment = makeSegment({
        id: 'isolation-seg-1',
        appName: 'UnknownApp',
        processName: 'unknown.exe',
        windowTitle: 'Unknown Window',
        screenshotPath
      })
      const ocrResult: OcrResult = {
        text: '这是一段普通的文本内容，不匹配任何特定分类器',
        boxes: [],
        confidence: 0.7,
        elapsed: 100
      }
      const engine = createFakeEngine([ocrResult])
      const queue = new OcrQueue(engine)

      try {
        const patch = await processOneSegment(queue, segment)

        // OCR 主流程字段始终写入
        expect(patch.sourceStatus).toBe('ocr_done')
        expect(patch.ocrText).toContain('普通的文本内容')
        expect(patch.ocrConfidence).toBe(0.7)
        // 感知增强字段也应写入（可能为兜底值 idle/other）
        expect(patch.activityType).toBeDefined()
        expect(patch.contentType).toBeDefined()
        expect(patch.layoutType).toBeDefined()
      } finally {
        queue.stop()
      }
    })
  })
})
