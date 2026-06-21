/**
 * WikiLinkEngine：双链与反链维护引擎
 *
 * 功能：
 *  - parseLinks(content)：正则解析 [[link]]，返回标题列表（支持别名 [[alias|display]]）
 *  - resolveLink(linkText, allPages)：按 title 或 aliases 匹配目标 WikiPage
 *  - rebuildAllBacklinks()：扫描全库 wiki_pages，重新计算 backlinks
 *  - findBrokenLinks()：返回无法解析的链接 [{ fromPageId, fromTitle, linkText }]
 *  - linkifyForRender(content, allPages)：将 [[link]] 转为 HTML <a> 标签
 *  - onWikiPageUpdated(pageId)：增量更新相关 backlinks
 *
 * 被 WikiRepository 复用（WikiRepository 内部 backlinks 逻辑可调用本引擎）。
 */
import type { WikiPage } from '@/types'
import { WikiRepository } from '../db/repositories/WikiRepository'

/** [[link]] 双链正则，支持 [[alias|display]] 格式 */
const WIKI_LINK_REGEX = /\[\[([^\]]+)\]\]/g

/** 解析后的链接信息 */
export interface ParsedLink {
  /** 原始匹配文本，如 [[Tauri 配置]] */
  raw: string
  /** 链接目标（别名前的部分），如 [[alias|display]] 中的 alias */
  target: string
  /** 显示文本（若有 | 分隔），否则等于 target */
  display: string
}

/** 断链信息 */
export interface BrokenLink {
  fromPageId: string
  fromTitle: string
  linkText: string
}

/**
 * WikiLinkEngine：双链与反链维护引擎。
 */
export class WikiLinkEngine {
  /**
   * 解析 Markdown 内容中的所有 [[link]]，返回 ParsedLink 列表。
   * 支持 [[alias|display]] 格式：target=alias, display=display。
   */
  parseLinks(content: string): ParsedLink[] {
    if (!content) return []
    const links: ParsedLink[] = []
    let match: RegExpExecArray | null
    WIKI_LINK_REGEX.lastIndex = 0
    while ((match = WIKI_LINK_REGEX.exec(content)) !== null) {
      const inner = match[1].trim()
      if (inner.length === 0) continue
      const pipeIdx = inner.indexOf('|')
      if (pipeIdx >= 0) {
        const target = inner.slice(0, pipeIdx).trim()
        const display = inner.slice(pipeIdx + 1).trim() || target
        links.push({ raw: match[0], target, display })
      } else {
        links.push({ raw: match[0], target: inner, display: inner })
      }
    }
    return links
  }

  /**
   * 解析内容中的链接目标标题列表（仅 target，去重）。
   * 兼容旧版 extractWikiLinks 接口。
   */
  parseLinkTargets(content: string): string[] {
    const links = this.parseLinks(content)
    const targets = new Set<string>()
    for (const link of links) {
      targets.add(link.target)
    }
    return [...targets]
  }

  /**
   * 按 title 或 aliases 匹配目标 WikiPage。
   * 大小写不敏感。返回匹配的 WikiPage 或 null。
   */
  resolveLink(linkText: string, allPages: WikiPage[]): WikiPage | null {
    const target = linkText.trim().toLowerCase()
    if (target.length === 0) return null
    for (const page of allPages) {
      if (page.title.toLowerCase() === target) return page
      for (const alias of page.aliases) {
        if (alias.trim().toLowerCase() === target) return page
      }
    }
    return null
  }

