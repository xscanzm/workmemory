/**
 * EpisodeBuilder activityType 感知聚类单元测试（Task P8）
 *
 * 验证：
 *  - isSemanticallySimilar 在两个聚类 activityType 不同（且都非 idle）时返回 false，
 *    即使关键词重叠（Jaccard > 0.3）也不误合并（如 reading 代码文档 vs coding 写代码）
 *  - 相同 activityType 或一方为 undefined/idle 时不阻断（向后兼容）
 *  - createEpisodeFromCluster 正确计算 dominantActivityType（多数投票，忽略 undefined/idle）
 *
 * 运行方式：npx vitest run electron/capture/__tests__/EpisodeBuilder.activityType.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import type { WorkSegment } from '@/types'

// Mock SegmentRepository / EpisodeRepository（避免数据库与 electron 依赖）
vi.mock('../../db/repositories/SegmentRepository', () => ({
  SegmentRepository: {
    getActiveByDate: vi.fn().mockReturnValue([])
  }
}))
vi.mock('../../db/repositories/EpisodeRepository', () => ({
  EpisodeRepository: {
    getByDate: vi.fn().mockReturnValue([]),
    hardDelete: vi.fn(),
    insert: vi.fn()
  }
}))

import {
  EpisodeBuilder,
  extractKeywords,
  extractTaskIds,
  jaccardSimilarity
} from '../EpisodeBuilder'

/** SegmentCluster 形状（与 EpisodeBuilder 内部私有接口对齐） */
interface SegmentClusterLike {
  segments: WorkSegment[]
  keywords: Set<string>
  taskIds: Set<string>
  apps: Set<string>
}

/** 创建测试 segment */
function makeSegment(overrides: Partial<WorkSegment> & { id: string }): WorkSegment {
  return {
    date: '2026-06-21',
    startTime: '10:00:00',
    endTime: '10:05:00',
    durationSeconds: 300,
    appName: 'Visual Studio Code',
    processName: 'Code.exe',
    windowTitle: '',
    ocrText: '',
    ocrSummary: '',
    imageHash: '',
    screenshotPath: '',
    isSelectedForReport: false,
    isPrivate: false,
    isImportant: false,
    isDeleted: false,
    sourceStatus: 'ocr_done',
    userTitle: '',
    userSummary: '',
    userNote: '',
    tags: [],
    ...overrides
  }
}

/** 从单个 segment 构建 Cluster（与 EpisodeBuilder.clusterSegments 初始化逻辑一致） */
function makeCluster(segment: WorkSegment): SegmentClusterLike {
  const text = `${segment.ocrText}\n${segment.windowTitle}`
  return {
    segments: [segment],
    keywords: new Set(extractKeywords(text)),
    taskIds: new Set(extractTaskIds(text)),
    apps: new Set([segment.appName])
  }
}

/** 从多个 segment 合并构建 Cluster（与 EpisodeBuilder.mergeCluster 累积逻辑一致） */
function makeClusterFromSegments(segments: WorkSegment[]): SegmentClusterLike {
  const keywords = new Set<string>()
  const taskIds = new Set<string>()
  const apps = new Set<string>()
  for (const seg of segments) {
    const text = `${seg.ocrText}\n${seg.windowTitle}`
    for (const k of extractKeywords(text)) keywords.add(k)
    for (const t of extractTaskIds(text)) taskIds.add(t)
    apps.add(seg.appName)
  }
  return { segments, keywords, taskIds, apps }
}

