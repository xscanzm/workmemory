/**
 * Task 6.5：知识库 (Wiki) 页
 * - 左侧目录栏：按 type 分类，点击切换，顶部"新建 Wiki 页"按钮
 * - 中间编辑器：标题 + 别名 + 结构区块（一句话/进展/关键事实/待确认）+ Markdown 正文 + [[wikilink]] 双链 + 来源 + 审核状态
 * - 右侧 Review Queue 面板：卡片预览/确认/忽略
 * - 操作：保存（update）、删除（delete）、新建（insert）
 * 已迁移到统一 UI 组件库（Button/Card/Badge/Select/Dialog/Toast + lucide 图标）。
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useRecordingStore } from '../store/recordingStore'
import { renderMarkdown, parseWikiLinks } from '../utils/markdown'
import type { WikiPage, WikiType } from '@/types'
import {
  Button,
  Card,
  Badge,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  toast,
  User,
  Folder,
  Lightbulb,
  Scale,
  Calendar,
  AlertTriangle,
  Users,
  Plus,
  X,
  Eye,
  Check,
  Trash2
} from '@/ui'
import './Wiki.css'

// ===================== 类型与常量 =====================

const WIKI_TYPES: Array<{ type: WikiType; label: string; icon: React.ReactNode }> = [
  { type: 'person', label: '人', icon: <User size={14} /> },
  { type: 'project', label: '项目', icon: <Folder size={14} /> },
  { type: 'customer', label: '客户', icon: <Users size={14} /> },
  { type: 'topic', label: '需求', icon: <Lightbulb size={14} /> },
  { type: 'decision', label: '决策', icon: <Scale size={14} /> },
  { type: 'meeting', label: '会议', icon: <Calendar size={14} /> },
  { type: 'issue', label: '问题', icon: <AlertTriangle size={14} /> }
]

const SECTION_SUMMARY = '## 一句话总结'
const SECTION_PROGRESS = '## 当前进展'
const SECTION_FACTS = '## 关键事实'
const SECTION_PENDING = '## 待确认'
const SECTION_BODY = '## 正文'
const SECTION_SOURCES = '## 来源片段'

interface WikiContentParts {
  summary: string
  progress: string
  keyFacts: string[]
  pendingQuestions: string[]
  body: string
  /** 来源片段（"为什么建议保存"的证据） */
  sources: string[]
}

// ===================== 内容解析/组合 =====================

function parseWikiContent(content: string): WikiContentParts {
  const parts: WikiContentParts = {
    summary: '',
    progress: '',
    keyFacts: [],
    pendingQuestions: [],
    body: '',
    sources: []
  }
  if (!content) return parts

  const lines = content.split('\n')
  let currentSection = ''
  const sectionBuffers: Record<string, string[]> = {
    summary: [],
    progress: [],
    facts: [],
    pending: [],
    body: [],
    sources: []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === SECTION_SUMMARY) {
      currentSection = 'summary'
    } else if (trimmed === SECTION_PROGRESS) {
      currentSection = 'progress'
    } else if (trimmed === SECTION_FACTS) {
      currentSection = 'facts'
    } else if (trimmed === SECTION_PENDING) {
      currentSection = 'pending'
    } else if (trimmed === SECTION_BODY) {
      currentSection = 'body'
    } else if (trimmed === SECTION_SOURCES) {
      currentSection = 'sources'
    } else if (currentSection) {
      sectionBuffers[currentSection].push(line)
    } else {
      sectionBuffers.body.push(line)
    }
  }

  parts.summary = sectionBuffers.summary.join('\n').trim()
  parts.progress = sectionBuffers.progress.join('\n').trim()
  parts.keyFacts = sectionBuffers.facts
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*]\s+/, ''))
  parts.pendingQuestions = sectionBuffers.pending
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*]\s+/, ''))
  parts.sources = sectionBuffers.sources
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*]\s+/, ''))
  parts.body = sectionBuffers.body.join('\n').trim()
  return parts
}

