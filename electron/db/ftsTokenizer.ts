/**
 * FTS5 中文分词预处理工具
 *
 * 问题：SQLite FTS5 默认 `unicode61` tokenizer 将整段中文字符串视为单个 token，
 * 导致双字滑窗（bigram）MATCH 查询无法命中。例如索引文本 "前端组件开发" 被存为
 * 一个 token，查询 "组件" 无法匹配。
 *
 * 解决方案：在写入 FTS5 索引前，将文本预处理为空格分隔的 bigram 序列。
 * 例如 "前端组件开发" → "前端 端组 组件 件开 开发"。
 * 这样 `unicode61` tokenizer 会将每个 bigram 作为独立 token，
 * MATCH 查询 `"组件"` 即可命中。
 *
 * 预处理规则（与 SearchRepository/SemanticSearchRepository 的 tokenize 保持一致）：
 *  - 中文：双字滑窗（bigram）
 *  - 英文：按空格/标点切分单词（≥2 字符，小写化）
 *  - 数字：独立 token
 */
import type Database from 'better-sqlite3'

/**
 * 将文本预处理为空格分隔的 token 序列，供 FTS5 索引使用。
 *
 * @param text 原始文本（可能含中英文混合、JSON 字符串等）
 * @returns 空格分隔的 token 字符串（如 "前端 端组 组件 api key"）
 */
export function preprocessFtsText(text: string | null | undefined): string {
  if (text === null || text === undefined) return ''
  const str = String(text)
  const tokens: string[] = []

  // 中文双字滑窗（bigram）
  const chineseChars = str.match(/[\u4e00-\u9fa5]/g)
  if (chineseChars) {
    const chineseText = chineseChars.join('')
    for (let i = 0; i < chineseText.length - 1; i++) {
      tokens.push(chineseText.substring(i, i + 2))
    }
    if (chineseText.length === 1) {
      tokens.push(chineseText)
    }
  }

  // 英文单词（≥2 字符，小写化）
  const englishWords = str.match(/[a-zA-Z]+/g)
  if (englishWords) {
    for (const word of englishWords) {
      if (word.length >= 2) tokens.push(word.toLowerCase())
    }
  }

  // 数字 token
  const numbers = str.match(/\d+/g)
  if (numbers) {
    for (const num of numbers) {
      tokens.push(num)
    }
  }

  return tokens.join(' ')
}

/**
 * 在指定数据库实例上注册 FTS5 预处理自定义函数 `wm_preprocess_fts`。
 *
 * 该函数被 fts_memory_cells 的同步触发器调用，确保写入 FTS5 索引的中文文本
 * 被预处理为 bigram 序列，从而支持双字滑窗 MATCH 查询。
 *
 * 必须在触发器触发（memory_cells INSERT/UPDATE/DELETE）之前注册。
 * 在 runMigrations() 开头调用，覆盖生产环境（initDatabase）与测试环境（createInMemoryDb）。
 *
 * @param db better-sqlite3 数据库实例
 */
export function registerFtsFunctions(db: Database.Database): void {
  db.function('wm_preprocess_fts', (text: string | null) => preprocessFtsText(text))
}
