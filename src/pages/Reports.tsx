/**
 * Task B3.2 / C5：日报中心 (Reports) 页 — 精品桌面产品视觉重构
 * - 顶部：标题 + 模板选择 + "生成今日日报"按钮（触发 AI 确认 Dialog）
 * - AI 确认 Dialog：标题、安全提示、模型名、估算字符数、Episode 勾选、备注、取消/确认
 * - 报告编辑区：TextField（日期）+ SegmentedControl（编辑/预览）+ textarea/Markdown 预览
 * - 导出按钮组：复制富文本、导出 Word、导出 Markdown、导出 JSON、保存草稿、标记已导出
 * - 报告历史列表：Card 卡片，按日期倒序，点击加载到编辑区
 * - Toast 通知：操作反馈使用 toast.success/error/warning/info
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useRecordingStore } from '@/store/recordingStore'
import { renderMarkdown } from '@/utils/markdown'
import { markdownToRichHtml } from '../../electron/ai/HtmlExporter'
import { maskSensitive } from '../../electron/ai/SensitiveMasker'
import { getTodayDate } from '@/utils/datetime'
import {
  Button,
  Card,
  Badge,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  TextField,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SegmentedControl,
  IconButton,
  toast,
  FileText,
  Copy,
  Download,
  Loader2,
  Shield,
  AlertCircle,
  Check,
  Trash2,
  ChevronDown,
  ChevronRight,
  type BadgeVariant
} from '@/ui'
import type { Episode, Report, ReportTemplate, ReportStatus } from '@/types'
import type { CleanEpisode, EvidenceRef, ReportInputSnapshot, ReportSnapshotItem, SourceQuality } from '@/types'
import type { AiGenerateReportPayload, AiGenerateReportResult } from '../../electron/types/ipc'
import './Reports.css'

// ===================== 常量 =====================

const DAILY_SUMMARY_TOPIC = '__daily_summary__'

/** 判断当前日报是否为结构化分区版（RP1.7） */
function isStructuredReport(report: Report): boolean {
  return report.templateId === 'structured'
}

/** 解析结构化日报 Markdown 为分区数组（RP1.7） */
interface ParsedSection {
  heading: string
  body: string
}

function parseStructuredSections(markdown: string): ParsedSection[] {
  const lines = markdown.split('\n')
  const sections: ParsedSection[] = []
  let currentHeading = ''
  let currentBody: string[] = []

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/)
    if (headingMatch) {
      if (currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
      }
      currentHeading = headingMatch[1].trim()
      currentBody = []
    } else if (currentHeading) {
      // 跳过一级标题（# 工作日报）
      if (!line.startsWith('# ')) {
        currentBody.push(line)
      }
    }
  }
  if (currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() })
  }
  return sections
}

/**
 * 渲染结构化日报预览（RP1.7）。
 * 按 sections 分区展示，每个 section 有标题和内容卡片。
 */