  /**
   * 重建全库 backlinks。
   * 扫描所有 wiki_pages，对每页 A 的 content 中的 [[link]]，
   * 若 link 命中页 B 的 title/aliases，则将 A.title 加入 B.backlinks。
   *
   * 返回更新的页数。
   */
  rebuildAllBacklinks(): number {
    const allPages = WikiRepository.getAll()
    if (allPages.length === 0) return 0

    // 构建 title/alias → pageId 索引（小写）
    const targetIndex = new Map<string, string>()
    for (const page of allPages) {
      targetIndex.set(page.title.toLowerCase(), page.id)
      for (const alias of page.aliases) {
        const trimmed = alias.trim().toLowerCase()
        if (trimmed.length > 0) {
          targetIndex.set(trimmed, page.id)
        }
      }
    }

    // 计算每个目标页的 backlinks（来源页 title 列表）
    const backlinksMap = new Map<string, Set<string>>()
    for (const page of allPages) {
      const links = this.parseLinks(page.content)
      for (const link of links) {
        const targetId = targetIndex.get(link.target.toLowerCase())
        if (!targetId || targetId === page.id) continue
        const set = backlinksMap.get(targetId) ?? new Set<string>()
        set.add(page.title)
        backlinksMap.set(targetId, set)
      }
    }

    // 持久化更新每页的 backlinks
    let updatedCount = 0
    for (const page of allPages) {
      const newBacklinks = [...(backlinksMap.get(page.id) ?? new Set<string>())].sort()
      const currentBacklinks = [...page.backlinks].sort()
      // 仅在变化时更新，避免无谓写入
      if (JSON.stringify(newBacklinks) !== JSON.stringify(currentBacklinks)) {
        WikiRepository.update(page.id, { backlinks: newBacklinks })
        updatedCount++
      }
    }

    return updatedCount
  }

  /**
   * 查找所有断链：[[link]] 指向的 title/alias 在 wiki_pages 中不存在。
   * 返回 [{ fromPageId, fromTitle, linkText }]。
   */
  findBrokenLinks(): BrokenLink[] {
    const allPages = WikiRepository.getAll()
    if (allPages.length === 0) return []

    // 构建有效目标集合（小写）
    const validTargets = new Set<string>()
    for (const page of allPages) {
      validTargets.add(page.title.toLowerCase())
      for (const alias of page.aliases) {
        const trimmed = alias.trim().toLowerCase()
        if (trimmed.length > 0) validTargets.add(trimmed)
      }
    }

    const broken: BrokenLink[] = []
    for (const page of allPages) {
      const links = this.parseLinks(page.content)
      for (const link of links) {
        if (!validTargets.has(link.target.toLowerCase())) {
          broken.push({
            fromPageId: page.id,
            fromTitle: page.title,
            linkText: link.target
          })
        }
      }
    }
    return broken
  }

  /**
   * 将 Markdown 中的 [[link]] 转为 HTML <a> 标签，供前端渲染。
   * 可解析的链接生成 <a href="#" data-wiki="pageId">display</a>；
   * 断链生成 <span class="wiki-broken">display</span>。
   */
  linkifyForRender(content: string, allPages: WikiPage[]): string {
    if (!content) return ''
    const links = this.parseLinks(content)
    if (links.length === 0) return content

    let result = content
    for (const link of links) {
      const target = this.resolveLink(link.target, allPages)
      if (target) {
        const html = `<a href="#" data-wiki="${this.escapeAttr(target.id)}" class="wiki-link">${this.escapeHtml(link.display)}</a>`
        result = result.split(link.raw).join(html)
      } else {
        const html = `<span class="wiki-broken" title="未找到目标页">${this.escapeHtml(link.display)}</span>`
        result = result.split(link.raw).join(html)
      }
    }
    return result
  }

  /**
   * 增量更新指定页相关的 backlinks。
   * 当某页 A 的 title/aliases/content 变化时：
   *  1. 重新计算 A 的 backlinks（谁引用了 A）
   *  2. 重新计算 A 引用的其他页的 backlinks（A 的 content 中的 [[link]] 目标）
   */
  onWikiPageUpdated(pageId: string): void {
    const target = WikiRepository.getById(pageId)
    if (!target) return

    // 1. 更新本页 backlinks（谁引用了本页）
    WikiRepository.updateBacklinks(pageId)

    // 2. 更新本页 content 中引用的其他页的 backlinks
    const allPages = WikiRepository.getAll()
    const links = this.parseLinks(target.content)
    const updatedTargetIds = new Set<string>()
    for (const link of links) {
      const resolved = this.resolveLink(link.target, allPages)
      if (resolved && resolved.id !== pageId && !updatedTargetIds.has(resolved.id)) {
        WikiRepository.updateBacklinks(resolved.id)
        updatedTargetIds.add(resolved.id)
      }
    }
  }

  // ===================== 内部工具 =====================

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  private escapeAttr(s: string): string {
    return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }
}

/** 单例 */
let linkEngineInstance: WikiLinkEngine | null = null

export function getWikiLinkEngine(): WikiLinkEngine {
  if (!linkEngineInstance) {
    linkEngineInstance = new WikiLinkEngine()
  }
  return linkEngineInstance
}
