/**
 * 简易 Markdown 渲染工具（自实现，不引入重型编辑器库）
 * 支持：标题、列表、粗体、斜体、代码、链接、[[wikilink]] 双链
 * 供 Wiki / Reports 页面共享。
 */
import { Fragment } from 'react'

/** 从 Markdown 内容中提取 [[wikilink]] 目标标题列表 */
export function parseWikiLinks(content: string): string[] {
  const regex = /\[\[([^\]]+)\]\]/g
  const links: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim())
  }
  return Array.from(new Set(links))
}

/** 转义 HTML 特殊字符 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 行内格式解析：粗体、斜体、代码、链接、[[wikilink]] */
interface InlineNode {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'wikilink'
  content: string
  href?: string
}

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  // 按优先级匹配：[[wikilink]] > `code` > **bold** > *italic* > [text](url)
  // 使用占位符法逐层替换
  const tokens: Array<{ regex: RegExp; type: InlineNode['type']; href?: (m: RegExpExecArray) => string }> = [
    { regex: /\[\[([^\]]+)\]\]/, type: 'wikilink', href: (m) => m[1].trim() },
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
    // 前置纯文本
    if (earliest.idx > 0) {
      nodes.push({ type: 'text', content: remaining.slice(0, earliest.idx) })
    }
    const m = earliest.match
    if (earliest.token.type === 'wikilink') {
      nodes.push({ type: 'wikilink', content: m[1].trim(), href: earliest.token.href!(m) })
    } else if (earliest.token.type === 'code') {
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

/** 渲染行内节点为 JSX */
function renderInlineNodes(
  nodes: InlineNode[],
  onWikiLink?: (title: string) => void
): JSX.Element[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'bold':
        return <strong key={i}>{node.content}</strong>
      case 'italic':
        return <em key={i}>{node.content}</em>
      case 'code':
        return (
          <code key={i} className="wm-md-code">
            {node.content}
          </code>
        )
      case 'link':
        return (
          <a key={i} href={node.href} target="_blank" rel="noreferrer" className="wm-md-link">
            {node.content}
          </a>
        )
      case 'wikilink':
        return (
          <a
            key={i}
            className="wm-md-wikilink"
            onClick={(e) => {
              e.preventDefault()
              onWikiLink?.(node.href ?? node.content)
            }}
          >
            {node.content}
          </a>
        )
      default:
        return <Fragment key={i}>{node.content}</Fragment>
    }
  })
}

interface MarkdownBlock {
  type: 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'p' | 'quote' | 'hr'
  items?: string[]
  text?: string
}

/** 将 Markdown 文本解析为块级结构 */
function parseBlocks(content: string): MarkdownBlock[] {
  const lines = content.split('\n')
  const blocks: MarkdownBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行跳过
    if (trimmed === '') {
      i++
      continue
    }

    // 水平分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // 标题
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

    // 引用
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

    // 无序列表
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(/^[-*]\s+(.*)$/.exec(lines[i].trim())![1])
        i++
      }
      blocks.push({ type: 'ul', items })
      continue
    }

    // 有序列表
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(/^\d+\.\s+(.*)$/.exec(lines[i].trim())![1])
        i++
      }
      blocks.push({ type: 'ol', items })
      continue
    }

    // 段落（连续非空行）
    const paraLines: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,3}\s+/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^>\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push({ type: 'p', text: paraLines.join('\n') })
  }
  return blocks
}