function renderStructuredPreview(markdown: string): JSX.Element {
  const sections = parseStructuredSections(markdown)
  // 提取一级标题（# 工作日报 YYYY-MM-DD）
  const titleMatch = markdown.match(/^#\s+(.+)$/m)
  const reportTitle = titleMatch ? titleMatch[1].trim() : '工作日报'

  return (
    <div className="wm-reports-structured">
      <h1 className="wm-reports-structured-title">{reportTitle}</h1>
      {sections.length === 0 ? (
        <div className="wm-reports-preview-empty">暂无结构化分区内容</div>
      ) : (
        sections.map((section, idx) => (
          <div key={`${section.heading}-${idx}`} className="wm-reports-structured-section">
            <h2 className="wm-reports-structured-section-heading">{section.heading}</h2>
            <div className="wm-reports-structured-section-body">
              {renderMarkdown(section.body || '（无内容）')}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

const TEMPLATE_OPTIONS: Array<{ id: ReportTemplate; name: string; description: string }> = [
  { id: 'enhanced', name: '汇报优化版', description: '将杂事改写为具商业价值的表达，突出产出与价值' },
  { id: 'concise', name: '简洁客观版', description: '项目/用时/产出列表，客观陈述事实' },
  { id: 'okr', name: 'OKR 对齐版', description: '按 OKR 进度归纳，对齐目标推进' },
  { id: 'structured', name: '结构化分区版', description: '按管家总结/今日做了什么/今日看了什么/主题归纳/时间线/分类要点/证据/建议分区输出' }
]

const TEMPLATE_NAME_MAP: Record<ReportTemplate, string> = {
  enhanced: '汇报优化版',
  concise: '简洁客观版',
  okr: 'OKR 对齐版',
  structured: '结构化分区版'
}

const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: '草稿',
  exported: '已导出'
}

const STATUS_VARIANT: Record<ReportStatus, BadgeVariant> = {
  draft: 'warning',
  exported: 'success'
}

const EDIT_PREVIEW_OPTIONS = [
  { value: 'edit', label: '编辑' },
  { value: 'preview', label: '预览' }
]

/** 报告预览文本：取 markdownContent 前 100 字符 */
function getReportPreview(markdown: string): string {
  const text = markdown.replace(/^#+\s*/gm, '').replace(/[*`>-]/g, '').trim()
  if (text.length <= 100) return text || '（无内容）'
  return text.slice(0, 100) + '...'
}

// ===================== 工具函数 =====================

/** 生成空 Report 草稿（P0 仅日报） */
function emptyReport(date: string, templateId: ReportTemplate): Report {
  return {
    id: '',
    date,
    templateId,
    templateName: TEMPLATE_NAME_MAP[templateId],
    segmentIds: [],
    aiInputSnapshot: '',
    markdownContent: '',
    status: 'draft',
    reportType: 'daily'
  }
}

// ===================== 主组件 =====================

export function Reports(): JSX.Element {
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)
  const [searchParams, setSearchParams] = useSearchParams()
  const [pendingAutoGenerate, setPendingAutoGenerate] = useState<boolean>(false)

  const [selectedDate, setSelectedDate] = useState<string>(getTodayDate())
  const [templateId, setTemplateId] = useState<ReportTemplate>('enhanced')
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [cleanEpisodes, setCleanEpisodes] = useState<CleanEpisode[]>([])
  const [history, setHistory] = useState<Report[]>([])
  const [loading, setLoading] = useState<boolean>(true)

  // 当前编辑的报告草稿
  const [draft, setDraft] = useState<Report>(emptyReport(getTodayDate(), 'enhanced'))
  const [isNew, setIsNew] = useState<boolean>(true)

  // 编辑/预览模式
  const [editorMode, setEditorMode] = useState<string>('edit')

  // AI 确认 Dialog 状态
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false)
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<Set<string>>(new Set())
  const [userNotes, setUserNotes] = useState<string>('')
  const [generating, setGenerating] = useState<boolean>(false)
  const [generatingMessage, setGeneratingMessage] = useState<string>('')
  const [generateError, setGenerateError] = useState<string>('')

  // C3.1：可展开预览的 Episode id 集合
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  // C3.2：已移除（隐藏）的 Episode id 集合，可恢复
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set())

  const [modelName, setModelName] = useState<string>('')

  // 加载数据
  const loadData = useCallback(async (): Promise<void> => {
    try {
      const [eps, hist] = await Promise.all([
        window.workmemory.episode.getByDate(selectedDate),
        window.workmemory.report.getAllHistory()
      ])
      const clean = await window.workmemory.cleanEpisode.getByDate(selectedDate).catch(() => [] as CleanEpisode[])
      setEpisodes(eps.filter((e) => !e.topics.includes(DAILY_SUMMARY_TOPIC)))
      setCleanEpisodes(clean)
      setHistory(hist)
    } catch (e) {
      console.error('[Reports] 加载数据失败:', e)
    } finally {
      setLoading(false)
    }
  }, [selectedDate])

  useEffect(() => {
    void loadData()
  }, [loadData, refreshTrigger])

  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // 加载模型名（用于 AI 确认面板显示）
  useEffect(() => {
    window.workmemory.settings
      .get()
      .then((s) => setModelName(s.modelName || 'gpt-4o-mini'))
      .catch(() => setModelName(''))
  }, [refreshTrigger])

  // 当切换日期/模板时，若草稿是新建状态，同步日期与模板
  useEffect(() => {
    if (isNew) {
      setDraft((d) => ({
        ...d,
        date: selectedDate,
        templateId,
        templateName: TEMPLATE_NAME_MAP[templateId]
      }))
    }
  }, [selectedDate, templateId, isNew])

  // C4.3：读取 date 查询参数，自动加载该日期的日报并高亮
  useEffect(() => {
    const dateParam = searchParams.get('date')
    const shouldGenerate = searchParams.get('generate') === '1'
    if (!dateParam) return
    // 校验 YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const reports = await window.workmemory.report.getByDate(dateParam)
        if (cancelled) return
        if (reports.length > 0) {
          // 取最新一条
          const target = reports[0]
          setDraft({ ...target })
          setIsNew(false)
          setSelectedDate(target.date)
          setTemplateId(target.templateId)
          toast.info('已加载日报', target.date)
        } else {
          // 该日期无日报，仅切换日期，便于用户生成
          setSelectedDate(dateParam)
          setDraft(emptyReport(dateParam, templateId))
          setIsNew(true)
          toast.info('该日期暂无日报', `${dateParam} 可生成新日报`)
        }
        if (shouldGenerate) {
          setPendingAutoGenerate(true)
        }
      } catch (e) {
        console.error('[Reports] 加载指定日期日报失败:', e)
      }
    })()
    // 消费后清除 date/generate 参数，避免后续刷新重复触发
    setSearchParams({}, { replace: true })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // 可勾选的 Episode 列表（reportEligible 优先，但允许全部）
  const eligibleEpisodes = useMemo<Episode[]>(() => {
    return [...episodes].sort((a, b) => a.startTime.localeCompare(b.startTime))
  }, [episodes])

  const eligibleCleanEpisodes = useMemo<CleanEpisode[]>(() => {
    return [...cleanEpisodes]
      .filter((e) => e.reportEligible)
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
  }, [cleanEpisodes])

  const usingCleanEpisodes = eligibleCleanEpisodes.length > 0

  // C3.2：可见 Episode 列表（排除已移除的）
  const visibleEpisodes = useMemo<Episode[]>(() => {
    return eligibleEpisodes.filter((e) => !removedIds.has(e.id))
  }, [eligibleEpisodes, removedIds])

  const visibleCleanEpisodes = useMemo<CleanEpisode[]>(() => {
    return eligibleCleanEpisodes.filter((e) => !removedIds.has(e.id))
  }, [eligibleCleanEpisodes, removedIds])

  // 估算发送字符数与脱敏数（基于勾选 Episode 的摘要文本）
  // C3.4：对组合文本应用脱敏，统计脱敏后字符数与脱敏处数
  const { estimatedChars, maskedCount } = useMemo<{ estimatedChars: number; maskedCount: number }>(() => {
    let combined = ''
    if (usingCleanEpisodes) {
      for (const ep of visibleCleanEpisodes) {
        if (!selectedEpisodeIds.has(ep.id)) continue
        combined += `${ep.title ?? ''}\n${ep.summary ?? ''}\n${ep.project ?? ''}\n`
        for (const e of ep.entities) combined += `${e.name}\n`
        for (const ev of ep.evidenceRefs) combined += `${ev.quote}\n`
      }
    } else {
      for (const ep of visibleEpisodes) {
      if (!selectedEpisodeIds.has(ep.id)) continue
      combined += `${ep.title ?? ''}\n${ep.oneLineSummary ?? ''}\n`
      for (const e of ep.entities) combined += `${e.name}\n`
      combined += '（时间/格式开销）\n'
      }
    }
    combined += userNotes
    const { text, maskedCount: mc } = maskSensitive(combined)
    return { estimatedChars: text.length, maskedCount: mc }
  }, [usingCleanEpisodes, visibleCleanEpisodes, visibleEpisodes, selectedEpisodeIds, userNotes])

  function fallbackEvidenceFromEpisode(ep: Episode): EvidenceRef[] {
    return [{
      segmentId: ep.segmentIds[0] ?? ep.id,
      quote: ep.oneLineSummary || ep.title,
      reason: '原始启发式 Episode 降级来源'
    }]
  }

  function sourceQualityFromEpisode(ep: Episode): SourceQuality {
    return ep.segmentIds.length > 0 ? 'low' : 'failed'
  }

  const buildReportSnapshot = useCallback((): ReportInputSnapshot => {
    const items: ReportSnapshotItem[] = []
    if (usingCleanEpisodes) {
      for (const ep of visibleCleanEpisodes) {
        if (!selectedEpisodeIds.has(ep.id)) continue
        items.push({
          id: ep.id,
          startTime: ep.startTime,
          endTime: ep.endTime,
          title: ep.title,
          summary: ep.summary,
          project: ep.project,
          topics: ep.topics,
          entities: ep.entities,
          evidenceRefs: ep.evidenceRefs,
          segmentIds: ep.segmentIds,
          sourceQuality: ep.sourceQuality,
          confidence: ep.confidence
        })
      }
    } else {
      for (const ep of visibleEpisodes) {
        if (!selectedEpisodeIds.has(ep.id)) continue
        items.push({
          id: ep.id,
          startTime: ep.startTime,
          endTime: ep.endTime,
          title: ep.title,
          summary: ep.oneLineSummary,
          project: ep.entities.find((e) => e.type === 'project')?.name ?? '',
          topics: ep.topics.filter((t) => !t.startsWith('__')),
          entities: ep.entities,
          evidenceRefs: fallbackEvidenceFromEpisode(ep),
          segmentIds: ep.segmentIds,
          sourceQuality: sourceQualityFromEpisode(ep),
          confidence: 0.35
        })
      }
    }
    return {
      date: selectedDate,
      templateId,
      userNotes,
      createdAt: new Date().toISOString(),
      sourceType: usingCleanEpisodes ? 'clean_episodes' : 'raw_fallback',
      items,
      segmentIds: [...new Set(items.flatMap((item) => item.segmentIds))],
      cleanEpisodeIds: usingCleanEpisodes ? items.map((item) => item.id) : [],
      maskedCount
    }
  }, [usingCleanEpisodes, visibleCleanEpisodes, visibleEpisodes, selectedEpisodeIds, selectedDate, templateId, userNotes, maskedCount])

  // ===================== Handlers =====================

  const handleOpenConfirm = useCallback((): void => {
    const sourceItems = usingCleanEpisodes ? eligibleCleanEpisodes : eligibleEpisodes
    if (sourceItems.length === 0) {
      toast.warning('无法生成日报', `${selectedDate} 没有可用的工作记忆事件`)
      return
    }
    // 默认勾选所有 reportEligible 的 Episode
    const defaultSelected = new Set<string>(
      usingCleanEpisodes
        ? eligibleCleanEpisodes.map((e) => e.id)
        : eligibleEpisodes.filter((e) => e.reportEligible).map((e) => e.id)
    )
    // 若没有 eligible，则默认勾选全部
    setSelectedEpisodeIds(
      defaultSelected.size > 0 ? defaultSelected : new Set(sourceItems.map((e) => e.id))
    )
    setUserNotes('')
    setGenerateError('')
    setRemovedIds(new Set())
    setExpandedIds(new Set())
    setShowConfirmModal(true)
  }, [eligibleEpisodes, eligibleCleanEpisodes, selectedDate, usingCleanEpisodes])

  useEffect(() => {
    if (!pendingAutoGenerate || loading) return
    setPendingAutoGenerate(false)
    handleOpenConfirm()
  }, [pendingAutoGenerate, loading, handleOpenConfirm])

  const handleToggleEpisode = useCallback((id: string): void => {
    setSelectedEpisodeIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleToggleAll = useCallback((selectAll: boolean): void => {
    if (selectAll) {
      setSelectedEpisodeIds(new Set(visibleEpisodes.map((e) => e.id)))
    } else {
      setSelectedEpisodeIds(new Set())
    }
  }, [visibleEpisodes])

  // C3.1：展开/折叠单条 Episode 预览
  const handleToggleExpand = useCallback((id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // C3.2：移除单条 Episode（隐藏，可恢复），同时取消勾选
  const handleRemoveEpisode = useCallback((id: string): void => {
    setRemovedIds((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
    setSelectedEpisodeIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  // C3.2：恢复所有已移除的 Episode
  const handleRestoreRemoved = useCallback((): void => {
    setRemovedIds(new Set())
  }, [])

  const handleConfirmGenerate = useCallback(async (): Promise<void> => {
    if (selectedEpisodeIds.size === 0) {
      setGenerateError('请至少勾选一个 Episode 片段')
      return
    }
    setGenerating(true)
    setGeneratingMessage('正在整理片段并请求 AI 生成日报，这通常需要几十秒。')
    setGenerateError('')
    try {
      const payload: AiGenerateReportPayload = {
        date: selectedDate,
        templateId,
        episodeIds: Array.from(selectedEpisodeIds),
        notes: userNotes,
        reportInputSnapshot: buildReportSnapshot()
      }
      // AiManager.generateReport 已将结果存入 ReportRepository（status='draft'），
      // 返回结果中含 reportId 和 report 对象，前端直接使用，无需再次 insert。
      const result: AiGenerateReportResult = await window.workmemory.ai.generateReport(payload)
      setDraft(result.report)
      setIsNew(false)
      setShowConfirmModal(false)
      setGeneratingMessage('')
      const warningSuffix = result.warning ? '（含交叉校验警告）' : ''
      toast.success('日报生成成功', `已保存为草稿${warningSuffix}`)
      await loadData()
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
      setGeneratingMessage('')
    }
  }, [selectedEpisodeIds, selectedDate, templateId, userNotes, loadData, buildReportSnapshot])

  const handleLoadHistory = useCallback((report: Report): void => {
    setDraft({ ...report })
    setIsNew(false)
    setSelectedDate(report.date)
    setTemplateId(report.templateId)
    toast.info('已加载日报', report.date)
  }, [])

  const handleSaveDraft = useCallback(async (): Promise<void> => {
    if (!draft.markdownContent.trim()) {
      toast.warning('日报内容为空', '无法保存')
      return
    }
    try {
      if (isNew || !draft.id) {
        const created = await window.workmemory.report.saveDraft(draft)
        setDraft(created)
        setIsNew(false)
        toast.success('草稿已保存')
      } else {
        const updated = await window.workmemory.report.update(draft.id, {
          markdownContent: draft.markdownContent,
          templateId: draft.templateId,
          templateName: draft.templateName
        })
        if (updated) setDraft(updated)
        toast.success('草稿已保存')
      }
      await loadData()
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft, isNew, loadData])

  const handleMarkExported = useCallback(async (): Promise<void> => {
    if (!draft.id || isNew) {
      toast.warning('请先保存草稿')
      return
    }
    try {
      await window.workmemory.report.setStatus(draft.id, 'exported')
      setDraft({ ...draft, status: 'exported' })
      toast.success('已标记为已导出')
      await loadData()
    } catch (e) {
      toast.error('标记失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft, isNew, loadData])

  const handleCopyRichText = useCallback(async (): Promise<void> => {
    if (!draft.markdownContent.trim()) {
      toast.warning('日报内容为空')
      return
    }
    try {
      const html = markdownToRichHtml(draft.markdownContent)
      await window.workmemory.system.writeClipboard({
        text: draft.markdownContent,
        html
      })
      toast.success('已复制富文本到剪贴板')
    } catch (e) {
      toast.error('复制失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft.markdownContent])

  const handleExportMarkdown = useCallback(async (): Promise<void> => {
    if (!draft.markdownContent.trim()) {
      toast.warning('日报内容为空')
      return
    }
    try {
      const content = await window.workmemory.ai.exportMarkdown(draft)
      const filename = `workmemory-daily-${draft.date}.md`
      const saved = await window.workmemory.system.saveFile(filename, content, [
        { name: 'Markdown', extensions: ['md'] }
      ])
      if (saved) toast.success('导出成功', saved)
      else toast.info('已取消导出')
    } catch (e) {
      toast.error('导出失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft])

  const handleExportWord = useCallback(async (): Promise<void> => {
    if (!draft.markdownContent.trim()) {
      toast.warning('日报内容为空')
      return
    }
    try {
      const filePath = await window.workmemory.ai.exportWord({
        markdown: draft.markdownContent,
        title: `工作日报 ${draft.date}`,
        date: draft.date
      })
      if (filePath) {
        toast.success('已导出 Word 文档', filePath)
      }
      // 用户取消时不弹 toast
    } catch (e) {
      toast.error('导出失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft])

  const handleExportJson = useCallback(async (): Promise<void> => {
    if (!draft.markdownContent.trim()) {
      toast.warning('日报内容为空')
      return
    }
    try {
      const content = await window.workmemory.ai.exportJson(draft)
      const filename = `workmemory-daily-${draft.date}.json`
      const saved = await window.workmemory.system.saveFile(filename, content, [
        { name: 'JSON', extensions: ['json'] }
      ])
      if (saved) toast.success('导出成功', saved)
      else toast.info('已取消导出')
    } catch (e) {
      toast.error('导出失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft])

  const handleNewReport = useCallback((): void => {
    setDraft(emptyReport(selectedDate, templateId))
    setIsNew(true)
    setEditorMode('edit')
    toast.info('已新建草稿')
  }, [selectedDate, templateId])

  // ===================== 渲染 =====================

  return (
    <div className="wm-reports">
      {/* 顶部工具栏 */}
      <header className="wm-reports-header">
        <div className="wm-reports-titles">
          <h1 className="wm-reports-title">日报中心</h1>
          <span className="wm-reports-subtitle">Daily Report Center</span>
        </div>
        <div className="wm-reports-toolbar">
          <div className="wm-reports-field">
            <span className="wm-reports-field-label">模板</span>
            <Select value={templateId} onValueChange={(v) => setTemplateId(v as ReportTemplate)}>
              <SelectTrigger className="wm-reports-template-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_OPTIONS.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="primary"
            size="md"
            leftIcon={<FileText size={14} />}
            onClick={handleOpenConfirm}
            disabled={eligibleEpisodes.length === 0 && eligibleCleanEpisodes.length === 0}
          >
            生成今日日报
          </Button>
          <Button variant="secondary" size="md" onClick={handleNewReport}>
            新建草稿
          </Button>
        </div>
      </header>

      <div className="wm-reports-body">
        {/* 左侧：编辑区 */}
        <section className="wm-reports-editor-section">
          {/* 编辑器工具栏 */}
          <Card variant="acrylic" padding="sm" className="wm-reports-editor-toolbar">
            <div className="wm-reports-editor-meta">
              <span className="wm-reports-editor-meta-text">
                {draft.id ? `${draft.date} · ${draft.templateName}` : '未保存草稿'}
              </span>
              <Badge variant="accent" size="sm">日报</Badge>
              <Badge variant={STATUS_VARIANT[draft.status]} size="sm">
                {STATUS_LABEL[draft.status]}
              </Badge>
            </div>
            <div className="wm-reports-editor-actions">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Copy size={13} />}
                onClick={() => void handleCopyRichText()}
              >
                复制富文本
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<FileText size={13} />}
                onClick={() => void handleExportWord()}
              >
                导出 Word
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Download size={13} />}
                onClick={() => void handleExportMarkdown()}
              >
                导出 Markdown
              </Button>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Download size={13} />}
                onClick={() => void handleExportJson()}
              >
                JSON
              </Button>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Check size={13} />}
                onClick={() => void handleSaveDraft()}
              >
                保存草稿
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void handleMarkExported()}
                disabled={!draft.id || draft.status === 'exported'}
              >
                标记已导出
              </Button>
            </div>
          </Card>

          {/* 报告日期 + 编辑/预览切换 */}
          <div className="wm-reports-editor-controls">
            <TextField
              label="日报日期"
              type="date"
              size="md"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="wm-reports-date-field"
            />
            <SegmentedControl
              options={EDIT_PREVIEW_OPTIONS}
              value={editorMode}
              onChange={setEditorMode}
              size="md"
            />
          </div>

          {/* 编辑区/预览区 */}
          <Card variant="solid" className="wm-reports-editor-pane">
            {generating ? (
              <div className="wm-reports-generating-state">
                <Loader2 size={18} className="wm-reports-loading-spinner" />
                <div className="wm-reports-generating-copy">
                  <div className="wm-reports-generating-title">日报生成中</div>
                  <div className="wm-reports-generating-text">
                    {generatingMessage || 'AI 正在生成日报，请稍候...'}
                  </div>
                </div>
              </div>
            ) : editorMode === 'edit' ? (
              <textarea
                className="wm-reports-editor-textarea"
                value={draft.markdownContent}
                onChange={(e) => setDraft({ ...draft, markdownContent: e.target.value })}
                placeholder="日报 Markdown 内容将在此显示... 点击右上角「生成今日日报」由 AI 生成，或直接手动编辑。"
                spellCheck={false}
              />
            ) : (
              <div className="wm-reports-preview-pane wm-scroll">
                {draft.markdownContent.trim()
                  ? (isStructuredReport(draft)
                      ? renderStructuredPreview(draft.markdownContent)
                      : renderMarkdown(draft.markdownContent))
                  : <div className="wm-reports-preview-empty">实时预览将在此显示</div>}
              </div>
            )}
          </Card>
        </section>

        {/* 右侧：历史列表 */}
        <aside className="wm-reports-history wm-scroll">
          <div className="wm-reports-history-header">
            <span className="wm-reports-history-title">日报历史</span>
            <Badge variant="accent" size="sm">{history.length}</Badge>
          </div>
          {loading ? (
            <div className="wm-reports-history-loading">
              <Loader2 size={16} className="wm-reports-loading-spinner" />
              <span>加载中...</span>
            </div>
          ) : history.length === 0 ? (
            <div className="wm-reports-history-empty">
              <p>暂无日报历史</p>
              <p className="wm-reports-history-empty-hint">生成日报后将在此显示</p>
            </div>
          ) : (
            <div className="wm-reports-history-list">
              {history.map((r) => (
                <Card
                  key={r.id}
                  variant="solid"
                  padding="md"
                  selected={draft.id === r.id}
                  onClick={() => handleLoadHistory(r)}
                  className="wm-reports-history-card"
                >
                  <div className="wm-reports-history-card-top">
                    <span className="wm-reports-history-card-date">{r.date}</span>
                    <div className="wm-reports-history-card-badges">
                      <Badge variant="accent" size="sm">日报</Badge>
                      <Badge variant="default" size="sm">{r.templateName}</Badge>
                      <Badge variant={STATUS_VARIANT[r.status]} size="sm">
                        {STATUS_LABEL[r.status]}
                      </Badge>
                    </div>
                  </div>
                  <p className="wm-reports-history-card-preview">{getReportPreview(r.markdownContent)}</p>
                </Card>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* AI 确认 Dialog */}
      <Dialog open={showConfirmModal} onOpenChange={(open) => !generating && setShowConfirmModal(open)}>
        <DialogContent className="wm-reports-dialog">
          <DialogHeader>
            <DialogTitle>确认生成日报</DialogTitle>
            <DialogDescription>
              仅发送勾选片段的文本摘要（标题、一句话总结、应用、OCR 摘要），不含截图。请确认内容无敏感信息。
            </DialogDescription>
          </DialogHeader>

          <div className="wm-reports-dialog-body wm-scroll">
            {/* 安全提示 */}
            <div className="wm-reports-dialog-notice">
              <Shield size={14} />
              <span>
                将发送约 <strong>{estimatedChars}</strong> 字符
                {maskedCount > 0 && <>（已脱敏 <strong>{maskedCount}</strong> 处）</>}
                {' '}到 <strong>{modelName || '未配置'}</strong> 模型。
              </span>
            </div>

            {/* 元信息 */}
            <div className="wm-reports-dialog-meta">
              <div className="wm-reports-dialog-meta-item">
                <span className="wm-reports-dialog-meta-label">日期</span>
                <span className="wm-reports-dialog-meta-value">{selectedDate}</span>
              </div>
              <div className="wm-reports-dialog-meta-item">
                <span className="wm-reports-dialog-meta-label">模板</span>
                <Select value={templateId} onValueChange={(v) => setTemplateId(v as ReportTemplate)}>
                  <SelectTrigger className="wm-reports-dialog-template-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_OPTIONS.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Episode 勾选列表 */}
            <div className="wm-reports-dialog-section">
              <div className="wm-reports-dialog-section-header">
                <span className="wm-reports-dialog-section-title">
                  勾选今日{usingCleanEpisodes ? '工作记忆事件' : '原始片段'}（{selectedEpisodeIds.size}/{usingCleanEpisodes ? visibleCleanEpisodes.length : visibleEpisodes.length}）
                </span>
                <div className="wm-reports-dialog-section-actions">
                  {removedIds.size > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleRestoreRemoved}
                      disabled={generating}
                    >
                      恢复已移除（{removedIds.size}）
                    </Button>
                  )}
                  <label className="wm-reports-dialog-checkall">
                    <input
                      type="checkbox"
                      checked={selectedEpisodeIds.size === (usingCleanEpisodes ? visibleCleanEpisodes.length : visibleEpisodes.length) && (usingCleanEpisodes ? visibleCleanEpisodes.length : visibleEpisodes.length) > 0}
                      onChange={(e) => {
                        if (usingCleanEpisodes) {
                          setSelectedEpisodeIds(e.target.checked ? new Set(visibleCleanEpisodes.map((ep) => ep.id)) : new Set())
                        } else {
                          handleToggleAll(e.target.checked)
                        }
                      }}
                      disabled={generating}
                    />
                    <span>全选</span>
                  </label>
                </div>
              </div>
              <div className="wm-reports-dialog-episode-list wm-scroll">
                {(usingCleanEpisodes ? visibleCleanEpisodes.length : visibleEpisodes.length) === 0 ? (
                  <div className="wm-reports-dialog-episode-empty">
                    {removedIds.size > 0 ? '已移除全部，点击「恢复已移除」还原' : '无可勾选片段'}
                  </div>
                ) : usingCleanEpisodes ? (
                  visibleCleanEpisodes.map((ep) => {
                    const isExpanded = expandedIds.has(ep.id)
                    return (
                      <div
                        key={ep.id}
                        className={`wm-reports-dialog-episode-item ${selectedEpisodeIds.has(ep.id) ? 'wm-reports-dialog-episode-item-checked' : ''} ${isExpanded ? 'wm-reports-dialog-episode-item-expanded' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedEpisodeIds.has(ep.id)}
                          onChange={() => handleToggleEpisode(ep.id)}
                          disabled={generating}
                        />
                        <button
                          type="button"
                          className="wm-reports-dialog-episode-chevron"
                          onClick={() => handleToggleExpand(ep.id)}
                          aria-label={isExpanded ? '折叠预览' : '展开预览'}
                        >
                          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                        <div className="wm-reports-dialog-episode-info">
                          <div className="wm-reports-dialog-episode-row">
                            <span className="wm-reports-dialog-episode-time">{ep.startTime} - {ep.endTime}</span>
                            <span className="wm-reports-dialog-episode-title">{ep.title}</span>
                          </div>
                          <p className="wm-reports-dialog-episode-summary">{ep.summary}</p>
                          {isExpanded && (
                            <div className="wm-reports-dialog-episode-preview wm-scroll">
                              <div className="wm-reports-dialog-episode-preview-row">
                                <span className="wm-reports-dialog-episode-preview-label">项目</span>
                                <span className="wm-reports-dialog-episode-preview-value">{ep.project || '（无）'}</span>
                              </div>
                              <div className="wm-reports-dialog-episode-preview-row">
                                <span className="wm-reports-dialog-episode-preview-label">证据</span>
                                <span className="wm-reports-dialog-episode-preview-value">
                                  {ep.evidenceRefs.map((ev) => ev.quote).join('；') || '（无）'}
                                </span>
                              </div>
                              {ep.topics.length > 0 && (
                                <div className="wm-reports-dialog-episode-preview-row">
                                  <span className="wm-reports-dialog-episode-preview-label">标签</span>
                                  <span className="wm-reports-dialog-episode-preview-value">
                                    {ep.topics.join('、')}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <IconButton
                          label="移除该事件"
                          size="sm"
                          variant="ghost"
                          icon={<Trash2 size={13} />}
                          onClick={() => handleRemoveEpisode(ep.id)}
                          disabled={generating}
                          className="wm-reports-dialog-episode-trash"
                        />
                      </div>
                    )
                  })
                ) : (
                  visibleEpisodes.map((ep) => {
                    const isExpanded = expandedIds.has(ep.id)
                    return (
                      <div
                        key={ep.id}
                        className={`wm-reports-dialog-episode-item ${selectedEpisodeIds.has(ep.id) ? 'wm-reports-dialog-episode-item-checked' : ''} ${isExpanded ? 'wm-reports-dialog-episode-item-expanded' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedEpisodeIds.has(ep.id)}
                          onChange={() => handleToggleEpisode(ep.id)}
                          disabled={generating}
                        />
                        <button
                          type="button"
                          className="wm-reports-dialog-episode-chevron"
                          onClick={() => handleToggleExpand(ep.id)}
                          aria-label={isExpanded ? '折叠预览' : '展开预览'}
                        >
                          {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                        <div className="wm-reports-dialog-episode-info">
                          <div className="wm-reports-dialog-episode-row">
                            <span className="wm-reports-dialog-episode-time">{ep.startTime} - {ep.endTime}</span>
                            <span className="wm-reports-dialog-episode-title">{ep.title}</span>
                          </div>
                          {ep.oneLineSummary && (
                            <p className="wm-reports-dialog-episode-summary">{ep.oneLineSummary}</p>
                          )}
                          {isExpanded && (
                            <div className="wm-reports-dialog-episode-preview wm-scroll">
                              <div className="wm-reports-dialog-episode-preview-row">
                                <span className="wm-reports-dialog-episode-preview-label">标题</span>
                                <span className="wm-reports-dialog-episode-preview-value">{ep.title}</span>
                              </div>
                              <div className="wm-reports-dialog-episode-preview-row">
                                <span className="wm-reports-dialog-episode-preview-label">总结</span>
                                <span className="wm-reports-dialog-episode-preview-value">{ep.oneLineSummary || '（无）'}</span>
                              </div>
                              {ep.entities.length > 0 && (
                                <div className="wm-reports-dialog-episode-preview-row">
                                  <span className="wm-reports-dialog-episode-preview-label">实体</span>
                                  <span className="wm-reports-dialog-episode-preview-value">
                                    {ep.entities.map((e) => e.name).join('、')}
                                  </span>
                                </div>
                              )}
                              {ep.topics.length > 0 && (
                                <div className="wm-reports-dialog-episode-preview-row">
                                  <span className="wm-reports-dialog-episode-preview-label">标签</span>
                                  <span className="wm-reports-dialog-episode-preview-value">
                                    {ep.topics.join('、')}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <IconButton
                          label="移除该片段"
                          size="sm"
                          variant="ghost"
                          icon={<Trash2 size={13} />}
                          onClick={() => handleRemoveEpisode(ep.id)}
                          disabled={generating}
                          className="wm-reports-dialog-episode-trash"
                        />
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            {/* 用户备注 */}
            <div className="wm-reports-dialog-section">
              <label className="wm-reports-dialog-section-title">
                用户备注（可选，特殊要求优先满足）
              </label>
              <textarea
                className="wm-reports-dialog-notes"
                value={userNotes}
                onChange={(e) => setUserNotes(e.target.value)}
                placeholder="例如：突出某项目进展、补充明日计划、强调协作贡献..."
                rows={3}
                disabled={generating}
              />
            </div>

            {generateError && (
              <div className="wm-reports-dialog-error">
                <AlertCircle size={13} />
                <span>{generateError}</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              size="md"
              onClick={() => setShowConfirmModal(false)}
              disabled={generating}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              loading={generating}
              onClick={() => void handleConfirmGenerate()}
              disabled={selectedEpisodeIds.size === 0}
            >
              确认生成日报
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