function composeWikiContent(parts: WikiContentParts): string {
  const sections: string[] = []
  sections.push(`${SECTION_SUMMARY}\n${parts.summary || '（待填写）'}`)
  sections.push(`${SECTION_PROGRESS}\n${parts.progress || '（待填写）'}`)
  const factsStr = parts.keyFacts.length > 0 ? parts.keyFacts.map((f) => `- ${f}`).join('\n') : '- （暂无）'
  sections.push(`${SECTION_FACTS}\n${factsStr}`)
  const pendingStr =
    parts.pendingQuestions.length > 0
      ? parts.pendingQuestions.map((q) => `- ${q}`).join('\n')
      : '- （暂无）'
  sections.push(`${SECTION_PENDING}\n${pendingStr}`)
  if (parts.body) {
    sections.push(`${SECTION_BODY}\n${parts.body}`)
  }
  return sections.join('\n\n')
}

function emptyWikiPage(): WikiPage {
  const ts = new Date().toISOString()
  return {
    id: '',
    type: 'topic',
    title: '',
    aliases: [],
    content: composeWikiContent({
      summary: '',
      progress: '',
      keyFacts: [],
      pendingQuestions: [],
      body: '',
      sources: []
    }),
    sources: [],
    backlinks: [],
    confidence: 1,
    reviewStatus: 'reviewed',
    createdAt: ts,
    updatedAt: ts
  }
}

// ===================== 主组件 =====================

