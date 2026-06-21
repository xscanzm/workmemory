/**
 * HtmlExporter：Markdown → 富文本 HTML 转换器
 *
 * 用于剪贴板富文本复制（粘贴到 Word / 飞书 / 钉钉文档等保留格式）。
 * 所有样式均为 inline style，因为富文本粘贴目标仅识别 inline style，不识别 CSS class。
 *
 * 支持 Markdown 元素：
 *  - 标题 # / ## / ### → <h1>/<h2>/<h3>
 *  - 无序列表 - / * → <ul><li>
 *  - 有序列表 1. 2. → <ol><li>
 *  - 粗体 **text** → <strong>
 *  - 斜体 *text* → <em>
 *  - 代码块 ``` → <pre><code>
 *  - 行内代码 `code` → <code>
 *  - 段落 → <p>
 *  - 水平分割线 --- → <hr>
 *  - 引用 > → <blockquote>
 *  - 链接 [text](url) → <a>
 *
 * 边界处理：空输入返回空字符串；嵌套格式按优先级匹配；HTML 特殊字符转义。
 */

/** 转义 HTML 特殊字符，避免破坏 HTML 结构 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 行内格式节点 */
interface InlineNode {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link'
  content: string
  href?: string
}

/** 行内格式解析：按优先级匹配 code > bold > italic > link */
function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  const tokens: Array<{
    regex: RegExp
    type: InlineNode['type']
    href?: (m: RegExpExecArray) => string
  }> = [
    { regex: /`([^`]+)`/, type: 'code' },
    { regex: /\*\*([^*]+)\*\*/, type: 'bold' },
    { regex: /\*([^*]+)\*/, type: 'italic' },
    { regex: /\[([^\]]+)\]\(([^)]+)\)/, type: 'link', href: (m) => m[2] }
  ]

  let remaining = text
  while (remaining.length > 0) {
    let earliest: { idx: number; match: RegExpExecArray; token: typeof tokens[0] } | null = null
    for (const token of tokens) {
      const m = token.regex.exec(remaining)
      if (m && (earliest === null || m.index < earliest.idx)) {
        earliest = { idx: m.index, match: m, token }
      }
    }
    if (!earliest) {
      nodes.push({ type: 'text', content: remaining })
      break
    }
    if (earliest.idx > 0) {
      nodes.push({ type: 'text', content: remaining.slice(0, earliest.idx) })
    }
    const m = earliest.match
    if (earliest.token.type === 'code') {
      nodes.push({ type: 'code', content: m[1] })
    } else if (earliest.token.type === 'bold') {
      nodes.push({ type: 'bold', content: m[1] })
    } else if (earliest.token.type === 'italic') {
      nodes.push({ type: 'italic', content: m[1] })
    } else if (earliest.token.type === 'link') {
      nodes.push({ type: 'link', content: m[1], href: earliest.token.href!(m) })
    }
    remaining = remaining.slice(m.index + m[0].length)
  }
  return nodes
}

/** 行内样式常量（inline style，便于粘贴到 Word/飞书保留格式） */
const INLINE_STYLE_CODE =
  'font-family: Consolas, Monaco, "Courier New", monospace; font-size: 12px; background: #eef2f7; color: #c7254e; padding: 1px 4px; border-radius: 3px;'
const INLINE_STYLE_LINK = 'color: #2b7fff; text-decoration: underline;'

/** 将行内节点渲染为 HTML 字符串（含 inline style） */
function renderInlineNodes(nodes: InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'bold':
          return `<strong>${escapeHtml(node.content)}</strong>`
        case 'italic':
          return `<em>${escapeHtml(node.content)}</em>`
        case 'code':
          return `<code style="${INLINE_STYLE_CODE}">${escapeHtml(node.content)}</code>`
        case 'link':
          return `<a href="${escapeHtml(node.href ?? '')}" style="${INLINE_STYLE_LINK}">${escapeHtml(node.content)}</a>`
        default:
          return escapeHtml(node.content)
      }
    })
    .join('')
}

/** Markdown 块级结构 */
interface MarkdownBlock {
  type: 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'p' | 'quote' | 'hr' | 'code'
  items?: string[]
  text?: string
  /** 代码块语言标识（可选） */
  lang?: string
}

/** 将 Markdown 解析为块级结构 */
function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (trimmed === '') {
      i++
      continue
    }

    // 代码块 ```lang ... ```
    if (/^```/.test(trimmed)) {
      const lang = trimmed.replace(/^```/, '').trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        i++
      }
      // 跳过结束 ```
      if (i < lines.length) i++
      blocks.push({ type: 'code', text: codeLines.join('\n'), lang })
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const h1 = /^#\s+(.*)$/.exec(trimmed)
    if (h1) {
      blocks.push({ type: 'h1', text: h1[1] })
      i++
      continue
    }
    const h2 = /^##\s+(.*)$/.exec(trimmed)
    if (h2) {
      blocks.push({ type: 'h2', text: h2[1] })
      i++
      continue
    }
    const h3 = /^###\s+(.*)$/.exec(trimmed)
    if (h3) {
      blocks.push({ type: 'h3', text: h3[1] })
      i++
      continue
    }

    const quote = /^>\s+(.*)$/.exec(trimmed)
    if (quote) {
      const quoteLines: string[] = [quote[1]]
      i++
      while (i < lines.length && /^>\s+/.test(lines[i].trim())) {
        quoteLines.push(/^>\s+(.*)$/.exec(lines[i].trim())![1])
        i++
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') })
      continue
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(/^[-*]\s+(.*)$/.exec(lines[i].trim())![1])
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(/^\d+\.\s+(.*)$/.exec(lines[i].trim())![1])
        i++
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    const paraLines: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,3}\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^>\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !/^```/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push({ type: 'p', text: paraLines.join('\n') })
  }
  return blocks
}

/** 块级 inline style 常量 */
const STYLE_H1 =
  'font-size: 22px; font-weight: 700; color: #1a2332; margin: 18px 0 10px; line-height: 1.3; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;'
const STYLE_H2 =
  'font-size: 17px; font-weight: 600; color: #1a2332; margin: 14px 0 8px; line-height: 1.3; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;'
const STYLE_H3 =
  'font-size: 14px; font-weight: 600; color: #5a6a7e; margin: 12px 0 6px; line-height: 1.4; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;'
const STYLE_P =
  'font-size: 13px; color: #1a2332; margin: 6px 0; line-height: 1.7; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; white-space: pre-wrap; word-break: break-word;'
const STYLE_UL =
  'font-size: 13px; color: #1a2332; margin: 6px 0; padding-left: 24px; line-height: 1.7; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;'
const STYLE_OL =
  'font-size: 13px; color: #1a2332; margin: 6px 0; padding-left: 24px; line-height: 1.7; font-family: "Microsoft YaHei", "PingFang SC", sans-serif;'
const STYLE_LI = 'margin: 3px 0;'
const STYLE_HR =
  'border: none; border-top: 1px solid #e1e7ef; margin: 12px 0;'
const STYLE_QUOTE =
  'margin: 8px 0; padding: 8px 14px; border-left: 3px solid #2b7fff; background: #f0f6ff; color: #5a6a7e; font-size: 13px; line-height: 1.7; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; white-space: pre-wrap; word-break: break-word;'
const STYLE_PRE =
  'margin: 10px 0; padding: 12px 14px; background: #f5f7fa; border: 1px solid #e1e7ef; border-radius: 6px; overflow-x: auto; line-height: 1.5;'
const STYLE_CODE_BLOCK =
  'font-family: Consolas, Monaco, "Courier New", monospace; font-size: 12px; color: #1a2332; white-space: pre-wrap; word-break: break-word;'

/**
 * 将 Markdown 转换为带 inline style 的 HTML 字符串，适合剪贴板富文本复制。
 * 粘贴到 Word / 飞书 / 钉钉文档等可保留标题、列表、粗体、代码等格式。
 *
 * @param markdown Markdown 源文本
 * @returns HTML 字符串（仅 body 片段，无 <html>/<head> 包裹）
 */
export function markdownToRichHtml(markdown: string): string {
  if (!markdown || markdown.trim() === '') return ''
  const blocks = parseBlocks(markdown)
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'h1':
        parts.push(`<h1 style="${STYLE_H1}">${renderInlineNodes(parseInline(block.text ?? ''))}</h1>`)
        break
      case 'h2':
        parts.push(`<h2 style="${STYLE_H2}">${renderInlineNodes(parseInline(block.text ?? ''))}</h2>`)
        break
      case 'h3':
        parts.push(`<h3 style="${STYLE_H3}">${renderInlineNodes(parseInline(block.text ?? ''))}</h3>`)
        break
      case 'ul':
        parts.push(
          `<ul style="${STYLE_UL}">${(block.items ?? [])
            .map((item) => `<li style="${STYLE_LI}">${renderInlineNodes(parseInline(item))}</li>`)
            .join('')}</ul>`
        )
        break
      case 'ol':
        parts.push(
          `<ol style="${STYLE_OL}">${(block.items ?? [])
            .map((item) => `<li style="${STYLE_LI}">${renderInlineNodes(parseInline(item))}</li>`)
            .join('')}</ol>`
        )
        break
      case 'quote':
        parts.push(
          `<blockquote style="${STYLE_QUOTE}">${renderInlineNodes(parseInline(block.text ?? ''))}</blockquote>`
        )
        break
      case 'hr':
        parts.push(`<hr style="${STYLE_HR}"/>`)
        break
      case 'code':
        parts.push(
          `<pre style="${STYLE_PRE}"><code style="${STYLE_CODE_BLOCK}">${escapeHtml(block.text ?? '')}</code></pre>`
        )
        break
      default:
        parts.push(
          `<p style="${STYLE_P}">${renderInlineNodes(parseInline(block.text ?? ''))}</p>`
        )
    }
  }
  return parts.join('\n')
}
