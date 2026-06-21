/**
 * Task 6.6：关系图谱 (Graph) 页
 * - 顶部工具栏：日期范围 + 项目筛选 + 节点类型筛选 + 框选导出
 * - 主画布：纯 SVG 力导向图谱（自实现弹簧模型）
 * - 右侧详情面板：选中节点详情 + 关联节点列表
 * - 交互：拖拽节点、点击高亮、滚轮缩放、画布平移、Shift 框选导出
 * - B4.3：节点数上限 100，超过降级为"关系预览"提示
 * - D5.2：布局结果缓存（按筛选条件 hash），相同筛选条件复用已稳定位置，避免重复抖动
 * 已迁移到统一 UI 组件库（Button/Card/Badge/Select/Toast + lucide 图标）。
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useRecordingStore } from '../store/recordingStore'
import { getTodayDate, getThisWeekDates, getThisMonthDates, formatDate, addDays } from '../utils/datetime'
import type { Episode, WorkSegment, WikiPage, Report, EntityRef } from '@/types'
import { filterHighConfidenceEntities } from '@/utils/entity'
import {
  Button,
  Card,
  Badge,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
  Download,
  Loader2,
  AlertCircle
} from '@/ui'
import './Graph.css'

// ===================== 类型定义 =====================

type GraphNodeType = 'person' | 'episode' | 'document' | 'wiki' | 'report'

interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  /** 关联度（边数） */
  degree: number
  /** 原始数据引用 */
  data?: unknown
  x: number
  y: number
  vx: number
  vy: number
  fixed: boolean
}

interface GraphEdge {
  source: string
  target: string
  label: string
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  isPreview: boolean
}

const NODE_COLORS: Record<GraphNodeType, string> = {
  person: '#2b7fff',
  episode: '#22c5d8',
  document: '#22b56a',
  wiki: '#8b5cf6',
  report: '#f5a623'
}

const NODE_LABELS: Record<GraphNodeType, string> = {
  person: '人',
  episode: '事',
  document: '文档',
  wiki: 'Wiki',
  report: '报告'
}

const ALL_NODE_TYPES: GraphNodeType[] = ['person', 'episode', 'document', 'wiki', 'report']

/** B4.3：节点数上限，超过降级为"关系预览" */
const MAX_NODES = 100

// ===================== 力导向布局 =====================

interface ForceParams {
  repulsion: number
  attraction: number
  centerGravity: number
  damping: number
  restLength: number
}

const DEFAULT_FORCE_PARAMS: ForceParams = {
  repulsion: 6000,
  attraction: 0.04,
  centerGravity: 0.008,
  damping: 0.85,
  restLength: 120
}

/** 画布尺寸常量（模块级，避免 useEffect 依赖告警） */
const WIDTH = 800
const HEIGHT = 500
const CENTER_X = WIDTH / 2
const CENTER_Y = HEIGHT / 2

/**
 * D5.2：布局结果缓存（模块级，跨渲染持久化）。
 * key = 筛选条件 hash，value = nodeId → 已稳定坐标。
 * 相同筛选条件复用已稳定位置，跳过力导向动画以避免重复抖动。
 */
const layoutCache = new Map<string, Map<string, { x: number; y: number }>>()

function runForceIteration(
  nodes: GraphNode[],
  edges: GraphEdge[],
  params: ForceParams,
  centerX: number,
  centerY: number
): boolean {
  if (nodes.length === 0) return true
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  // 重置受力
  for (const n of nodes) {
    n.vx *= params.damping
    n.vy *= params.damping
  }

  // 节点斥力
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 1) {
        dist = 1
        dx = Math.random() - 0.5
        dy = Math.random() - 0.5
      }
      const force = params.repulsion / (dist * dist)
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      if (!a.fixed) {
        a.vx -= fx
        a.vy -= fy
      }
      if (!b.fixed) {
        b.vx += fx
        b.vy += fy
      }
    }
  }

  // 边引力（弹簧）
  for (const edge of edges) {
    const a = nodeMap.get(edge.source)
    const b = nodeMap.get(edge.target)
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const force = params.attraction * (dist - params.restLength)
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    if (!a.fixed) {
      a.vx += fx
      a.vy += fy
    }
    if (!b.fixed) {
      b.vx -= fx
      b.vy -= fy
    }
  }

  // 中心引力 + 位置更新
  let totalEnergy = 0
  for (const n of nodes) {
    if (n.fixed) continue
    n.vx += (centerX - n.x) * params.centerGravity
    n.vy += (centerY - n.y) * params.centerGravity
    n.x += n.vx
    n.y += n.vy
    totalEnergy += n.vx * n.vx + n.vy * n.vy
  }

  // 稳定判定：总动能低于阈值
  return totalEnergy < 0.5
}

