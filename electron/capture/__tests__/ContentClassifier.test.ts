/**
 * ContentClassifier 单元测试
 *
 * 覆盖 5 类核心场景：chat / webpage / video / forum / product，
 * 并补充 other 兜底与类实例方法一致性验证。
 *
 * 运行方式：npx vitest run electron/capture/__tests__/ContentClassifier.test.ts
 */
import { describe, it, expect } from 'vitest'
import { classifyContent, ContentClassifier } from '../ContentClassifier'
import type { ContentSegmentInput } from '../ContentClassifier'

describe('ContentClassifier', () => {
  describe('classifyContent - 5 类核心场景', () => {
    it('chat: 微信 + 群聊标题 + 对话气泡 OCR → chat', () => {
      const segment: ContentSegmentInput = {
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
      const result = classifyContent(segment)
      expect(result.contentType).toBe('chat')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // app(微信) + title(群) + ocr(姓名:消息 / 时间戳 / [微笑] / 发送) 三条全中
      expect(result.confidence).toBe(1)
      const data = result.contentData as {
        participants: string[]
        messageCount: number
        keyMessages: string[]
        platform: string
      }
      expect(data.participants).toContain('张三')
      expect(data.participants).toContain('李四')
      expect(data.messageCount).toBeGreaterThan(0)
      expect(data.keyMessages.length).toBeGreaterThan(0)
      expect(data.platform).toBe('wechat')
    })

    it('webpage: Chrome + URL 标题 + 浏览器 UI OCR → webpage', () => {
      const segment: ContentSegmentInput = {
        appName: 'Google Chrome',
        windowTitle: 'WorkMemory - GitHub - https://github.com/user/workmemory - Google Chrome',
        ocrText: [
          'https://github.com/user/workmemory',
          'Code Issues Pull requests',
          '搜索',
          '登录',
          'Sign in',
          'WorkMemory is a screen memory system that helps track work.'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyContent(segment)
      expect(result.contentType).toBe('webpage')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // app(chrome) + title(https + 浏览器后缀 + .com) + ocr(https + 搜索/登录) 三条全中
      expect(result.confidence).toBe(1)
      const data = result.contentData as {
        url: string
        pageTitle: string
        domain: string
        keyParagraphs: string[]
      }
      expect(data.url).toContain('github.com')
      expect(data.pageTitle).toContain('WorkMemory')
      expect(data.domain).toContain('github.com')
    })

    it('video: bilibili + 视频标题 + 播放控件/进度条 OCR → video', () => {
      const segment: ContentSegmentInput = {
        appName: 'bilibili',
        windowTitle: '【4K】WorkMemory 项目演示 - bilibili',
        ocrText: [
          '00:39 / 05:23',
          '播放 暂停 弹幕 全屏',
          '这是一个演示视频',
          'WorkMemory 是一个屏幕记忆系统'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyContent(segment)
      expect(result.contentType).toBe('video')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // app(bilibili) + title(bilibili) + ocr(进度条 + 播放控件 + 弹幕) 三条全中
      expect(result.confidence).toBe(1)
      const data = result.contentData as {
        platform: string
        title: string
        duration: string
        subtitles: string[]
      }
      expect(data.platform).toBe('bilibili')
      expect(data.title).toContain('WorkMemory')
      expect(data.duration).toBe('05:23')
      expect(data.subtitles.length).toBeGreaterThan(0)
    })

    it('forum: V2EX + 帖子标题 + 帖子列表 OCR → forum', () => {
      const segment: ContentSegmentInput = {
        appName: 'V2EX',
        windowTitle: 'WorkMemory 项目演示 - V2EX',
        ocrText: [
          '@alice 这个项目不错',
          '回复 12 查看 345',
          '@bob 我也觉得',
          '楼主 发表于 10:30'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyContent(segment)
      expect(result.contentType).toBe('forum')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // app(v2ex) + title(V2EX) + ocr(@alice / 回复 12 查看 345 / 楼主) 三条全中
      expect(result.confidence).toBe(1)
      const data = result.contentData as {
        threadTitle: string
        posts: number
        authors: string[]
      }
      expect(data.threadTitle).toContain('WorkMemory')
      expect(data.posts).toBeGreaterThan(0)
      expect(data.authors).toContain('alice')
      expect(data.authors).toContain('bob')
    })

    it('product: 淘宝 + 商品标题 + 价格 OCR → product', () => {
      const segment: ContentSegmentInput = {
        appName: '淘宝',
        windowTitle: 'WorkMemory 机械键盘 - 淘宝',
        ocrText: [
          '¥299.00',
          '加入购物车',
          '立即购买',
          '月销 1000+',
          '评价 500'
        ].join('\n'),
        ocrBlocks: []
      }
      const result = classifyContent(segment)
      expect(result.contentType).toBe('product')
      expect(result.confidence).toBeGreaterThanOrEqual(0.5)
      // app(淘宝) + title(淘宝) + ocr(¥299.00 + 加入购物车/立即购买/月销/评价) 三条全中
      expect(result.confidence).toBe(1)
      const data = result.contentData as {
        name: string
        price: string
        source: string
      }
      expect(data.name).toContain('机械键盘')
      expect(data.price).toBe('¥299.00')
      expect(data.source).toBe('taobao')
    })
  })

  describe('兜底与一致性', () => {
    it('other: 无任何规则匹配 → other, confidence 0', () => {
      const segment: ContentSegmentInput = {
        appName: '',
        windowTitle: '',
        ocrText: '',
        ocrBlocks: []
      }
      const result = classifyContent(segment)
      expect(result.contentType).toBe('other')
      expect(result.confidence).toBe(0)
      expect(result.contentData).toEqual({})
    })

    it('new ContentClassifier().classifyContent 与导出函数结果一致', () => {
      const segment: ContentSegmentInput = {
        appName: 'Slack',
        windowTitle: '#engineering - Slack',
        ocrText: 'Alice: 线上有个告警，谁在看\n12:05\nBob: 我来排查\n回复',
        ocrBlocks: []
      }
      const fromInstance = new ContentClassifier().classifyContent(segment)
      const fromFunction = classifyContent(segment)
      expect(fromInstance.contentType).toBe(fromFunction.contentType)
      expect(fromInstance.confidence).toBe(fromFunction.confidence)
      expect(fromFunction.contentType).toBe('chat')
    })
  })
})
