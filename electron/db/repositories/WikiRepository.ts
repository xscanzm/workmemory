/**
 * WikiRepository：知识双链沉淀数据访问层
 * 含 Review Queue 审核队列、[[wikilink]] 双链反链维护、断链检测。
 */
import { randomUUID } from 'node:crypto'
import type { WikiPage, WikiType, WikiReviewStatus } from '@/types'
import { getDatabase } from '../database'
import { parseJsonArray, stringifyJsonArray } from '../json'

interface WikiRow {
  id: string
  type: string
  title: string
  aliases: string
  content: string
  sources: string
  backlinks: string
  confidence: number
  review_status: string
  created_at: string
  updated_at: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToWiki(row: WikiRow): WikiPage {
  return {
    id: row.id,
    type: row.type as WikiType,
    title: row.title,
    aliases: parseJsonArray<string>(row.aliases),
    content: row.content,
    sources: parseJsonArray<string>(row.sources),
    backlinks: parseJsonArray<string>(row.backlinks),
    confidence: row.confidence,
    reviewStatus: row.review_status as WikiReviewStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

interface WikiParams {
  id: string
  type: string
  title: string
  aliases: string
  content: string
  sources: string
  backlinks: string
  confidence: number
  review_status: string
  created_at: string
  updated_at: string
}

function wikiToParams(page: WikiPage): WikiParams {
  return {
    id: page.id,
    type: page.type,
    title: page.title,
    aliases: stringifyJsonArray(page.aliases),
    content: page.content,
    sources: stringifyJsonArray(page.sources),
    backlinks: stringifyJsonArray(page.backlinks),
    confidence: page.confidence,
    review_status: page.reviewStatus,
    created_at: page.createdAt,
    updated_at: page.updatedAt
  }
}

/** 从 Markdown 内容中提取 [[wikilink]] 目标标题 */
export function extractWikiLinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g
  const links: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return links
}

export const WikiRepository = {
  insert(page: WikiPage): WikiPage {
    const db = getDatabase()
    const id = page.id || randomUUID()
    const ts = page.createdAt || nowIso()
    const params = wikiToParams({
      ...page,
      id,
      createdAt: ts,
      updatedAt: page.updatedAt || ts
    })
    db.prepare(
      `INSERT INTO wiki_pages (
        id, type, title, aliases, content, sources, backlinks,
        confidence, review_status, created_at, updated_at
      ) VALUES (
        @id, @type, @title, @aliases, @content, @sources, @backlinks,
        @confidence, @review_status, @created_at, @updated_at
      )`
    ).run(params)
    const created = this.getById(id)
    if (!created) throw new Error(`WikiPage insert failed for id=${id}`)
    return created
  },

  update(id: string, patch: Partial<WikiPage>): WikiPage | null {
    const existing = this.getById(id)
    if (!existing) return null
    const merged: WikiPage = { ...existing, ...patch, id, updatedAt: nowIso() }
    const params = wikiToParams(merged)
    const db = getDatabase()
    db.prepare(
      `UPDATE wiki_pages SET
        type = @type, title = @title, aliases = @aliases, content = @content,
        sources = @sources, backlinks = @backlinks, confidence = @confidence,
        review_status = @review_status, updated_at = @updated_at
      WHERE id = @id`
    ).run(params)
    return this.getById(id)
  },

  getById(id: string): WikiPage | null {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as WikiRow | undefined
    return row ? rowToWiki(row) : null
  },

  getByType(type: WikiType): WikiPage[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM wiki_pages WHERE type = ? ORDER BY updated_at DESC')
      .all(type) as WikiRow[]
    return rows.map(rowToWiki)
  },

  getByTitle(title: string): WikiPage | null {
    const db = getDatabase()
    const row = db
      .prepare('SELECT * FROM wiki_pages WHERE title = ? COLLATE NOCASE LIMIT 1')
      .get(title) as WikiRow | undefined
    return row ? rowToWiki(row) : null
  },

  /** 物理删除指定 Wiki 页 */
  delete(id: string): boolean {
    const db = getDatabase()
    const result = db.prepare('DELETE FROM wiki_pages WHERE id = ?').run(id)
    return result.changes > 0
  },

  getAll(): WikiPage[] {
    const db = getDatabase()
    const rows = db
      .prepare('SELECT * FROM wiki_pages ORDER BY updated_at DESC')
      .all() as WikiRow[]
    return rows.map(rowToWiki)
  },

  searchByTitle(keyword: string): WikiPage[] {
    const db = getDatabase()
    const like = `%${keyword}%`
    const rows = db
      .prepare(
        `SELECT * FROM wiki_pages WHERE title LIKE ? OR aliases LIKE ? ORDER BY updated_at DESC`
      )
      .all(like, like) as WikiRow[]
    return rows.map(rowToWiki)
  },

  /** 加入审核队列（review_status = needs_review） */
  addToReviewQueue(
    page: Omit<WikiPage, 'id' | 'reviewStatus' | 'createdAt' | 'updatedAt'>
  ): WikiPage {
    const ts = nowIso()
    const full: WikiPage = {
      ...page,
      id: randomUUID(),
      reviewStatus: 'needs_review',
      createdAt: ts,
      updatedAt: ts
    }
    return this.insert(full)
  },

  getReviewQueue(): WikiPage[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT * FROM wiki_pages WHERE review_status = 'needs_review' ORDER BY created_at ASC`
      )
      .all() as WikiRow[]
    return rows.map(rowToWiki)
  },

  /** 确认审核：将 needs_review 转为 reviewed，正式沉淀为 Wiki 页 */
  confirmReview(id: string): WikiPage | null {
    const existing = this.getById(id)
    if (!existing) return null
    return this.update(id, { reviewStatus: 'reviewed' })
  },

  /** 忽略审核：从 Review Queue 中移除（物理删除 needs_review 的候选页） */
  rejectReview(id: string): boolean {
    const existing = this.getById(id)
    if (!existing) return false
    if (existing.reviewStatus !== 'needs_review') return false
    return this.delete(id)
  },

  /**
   * 重新计算指定页的反向链接：扫描所有其他页的 content 中的 [[link]]，
   * 若 link 命中本页 title 或 aliases，则记录该来源页 title 到本页 backlinks。
   * 返回更新后的 backlinks 列表。
   */
  updateBacklinks(id: string): string[] {
    const target = this.getById(id)
    if (!target) return []
    const db = getDatabase()
    const candidates = target.aliases.concat(target.title).filter(s => s.length > 0)
    if (candidates.length === 0) {
      this.update(id, { backlinks: [] })
      return []
    }
    const allRows = db
      .prepare('SELECT id, title, content FROM wiki_pages WHERE id != ?')
      .all(id) as Array<{ id: string; title: string; content: string }>
    const backlinkTitles: string[] = []
    for (const row of allRows) {
      const links = extractWikiLinks(row.content)
      const hit = links.some(link => candidates.some(c => c.toLowerCase() === link.toLowerCase()))
      if (hit) backlinkTitles.push(row.title)
    }
    this.update(id, { backlinks: Array.from(new Set(backlinkTitles)) })
    return backlinkTitles
  },

  /** 查找所有 content 中引用了指定 title 的页（反向链接查询） */
  getBacklinks(title: string): WikiPage[] {
    const db = getDatabase()
    const allRows = db
      .prepare('SELECT * FROM wiki_pages')
      .all() as WikiRow[]
    const result: WikiPage[] = []
    for (const row of allRows) {
      const links = extractWikiLinks(row.content)
      if (links.some(link => link.toLowerCase() === title.toLowerCase())) {
        result.push(rowToWiki(row))
      }
    }
    return result
  },

  /** 检测所有断链：[[link]] 指向的 title/alias 在 wiki_pages 中不存在 */
  findBrokenLinks(): Array<{ fromTitle: string; brokenLink: string }> {
    const db = getDatabase()
    const allRows = db
      .prepare('SELECT title, aliases, content FROM wiki_pages')
      .all() as Array<{ title: string; aliases: string; content: string }>
    // 收集所有 title 与 aliases 形成有效目标集合
    const validTargets = new Set<string>()
    for (const row of allRows) {
      validTargets.add(row.title.toLowerCase())
      for (const a of parseJsonArray<string>(row.aliases)) {
        validTargets.add(a.toLowerCase())
      }
    }
    const broken: Array<{ fromTitle: string; brokenLink: string }> = []
    for (const row of allRows) {
      const links = extractWikiLinks(row.content)
      for (const link of links) {
        if (!validTargets.has(link.toLowerCase())) {
          broken.push({ fromTitle: row.title, brokenLink: link })
        }
      }
    }
    return broken
  }
}