export function Wiki(): JSX.Element {
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)

  const [allPages, setAllPages] = useState<WikiPage[]>([])
  const [reviewQueue, setReviewQueue] = useState<WikiPage[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(true)
  const [previewModal, setPreviewModal] = useState<WikiPage | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState<boolean>(false)

  // 编辑中的页面（本地草稿）
  const [draft, setDraft] = useState<WikiPage>(emptyWikiPage())
  const [isNew, setIsNew] = useState<boolean>(false)

  // 加载数据
  const loadData = useCallback(async (): Promise<void> => {
    try {
      const [pages, queue] = await Promise.all([
        window.workmemory.wiki.getAll(),
        window.workmemory.wiki.getReviewQueue()
      ])
      setAllPages(pages)
      setReviewQueue(queue)
    } catch (e) {
      console.error('[Wiki] 加载数据失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData, refreshTrigger])

  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // 按类型分组
  const pagesByType = useMemo<Record<string, WikiPage[]>>(() => {
    const map: Record<string, WikiPage[]> = {}
    for (const page of allPages) {
      if (page.reviewStatus === 'needs_review') continue
      if (!map[page.type]) map[page.type] = []
      map[page.type].push(page)
    }
    return map
  }, [allPages])

  // 选中页面时加载到编辑器
  useEffect(() => {
    if (selectedId) {
      const page = allPages.find((p) => p.id === selectedId)
      if (page) {
        setDraft({ ...page })
        setIsNew(false)
      }
    }
  }, [selectedId, allPages])

  // ===================== Handlers =====================

  const handleNew = useCallback((): void => {
    const newPage = emptyWikiPage()
    setDraft(newPage)
    setSelectedId(null)
    setIsNew(true)
  }, [])

  const handleSelect = useCallback((page: WikiPage): void => {
    setSelectedId(page.id)
  }, [])

  const handleSave = useCallback(async (): Promise<void> => {
    if (!draft.title.trim()) {
      toast.warning('请填写标题')
      return
    }
    try {
      if (isNew) {
        const created = await window.workmemory.wiki.insert(draft)
        setSelectedId(created.id)
        setIsNew(false)
        toast.success('已创建')
      } else {
        await window.workmemory.wiki.update(draft.id, draft)
        // 更新反链
        await window.workmemory.wiki.updateBacklinks(draft.id)
        toast.success('已保存')
      }
      await loadData()
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft, isNew, loadData])

  const handleDeleteClick = useCallback((): void => {
    if (isNew || !draft.id) {
      handleNew()
      return
    }
    setConfirmDeleteOpen(true)
  }, [draft, isNew, handleNew])

  const handleDeleteConfirm = useCallback(async (): Promise<void> => {
    setConfirmDeleteOpen(false)
    if (!draft.id) return
    try {
      await window.workmemory.wiki.delete(draft.id)
      handleNew()
      await loadData()
      toast.success('已删除')
    } catch (e) {
      toast.error('删除失败', e instanceof Error ? e.message : String(e))
    }
  }, [draft, handleNew, loadData])

  const handleConfirmReview = useCallback(
    async (id: string): Promise<void> => {
      await window.workmemory.wiki.confirmReview(id)
      await loadData()
    },
    [loadData]
  )

  const handleRejectReview = useCallback(
    async (id: string): Promise<void> => {
      await window.workmemory.wiki.rejectReview(id)
      await loadData()
    },
    [loadData]
  )

  const handleWikiLinkClick = useCallback(
    (title: string): void => {
      const target = allPages.find(
        (p) => p.title.toLowerCase() === title.toLowerCase() && p.reviewStatus === 'reviewed'
      )
      if (target) {
        setSelectedId(target.id)
      } else {
        toast.warning('未找到 Wiki 页', `「${title}」不存在，可新建后创建双链`)
      }
    },
    [allPages]
  )

  // ===================== 渲染 =====================

  return (
    <div className="wm-wiki">
      {/* 左侧目录栏 */}
      <aside className="wm-wiki-sidebar wm-scroll">
        <Button variant="primary" size="sm" fullWidth onClick={handleNew} leftIcon={<Plus size={14} />}>
          新建 Wiki 页
        </Button>
        <div className="wm-wiki-dir">
          {WIKI_TYPES.map(({ type, label, icon }) => {
            const pages = pagesByType[type] ?? []
            return (
              <div key={type} className="wm-wiki-dir-group">
                <div className="wm-wiki-dir-header">
                  <span className="wm-wiki-dir-icon">{icon}</span>
                  <span className="wm-wiki-dir-label">{label}</span>
                  <Badge variant="default" size="sm">{pages.length}</Badge>
                </div>
                {pages.length > 0 && (
                  <ul className="wm-wiki-dir-list">
                    {pages.map((page) => (
                      <li
                        key={page.id}
                        className={`wm-wiki-dir-item ${selectedId === page.id ? 'wm-wiki-dir-item-active' : ''}`}
                        onClick={() => handleSelect(page)}
                        title={page.title}
                      >
                        {page.title}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
          {allPages.length === 0 && !loading && (
            <p className="wm-wiki-dir-empty">暂无 Wiki 页，点击上方按钮新建</p>
          )}
        </div>
      </aside>

      {/* 中间编辑器 */}
      <section className="wm-wiki-editor wm-scroll">
        <WikiEditor
          draft={draft}
          isNew={isNew}
          allPages={allPages}
          onChange={setDraft}
          onSave={() => void handleSave()}
          onDelete={handleDeleteClick}
          onWikiLinkClick={handleWikiLinkClick}
        />
      </section>

      {/* 右侧 Review Queue */}
      <aside className="wm-wiki-review wm-scroll">
        <div className="wm-wiki-review-header">
          <span className="wm-wiki-review-title">审核队列</span>
          <Badge variant="warning" size="sm">{reviewQueue.length}</Badge>
        </div>
        {reviewQueue.length === 0 ? (
          <div className="wm-wiki-review-empty">
            <p>暂无待审核的 Wiki 候选页</p>
            <p className="wm-wiki-review-empty-hint">在今日页将 Episode 保存到 Wiki 后，将在此审核</p>
          </div>
        ) : (
          <div className="wm-wiki-review-list">
            {reviewQueue.map((item) => (
              <ReviewCard
                key={item.id}
                page={item}
                onPreview={() => setPreviewModal(item)}
                onConfirm={() => void handleConfirmReview(item.id)}
                onReject={() => void handleRejectReview(item.id)}
              />
            ))}
          </div>
        )}
      </aside>

      {/* 预览模态 */}
      <Dialog open={!!previewModal} onOpenChange={(open) => !open && setPreviewModal(null)}>
        <DialogContent className="wm-wiki-preview-dialog">
          {previewModal && (
            <>
              <DialogHeader>
                <DialogTitle>{previewModal.title}</DialogTitle>
                <DialogDescription>Wiki 页内容预览</DialogDescription>
              </DialogHeader>
              <div className="wm-wiki-modal-body wm-scroll">
                {renderMarkdown(previewModal.content, (title) => {
                  handleWikiLinkClick(title)
                  setPreviewModal(null)
                })}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent className="wm-wiki-confirm-dialog">
          <DialogHeader>
            <DialogTitle>确认删除 Wiki 页</DialogTitle>
            <DialogDescription>
              确定删除「{draft.title}」吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">取消</Button>
            </DialogClose>
            <Button variant="danger" size="sm" onClick={() => void handleDeleteConfirm()} leftIcon={<Trash2 size={12} />}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}

// ===================== Wiki 编辑器 =====================

interface WikiEditorProps {
  draft: WikiPage
  isNew: boolean
  allPages: WikiPage[]
  onChange: (page: WikiPage) => void
  onSave: () => void
  onDelete: () => void
  onWikiLinkClick: (title: string) => void
}

function WikiEditor(props: WikiEditorProps): JSX.Element {
  const { draft, isNew, allPages, onChange, onSave, onDelete, onWikiLinkClick } = props
  const [showPreview, setShowPreview] = useState<boolean>(false)
  const [aliasInput, setAliasInput] = useState<string>('')
  const [linkAutocomplete, setLinkAutocomplete] = useState<{ active: boolean; query: string; index: number }>({
    active: false,
    query: '',
    index: 0
  })
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const contentParts = useMemo(() => parseWikiContent(draft.content), [draft.content])
  const outgoingLinks = useMemo(() => parseWikiLinks(draft.content), [draft.content])

  // 更新结构区块
  const updateParts = useCallback(
    (partial: Partial<WikiContentParts>): void => {
      const next = { ...contentParts, ...partial }
      onChange({ ...draft, content: composeWikiContent(next) })
    },
    [contentParts, draft, onChange]
  )

  // 别名管理
  const handleAddAlias = useCallback((): void => {
    const val = aliasInput.trim()
    if (!val || draft.aliases.includes(val)) return
    onChange({ ...draft, aliases: [...draft.aliases, val] })
    setAliasInput('')
  }, [aliasInput, draft, onChange])

  const handleRemoveAlias = useCallback(
    (alias: string): void => {
      onChange({ ...draft, aliases: draft.aliases.filter((a) => a !== alias) })
    },
    [draft, onChange]
  )

  // 关键事实管理
  const handleAddFact = useCallback((): void => {
    updateParts({ keyFacts: [...contentParts.keyFacts, ''] })
  }, [contentParts.keyFacts, updateParts])

  const handleUpdateFact = useCallback(
    (idx: number, value: string): void => {
      const facts = [...contentParts.keyFacts]
      facts[idx] = value
      updateParts({ keyFacts: facts })
    },
    [contentParts.keyFacts, updateParts]
  )

  const handleRemoveFact = useCallback(
    (idx: number): void => {
      updateParts({ keyFacts: contentParts.keyFacts.filter((_, i) => i !== idx) })
    },
    [contentParts.keyFacts, updateParts]
  )

  // 待确认管理
  const handleAddQuestion = useCallback((): void => {
    updateParts({ pendingQuestions: [...contentParts.pendingQuestions, ''] })
  }, [contentParts.pendingQuestions, updateParts])

  const handleUpdateQuestion = useCallback(
    (idx: number, value: string): void => {
      const qs = [...contentParts.pendingQuestions]
      qs[idx] = value
      updateParts({ pendingQuestions: qs })
    },
    [contentParts.pendingQuestions, updateParts]
  )

  const handleRemoveQuestion = useCallback(
    (idx: number): void => {
      updateParts({ pendingQuestions: contentParts.pendingQuestions.filter((_, i) => i !== idx) })
    },
    [contentParts.pendingQuestions, updateParts]
  )

  // [[wikilink]] 自动补全
  const filteredTitles = useMemo(() => {
    if (!linkAutocomplete.active) return []
    const query = linkAutocomplete.query.toLowerCase()
    return allPages
      .filter((p) => p.reviewStatus === 'reviewed')
      .map((p) => p.title)
      .filter((t) => t.toLowerCase().includes(query))
      .slice(0, 8)
  }, [allPages, linkAutocomplete])

  const detectWikiLinkTrigger = useCallback(
    (textarea: HTMLTextAreaElement): void => {
      const cursor = textarea.selectionStart
      const before = textarea.value.slice(0, cursor)
      // 查找最后一个未闭合的 [[
      const lastOpen = before.lastIndexOf('[[')
      if (lastOpen === -1) {
        setLinkAutocomplete({ active: false, query: '', index: 0 })
        return
      }
      const afterOpen = before.slice(lastOpen + 2)
      // 如果已闭合则不触发
      if (afterOpen.includes(']]')) {
        setLinkAutocomplete({ active: false, query: '', index: 0 })
        return
      }
      setLinkAutocomplete({ active: true, query: afterOpen, index: 0 })
    },
    []
  )

  const insertWikiLink = useCallback(
    (title: string): void => {
      const textarea = bodyRef.current
      if (!textarea) return
      const cursor = textarea.selectionStart
      const before = textarea.value.slice(0, cursor)
      const after = textarea.value.slice(cursor)
      const lastOpen = before.lastIndexOf('[[')
      if (lastOpen === -1) return
      const newContent = before.slice(0, lastOpen) + `[[${title}]]` + after
      onChange({ ...draft, content: newContent })
      setLinkAutocomplete({ active: false, query: '', index: 0 })
      // 恢复焦点
      requestAnimationFrame(() => {
        const newPos = lastOpen + title.length + 4
        textarea.focus()
        textarea.setSelectionRange(newPos, newPos)
      })
    },
    [draft, onChange]
  )

  const handleBodyKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (linkAutocomplete.active && filteredTitles.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setLinkAutocomplete((s) => ({ ...s, index: (s.index + 1) % filteredTitles.length }))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setLinkAutocomplete((s) => ({ ...s, index: (s.index - 1 + filteredTitles.length) % filteredTitles.length }))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          insertWikiLink(filteredTitles[linkAutocomplete.index])
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setLinkAutocomplete({ active: false, query: '', index: 0 })
          return
        }
      }
      // Ctrl/Cmd + S 保存
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        onSave()
      }
    },
    [linkAutocomplete, filteredTitles, insertWikiLink, onSave]
  )

  return (
    <div className="wm-wiki-edit">
      {/* 工具栏 */}
      <div className="wm-wiki-edit-toolbar">
        <div className="wm-wiki-edit-toolbar-left">
          <Select
            value={draft.type}
            onValueChange={(v) => onChange({ ...draft, type: v as WikiType })}
          >
            <SelectTrigger className="wm-wiki-type-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WIKI_TYPES.map((t) => (
                <SelectItem key={t.type} value={t.type}>
                  <span className="wm-wiki-type-option">
                    {t.icon}
                    {t.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Badge variant={draft.reviewStatus === 'reviewed' ? 'success' : 'warning'} size="sm">
            {draft.reviewStatus === 'needs_review' ? '待审核' : '已审核'}
          </Badge>
        </div>
        <div className="wm-wiki-edit-toolbar-right">
          <Button variant="primary" size="sm" onClick={onSave}>
            {isNew ? '创建' : '保存'}
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete} leftIcon={<Trash2 size={12} />}>
            {isNew ? '清空' : '删除'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? '编辑' : '预览'}
          </Button>
        </div>
      </div>

      {/* 标题 */}
      <input
        className="wm-wiki-title-input"
        value={draft.title}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
        placeholder="输入 Wiki 页标题..."
      />

      {/* 别名 */}
      <div className="wm-wiki-aliases">
        <span className="wm-wiki-field-label">别名</span>
        <div className="wm-wiki-alias-tags">
          {draft.aliases.map((alias) => (
            <Badge key={alias} variant="cyan" size="sm" className="wm-wiki-alias-tag">
              {alias}
              <button className="wm-wiki-alias-remove" onClick={() => handleRemoveAlias(alias)} aria-label={`移除别名 ${alias}`}>
                <X size={10} />
              </button>
            </Badge>
          ))}
          <input
            className="wm-wiki-alias-input"
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddAlias()
              }
            }}
            placeholder="添加别名后回车"
          />
        </div>
      </div>

      {showPreview ? (
        /* 预览模式 */
        <Card variant="acrylic" padding="md" className="wm-wiki-preview">
          {renderMarkdown(draft.content, onWikiLinkClick)}
        </Card>
      ) : (
        /* 编辑模式 */
        <div className="wm-wiki-edit-body">
          {/* 一句话总结 */}
          <WikiField label="一句话总结">
            <textarea
              className="wm-wiki-field-textarea wm-wiki-field-oneline"
              value={contentParts.summary}
              onChange={(e) => updateParts({ summary: e.target.value })}
              placeholder="用一句话概括此页核心..."
              rows={2}
            />
          </WikiField>

          {/* 当前进展 */}
          <WikiField label="当前进展">
            <textarea
              className="wm-wiki-field-textarea"
              value={contentParts.progress}
              onChange={(e) => updateParts({ progress: e.target.value })}
              placeholder="描述当前进展状态..."
              rows={3}
            />
          </WikiField>

          {/* 关键事实 */}
          <WikiField label="关键事实">
            <div className="wm-wiki-list-editor">
              {contentParts.keyFacts.map((fact, idx) => (
                <div key={idx} className="wm-wiki-list-item">
                  <span className="wm-wiki-list-bullet">•</span>
                  <input
                    className="wm-wiki-list-input"
                    value={fact}
                    onChange={(e) => handleUpdateFact(idx, e.target.value)}
                    placeholder="输入关键事实..."
                  />
                  <button className="wm-wiki-list-remove" onClick={() => handleRemoveFact(idx)} aria-label="移除关键事实">
                    <X size={12} />
                  </button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={handleAddFact} leftIcon={<Plus size={12} />}>
                添加关键事实
              </Button>
            </div>
          </WikiField>

          {/* 待确认 */}
          <WikiField label="待确认">
            <div className="wm-wiki-list-editor">
              {contentParts.pendingQuestions.map((q, idx) => (
                <div key={idx} className="wm-wiki-list-item">
                  <span className="wm-wiki-list-bullet">?</span>
                  <input
                    className="wm-wiki-list-input"
                    value={q}
                    onChange={(e) => handleUpdateQuestion(idx, e.target.value)}
                    placeholder="输入待确认问题..."
                  />
                  <button className="wm-wiki-list-remove" onClick={() => handleRemoveQuestion(idx)} aria-label="移除待确认">
                    <X size={12} />
                  </button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={handleAddQuestion} leftIcon={<Plus size={12} />}>
                添加待确认
              </Button>
            </div>
          </WikiField>

          {/* 正文 Markdown 编辑器 */}
          <WikiField label="正文（Markdown，支持 [[双链]]）">
            <div className="wm-wiki-body-editor-wrap">
              <textarea
                ref={bodyRef}
                className="wm-wiki-body-textarea"
                value={contentParts.body}
                onChange={(e) => {
                  updateParts({ body: e.target.value })
                  detectWikiLinkTrigger(e.target)
                }}
                onKeyDown={handleBodyKeyDown}
                onBlur={() => setTimeout(() => setLinkAutocomplete({ active: false, query: '', index: 0 }), 200)}
                placeholder="输入 Markdown 正文... 输入 [[ 触发双链补全"
                rows={10}
              />
              {linkAutocomplete.active && filteredTitles.length > 0 && (
                <div className="wm-wiki-link-popup">
                  {filteredTitles.map((title, i) => (
                    <div
                      key={title}
                      className={`wm-wiki-link-item ${i === linkAutocomplete.index ? 'wm-wiki-link-item-active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        insertWikiLink(title)
                      }}
                      onMouseEnter={() => setLinkAutocomplete((s) => ({ ...s, index: i }))}
                    >
                      {title}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </WikiField>
        </div>
      )}

      {/* 出链与反链 */}
      <div className="wm-wiki-links-section">
        {outgoingLinks.length > 0 && (
          <div className="wm-wiki-link-group">
            <span className="wm-wiki-field-label">出链</span>
            <div className="wm-wiki-link-tags">
              {outgoingLinks.map((link) => (
                <Badge
                  key={link}
                  variant="success"
                  size="sm"
                  className="wm-wiki-link-tag"
                  onClick={() => onWikiLinkClick(link)}
                >
                  {link}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {draft.backlinks.length > 0 && (
          <div className="wm-wiki-link-group">
            <span className="wm-wiki-field-label">反链</span>
            <div className="wm-wiki-link-tags">
              {draft.backlinks.map((link) => (
                <Badge
                  key={link}
                  variant="accent"
                  size="sm"
                  className="wm-wiki-link-tag"
                  onClick={() => onWikiLinkClick(link)}
                >
                  {link}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 来源 */}
      {draft.sources.length > 0 && (
        <div className="wm-wiki-sources">
          <span className="wm-wiki-field-label">来源（Episode / Segment 引用）</span>
          <div className="wm-wiki-source-list">
            {draft.sources.map((src) => (
              <Badge key={src} variant="default" size="sm" className="wm-wiki-source-tag">
                {src.slice(0, 8)}...
              </Badge>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

// ===================== 字段包装 =====================

function WikiField({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="wm-wiki-field">
      <span className="wm-wiki-field-label">{label}</span>
      <div className="wm-wiki-field-content">{children}</div>
    </div>
  )
}

// ===================== Review 卡片 =====================

interface ReviewCardProps {
  page: WikiPage
  onPreview: () => void
  onConfirm: () => void
  onReject: () => void
}

function ReviewCard({ page, onPreview, onConfirm, onReject }: ReviewCardProps): JSX.Element {
  const parts = parseWikiContent(page.content)
  const typeMeta = WIKI_TYPES.find((t) => t.type === page.type)
  const confidencePct = Math.round(page.confidence * 100)
  const isLowConfidence = page.confidence < 0.5
  return (
    <Card variant="acrylic" padding="sm" className="wm-wiki-review-card">
      <p className="wm-wiki-review-card-q">是否将以下内容沉淀为 Wiki 页？</p>
      <div className="wm-wiki-review-card-title">[[{page.title}]]</div>
      <div className="wm-wiki-review-card-meta">
        类型：{typeMeta?.label ?? page.type} · 置信度{' '}
        <span className={isLowConfidence ? 'wm-wiki-review-card-conf-low' : ''}>
          {confidencePct}%
        </span>
        {isLowConfidence && <span className="wm-wiki-review-card-conf-tag">低</span>}
      </div>
      {parts.summary && (
        <p className="wm-wiki-review-card-summary">{parts.summary}</p>
      )}
      {parts.sources.length > 0 && (
        <div className="wm-wiki-review-card-why">
          <span className="wm-wiki-review-card-why-title">为什么建议保存</span>
          <ul className="wm-wiki-review-card-why-list">
            {parts.sources.slice(0, 3).map((src, i) => (
              <li key={i}>{src}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="wm-wiki-review-card-actions">
        <Button variant="ghost" size="sm" onClick={onPreview} leftIcon={<Eye size={12} />}>
          预览
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm} leftIcon={<Check size={12} />}>
          确认
        </Button>
        <Button variant="danger" size="sm" onClick={onReject}>
          忽略
        </Button>
      </div>
    </Card>
  )
}
