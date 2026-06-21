/**
 * BrowserContextCollector 单元测试
 *
 * 覆盖场景：
 *  - 非浏览器进程返回 none
 *  - Chrome 标题解析（无域名）
 *  - Edge 标题解析（无域名）
 *  - Firefox 标题解析（无域名）
 *  - 含域名的标题（Chrome + github.com / Edge + stackoverflow.com）
 *  - 无痕模式跳过（Chrome Incognito / Edge InPrivate / Firefox Private Browsing）
 *  - 浏览器进程但无标题后缀返回 none
 *  - 其他浏览器（Brave / Safari / Vivaldi / Opera）
 *
 * 运行方式：npx vitest run electron/capture/__tests__/BrowserContextCollector.test.ts
 */
import { describe, it, expect } from 'vitest'
import { collectBrowserUrl } from '../BrowserContextCollector'

describe('BrowserContextCollector', () => {
  describe('非浏览器进程返回 none', () => {
    it('VS Code 进程 → none', () => {
      const result = collectBrowserUrl({
        processName: 'Code.exe',
        windowTitle: 'main.ts - WorkMemory - Code'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })

    it('Explorer 进程 → none', () => {
      const result = collectBrowserUrl({
        processName: 'explorer.exe',
        windowTitle: 'Downloads'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })

    it('空进程名 → none', () => {
      const result = collectBrowserUrl({
        processName: '',
        windowTitle: 'Anything'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })
  })

  describe('Chrome 标题解析', () => {
    it('Chrome + 普通页面标题（无域名）→ title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'chrome.exe',
        windowTitle: 'WorkMemory - 今日记忆 - Google Chrome'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })

    it('Chrome + New Tab → title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'chrome.exe',
        windowTitle: 'New Tab - Google Chrome'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })

    it('Chrome + 仅浏览器名（无后缀分隔）→ none', () => {
      const result = collectBrowserUrl({
        processName: 'chrome.exe',
        windowTitle: 'Google Chrome'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })
  })

  describe('Edge 标题解析', () => {
    it('Edge + 普通页面标题（无域名）→ title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'msedge.exe',
        windowTitle: 'WorkMemory 文档 - Microsoft Edge'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })
  })

  describe('Firefox 标题解析', () => {
    it('Firefox + 普通页面标题（无域名）→ title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'firefox.exe',
        windowTitle: 'WorkMemory 设计稿 - Mozilla Firefox'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })
  })

  describe('含域名的标题', () => {
    it('Chrome + github.com 出现在标题 → title_parse, 0.8, url=https://github.com', () => {
      const result = collectBrowserUrl({
        processName: 'chrome.exe',
        windowTitle: 'user/workmemory - github.com - Google Chrome'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('https://github.com')
      expect(result.confidence).toBe(0.8)
    })

    it('Edge + stackoverflow.com 出现在标题 → title_parse, 0.8', () => {
      const result = collectBrowserUrl({
        processName: 'msedge.exe',
        windowTitle: 'javascript - How to parse URL - stackoverflow.com - Microsoft Edge'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('https://stackoverflow.com')
      expect(result.confidence).toBe(0.8)
    })

    it('Chrome + 标题含完整 URL（含域名）→ title_parse, 0.8', () => {
      const result = collectBrowserUrl({
        processName: 'chrome.exe',
        windowTitle: 'https://github.com/user/workmemory - Google Chrome'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('https://github.com')
      expect(result.confidence).toBe(0.8)
    })
  })

  describe('无痕模式跳过', () => {
    it('Chrome Incognito → none', () => {
      const result = collectBrowserUrl({
        processName: 'chrome.exe',
        windowTitle: 'Incognito - Google Chrome'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })

    it('Edge InPrivate → none', () => {
      const result = collectBrowserUrl({
        processName: 'msedge.exe',
        windowTitle: 'InPrivate - Microsoft Edge'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })

    it('Firefox Private Browsing → none', () => {
      const result = collectBrowserUrl({
        processName: 'firefox.exe',
        windowTitle: 'Private Browsing - Mozilla Firefox'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })

    it('Chrome 中文无痕关键词（无痕）→ none', () => {
      const result = collectBrowserUrl({
        processName: 'chrome.exe',
        windowTitle: '无痕模式 - Google Chrome'
      })
      expect(result.method).toBe('none')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0)
    })
  })

  describe('其他浏览器', () => {
    it('Brave + 页面标题 → title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'brave.exe',
        windowTitle: 'WorkMemory - Brave'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })

    it('Safari + 页面标题 → title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'safari.exe',
        windowTitle: 'Apple - Safari'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })

    it('Vivaldi + 页面标题 → title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'vivaldi.exe',
        windowTitle: 'WorkMemory - Vivaldi'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })

    it('Chromium + 页面标题 → title_parse, 0.6', () => {
      const result = collectBrowserUrl({
        processName: 'chromium.exe',
        windowTitle: 'WorkMemory - Chromium'
      })
      expect(result.method).toBe('title_parse')
      expect(result.url).toBe('')
      expect(result.confidence).toBe(0.6)
    })
  })

  describe('进程名大小写兼容', () => {
    it('Chrome.exe（首字母大写）→ 仍可识别', () => {
      const result = collectBrowserUrl({
        processName: 'Chrome.exe',
        windowTitle: 'WorkMemory - Google Chrome'
      })
      expect(result.method).toBe('title_parse')
      expect(result.confidence).toBe(0.6)
    })

    it('chrome（无 .exe 后缀，macOS 风格）→ 仍可识别', () => {
      const result = collectBrowserUrl({
        processName: 'chrome',
        windowTitle: 'WorkMemory - Google Chrome'
      })
      expect(result.method).toBe('title_parse')
      expect(result.confidence).toBe(0.6)
    })
  })
})
