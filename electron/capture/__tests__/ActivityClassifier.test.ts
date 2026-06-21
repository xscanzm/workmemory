/**
 * ActivityClassifier 单元测试
 *
 * 覆盖 5 类场景：coding / chatting / browsing / reading / idle，
 * 并补充置信度阈值边界（2/3 通过、1/3 回退 idle）与类实例方法验证。
 *
 * 运行方式：npx vitest run electron/capture/__tests__/ActivityClassifier.test.ts
 */
import { describe, it, expect } from 'vitest'
import { classifyActivity, ActivityClassifier } from '../ActivityClassifier'
import type { ActivitySegmentInput } from '../ActivityClassifier'

describe('ActivityClassifier', () => {
  describe('classifyActivity - 5 类核心场景', () => {
    it('coding: VS Code + 代码文件标题 + 代码关键词 OCR → coding', () => {
      const segment: ActivitySegmentInput = {
        appName: 'Visual Studio Code',
        windowTitle: 'ActivityClassifier.ts - WorkMemory - Code',
        ocrText: [
          'export class ActivityClassifier {',
          '  classifyActivity(segment) {',
          '    const appName = segment.appName',
          '    return { activityType, confidence }',
          '  }',
          '}',
          'import { ActivityType } from "@/types"'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('coding')
      expect(result.confidence).toBeGreaterThanOrEqual(0.6)
      // app + title(.ts) + ocr(export/class/const/import) 三条规则全中
      expect(result.confidence).toBe(1)
    })

    it('chatting: 微信 + 群聊标题 + 对话气泡 OCR → chatting', () => {
      const segment: ActivitySegmentInput = {
        appName: '微信',
        windowTitle: '工作群 - 微信',
        ocrText: [
          '张三: 这个需求我们今天讨论一下',
          '10:30',
          '李四: 好的，我准备一下材料',
          '[微笑]',
          '发送'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('chatting')
      expect(result.confidence).toBeGreaterThanOrEqual(0.6)
      // app(微信) + title(群) + ocr(姓名:消息 / 时间戳 / [微笑] / 发送) 三条全中
      expect(result.confidence).toBe(1)
    })

    it('browsing: Chrome + URL 标题 + 浏览器 UI OCR → browsing', () => {
      const segment: ActivitySegmentInput = {
        appName: 'Google Chrome',
        windowTitle: 'WorkMemory - GitHub - https://github.com/user/workmemory - Google Chrome',
        ocrText: [
          'https://github.com/user/workmemory',
          'Code Issues Pull requests',
          '搜索',
          '登录',
          'Sign in'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('browsing')
      expect(result.confidence).toBeGreaterThanOrEqual(0.6)
      // app(chrome) + title(https + 浏览器后缀 + .com) + ocr(https + 搜索/登录) 三条全中
      expect(result.confidence).toBe(1)
    })

    it('reading: Adobe Acrobat + PDF 标题 + 页码/长段落 OCR → reading', () => {
      const segment: ActivitySegmentInput = {
        appName: 'Adobe Acrobat',
        windowTitle: '系统架构文档.pdf - Adobe Acrobat',
        ocrText: [
          '第 1 页',
          '本系统采用微服务架构设计，主要包含用户管理、订单管理、支付管理等核心模块。',
          '每个模块独立部署，通过 REST API 进行通信。系统整体可用性目标为 99.9%。'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('reading')
      expect(result.confidence).toBeGreaterThanOrEqual(0.6)
      // app(acrobat) + title(.pdf) + ocr(第 1 页) 三条全中；reading 击败 writing(2/3)
      expect(result.confidence).toBe(1)
    })

    it('idle: 置信度不足（无任何规则匹配）→ idle, confidence 0', () => {
      const segment: ActivitySegmentInput = {
        appName: '',
        windowTitle: '',
        ocrText: '',
        ocrBlocks: []
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('idle')
      expect(result.confidence).toBe(0)
    })
  })

  describe('置信度阈值边界', () => {
    it('仅应用名命中（1/3 < 0.6）→ idle', () => {
      // VS Code 但标题/OCR 无代码特征：app 命中不足以赋值
      const segment: ActivitySegmentInput = {
        appName: 'Code',
        windowTitle: 'Welcome',
        ocrText: 'Welcome\nGet Started\nNew File\nRecent Projects',
        ocrBlocks: []
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('idle')
      expect(result.confidence).toBeLessThan(0.6)
      expect(result.confidence).toBe(0.33)
    })

    it('应用名 + 标题命中（2/3 ≥ 0.6）→ 赋具体类型', () => {
      // VS Code + main.py 标题，但 OCR 无代码关键词：2/3 通过阈值
      const segment: ActivitySegmentInput = {
        appName: 'Visual Studio Code',
        windowTitle: 'main.py - MyProject - Code',
        ocrText: 'print hello world',
        ocrBlocks: []
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('coding')
      expect(result.confidence).toBeGreaterThanOrEqual(0.6)
      expect(result.confidence).toBe(0.67)
    })
  })

  describe('类实例方法与独立函数一致', () => {
    it('new ActivityClassifier().classifyActivity 与导出函数结果一致', () => {
      const segment: ActivitySegmentInput = {
        appName: 'Slack',
        windowTitle: '#engineering - Slack',
        ocrText: 'Alice: 线上有个告警，谁在看\n12:05\nBob: 我来排查\n回复',
        ocrBlocks: []
      }
      const fromInstance = new ActivityClassifier().classifyActivity(segment)
      const fromFunction = classifyActivity(segment)
      expect(fromInstance.activityType).toBe(fromFunction.activityType)
      expect(fromInstance.confidence).toBe(fromFunction.confidence)
      expect(fromFunction.activityType).toBe('chatting')
    })
  })

  describe('ocrBlocks 聚合（ocrText 为空时从 blocks 提取）', () => {
    it('ocrText 为空但 blocks 含代码关键词 → 仍可识别 coding', () => {
      const segment: ActivitySegmentInput = {
        appName: 'Cursor',
        windowTitle: 'server.ts - Cursor',
        ocrText: '',
        ocrBlocks: [
          { text: 'export function handler()', box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9 },
          { text: 'const result = await fetch(url)', box: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9 }
        ]
      }
      const result = classifyActivity(segment)
      expect(result.activityType).toBe('coding')
      expect(result.confidence).toBeGreaterThanOrEqual(0.6)
    })
  })
})
