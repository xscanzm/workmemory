/**
 * ActionFlowInferrer 单元测试
 *
 * 覆盖 3 类核心场景：copy-paste / switch-context / edit-continuous，
 * 并补充 scroll-deep / browse-linear / unknown 兜底验证。
 *
 * 运行方式：npx vitest run electron/capture/__tests__/ActionFlowInferrer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { inferActionFlow } from '../ActionFlowInferrer'
import type { SegmentLike } from '../ActionFlowInferrer'

describe('ActionFlowInferrer', () => {
  describe('inferActionFlow - copy-paste', () => {
    it('prev 中的代码行出现在 curr 中，时间间隔 <2min → copy-paste', () => {
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: [
          'function calculateTotal(items: Item[]) {',
          '  return items.reduce((sum, item) => sum + item.price, 0)',
          '}'
        ].join('\n'),
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: '微信',
        windowTitle: '工作群 - 微信',
        ocrText: [
          '张三: 看看这个函数',
          'function calculateTotal(items: Item[]) {',
          '  return items.reduce((sum, item) => sum + item.price, 0)',
          '}',
          '李四: 不错'
        ].join('\n'),
        startTime: '10:31:00',
        endTime: '10:31:30'
      }
      const result = inferActionFlow(prev, curr)
      expect(result.actionFlow).toBe('copy-paste')
      expect(result.evidence).toContain('prev 中的')
      expect(result.evidence).toContain('出现在 curr 中')
    })

    it('时间间隔 ≥2min 时不触发 copy-paste（降级为 switch-context）', () => {
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: 'function calculateTotal(items: Item[]) {',
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: '微信',
        windowTitle: '工作群 - 微信',
        ocrText: 'function calculateTotal(items: Item[]) {',
        startTime: '10:33:00', // 2min30s 后
        endTime: '10:33:30'
      }
      const result = inferActionFlow(prev, curr)
      // 时间间隔 ≥2min，copy-paste 不匹配；appName 变化 → switch-context
      expect(result.actionFlow).toBe('switch-context')
    })

    it('支持 ISO 时间戳计算间隔', () => {
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Notion',
        windowTitle: '会议纪要 - Notion',
        ocrText: '本次会议讨论了产品路线图和下一季度的关键里程碑。',
        startTime: '2026-06-21T10:30:00.000Z',
        endTime: '2026-06-21T10:30:30.000Z'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: '飞书',
        windowTitle: '产品群 - 飞书',
        ocrText: [
          '会议纪要已发',
          '本次会议讨论了产品路线图和下一季度的关键里程碑。',
          '请查收'
        ].join('\n'),
        startTime: '2026-06-21T10:31:00.000Z', // 30s 后
        endTime: '2026-06-21T10:31:30.000Z'
      }
      const result = inferActionFlow(prev, curr)
      expect(result.actionFlow).toBe('copy-paste')
    })
  })

  describe('inferActionFlow - switch-context', () => {
    it('appName 从 VS Code 切换到 Chrome → switch-context', () => {
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: 'const x = 1',
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: 'Google Chrome',
        windowTitle: 'Google - Chrome',
        ocrText: 'Google Search',
        startTime: '10:31:00',
        endTime: '10:31:30'
      }
      const result = inferActionFlow(prev, curr)
      expect(result.actionFlow).toBe('switch-context')
      expect(result.evidence).toContain('Visual Studio Code')
      expect(result.evidence).toContain('Google Chrome')
    })

    it('同应用非浏览器，windowTitle 变化 → switch-context', () => {
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: 'const x = 1',
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: 'Visual Studio Code',
        windowTitle: 'README.md - Code',
        ocrText: '# README\nThis is a readme file.',
        startTime: '10:31:00',
        endTime: '10:31:30'
      }
      const result = inferActionFlow(prev, curr)
      expect(result.actionFlow).toBe('switch-context')
      expect(result.evidence).toContain('main.ts')
      expect(result.evidence).toContain('README.md')
    })
  })

  describe('inferActionFlow - edit-continuous', () => {
    it('同应用同窗口，OCR 文本渐进变化（差异 20-50%）→ edit-continuous', () => {
      // 10 行，2 行变化（差异约 33%）
      const prevLines = [
        'line 1: hello world',
        'line 2: foo bar baz',
        'line 3: test data here',
        'line 4: alpha beta gamma',
        'line 5: delta epsilon zeta',
        'line 6: eta theta iota',
        'line 7: kappa lambda mu',
        'line 8: nu xi omicron',
        'line 9: pi rho sigma',
        'line 10: tau upsilon phi'
      ]
      const currLines = [
        'line 1: hello world',
        'line 2: foo bar baz',
        'line 3: test data CHANGED',
        'line 4: alpha beta gamma',
        'line 5: delta epsilon zeta',
        'line 6: eta theta iota',
        'line 7: kappa lambda mu',
        'line 8: nu xi omicron',
        'line 9: pi rho MODIFIED',
        'line 10: tau upsilon phi'
      ]
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: prevLines.join('\n'),
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: currLines.join('\n'),
        // 时间间隔 >2min，避免 copy-paste/scroll-deep 匹配
        startTime: '10:33:00',
        endTime: '10:33:30'
      }
      const result = inferActionFlow(prev, curr)
      expect(result.actionFlow).toBe('edit-continuous')
      expect(result.evidence).toContain('渐进变化')
    })
  })

  describe('其他场景兜底', () => {
    it('scroll-deep: 同窗口滚动，重叠率 >50% 且有新增，时间 <1min', () => {
      const prevLines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5']
      const currLines = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7']
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Chrome',
        windowTitle: '文档 - Chrome',
        ocrText: prevLines.join('\n'),
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: 'Chrome',
        windowTitle: '文档 - Chrome',
        ocrText: currLines.join('\n'),
        startTime: '10:30:45', // 15s 后
        endTime: '10:31:00'
      }
      const result = inferActionFlow(prev, curr)
      expect(result.actionFlow).toBe('scroll-deep')
    })

    it('browse-linear: 同浏览器，标题变化，时间 <2min', () => {
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Google Chrome',
        windowTitle: 'Google - Chrome',
        ocrText: 'Search Google',
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: 'Google Chrome',
        windowTitle: 'GitHub - Chrome',
        ocrText: 'GitHub',
        startTime: '10:31:00',
        endTime: '10:31:30'
      }
      const result = inferActionFlow(prev, curr)
      expect(result.actionFlow).toBe('browse-linear')
    })

    it('unknown: 完全相同的文本，无规则匹配', () => {
      const prev: SegmentLike = {
        id: 'seg-1',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: 'const x = 1',
        startTime: '10:30:00',
        endTime: '10:30:30'
      }
      const curr: SegmentLike = {
        id: 'seg-2',
        appName: 'Visual Studio Code',
        windowTitle: 'main.ts - Code',
        ocrText: 'const x = 1', // 完全相同
        // 时间间隔 >2min，避免 copy-paste 匹配
        startTime: '10:33:00',
        endTime: '10:33:30'
      }
      const result = inferActionFlow(prev, curr)
      // 完全相同：diff=0，不在 20-50% 范围 → unknown
      expect(result.actionFlow).toBe('unknown')
    })
  })
})
