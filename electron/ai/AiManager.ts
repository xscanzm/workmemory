/**
 * AiManager：AI 编排层单例
 *
 * 职责：
 *  - generateReport(params)：调 ReportGenerator 生成日报，结果存入 ReportRepository（status='draft'）
 *  - testConnection()：测试 API 连接（发一个简单 ping 请求）
 *  - estimateChars(episodeIds)：估算发送字符数（供前端确认面板）
 *  - exportMarkdown / exportWord / exportJson：委托 ReportExporter
 *
 * 暴露 IPC：ai:generateReport、ai:testConnection、ai:estimateChars
 *
 * 单例导出 getAiManager()。
 */
import type { Report, ReportTemplate } from '@/types'
import { ReportGenerator } from './ReportGenerator'
import type { GenerateReportPayload, GenerateReportResult } from './ReportGenerator'
import { ReportRepository } from '../db/repositories/ReportRepository'
import { ReportExporter } from './ReportExporter'
import { getTemplateList } from './templates'

/** 模板列表项 */
export interface TemplateListItem {
  id: ReportTemplate
  name: string
  description: string
}

/** AI 生成日报的最终结果（含已保存的 Report） */
export interface AiGenerateReportFinalResult extends GenerateReportResult {
  /** 已保存到数据库的报告 ID */
  reportId: string
  /** 已保存的 Report 对象（status='draft'） */
  report: Report
}

/**
 * AiManager：AI 编排层。
 */
export class AiManager {
  private initialized = false

  /** 初始化（app ready 后调用，当前无特殊初始化逻辑，预留扩展点） */
  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    console.log('[AiManager] 初始化完成')
  }

  /**
   * 生成日报并保存到数据库。
   *
   * 流程：
   * 1. 调 ReportGenerator.generate 生成 markdown + aiInputSnapshot + usage
   * 2. 构造 Report 对象（status='draft'）
   * 3. 调 ReportRepository.insert 保存
   * 4. 返回含 reportId 的完整结果
   *
   * @throws 当 API Key 未配置或 AI 调用失败时抛出明确错误
   */
  async generateReport(payload: GenerateReportPayload): Promise<AiGenerateReportFinalResult> {
    // 调用 ReportGenerator 生成内容
    const genResult: GenerateReportResult = await ReportGenerator.generate(payload)

    // 构造 Report 对象
    const templateName = this.getTemplateName(payload.templateId)
    const report: Report = {
      id: '',
      date: payload.date,
      templateId: payload.templateId,
      templateName,
      segmentIds: genResult.segmentIds,
      aiInputSnapshot: genResult.aiInputSnapshot,
      markdownContent: genResult.markdown,
      status: 'draft',
      reportType: 'daily'
    }

    // 保存到数据库
    const saved = ReportRepository.insert(report)

    return {
      ...genResult,
      reportId: saved.id,
      report: saved
    }
  }

  /**
   * 测试 API 连接（发送一个极简 ping 请求）。
   * 不抛异常，返回 { ok, message }。
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    return ReportGenerator.testConnection()
  }

  /**
   * 估算发送字符数（供前端确认面板显示）。
   * 构建 timeline 并返回字符数，不调用 AI。
   */
  estimateChars(episodeIds: string[], notes: string): number {
    return ReportGenerator.estimateChars(episodeIds, notes)
  }

  /** 获取所有模板列表 */
  getTemplates(): TemplateListItem[] {
    return getTemplateList()
  }

  /** 导出为 Markdown */
  exportMarkdown(report: Report): string {
    return ReportExporter.exportMarkdown(report)
  }

  /**
   * 生成原生 .docx 文件 Buffer。
   * 委托 ReportExporter.exportWord 使用 docx 库生成，可在 Microsoft Word 直接打开。
   * 保存对话框与文件写入由 IPC handler 层负责（保持 AiManager 不依赖 electron dialog）。
   */
  async exportWord(
    markdown: string,
    metadata: { title: string; date: string }
  ): Promise<Buffer> {
    return ReportExporter.exportWord(markdown, metadata)
  }

  /** 导出为 JSON */
  exportJson(report: Report): string {
    return ReportExporter.exportJson(report)
  }

  /** 停止管理器 */
  stop(): void {
    this.initialized = false
  }

  // ===================== 内部工具 =====================

  /** 获取模板中文名 */
  private getTemplateName(templateId: ReportTemplate): string {
    const templates = getTemplateList()
    const found = templates.find((t) => t.id === templateId)
    return found?.name ?? templateId
  }
}

// ===================== 单例 =====================

let managerInstance: AiManager | null = null

/** 获取 AiManager 单例 */
export function getAiManager(): AiManager {
  if (!managerInstance) {
    managerInstance = new AiManager()
  }
  return managerInstance
}

/** 重置单例（仅供测试） */
export function resetAiManager(): void {
  if (managerInstance) {
    managerInstance.stop()
    managerInstance = null
  }
}
