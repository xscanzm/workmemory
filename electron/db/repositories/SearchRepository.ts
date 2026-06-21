/**
 * SearchRepository：基于 SQLite FTS5 的全文检索数据访问层
 *
 * 索引三张外部内容 FTS5 虚拟表：
 *  - fts_segments(ocr_text, window_title) → segments 表
 *  - fts_episodes(title, one_line_summary) → episodes 表
 *  - fts_wiki(content) → wiki_pages 表
 *
 * 查询流程：
 *  1. tokenize()：中文双字滑窗 + 英文单词 + 数字 token
 *  2. buildMatchExpr()：构建 FTS5 MATCH 表达式（短语 OR 连接）
 *  3. 分别查询三张 FTS 表，返回 ID + snippet + 命中字段
 *
 * 调用方（Search 页）结合本地时间/实体维度匹配，组合多维匹配原因。
 */
import { getDatabase } from '../database'

/** FTS 段落匹配结果 */
export interface FtsSegmentMatch {
  segmentId: string
  snippet: string
  matchedField: 'ocr_text' | 'window_title'
}

/** FTS 事件匹配结果 */
export interface FtsEpisodeMatch {
  episodeId: string
  snippet: string
  matchedField: 'title' | 'one_line_summary'
}

export interface FtsCleanEpisodeMatch {
  cleanEpisodeId: string
  snippet: string
  matchedField: 'title' | 'summary' | 'evidence_refs'
}

/** FTS Wiki 匹配结果 */
export interface FtsWikiMatch {
  wikiId: string
  title: string
  snippet: string
}

/** FTS 综合搜索结果 */
export interface FtsSearchResult {
  cleanEpisodes: FtsCleanEpisodeMatch[]
  segments: FtsSegmentMatch[]
  episodes: FtsEpisodeMatch[]
  wikis: FtsWikiMatch[]
}

/** snippet 最大 token 数 */
const SNIPPET_TOKENS = 12

/**
 * 将查询字符串分词（与 Search 页 tokenize 保持一致）：
 * - 中文：双字滑窗（bigram）
 * - 英文：按空格/标点切分单词（≥2 字符）
 * - 数字：独立 token
 */
function tokenize(query: string): string[] {
  const terms: string[] = []
  // 中文双字滑窗
  const chineseChars = query.match(/[\u4e00-\u9fa5]/g)
  if (chineseChars) {
    const chineseText = chineseChars.join('')
    for (let i = 0; i < chineseText.length - 1; i++) {
      terms.push(chineseText.substring(i, i + 2))
    }
    if (chineseText.length === 1) {
      terms.push(chineseText)
    }
  }
  // 英文单词
  const englishWords = query.match(/[a-zA-Z]+/g)
  if (englishWords) {
    for (const word of englishWords) {
      if (word.length >= 2) terms.push(word.toLowerCase())
    }
  }
  // 数字 token
  const numbers = query.match(/\d+/g)
  if (numbers) {
    for (const num of numbers) {
      terms.push(num)
    }
  }
  return [...new Set(terms)]
}

/**
 * 构建 FTS5 MATCH 表达式。
 * 每个 term 用双引号包裹（短语查询），转义内部双引号，term 间用 OR 连接。
 * 返回 null 表示无有效 term。
 */
function buildMatchExpr(terms: string[]): string | null {
  if (terms.length === 0) return null
  const quoted = terms.map(t => `"${t.replace(/"/g, '""')}"`)
  return quoted.join(' OR ')
}

interface SegmentFtsRow {
  id: string
  snippet: string
  matched_ocr: number
  matched_title: number
}

interface EpisodeFtsRow {
  id: string
  snippet: string
  matched_title: number
  matched_summary: number
}

interface CleanEpisodeFtsRow {
  id: string
  snippet: string
  matched_title: number
  matched_summary: number
  matched_evidence: number
}

interface WikiFtsRow {
  id: string
  title: string
  snippet: string
}