describe('EpisodeBuilder activityType 感知聚类（Task P8）', () => {
  // 共享 OCR 文本：包含大量重叠关键词，确保 Jaccard > 0.3
  const sharedOcrText = 'EpisodeBuilder isSemanticallySimilar 代码 函数 聚类 合并 cluster'

  it('测试1: reading 代码文档 vs coding 写代码，关键词重叠但 activityType 不同 → isSemanticallySimilar 返回 false', () => {
    const builder = new EpisodeBuilder()
    const readingSegment = makeSegment({
      id: 'seg-reading',
      appName: 'Adobe Acrobat',
      processName: 'Acrobat.exe',
      windowTitle: 'EpisodeBuilder 文档.pdf - Adobe Acrobat',
      ocrText: sharedOcrText,
      activityType: 'reading'
    })
    const codingSegment = makeSegment({
      id: 'seg-coding',
      appName: 'Visual Studio Code',
      processName: 'Code.exe',
      windowTitle: 'EpisodeBuilder.ts - WorkMemory - Code',
      ocrText: sharedOcrText,
      activityType: 'coding'
    })

    const clusterA = makeCluster(readingSegment)
    const clusterB = makeCluster(codingSegment)

    // 前置校验：关键词确实重叠（Jaccard > 0.3），若无 activityType 检查本应相似
    const overlap = jaccardSimilarity(clusterA.keywords, clusterB.keywords)
    expect(overlap).toBeGreaterThan(0.3)

    // activityType 不同（reading vs coding）→ 不合并
    const result = (builder as unknown as {
      isSemanticallySimilar(a: SegmentClusterLike, b: SegmentClusterLike): boolean
    }).isSemanticallySimilar(clusterA, clusterB)
    expect(result).toBe(false)
  })

  it('测试2: 两个 coding segment，关键词重叠 → isSemanticallySimilar 正常判断（不被 activityType 阻断）', () => {
    const builder = new EpisodeBuilder()
    const codingA = makeSegment({
      id: 'seg-coding-a',
      windowTitle: 'EpisodeBuilder.ts - WorkMemory - Code',
      ocrText: sharedOcrText,
      activityType: 'coding'
    })
    const codingB = makeSegment({
      id: 'seg-coding-b',
      windowTitle: 'EpisodeBuilder.ts - WorkMemory - Code',
      ocrText: sharedOcrText,
      activityType: 'coding'
    })

    const clusterA = makeCluster(codingA)
    const clusterB = makeCluster(codingB)

    // 关键词重叠
    const overlap = jaccardSimilarity(clusterA.keywords, clusterB.keywords)
    expect(overlap).toBeGreaterThan(0.3)

    // 相同 activityType（coding）→ 不阻断，正常判定为相似
    const result = (builder as unknown as {
      isSemanticallySimilar(a: SegmentClusterLike, b: SegmentClusterLike): boolean
    }).isSemanticallySimilar(clusterA, clusterB)
    expect(result).toBe(true)
  })

  it('测试3: 一个有 activityType、一个无 activityType（undefined），关键词重叠 → activityType 不阻断（向后兼容）', () => {
    const builder = new EpisodeBuilder()
    const withActivity = makeSegment({
      id: 'seg-with-activity',
      windowTitle: 'EpisodeBuilder.ts - WorkMemory - Code',
      ocrText: sharedOcrText,
      activityType: 'coding'
    })
    const withoutActivity = makeSegment({
      id: 'seg-without-activity',
      windowTitle: 'EpisodeBuilder.ts - WorkMemory - Code',
      ocrText: sharedOcrText
      // activityType 故意省略（undefined）
    })

    const clusterA = makeCluster(withActivity)
    const clusterB = makeCluster(withoutActivity)

    // 关键词重叠
    const overlap = jaccardSimilarity(clusterA.keywords, clusterB.keywords)
    expect(overlap).toBeGreaterThan(0.3)

    // 一方为 undefined → 向后兼容，不阻断，正常判定为相似
    const result = (builder as unknown as {
      isSemanticallySimilar(a: SegmentClusterLike, b: SegmentClusterLike): boolean
    }).isSemanticallySimilar(clusterA, clusterB)
    expect(result).toBe(true)
  })

  it('测试4: 含 3 个 coding + 1 个 reading 的 cluster → dominantActivityType = coding', () => {
    const builder = new EpisodeBuilder()
    const segments: WorkSegment[] = [
      makeSegment({
        id: 'seg-c1',
        startTime: '10:00:00',
        endTime: '10:05:00',
        activityType: 'coding',
        ocrText: '编写 代码 函数 EpisodeBuilder'
      }),
      makeSegment({
        id: 'seg-c2',
        startTime: '10:05:00',
        endTime: '10:10:00',
        activityType: 'coding',
        ocrText: '实现 聚类 算法 cluster'
      }),
      makeSegment({
        id: 'seg-c3',
        startTime: '10:10:00',
        endTime: '10:15:00',
        activityType: 'coding',
        ocrText: '测试 合并 逻辑 merge'
      }),
      makeSegment({
        id: 'seg-r1',
        startTime: '10:15:00',
        endTime: '10:20:00',
        activityType: 'reading',
        ocrText: '阅读 文档 代码 函数'
      })
    ]

    const cluster = makeClusterFromSegments(segments)

    const episode = (builder as unknown as {
      createEpisodeFromCluster(c: SegmentClusterLike, date: string): WorkSegment & {
        dominantActivityType?: string
      }
    }).createEpisodeFromCluster(cluster, '2026-06-21')

    // 多数投票：coding 出现 3 次，reading 出现 1 次 → dominantActivityType = coding
    expect(episode.dominantActivityType).toBe('coding')
  })

  it('测试5: 全 idle 的 cluster → dominantActivityType = undefined', () => {
    const builder = new EpisodeBuilder()
    const segments: WorkSegment[] = [
      makeSegment({
        id: 'seg-i1',
        startTime: '11:00:00',
        endTime: '11:05:00',
        activityType: 'idle',
        ocrText: '桌面 空闲'
      }),
      makeSegment({
        id: 'seg-i2',
        startTime: '11:05:00',
        endTime: '11:10:00',
        activityType: 'idle',
        ocrText: '无 操作'
      }),
      makeSegment({
        id: 'seg-i3',
        startTime: '11:10:00',
        endTime: '11:15:00',
        activityType: 'idle',
        ocrText: '待机 状态'
      })
    ]

    const cluster = makeClusterFromSegments(segments)

    const episode = (builder as unknown as {
      createEpisodeFromCluster(c: SegmentClusterLike, date: string): WorkSegment & {
        dominantActivityType?: string
      }
    }).createEpisodeFromCluster(cluster, '2026-06-21')

    // 全部为 idle（被忽略）→ dominantActivityType = undefined
    expect(episode.dominantActivityType).toBeUndefined()
  })
})
