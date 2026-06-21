/**
 * ReportExporter：报告导出器
 *
 * 支持 3 种导出格式：
 *  - Markdown（.md）：纯 Markdown 文本
 *  - Word（.docx）：使用 docx 库生成原生 .docx，可在 Microsoft Word 直接打开
 *  - JSON（.json）：含完整元数据，用于存档审计
 *
 * 将 Reports.tsx 前端的导出逻辑统一到此后端实现，前端通过 IPC 调用。
 */
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  AlignmentType,
  LevelFormat
} from 'docx'
import type { ParagraphChild } from 'docx'
import type { Report, ReportStatus } from '@/types'

/** 报告状态中文标签 */
const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: '草稿',
  exported: '已导出'
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

/** 将行内节点渲染为 docx TextRun 数组 */
function inlineNodesToRuns(nodes: InlineNode[]): ParagraphChild[] {
  return nodes.map((node) => {
    switch (node.type) {
      case 'bold':
        return new TextRun({ text: node.content, bold: true })
      case 'italic':
        return new TextRun({ text: node.content, italics: true })
      case 'code':
        return new TextRun({
          text: node.content,
          font: 'Consolas',
          color: 'C7254E'
        })
      case 'link':
        return new TextRun({
          text: node.content,
          color: '2B7FFF',
          underline: {}
        })
      default:
        return new TextRun({ text: node.content })
    }
  })
}

/** Markdown 块级结构 */
interface MarkdownBlock {
  type: 'h1' | 'h2' | 'h3' | 'ul' | 'ol' | 'p' | 'quote' | 'hr' | 'code'
  items?: string[]
  text?: string
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
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      blocks.push({ type: 'code', text: codeLines.join('\n') })
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

/** 将 Markdown 块级结构转为 docx Paragraph 数组 */
function blocksToParagraphs(blocks: MarkdownBlock[]): Paragraph[] {
  const paragraphs: Paragraph[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'h1':
        paragraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: block.text ?? '', bold: true })]
          })
        )
        break
      case 'h2':
        paragraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: block.text ?? '', bold: true })]
          })
        )
        break
      case 'h3':
        paragraphs.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun({ text: block.text ?? '', bold: true })]
          })
        )
        break
      case 'ul':
        for (const item of block.items ?? []) {
          paragraphs.push(
            new Paragraph({
              bullet: { level: 0 },
              children: inlineNodesToRuns(parseInline(item))
            })
          )
        }
        break
      case 'ol':
        for (const item of block.items ?? []) {
          paragraphs.push(
            new Paragraph({
              numbering: { reference: 'wm-numbering', level: 0 },
              children: inlineNodesToRuns(parseInline(item))
            })
          )
        }
        break
      case 'quote':
        paragraphs.push(
          new Paragraph({
            children: inlineNodesToRuns(parseInline(block.text ?? '')),
            indent: { left: 360 }
          })
        )
        break
      case 'hr':
        paragraphs.push(
          new Paragraph({
            children: [],
            border: {
              bottom: { color: 'E1E7EF', space: 1, style: 'single', size: 6 }
            }
          })
        )
        break
      case 'code':
        // 代码块：每行一个 Paragraph，使用 Consolas 字体
        for (const codeLine of (block.text ?? '').split('\n')) {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: codeLine,
                  font: 'Consolas',
                  size: 20,
                  color: '1A2332'
                })
              ],
              shading: { fill: 'F5F7FA' }
            })
          )
        }
        break
      default: {
        // 段落：支持多行（按 \n 拆分为多个 TextRun + break）
        const text = block.text ?? ''
        const lines = text.split('\n')
        const runs: ParagraphChild[] = []
        lines.forEach((ln, idx) => {
          if (idx > 0) {
            runs.push(new TextRun({ break: 1 }))
          }
          runs.push(...inlineNodesToRuns(parseInline(ln)))
        })
        paragraphs.push(new Paragraph({ children: runs }))
      }
    }
  }
  return paragraphs
}

export const ReportExporter = {
  /**
   * 导出为 Markdown 文件内容。
   * 返回纯 Markdown 文本，文件扩展名 .md。
   */
  exportMarkdown(report: Report): string {
    const header = `<!-- WorkMemory 日报 | 日期: ${report.date} | 模板: ${report.templateName} | 状态: ${STATUS_LABEL[report.status]} -->\n\n`
    return `${header}${report.markdownContent}`
  },

  /**
   * 导出为原生 .docx 文件 Buffer。
   * 使用 docx 库生成，可在 Microsoft Word 直接打开。
   * 标题/列表/粗体/段落/代码块均正确渲染。
   *
   * @param markdown Markdown 源文本
   * @param metadata 元数据（标题、日期）
   * @returns .docx 文件 Buffer
   */
  async exportWord(
    markdown: string,
    metadata: { title: string; date: string }
  ): Promise<Buffer> {
    const blocks = parseBlocks(markdown)
    const bodyParagraphs = blocksToParagraphs(blocks)

    // 元信息段落（日期 + 标题）
    const metaParagraphs: Paragraph[] = [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new TextRun({
            text: metadata.title,
            bold: true,
            size: 32,
            color: '1A2332'
          })
        ]
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `日期：${metadata.date}`,
            size: 20,
            color: '5A6A7E'
          })
        ]
      }),
      new Paragraph({
        children: [],
        border: {
          bottom: { color: 'E1E7EF', space: 1, style: 'single', size: 6 }
        }
      }),
      new Paragraph({ children: [] })
    ]

    const doc = new Document({
      title: metadata.title,
      creator: 'WorkMemory',
      description: `WorkMemory 工作日报 ${metadata.date}`,
      numbering: {
        config: [
          {
            reference: 'wm-numbering',
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: '%1.',
                alignment: AlignmentType.START,
                style: {
                  paragraph: { indent: { left: 720, hanging: 360 } }
                }
              }
            ]
          }
        ]
      },
      sections: [
        {
          properties: {
            page: {
              margin: {
                top: 1440,
                right: 1440,
                bottom: 1440,
                left: 1440
              }
            }
          },
          children: [...metaParagraphs, ...bodyParagraphs]
        }
      ]
    })

    return Packer.toBuffer(doc)
  },

  /**
   * 导出为 JSON 文件内容。
   * 含完整元数据：date/template/segmentIds/aiInputSnapshot/markdownContent/status/createdAt。
   */
  exportJson(report: Report): string {
    const exportData = {
      exportedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      id: report.id,
      date: report.date,
      templateId: report.templateId,
      templateName: report.templateName,
      status: report.status,
      reportType: report.reportType,
      segmentIds: report.segmentIds,
      aiInputSnapshot: report.aiInputSnapshot,
      markdownContent: report.markdownContent
    }
    return JSON.stringify(exportData, null, 2)
  }
}