export const SearchRepository = {
  /**
   * 执行 FTS5 全文搜索，返回三张表的匹配结果。
   * 若 query 无有效 token，返回空结果。
   */
  search(query: string): FtsSearchResult {
    const terms = tokenize(query)
    const matchExpr = buildMatchExpr(terms)
    if (!matchExpr) {
      return { cleanEpisodes: [], segments: [], episodes: [], wikis: [] }
    }

    const db = getDatabase()
    const result: FtsSearchResult = { cleanEpisodes: [], segments: [], episodes: [], wikis: [] }

    try {
      const cleanRows = db
        .prepare(
          `SELECT c.id,
             snippet(fts_clean_episodes, 0, '«', '»', '…', ?) AS snippet,
             (fts_clean_episodes MATCH ? AND title != '') AS matched_title,
             (fts_clean_episodes MATCH ? AND summary != '') AS matched_summary,
             (fts_clean_episodes MATCH ? AND evidence_refs != '') AS matched_evidence
           FROM fts_clean_episodes
           JOIN clean_episodes c ON c.rowid = fts_clean_episodes.rowid
           WHERE fts_clean_episodes MATCH ?`
        )
        .all(SNIPPET_TOKENS, matchExpr, matchExpr, matchExpr, matchExpr) as CleanEpisodeFtsRow[]
      for (const row of cleanRows) {
        result.cleanEpisodes.push({
          cleanEpisodeId: row.id,
          snippet: row.snippet,
          matchedField: row.matched_title ? 'title' : row.matched_summary ? 'summary' : 'evidence_refs'
        })
      }
    } catch (e) {
      console.error('[SearchRepository] fts_clean_episodes 查询失败:', e instanceof Error ? e.message : String(e))
    }

    // 查询 fts_segments：join segments 取 id，snippet 取 ocr_text 或 window_title
    try {
      const segRows = db
        .prepare(
          `SELECT s.id,
             snippet(fts_segments, 0, '«', '»', '…', ?) AS snippet,
             (fts_segments MATCH ? AND ocr_text != '') AS matched_ocr,
             (fts_segments MATCH ? AND window_title != '') AS matched_title
           FROM fts_segments
           JOIN segments s ON s.rowid = fts_segments.rowid
           WHERE fts_segments MATCH ?`
        )
        .all(SNIPPET_TOKENS, matchExpr, matchExpr, matchExpr) as SegmentFtsRow[]

      for (const row of segRows) {
        // 优先返回 ocr_text 命中的 snippet，否则返回 window_title 命中
        if (row.matched_ocr) {
          result.segments.push({
            segmentId: row.id,
            snippet: row.snippet,
            matchedField: 'ocr_text'
          })
        } else if (row.matched_title) {
          // window_title 命中时重新取 window_title 列的 snippet
          const titleSnippet = db
            .prepare(
              `SELECT snippet(fts_segments, 1, '«', '»', '…', ?) AS s
               FROM fts_segments
               JOIN segments s ON s.rowid = fts_segments.rowid
               WHERE s.id = ? AND fts_segments MATCH ?`
            )
            .get(SNIPPET_TOKENS, row.id, matchExpr) as { s: string } | undefined
          result.segments.push({
            segmentId: row.id,
            snippet: titleSnippet?.s ?? row.snippet,
            matchedField: 'window_title'
          })
        }
      }
    } catch (e) {
      console.error('[SearchRepository] fts_segments 查询失败:', e instanceof Error ? e.message : String(e))
    }

    // 查询 fts_episodes：join episodes 取 id
    try {
      const epRows = db
        .prepare(
          `SELECT e.id,
             snippet(fts_episodes, 0, '«', '»', '…', ?) AS snippet,
             (fts_episodes MATCH ? AND title != '') AS matched_title,
             (fts_episodes MATCH ? AND one_line_summary != '') AS matched_summary
           FROM fts_episodes
           JOIN episodes e ON e.rowid = fts_episodes.rowid
           WHERE fts_episodes MATCH ?`
        )
        .all(SNIPPET_TOKENS, matchExpr, matchExpr, matchExpr) as EpisodeFtsRow[]

      for (const row of epRows) {
        if (row.matched_title) {
          result.episodes.push({
            episodeId: row.id,
            snippet: row.snippet,
            matchedField: 'title'
          })
        } else if (row.matched_summary) {
          // one_line_summary 命中时重新取 summary 列的 snippet
          const sumSnippet = db
            .prepare(
              `SELECT snippet(fts_episodes, 1, '«', '»', '…', ?) AS s
               FROM fts_episodes
               JOIN episodes e ON e.rowid = fts_episodes.rowid
               WHERE e.id = ? AND fts_episodes MATCH ?`
            )
            .get(SNIPPET_TOKENS, row.id, matchExpr) as { s: string } | undefined
          result.episodes.push({
            episodeId: row.id,
            snippet: sumSnippet?.s ?? row.snippet,
            matchedField: 'one_line_summary'
          })
        }
      }
    } catch (e) {
      console.error('[SearchRepository] fts_episodes 查询失败:', e instanceof Error ? e.message : String(e))
    }

    // 查询 fts_wiki：join wiki_pages 取 id + title
    try {
      const wikiRows = db
        .prepare(
          `SELECT w.id, w.title,
             snippet(fts_wiki, 0, '«', '»', '…', ?) AS snippet
           FROM fts_wiki
           JOIN wiki_pages w ON w.rowid = fts_wiki.rowid
           WHERE fts_wiki MATCH ?`
        )
        .all(SNIPPET_TOKENS, matchExpr) as WikiFtsRow[]

      for (const row of wikiRows) {
        result.wikis.push({
          wikiId: row.id,
          title: row.title,
          snippet: row.snippet
        })
      }
    } catch (e) {
      console.error('[SearchRepository] fts_wiki 查询失败:', e instanceof Error ? e.message : String(e))
    }

    return result
  }
}