// ===================== 图数据构建 =====================

function buildGraphData(
  episodes: Episode[],
  segments: WorkSegment[],
  wikiPages: WikiPage[],
  reports: Report[],
  enabledTypes: Set<GraphNodeType>
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>()
  const edgeSet = new Set<string>()
  const edges: GraphEdge[] = []

  const addNode = (id: string, type: GraphNodeType, label: string, data?: unknown): GraphNode => {
    if (!nodeMap.has(id)) {
      const angle = Math.random() * Math.PI * 2
      const radius = 100 + Math.random() * 100
      nodeMap.set(id, {
        id,
        type,
        label,
        degree: 0,
        data,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        fixed: false
      })
    }
    return nodeMap.get(id)!
  }

  const addEdge = (source: string, target: string, label: string): void => {
    const key = source < target ? `${source}|${target}` : `${target}|${source}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push({ source, target, label })
    const s = nodeMap.get(source)
    const t = nodeMap.get(target)
    if (s) s.degree++
    if (t) t.degree++
  }

  const segToEpisode = new Map<string, string>()
  for (const ep of episodes) {
    for (const sid of ep.segmentIds) {
      segToEpisode.set(sid, ep.id)
    }
  }

  // Episode 节点
  if (enabledTypes.has('episode')) {
    for (const ep of episodes) {
      addNode(`episode:${ep.id}`, 'episode', ep.title || '未命名事件', ep)
    }
  }

  // Entity 节点（人/文档）+ Episode↔Entity 边（低置信实体不进入图谱）
  for (const ep of episodes) {
    const highConfidenceEntities = filterHighConfidenceEntities(ep.entities)
    for (const entity of highConfidenceEntities) {
      if (entity.type === 'person' && enabledTypes.has('person')) {
        const nodeId = `person:${entity.name}`
        addNode(nodeId, 'person', entity.name, entity)
        if (enabledTypes.has('episode')) {
          addEdge(`episode:${ep.id}`, nodeId, '涉及')
        }
      } else if (entity.type === 'document' && enabledTypes.has('document')) {
        const nodeId = `document:${entity.name}`
        addNode(nodeId, 'document', entity.name, entity)
        if (enabledTypes.has('episode')) {
          addEdge(`episode:${ep.id}`, nodeId, '引用')
        }
      }
    }
  }

  // Wiki 节点 + Episode↔Wiki 边（sources）+ Wiki↔Wiki 边（backlinks）
  if (enabledTypes.has('wiki')) {
    for (const wp of wikiPages) {
      if (wp.reviewStatus === 'needs_review') continue
      addNode(`wiki:${wp.id}`, 'wiki', wp.title, wp)
      // Episode ↔ Wiki (sources)
      if (enabledTypes.has('episode')) {
        for (const src of wp.sources) {
          if (episodes.some((e) => e.id === src)) {
            addEdge(`wiki:${wp.id}`, `episode:${src}`, '来源')
          }
        }
      }
    }
    // Wiki ↔ Wiki (backlinks)
    for (const wp of wikiPages) {
      if (wp.reviewStatus === 'needs_review') continue
      for (const bl of wp.backlinks) {
        const target = wikiPages.find((p) => p.title === bl && p.reviewStatus === 'reviewed')
        if (target) {
          addEdge(`wiki:${wp.id}`, `wiki:${target.id}`, '反链')
        }
      }
    }
  }

  // Report 节点 + Report↔Episode 边（segmentIds → episode）
  if (enabledTypes.has('report')) {
    for (const rp of reports) {
      addNode(`report:${rp.id}`, 'report', `${rp.date} 日报`, rp)
      if (enabledTypes.has('episode')) {
        const linkedEpisodes = new Set<string>()
        for (const sid of rp.segmentIds) {
          const epId = segToEpisode.get(sid)
          if (epId) linkedEpisodes.add(epId)
        }
        for (const epId of linkedEpisodes) {
          addEdge(`report:${rp.id}`, `episode:${epId}`, '包含')
        }
      }
    }
  }

  return { nodes: Array.from(nodeMap.values()), edges }
}

// ===================== 主组件 =====================

type DateRange = 'today' | 'week' | 'month' | 'custom'

export function Graph(): JSX.Element {
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)
  const triggerRefresh = useRecordingStore((s) => s.triggerRefresh)

  const [dateRange, setDateRange] = useState<DateRange>('week')
  const [customStart, setCustomStart] = useState<string>(getTodayDate())
  const [customEnd, setCustomEnd] = useState<string>(getTodayDate())
  const [projectFilter, setProjectFilter] = useState<string>('')
  const [enabledTypes, setEnabledTypes] = useState<Set<GraphNodeType>>(new Set(ALL_NODE_TYPES))
  const [loading, setLoading] = useState<boolean>(true)

  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [segments, setSegments] = useState<WorkSegment[]>([])
  const [wikiPages, setWikiPages] = useState<WikiPage[]>([])
  const [reports, setReports] = useState<Report[]>([])

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // 计算日期范围
  const dates = useMemo<string[]>(() => {
    if (dateRange === 'today') return [getTodayDate()]
    if (dateRange === 'week') return getThisWeekDates()
    if (dateRange === 'month') return getThisMonthDates()
    // custom
    const result: string[] = []
    let cur = new Date(customStart + 'T00:00:00')
    const end = new Date(customEnd + 'T00:00:00')
    while (cur <= end) {
      result.push(formatDate(cur))
      cur = addDays(cur, 1)
    }
    return result.length > 0 ? result : [getTodayDate()]
  }, [dateRange, customStart, customEnd])

  // 加载数据
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      Promise.all(dates.map((d) => window.workmemory.episode.getByDate(d).catch(() => [] as Episode[]))),
      Promise.all(dates.map((d) => window.workmemory.segment.getActiveByDate(d).catch(() => [] as WorkSegment[]))),
      window.workmemory.wiki.getAll().catch(() => [] as WikiPage[]),
      Promise.all(dates.map((d) => window.workmemory.report.getByDate(d).catch(() => [] as Report[])))
    ])
      .then(([epResults, segResults, wiki, repResults]) => {
        if (cancelled) return
        const eps: Episode[] = []
        for (const list of epResults) for (const e of list) eps.push(e)
        const segs: WorkSegment[] = []
        for (const list of segResults) for (const s of list) segs.push(s)
        const reps: Report[] = []
        for (const list of repResults) for (const r of list) reps.push(r)
        setEpisodes(eps)
        setSegments(segs)
        setWikiPages(wiki)
        setReports(reps)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [dates, refreshTrigger])

  // 项目列表（用于筛选下拉，低置信实体不进入）
  const projectList = useMemo<string[]>(() => {
    const set = new Set<string>()
    for (const ep of episodes) {
      const highConfidenceEntities = filterHighConfidenceEntities(ep.entities)
      for (const e of highConfidenceEntities) {
        if (e.type === 'project') set.add(e.name)
      }
      for (const t of ep.topics) set.add(t)
    }
    return Array.from(set).sort()
  }, [episodes])

  // 构建图数据（含 B4.3 节点上限降级）
  const graphData = useMemo<GraphData>(() => {
    let filteredEpisodes = episodes
    if (projectFilter) {
      filteredEpisodes = episodes.filter(
        (e) =>
          filterHighConfidenceEntities(e.entities).some(
            (en) => en.type === 'project' && en.name === projectFilter
          ) ||
          e.topics.includes(projectFilter)
      )
    }
    const built = buildGraphData(filteredEpisodes, segments, wikiPages, reports, enabledTypes)
    // B4.3：节点数上限 MAX_NODES，超过按关联度排序保留 Top N，降级为"关系预览"
    if (built.nodes.length > MAX_NODES) {
      const keptIds = new Set(
        built.nodes
          .slice()
          .sort((a, b) => b.degree - a.degree)
          .slice(0, MAX_NODES)
          .map((n) => n.id)
      )
      const truncatedNodes = built.nodes.filter((n) => keptIds.has(n.id))
      const truncatedEdges = built.edges.filter(
        (e) => keptIds.has(e.source) && keptIds.has(e.target)
      )
      return { nodes: truncatedNodes, edges: truncatedEdges, isPreview: true }
    }
    return { nodes: built.nodes, edges: built.edges, isPreview: false }
  }, [episodes, segments, wikiPages, reports, enabledTypes, projectFilter])

  // D5.2：布局缓存键（按筛选条件 hash），相同条件复用已稳定的节点位置
  const layoutKey = useMemo<string>(() => {
    const types = [...enabledTypes].sort().join(',')
    return `${dateRange}|${customStart}|${customEnd}|${projectFilter}|${types}|${refreshTrigger}`
  }, [dateRange, customStart, customEnd, projectFilter, enabledTypes, refreshTrigger])

  // 切换节点类型
  const toggleType = useCallback((type: GraphNodeType): void => {
    setEnabledTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }, [])

  // 导出选中节点
  const handleExport = useCallback(async (): Promise<void> => {
    if (selectedNodeIds.size === 0) {
      toast.warning('请先按住 Shift 框选节点')
      return
    }
    const selectedNodes = graphData.nodes.filter((n) => selectedNodeIds.has(n.id))
    const selectedEdges = graphData.edges.filter(
      (e) => selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target)
    )
    const exportData = {
      exportedAt: new Date().toISOString(),
      dateRange: dates,
      nodes: selectedNodes.map((n) => ({ id: n.id, type: n.type, label: n.label, degree: n.degree })),
      edges: selectedEdges.map((e) => ({ source: e.source, target: e.target, label: e.label }))
    }
    const json = JSON.stringify(exportData, null, 2)
    const filename = `workmemory-graph-${getTodayDate()}.json`
    const saved = await window.workmemory.system.saveFile(filename, json, [
      { name: 'JSON', extensions: ['json'] }
    ])
    if (saved) {
      toast.success('已导出', saved)
    } else {
      toast.info('已取消导出')
    }
  }, [selectedNodeIds, graphData, dates])

  return (
    <div className="wm-graph">
      {/* 工具栏 */}
      <Card variant="acrylic" padding="sm" className="wm-graph-toolbar">
        <div className="wm-graph-toolbar-group">
          <label className="wm-graph-toolbar-label">日期范围</label>
          <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
            <SelectTrigger className="wm-graph-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">今日</SelectItem>
              <SelectItem value="week">本周</SelectItem>
              <SelectItem value="month">本月</SelectItem>
              <SelectItem value="custom">自定义</SelectItem>
            </SelectContent>
          </Select>
          {dateRange === 'custom' && (
            <>
              <input type="date" className="wm-graph-date-input" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
              <span className="wm-graph-date-sep">至</span>
              <input type="date" className="wm-graph-date-input" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
            </>
          )}
        </div>
        <div className="wm-graph-toolbar-group">
          <label className="wm-graph-toolbar-label">项目</label>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger className="wm-graph-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">全部</SelectItem>
              {projectList.map((p) => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="wm-graph-toolbar-group">
          <label className="wm-graph-toolbar-label">节点类型</label>
          {ALL_NODE_TYPES.map((t) => (
            <label
              key={t}
              className={`wm-graph-type-chip ${enabledTypes.has(t) ? 'wm-graph-type-chip-active' : ''}`}
              style={{ '--wm-graph-chip-color': NODE_COLORS[t] } as React.CSSProperties}
            >
              <input type="checkbox" checked={enabledTypes.has(t)} onChange={() => toggleType(t)} />
              <span className="wm-graph-type-dot" style={{ background: NODE_COLORS[t] }} />
              {NODE_LABELS[t]}
            </label>
          ))}
        </div>
        <div className="wm-graph-toolbar-group">
          <Button variant="primary" size="sm" onClick={() => void handleExport()} leftIcon={<Download size={12} />}>
            导出选中 ({selectedNodeIds.size})
          </Button>
          {graphData.isPreview && (
            <Badge variant="warning" size="sm" dot>
              关系预览（超过 {MAX_NODES} 节点已降级）
            </Badge>
          )}
        </div>
      </Card>

      {/* 主体：画布 + 详情 */}
      <div className="wm-graph-body">
        <GraphCanvas
          nodes={graphData.nodes}
          edges={graphData.edges}
          loading={loading}
          isPreview={graphData.isPreview}
          layoutKey={layoutKey}
          selectedNodeId={selectedNodeId}
          selectedNodeIds={selectedNodeIds}
          onSelectNode={(id) => setSelectedNodeId(id)}
          onSelectNodes={(ids) => setSelectedNodeIds(ids)}
        />
        <GraphDetailPanel
          nodes={graphData.nodes}
          edges={graphData.edges}
          selectedNodeId={selectedNodeId}
          onSelectNode={(id) => setSelectedNodeId(id)}
          onRefresh={triggerRefresh}
        />
      </div>
    </div>
  )
}

// ===================== 图谱画布 =====================

interface GraphCanvasProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  loading: boolean
  isPreview: boolean
  /** D5.2：布局缓存键，相同键复用已稳定的节点位置 */
  layoutKey: string
  selectedNodeId: string | null
  selectedNodeIds: Set<string>
  onSelectNode: (id: string | null) => void
  onSelectNodes: (ids: Set<string>) => void
}

function GraphCanvas(props: GraphCanvasProps): JSX.Element {
  const { nodes, edges, loading, isPreview, layoutKey, selectedNodeId, selectedNodeIds, onSelectNode, onSelectNodes } = props
  const svgRef = useRef<SVGSVGElement>(null)
  const nodesRef = useRef<GraphNode[]>([])
  const animationRef = useRef<number>(0)
  const [, setTick] = useState<number>(0)

  // 视图变换
  const [scale, setScale] = useState<number>(1)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const scaleRef = useRef<number>(1)

  // 拖拽状态
  const dragState = useRef<{
    mode: 'none' | 'node' | 'pan' | 'box'
    nodeId: string | null
    startX: number
    startY: number
    boxEndX: number
    boxEndY: number
  }>({ mode: 'none', nodeId: null, startX: 0, startY: 0, boxEndX: 0, boxEndY: 0 })

  const [boxSelect, setBoxSelect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)

  // D5.2：初始化节点位置 — 优先从布局缓存复用已稳定的坐标，避免重复抖动
  useEffect(() => {
    const cached = layoutCache.get(layoutKey)
    nodesRef.current = nodes.map((n) => {
      // 1) 优先用同 layoutKey 下已缓存的稳定坐标
      if (cached) {
        const cachedPos = cached.get(n.id)
        if (cachedPos) {
          return { ...n, x: cachedPos.x, y: cachedPos.y, vx: 0, vy: 0, fixed: false }
        }
      }
      // 2) 否则尝试沿用同节点的上一帧位置（防止数据刷新时跳变）
      const existing = nodesRef.current.find((old) => old.id === n.id)
      if (existing) {
        return { ...n, x: existing.x, y: existing.y, vx: existing.vx, vy: existing.vy, fixed: existing.fixed }
      }
      // 3) 新节点：随机初始位置
      return { ...n }
    })
  }, [nodes, layoutKey])

  // 力导向动画
  useEffect(() => {
    if (nodesRef.current.length === 0) return
    // D5.2：若已有该 layoutKey 的缓存坐标，跳过力导向动画（位置已稳定）
    if (layoutCache.has(layoutKey)) {
      setTick((t) => (t + 1) % 1000000)
      return
    }
    let stable = false
    let frameCount = 0
    const maxFrames = 300

    const animate = (): void => {
      frameCount++
      stable = runForceIteration(nodesRef.current, edges, DEFAULT_FORCE_PARAMS, CENTER_X, CENTER_Y)
      setTick((t) => (t + 1) % 1000000)
      if (!stable && frameCount < maxFrames) {
        animationRef.current = requestAnimationFrame(animate)
      } else {
        // D5.2：布局稳定后，将坐标写入缓存，后续相同筛选条件直接复用
        const snapshot = new Map<string, { x: number; y: number }>()
        for (const n of nodesRef.current) {
          snapshot.set(n.id, { x: n.x, y: n.y })
        }
        layoutCache.set(layoutKey, snapshot)
      }
    }
    animationRef.current = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(animationRef.current)
    }
  }, [edges, nodes.length, layoutKey])

  // 坐标转换：屏幕 → 画布
  const screenToCanvas = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const scaleX = WIDTH / rect.width
    const scaleY = HEIGHT / rect.height
    const x = (clientX - rect.left) * scaleX
    const y = (clientY - rect.top) * scaleY
    return {
      x: (x - panRef.current.x) / scaleRef.current,
      y: (y - panRef.current.y) / scaleRef.current
    }
  }, [])

  // 查找点击位置的节点
  const findNodeAt = useCallback((x: number, y: number): string | null => {
    for (let i = nodesRef.current.length - 1; i >= 0; i--) {
      const n = nodesRef.current[i]
      const dx = n.x - x
      const dy = n.y - y
      const radius = 8 + Math.min(n.degree * 2, 16)
      if (dx * dx + dy * dy <= radius * radius) {
        return n.id
      }
    }
    return null
  }, [])

  // 鼠标按下
  const handleMouseDown = useCallback(
    (e: React.MouseEvent): void => {
      const pos = screenToCanvas(e.clientX, e.clientY)
      const nodeId = findNodeAt(pos.x, pos.y)

      if (e.shiftKey) {
        // 框选模式
        dragState.current = { mode: 'box', nodeId: null, startX: pos.x, startY: pos.y, boxEndX: pos.x, boxEndY: pos.y }
        setBoxSelect({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y })
      } else if (nodeId) {
        // 拖拽节点
        const node = nodesRef.current.find((n) => n.id === nodeId)
        if (node) node.fixed = true
        dragState.current = { mode: 'node', nodeId, startX: pos.x, startY: pos.y, boxEndX: 0, boxEndY: 0 }
        onSelectNode(nodeId)
      } else {
        // 平移画布
        dragState.current = { mode: 'pan', nodeId: null, startX: e.clientX, startY: e.clientY, boxEndX: 0, boxEndY: 0 }
      }
    },
    [screenToCanvas, findNodeAt, onSelectNode]
  )

  // 鼠标移动
  const handleMouseMove = useCallback(
    (e: React.MouseEvent): void => {
      const ds = dragState.current
      if (ds.mode === 'none') return

      if (ds.mode === 'node' && ds.nodeId) {
        const pos = screenToCanvas(e.clientX, e.clientY)
        const node = nodesRef.current.find((n) => n.id === ds.nodeId)
        if (node) {
          node.x = pos.x
          node.y = pos.y
          node.vx = 0
          node.vy = 0
          setTick((t) => (t + 1) % 1000000)
        }
      } else if (ds.mode === 'pan') {
        const dx = e.clientX - ds.startX
        const dy = e.clientY - ds.startY
        const newPan = { x: panRef.current.x + dx, y: panRef.current.y + dy }
        panRef.current = newPan
        setPan(newPan)
        ds.startX = e.clientX
        ds.startY = e.clientY
      } else if (ds.mode === 'box') {
        const pos = screenToCanvas(e.clientX, e.clientY)
        ds.boxEndX = pos.x
        ds.boxEndY = pos.y
        setBoxSelect({ x1: ds.startX, y1: ds.startY, x2: pos.x, y2: pos.y })
      }
    },
    [screenToCanvas]
  )

  // 鼠标释放
  const handleMouseUp = useCallback((): void => {
    const ds = dragState.current
    if (ds.mode === 'node' && ds.nodeId) {
      const node = nodesRef.current.find((n) => n.id === ds.nodeId)
      if (node) node.fixed = false
    } else if (ds.mode === 'box') {
      // 计算框选范围内的节点
      const x1 = Math.min(ds.startX, ds.boxEndX)
      const x2 = Math.max(ds.startX, ds.boxEndX)
      const y1 = Math.min(ds.startY, ds.boxEndY)
      const y2 = Math.max(ds.startY, ds.boxEndY)
      const selected = new Set<string>()
      for (const n of nodesRef.current) {
        if (n.x >= x1 && n.x <= x2 && n.y >= y1 && n.y <= y2) {
          selected.add(n.id)
        }
      }
      onSelectNodes(selected)
      setBoxSelect(null)
    }
    dragState.current = { mode: 'none', nodeId: null, startX: 0, startY: 0, boxEndX: 0, boxEndY: 0 }
  }, [onSelectNodes])

  // 滚轮缩放
  const handleWheel = useCallback(
    (e: React.WheelEvent): void => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const newScale = Math.max(0.2, Math.min(3, scaleRef.current * delta))
      scaleRef.current = newScale
      setScale(newScale)
    },
    []
  )

  // 渲染
  if (loading) {
    return (
      <div className="wm-graph-canvas-loading">
        <Loader2 size={16} className="wm-graph-loading-spinner" />
        <span>加载图谱数据中...</span>
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div className="wm-graph-canvas-empty">
        <p>所选范围内暂无图谱数据</p>
        <p className="wm-graph-canvas-empty-hint">尝试调整日期范围或节点类型筛选</p>
      </div>
    )
  }

  const transform = `translate(${pan.x}, ${pan.y}) scale(${scale})`

  return (
    <div className="wm-graph-canvas-wrap">
      {isPreview && (
        <div className="wm-graph-preview-notice">
          <AlertCircle size={14} />
          <span>关系预览：当前数据超过 {MAX_NODES} 节点，已按关联度保留 Top {MAX_NODES}</span>
        </div>
      )}
      <svg
        ref={svgRef}
        className="wm-graph-canvas"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: dragState.current.mode === 'pan' ? 'grabbing' : 'default' }}
      >
        <g transform={transform}>
          {/* 边 */}
          {edges.map((edge, i) => {
            const s = nodesRef.current.find((n) => n.id === edge.source)
            const t = nodesRef.current.find((n) => n.id === edge.target)
            if (!s || !t) return null
            const isHighlighted =
              selectedNodeId === edge.source ||
              selectedNodeId === edge.target ||
              (selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target))
            return (
              <line
                key={i}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={isHighlighted ? 'var(--wm-color-accent)' : 'var(--wm-color-border-strong)'}
                strokeWidth={isHighlighted ? 2 : 1}
                opacity={selectedNodeId && !isHighlighted ? 0.2 : 0.6}
              />
            )
          })}

          {/* 框选矩形 */}
          {boxSelect && (
            <rect
              x={Math.min(boxSelect.x1, boxSelect.x2)}
              y={Math.min(boxSelect.y1, boxSelect.y2)}
              width={Math.abs(boxSelect.x2 - boxSelect.x1)}
              height={Math.abs(boxSelect.y2 - boxSelect.y1)}
              fill="rgba(43,127,255,0.08)"
              stroke="var(--wm-color-accent)"
              strokeWidth={1}
              strokeDasharray="4 2"
            />
          )}

          {/* 节点 */}
          {nodesRef.current.map((node) => {
            const radius = 8 + Math.min(node.degree * 2, 16)
            const isSelected = selectedNodeId === node.id
            const isInBox = selectedNodeIds.has(node.id)
            const isDimmed = selectedNodeId !== null && !isSelected && !inSelectedNeighbors(node, edges, selectedNodeId)
            const color = NODE_COLORS[node.type]
            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                style={{ cursor: 'pointer', opacity: isDimmed ? 0.3 : 1 }}
              >
                <circle
                  r={radius}
                  fill={color}
                  fillOpacity={isSelected ? 1 : 0.75}
                  stroke={isSelected || isInBox ? '#fff' : 'none'}
                  strokeWidth={isSelected || isInBox ? 2.5 : 0}
                />
                <text
                  y={radius + 12}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--wm-color-text-primary)"
                  fontWeight={isSelected ? 600 : 400}
                >
                  {node.label.length > 12 ? node.label.slice(0, 11) + '…' : node.label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
      <div className="wm-graph-canvas-hint">
        拖拽节点移动 · 点击查看详情 · 滚轮缩放 · 拖拽空白平移 · Shift+拖拽框选
      </div>
    </div>
  )
}

function inSelectedNeighbors(node: GraphNode, edges: GraphEdge[], selectedId: string): boolean {
  for (const e of edges) {
    if (e.source === selectedId && e.target === node.id) return true
    if (e.target === selectedId && e.source === node.id) return true
  }
  return false
}

// ===================== 详情面板 =====================

interface GraphDetailPanelProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
  selectedNodeId: string | null
  onSelectNode: (id: string | null) => void
  onRefresh: () => void
}

function GraphDetailPanel({ nodes, edges, selectedNodeId, onSelectNode, onRefresh }: GraphDetailPanelProps): JSX.Element {
  const selected = useMemo(() => nodes.find((n) => n.id === selectedNodeId), [nodes, selectedNodeId])

  const neighbors = useMemo<{ node: GraphNode; edgeLabel: string }[]>(() => {
    if (!selected) return []
    const result: { node: GraphNode; edgeLabel: string }[] = []
    for (const e of edges) {
      if (e.source === selected.id) {
        const n = nodes.find((nn) => nn.id === e.target)
        if (n) result.push({ node: n, edgeLabel: e.label })
      } else if (e.target === selected.id) {
        const n = nodes.find((nn) => nn.id === e.source)
        if (n) result.push({ node: n, edgeLabel: e.label })
      }
    }
    return result
  }, [selected, edges, nodes])

  if (!selected) {
    return (
      <Card variant="acrylic" padding="md" className="wm-graph-detail">
        <div className="wm-graph-detail-empty">
          <p>点击图谱节点查看详情</p>
          <p className="wm-graph-detail-empty-hint">关联节点将在此展示，点击可跳转</p>
        </div>
      </Card>
    )
  }

  const color = NODE_COLORS[selected.type]
  const data = selected.data as Episode | WikiPage | Report | EntityRef | undefined
  let metaLines: string[] = []
  if (selected.type === 'episode' && data && 'startTime' in data) {
    const ep = data as Episode
    metaLines = [`时间：${ep.startTime} - ${ep.endTime}`, `日期：${ep.date}`, `片段数：${ep.segmentIds.length}`]
    if (ep.oneLineSummary) metaLines.push(`摘要：${ep.oneLineSummary}`)
  } else if (selected.type === 'wiki' && data && 'content' in data) {
    const wp = data as WikiPage
    metaLines = [`类型：${wp.type}`, `审核：${wp.reviewStatus === 'reviewed' ? '已审核' : '待审核'}`, `来源数：${wp.sources.length}`]
  } else if (selected.type === 'report' && data && 'markdownContent' in data) {
    const rp = data as Report
    metaLines = [`日期：${rp.date}`, `模板：${rp.templateName}`, `状态：${rp.status === 'draft' ? '草稿' : '已导出'}`]
  } else if (selected.type === 'person' || selected.type === 'document') {
    const ent = data as EntityRef | undefined
    metaLines = [`名称：${selected.label}`, ent?.value ? `值：${ent.value}` : ''].filter((s) => s.length > 0)
    if (ent) {
      const confidencePct = typeof ent.confidence === 'number' ? Math.round(ent.confidence * 100) : null
      if (ent.userConfirmed) {
        metaLines.push('置信度：已确认')
      } else if (confidencePct !== null) {
        metaLines.push(`置信度：${confidencePct}%${confidencePct < 50 ? '（低）' : ''}`)
      }
    }
  }

  return (
    <Card variant="acrylic" padding="md" className="wm-graph-detail">
      <div className="wm-graph-detail-header">
        <span className="wm-graph-detail-type-dot" style={{ background: color }} />
        <span className="wm-graph-detail-type">{NODE_LABELS[selected.type]}</span>
        <span className="wm-graph-detail-degree">关联 {selected.degree}</span>
      </div>
      <h3 className="wm-graph-detail-title">{selected.label}</h3>
      {metaLines.length > 0 && (
        <div className="wm-graph-detail-meta">
          {metaLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
      {(selected.type === 'person' || selected.type === 'document') && (
        <EntityActionPanel
          entityType={selected.type}
          entityName={selected.label}
          neighbors={neighbors}
          onRefresh={onRefresh}
          onSelectNode={onSelectNode}
        />
      )}
      {neighbors.length > 0 && (
        <div className="wm-graph-detail-neighbors">
          <span className="wm-graph-detail-section-title">关联节点</span>
          {neighbors.map(({ node, edgeLabel }) => (
            <div
              key={node.id}
              className="wm-graph-detail-neighbor"
              onClick={() => onSelectNode(node.id)}
            >
              <span className="wm-graph-detail-neighbor-dot" style={{ background: NODE_COLORS[node.type] }} />
              <span className="wm-graph-detail-neighbor-label">{node.label}</span>
              <span className="wm-graph-detail-neighbor-edge">{edgeLabel}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/**
 * 实体操作面板：确认 / 修正 / 忽略。
 * 从关联的 Episode 节点中提取 episodeId，对每个关联 Episode 执行操作。
 */
interface EntityActionPanelProps {
  entityType: 'person' | 'document'
  entityName: string
  neighbors: { node: GraphNode; edgeLabel: string }[]
  onRefresh: () => void
  onSelectNode: (id: string | null) => void
}

function EntityActionPanel({ entityType, entityName, neighbors, onRefresh, onSelectNode }: EntityActionPanelProps): JSX.Element {
  const [correcting, setCorrecting] = useState<boolean>(false)
  const [newName, setNewName] = useState<string>('')
  const [acting, setActing] = useState<boolean>(false)

  // 从关联节点中提取 Episode ID
  const episodeIds = useMemo<string[]>(() => {
    const ids: string[] = []
    for (const { node } of neighbors) {
      if (node.type === 'episode' && node.data && 'segmentIds' in (node.data as Episode)) {
        ids.push((node.data as Episode).id)
      }
    }
    return ids
  }, [neighbors])

  if (episodeIds.length === 0) return <></>

  const handleConfirm = async (): Promise<void> => {
    setActing(true)
    try {
      for (const id of episodeIds) {
        await window.workmemory.episode.confirmEntity(id, entityType, entityName)
      }
      toast.success(`已确认实体「${entityName}」`)
      onRefresh()
    } catch (e) {
      toast.error('确认失败', e instanceof Error ? e.message : String(e))
    } finally {
      setActing(false)
    }
  }

  const handleCorrect = async (): Promise<void> => {
    const trimmed = newName.trim()
    if (trimmed.length === 0) {
      toast.warning('请输入修正后的名称')
      return
    }
    setActing(true)
    try {
      for (const id of episodeIds) {
        await window.workmemory.episode.correctEntity(id, entityType, entityName, trimmed)
      }
      toast.success(`已修正为「${trimmed}」`)
      setCorrecting(false)
      setNewName('')
      onRefresh()
      onSelectNode(null)
    } catch (e) {
      toast.error('修正失败', e instanceof Error ? e.message : String(e))
    } finally {
      setActing(false)
    }
  }

  const handleIgnore = async (): Promise<void> => {
    setActing(true)
    try {
      for (const id of episodeIds) {
        await window.workmemory.episode.ignoreEntity(id, entityType, entityName)
      }
      toast.info(`已忽略实体「${entityName}」`)
      onRefresh()
      onSelectNode(null)
    } catch (e) {
      toast.error('忽略失败', e instanceof Error ? e.message : String(e))
    } finally {
      setActing(false)
    }
  }

  return (
    <div className="wm-graph-entity-actions">
      <span className="wm-graph-detail-section-title">实体操作</span>
      {!correcting ? (
        <div className="wm-graph-entity-actions-row">
          <Button size="sm" variant="secondary" disabled={acting} onClick={handleConfirm}>
            确认
          </Button>
          <Button size="sm" variant="ghost" disabled={acting} onClick={() => { setCorrecting(true); setNewName(entityName) }}>
            修正
          </Button>
          <Button size="sm" variant="danger" disabled={acting} onClick={handleIgnore}>
            忽略
          </Button>
        </div>
      ) : (
        <div className="wm-graph-entity-correct">
          <input
            className="wm-graph-entity-correct-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="修正后的名称"
            disabled={acting}
          />
          <div className="wm-graph-entity-actions-row">
            <Button size="sm" variant="primary" disabled={acting} onClick={handleCorrect}>
              保存
            </Button>
            <Button size="sm" variant="ghost" disabled={acting} onClick={() => { setCorrecting(false); setNewName('') }}>
              取消
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