/** 渲染 Markdown 为 JSX */
export function renderMarkdown(
  content: string,
  onWikiLink?: (title: string) => void
): JSX.Element {
  if (!content || content.trim() === '') {
    return <p className="wm-md-empty">（空内容）</p>
  }
  const blocks = parseBlocks(content)
  return (
    <div className="wm-md-body">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'h1':
            return <h1 key={i} className="wm-md-h1">{renderInlineNodes(parseInline(block.text ?? ''), onWikiLink)}</h1>
          case 'h2':
            return <h2 key={i} className="wm-md-h2">{renderInlineNodes(parseInline(block.text ?? ''), onWikiLink)}</h2>
          case 'h3':
            return <h3 key={i} className="wm-md-h3">{renderInlineNodes(parseInline(block.text ?? ''), onWikiLink)}</h3>
          case 'ul':
            return (
              <ul key={i} className="wm-md-ul">
                {block.items?.map((item, j) => (
                  <li key={j}>{renderInlineNodes(parseInline(item), onWikiLink)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i} className="wm-md-ol">
                {block.items?.map((item, j) => (
                  <li key={j}>{renderInlineNodes(parseInline(item), onWikiLink)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return (
              <blockquote key={i} className="wm-md-quote">
                {renderInlineNodes(parseInline(block.text ?? ''), onWikiLink)}
              </blockquote>
            )
          case 'hr':
            return <hr key={i} className="wm-md-hr" />
          default:
            return (
              <p key={i} className="wm-md-p">
                {renderInlineNodes(parseInline(block.text ?? ''), onWikiLink)}
              </p>
            )
        }
      })}
      <style>{`
        .wm-md-body { font-size: 13px; line-height: 1.7; color: var(--wm-color-text-primary); word-break: break-word; }
        .wm-md-body .wm-md-h1 { font-size: 20px; font-weight: 700; margin: 16px 0 8px; color: var(--wm-color-text-primary); }
        .wm-md-body .wm-md-h2 { font-size: 16px; font-weight: 600; margin: 14px 0 6px; color: var(--wm-color-text-primary); }
        .wm-md-body .wm-md-h3 { font-size: 14px; font-weight: 600; margin: 12px 0 4px; color: var(--wm-color-text-secondary); }
        .wm-md-body .wm-md-p { margin: 6px 0; white-space: pre-wrap; }
        .wm-md-body .wm-md-ul, .wm-md-body .wm-md-ol { margin: 6px 0; padding-left: 22px; }
        .wm-md-body .wm-md-ul li, .wm-md-body .wm-md-ol li { margin: 3px 0; }
        .wm-md-body .wm-md-quote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid var(--wm-color-accent); background: var(--wm-color-accent-soft); color: var(--wm-color-text-secondary); border-radius: 0 var(--wm-radius-button) var(--wm-radius-button) 0; }
        .wm-md-body .wm-md-hr { border: none; border-top: 1px solid var(--wm-color-border); margin: 12px 0; }
        .wm-md-body .wm-md-code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 12px; padding: 1px 5px; background: var(--wm-color-surface-alt); border-radius: 3px; color: var(--wm-color-danger); }
        .wm-md-body .wm-md-link { color: var(--wm-color-accent); text-decoration: underline; cursor: pointer; }
        .wm-md-body .wm-md-wikilink { color: var(--wm-color-success); background: rgba(34,181,106,0.1); padding: 1px 6px; border-radius: var(--wm-radius-pill); cursor: pointer; font-weight: 500; font-size: 12px; transition: all 0.12s; }
        .wm-md-body .wm-md-wikilink:hover { background: rgba(34,181,106,0.2); }
        .wm-md-empty { color: var(--wm-color-text-muted); font-size: 12px; font-style: italic; }
      `}</style>
    </div>
  )
}

/** 将纯文本转为安全 HTML（用于导出场景） */
export function markdownToHtml(content: string): string {
  const blocks = parseBlocks(content)
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'h1':
        parts.push(`<h1>${escapeHtml(block.text ?? '')}</h1>`)
        break
      case 'h2':
        parts.push(`<h2>${escapeHtml(block.text ?? '')}</h2>`)
        break
      case 'h3':
        parts.push(`<h3>${escapeHtml(block.text ?? '')}</h3>`)
        break
      case 'ul':
        parts.push(`<ul>${(block.items ?? []).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`)
        break
      case 'ol':
        parts.push(`<ol>${(block.items ?? []).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ol>`)
        break
      case 'quote':
        parts.push(`<blockquote>${escapeHtml(block.text ?? '')}</blockquote>`)
        break
      case 'hr':
        parts.push('<hr/>')
        break
      default:
        parts.push(`<p>${escapeHtml(block.text ?? '').replace(/\n/g, '<br/>')}</p>`)
    }
  }
  return parts.join('\n')
}
