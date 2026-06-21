/**
 * LayoutAnalyzer 单元测试
 *
 * 覆盖 4 类核心场景：form / article / chat / editor，
 * 并补充 other 兜底验证（空数组、信息不足）。
 *
 * 运行方式：npx vitest run electron/capture/__tests__/LayoutAnalyzer.test.ts
 */
import { describe, it, expect } from 'vitest'
import { analyzeLayout } from '../LayoutAnalyzer'
import type { OcrBlock } from '@/types'

describe('LayoutAnalyzer', () => {
  describe('analyzeLayout - 4 类核心场景', () => {
    it('form: 标签+输入框交替排列 + 按钮文字 + 垂直排列 → form', () => {
      const blocks: OcrBlock[] = [
        { text: '姓名：', box: { x: 100, y: 100, w: 80, h: 30 }, confidence: 0.95 },
        { text: '张三', box: { x: 200, y: 100, w: 250, h: 30 }, confidence: 0.9 },
        { text: '邮箱：', box: { x: 100, y: 150, w: 80, h: 30 }, confidence: 0.95 },
        { text: 'test@example.com', box: { x: 200, y: 150, w: 250, h: 30 }, confidence: 0.9 },
        { text: '电话：', box: { x: 100, y: 200, w: 80, h: 30 }, confidence: 0.95 },
        { text: '13800138000', box: { x: 200, y: 200, w: 250, h: 30 }, confidence: 0.9 },
        { text: '提交', box: { x: 200, y: 260, w: 100, h: 35 }, confidence: 0.95 },
        { text: '取消', box: { x: 320, y: 260, w: 100, h: 35 }, confidence: 0.95 }
      ]
      const result = analyzeLayout(blocks)
      expect(result.layoutType).toBe('form')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // 3 条规则全中：标签+输入框对 ≥2 + 按钮 ≥1 + 垂直排列标签 ≥3
      expect(result.confidence).toBe(1)
      // regions 应包含 label / input / button
      const types = result.regions.map(r => r.type)
      expect(types).toContain('label')
      expect(types).toContain('input')
      expect(types).toContain('button')
      // 每个 region 应有合法 confidence（继承自源 OcrBlock）
      for (const region of result.regions) {
        expect(region.confidence).toBeGreaterThanOrEqual(0)
        expect(region.confidence).toBeLessThanOrEqual(1)
        // bounds 使用 { x, y, w, h } 形态
        expect(region.bounds).toHaveProperty('w')
        expect(region.bounds).toHaveProperty('h')
      }
    })

    it('article: 长段落连续排列 + 无交互元素 + 段落间空行 → article', () => {
      const blocks: OcrBlock[] = [
        {
          text: '在软件工程中，需求分析是项目成功的关键环节，通过深入了解用户需求和业务流程，团队可以制定出更加合理的开发计划。',
          box: { x: 100, y: 100, w: 600, h: 40 },
          confidence: 0.92
        },
        {
          text: '设计模式是解决特定问题的经验总结，合理使用设计模式可以提高代码的可维护性和可扩展性，降低系统复杂度。',
          box: { x: 100, y: 200, w: 600, h: 40 },
          confidence: 0.9
        },
        {
          text: '测试驱动开发是一种有效的开发实践，先编写测试用例再实现功能代码，有助于保证代码质量和功能正确性。',
          box: { x: 100, y: 300, w: 600, h: 40 },
          confidence: 0.91
        },
        {
          text: '持续集成是现代软件开发的重要实践，通过自动化构建和测试，团队可以更早地发现和修复问题，提高交付效率。',
          box: { x: 100, y: 400, w: 600, h: 40 },
          confidence: 0.89
        }
      ]
      const result = analyzeLayout(blocks)
      expect(result.layoutType).toBe('article')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // 3 条规则全中：长段落 ≥50% + 无交互元素 + 段落间空行
      expect(result.confidence).toBe(1)
      // regions 应全部为 paragraph
      const types = result.regions.map(r => r.type)
      expect(types.every(t => t === 'paragraph')).toBe(true)
      expect(result.regions.length).toBe(4)
    })

    it('chat: 左右分栏对话气泡 + 头像区域 + 昵称模式 → chat', () => {
      const blocks: OcrBlock[] = [
        { text: '张三：', box: { x: 50, y: 100, w: 60, h: 20 }, confidence: 0.9 },
        { text: '你好，今天开会吗？', box: { x: 50, y: 130, w: 200, h: 30 }, confidence: 0.88 },
        { text: '张', box: { x: 20, y: 100, w: 20, h: 20 }, confidence: 0.85 },
        { text: '李四：', box: { x: 500, y: 200, w: 60, h: 20 }, confidence: 0.9 },
        { text: '好的，马上来', box: { x: 400, y: 230, w: 200, h: 30 }, confidence: 0.88 },
        { text: '李', box: { x: 580, y: 200, w: 20, h: 20 }, confidence: 0.85 }
      ]
      const result = analyzeLayout(blocks)
      expect(result.layoutType).toBe('chat')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // 3 条规则全中：左右分栏 + 头像 + 昵称
      expect(result.confidence).toBe(1)
      // regions 应包含 bubble / avatar / nickname
      const types = result.regions.map(r => r.type)
      expect(types).toContain('bubble')
      expect(types).toContain('avatar')
      expect(types).toContain('nickname')
    })

    it('editor: 代码关键词 + 行号连续递增 + 等宽字体 → editor', () => {
      const blocks: OcrBlock[] = [
        { text: '1 function helloWorld(name, age) {', box: { x: 50, y: 100, w: 340, h: 20 }, confidence: 0.95 },
        { text: '2   const x = 1;', box: { x: 50, y: 130, w: 160, h: 20 }, confidence: 0.93 },
        { text: '3   return x;', box: { x: 50, y: 160, w: 130, h: 20 }, confidence: 0.94 },
        { text: '4 }', box: { x: 50, y: 190, w: 30, h: 20 }, confidence: 0.92 },
        { text: '5 function world() {', box: { x: 50, y: 220, w: 200, h: 20 }, confidence: 0.95 }
      ]
      const result = analyzeLayout(blocks)
      expect(result.layoutType).toBe('editor')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // 3 条规则全中：代码关键词/缩进 ≥3 + 行号连续 ≥2 + 等宽字体 CV<0.3
      expect(result.confidence).toBe(1)
      // regions 应包含 code-line
      const types = result.regions.map(r => r.type)
      expect(types).toContain('code-line')
    })
  })

  describe('analyzeLayout - 兜底场景', () => {
    it('空数组 → other，confidence=0', () => {
      const result = analyzeLayout([])
      expect(result.layoutType).toBe('other')
      expect(result.confidence).toBe(0)
      expect(result.regions).toEqual([])
    })

    it('单个短文本块（信息不足）→ other，confidence < 0.5', () => {
      const blocks: OcrBlock[] = [
        { text: '孤立的短文本', box: { x: 100, y: 100, w: 100, h: 30 }, confidence: 0.5 }
      ]
      const result = analyzeLayout(blocks)
      expect(result.layoutType).toBe('other')
      expect(result.confidence).toBeLessThan(0.5)
    })
  })
})
