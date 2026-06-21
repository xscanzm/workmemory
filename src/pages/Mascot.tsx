/**
 * Mascot 桌面伙伴渲染组件（统一视觉语言版）
 *
 * 在独立透明窗口中渲染（#/mascot 路由，不使用 AppLayout）。
 *
 * 统一视觉规范（V0.4 Trust & Beauty Sprint Task B5）：
 *  - viewBox：统一 120x120
 *  - 描边：主体轮廓 1.5px，装饰细节 1px
 *  - 色板：白底 (#ffffff) + 边框 (#e1e7ef) + 文字 (#1a2332) + 状态强调色
 *  - 表情语言：5 种状态对应 5 种统一表情，跨形象一致
 *  - 扁平设计：无渐变，圆角，柔和投影
 *
 * 5 种形象（共享同一套表情与色彩逻辑）：
 *  - note：便签（方形 + 折角）
 *  - film：胶片（矩形 + 齿孔 + 中央画面）
 *  - copilot：副驾驶（圆角机器人 + 天线 + 屏幕）
 *  - cursor：光标（箭头 + 涟漪）
 *  - paper：纸页（纸张 + 折角 + 文字线）
 *
 * 5 种状态（统一表情 + 强调色）：
 *  - recording：聚焦（实心点眼 + 微笑 + 脉冲点）强调色 #2b7fff
 *  - paused：休憩（横线眼 + 平嘴 + 暂停符）强调色 #f5a623
 *  - privacy：隐匿（遮罩眼 + 平嘴 + 盾牌）强调色 #8b5cf6
 *  - ocr_scanning：扫描（点眼 + 圆嘴 + 扫描线 + 放大镜）强调色 #22c5d8
 *  - report_ready：欢喜（笑眼 + 大笑 + 闪光）强调色 #22b56a
 *
 * 渲染架构：形象主体（base body）+ 统一表情（Expression）+ 状态强调（StateAccent）
 *  - 每个形象组件绘制自身主体形状，并指定面部几何位置
 *  - Expression 根据 state 渲染统一表情（眼睛/嘴），跨形象一致
 *  - StateAccent 根据 state 渲染状态徽标（脉冲点/盾牌/扫描线/闪光等）
 *
 * 交互：
 *  - 左键单击：通知主进程（首次显示今日总结，再次跳转）
 *  - 右键单击：通知主进程显示上下文菜单
 *  - 右键双击：通知主进程隐藏至托盘
 *  - 鼠标按下拖拽：通知主进程开始拖拽（主进程轮询光标移动窗口）
 *  - 鼠标释放：通知主进程结束拖拽（检测边缘吸附）
 *  - 鼠标进入/离开：通知主进程调整透明度
 *  - 气泡关闭按钮：通知主进程记录关闭（频率限制）
 *
 * 视觉治理：气泡圆角 8px，亚克力材质背景。
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import type { MascotStyle, MascotState } from '@/types'
import './Mascot.css'

// ===================== 常量 =====================

/** 气泡自动消失时间（毫秒） */
const BUBBLE_AUTO_DISMISS_MS = 8000

/** 拖拽防抖阈值（毫秒）：避免点击误判为拖拽 */
const DRAG_THRESHOLD_MS = 150

/** 拖拽移动阈值（像素）：超过此距离才视为拖拽 */
const DRAG_MOVE_THRESHOLD = 4

// ===================== 类型 =====================

/** 气泡数据 */
interface BubbleData {
  title: string
  message: string
  action?: string
}

// ===================== 主组件 =====================

export default function Mascot(): JSX.Element {
  const [state, setState] = useState<MascotState>('recording')
  const [style, setStyle] = useState<MascotStyle>('note')
  const [bubble, setBubble] = useState<BubbleData | null>(null)
  const [ready, setReady] = useState(false)

  // 拖拽状态
  const mouseDownRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const draggingRef = useRef(false)
  const bubbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ===================== 气泡控制 =====================

  const showBubble = useCallback((b: BubbleData): void => {
    setBubble(b)
    if (bubbleTimerRef.current) {
      clearTimeout(bubbleTimerRef.current)
    }
    bubbleTimerRef.current = setTimeout(() => {
      setBubble(null)
      bubbleTimerRef.current = null
    }, BUBBLE_AUTO_DISMISS_MS)
  }, [])

  const closeBubble = useCallback((): void => {
    setBubble(null)
    if (bubbleTimerRef.current) {
      clearTimeout(bubbleTimerRef.current)
      bubbleTimerRef.current = null
    }
    void window.workmemory.mascot.bubbleClosed()
  }, [])

  // ===================== 初始化：获取初始状态 =====================

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const initial = await window.workmemory.mascot.getInitialState()
        setState(initial.state as MascotState)
        setStyle(initial.style as MascotStyle)
      } catch (e) {
        console.warn('[Mascot] 获取初始状态失败:', e)
      } finally {
        setReady(true)
      }
    })()
  }, [])

  // ===================== 监听主进程事件 =====================

  useEffect(() => {
    const removeStateListener = window.workmemory.mascot.onStateChanged((s: string) => {
      setState(s as MascotState)
    })
    const removeStyleListener = window.workmemory.mascot.onStyleChanged((s: string) => {
      setStyle(s as MascotStyle)
    })
    const removeBubbleListener = window.workmemory.mascot.onBubbleShow((b: BubbleData) => {
      showBubble(b)
    })
    const removeNavigateListener = window.workmemory.mascot.onNavigate(() => {
      // 导航事件由主窗口处理，mascot 窗口无需响应
    })
    return () => {
      removeStateListener()
      removeStyleListener()
      removeBubbleListener()
      removeNavigateListener()
    }
  }, [showBubble])

  // ===================== 鼠标交互 =====================

  const handleMouseDown = useCallback((e: React.MouseEvent): void => {
    if (e.button !== 0) return // 仅左键触发拖拽
    mouseDownRef.current = {
      x: e.screenX,
      y: e.screenY,
      time: Date.now()
    }
    draggingRef.current = false
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent): void => {
    if (!mouseDownRef.current || draggingRef.current) return
    const dx = Math.abs(e.screenX - mouseDownRef.current.x)
    const dy = Math.abs(e.screenY - mouseDownRef.current.y)
    if (dx > DRAG_MOVE_THRESHOLD || dy > DRAG_MOVE_THRESHOLD) {
      // 超过移动阈值，开始拖拽
      draggingRef.current = true
      void window.workmemory.mascot.dragStart()
    }
  }, [])

  const handleMouseUp = useCallback((e: React.MouseEvent): void => {
    if (!mouseDownRef.current) return
    const wasDragging = draggingRef.current
    const elapsed = Date.now() - mouseDownRef.current.time
    mouseDownRef.current = null

    if (wasDragging) {
      draggingRef.current = false
      void window.workmemory.mascot.dragEnd()
    } else if (elapsed < DRAG_THRESHOLD_MS && e.button === 0) {
      // 短按左键：视为单击
      void window.workmemory.mascot.leftClick()
    }
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    void window.workmemory.mascot.rightClick()
  }, [])

  const handleRightDoubleClick = useCallback((): void => {
    void window.workmemory.mascot.rightDoubleClick()
  }, [])

  const handleMouseEnter = useCallback((): void => {
    void window.workmemory.mascot.mouseEnter()
  }, [])

  const handleMouseLeave = useCallback((): void => {
    void window.workmemory.mascot.mouseLeave()
  }, [])

  // ===================== 渲染 =====================

  return (
    <div
      className={`wm-mascot-root wm-mascot-state-${state} ${ready ? 'wm-mascot-ready' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleRightDoubleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="wm-mascot-stage">
        <MascotFigure style={style} state={state} />
        <StateIndicator state={state} />
      </div>
      {bubble && (
        <MascotBubble
          title={bubble.title}
          message={bubble.message}
          action={bubble.action}
          onClose={closeBubble}
        />
      )}
    </div>
  )
}

// ===================== 统一色板 =====================

/** Mascot 统一色板：跨形象共享，仅强调色随状态变化 */
interface MascotPalette {
  /** 主体填充（白底） */
  surface: string
  /** 次要面（折角/屏幕/画面，略灰） */
  surfaceAlt: string
  /** 边框/轮廓 */
  border: string
  /** 细节（眼睛/嘴/文字线） */
  text: string
  /** 状态强调色 */
  accent: string
}

/** 基础色板（与状态无关，对齐设计系统） */
const BASE_PALETTE: Omit<MascotPalette, 'accent'> = {
  surface: '#ffffff',
  surfaceAlt: '#eef2f7',
  border: '#e1e7ef',
  text: '#1a2332'
}

/** 根据状态获取色板：基础色固定，仅强调色随状态变化 */
function getStatePalette(state: MascotState): MascotPalette {
  switch (state) {
    case 'recording':
      return { ...BASE_PALETTE, accent: '#2b7fff' }
    case 'paused':
      return { ...BASE_PALETTE, accent: '#f5a623' }
    case 'privacy':
      return { ...BASE_PALETTE, accent: '#8b5cf6' }
    case 'ocr_scanning':
      return { ...BASE_PALETTE, accent: '#22c5d8' }
    case 'report_ready':
      return { ...BASE_PALETTE, accent: '#22b56a' }
    default:
      return { ...BASE_PALETTE, accent: '#2b7fff' }
  }
}

// ===================== 形象渲染 =====================

interface MascotFigureProps {
  style: MascotStyle
  state: MascotState
}

/** 根据形象类型渲染对应 SVG */
function MascotFigure({ style, state }: MascotFigureProps): JSX.Element {
  switch (style) {
    case 'note':
      return <NoteFigure state={state} />
    case 'film':
      return <FilmFigure state={state} />
    case 'copilot':
      return <CopilotFigure state={state} />
    case 'cursor':
      return <CursorFigure state={state} />
    case 'paper':
      return <PaperFigure state={state} />
    default:
      return <NoteFigure state={state} />
  }
}

// -------------------- 统一表情 --------------------

/** 面部几何：眼睛与嘴的位置，由各形象主体指定 */
interface FaceGeometry {
  eyeLeft: { x: number; y: number }
  eyeRight: { x: number; y: number }
  mouthY: number
  /** 眼睛半径基准，光标等小脸可缩小 */
  eyeRadius?: number
}

interface ExpressionProps {
  state: MascotState
  geo: FaceGeometry
  palette: MascotPalette
}

/**
 * 统一表情渲染：5 种状态对应 5 种表情语言，跨形象一致。
 *  - recording：实心点眼 + 微笑（聚焦活跃）
 *  - paused：横线眼 + 平嘴（休憩平静）
 *  - privacy：遮罩眼 + 平嘴（隐匿防护）
 *  - ocr_scanning：点眼 + 圆嘴（分析扫描）
 *  - report_ready：笑眼 + 大笑（欢喜自豪）
 */
function Expression({ state, geo, palette }: ExpressionProps): JSX.Element {
  const { eyeLeft, eyeRight, mouthY, eyeRadius = 2.6 } = geo
  const cx = (eyeLeft.x + eyeRight.x) / 2
  const ink = palette.text
  const accent = palette.accent

  switch (state) {
    case 'recording':
      // 实心点眼 + 微笑
      return (
        <g>
          <circle cx={eyeLeft.x} cy={eyeLeft.y} r={eyeRadius} fill={ink} />
          <circle cx={eyeRight.x} cy={eyeRight.y} r={eyeRadius} fill={ink} />
          <path
            d={`M ${eyeLeft.x} ${mouthY} Q ${cx} ${mouthY + 4} ${eyeRight.x} ${mouthY}`}
            stroke={ink}
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </g>
      )
    case 'paused':
      // 横线眼 + 平嘴
      return (
        <g>
          <line
            x1={eyeLeft.x - 3}
            y1={eyeLeft.y}
            x2={eyeLeft.x + 3}
            y2={eyeLeft.y}
            stroke={ink}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <line
            x1={eyeRight.x - 3}
            y1={eyeRight.y}
            x2={eyeRight.x + 3}
            y2={eyeRight.y}
            stroke={ink}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <line
            x1={cx - 6}
            y1={mouthY}
            x2={cx + 6}
            y2={mouthY}
            stroke={ink}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      )
    case 'privacy':
      // 遮罩眼（横条）+ 平嘴
      return (
        <g>
          <rect x={eyeLeft.x - 4} y={eyeLeft.y - 1.6} width="8" height="3.2" rx="1.6" fill={ink} />
          <rect x={eyeRight.x - 4} y={eyeRight.y - 1.6} width="8" height="3.2" rx="1.6" fill={ink} />
          <line
            x1={cx - 5}
            y1={mouthY}
            x2={cx + 5}
            y2={mouthY}
            stroke={ink}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      )
    case 'ocr_scanning':
      // 点眼 + 圆嘴（分析中）
      return (
        <g>
          <circle cx={eyeLeft.x} cy={eyeLeft.y} r={eyeRadius} fill={ink} />
          <circle cx={eyeRight.x} cy={eyeRight.y} r={eyeRadius} fill={ink} />
          <circle cx={cx} cy={mouthY} r="2.2" fill="none" stroke={accent} strokeWidth="1.5" />
        </g>
      )
    case 'report_ready':
      // 笑眼（弧形）+ 大笑
      return (
        <g>
          <path
            d={`M ${eyeLeft.x - 3} ${eyeLeft.y + 1} Q ${eyeLeft.x} ${eyeLeft.y - 3} ${eyeLeft.x + 3} ${eyeLeft.y + 1}`}
            stroke={ink}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M ${eyeRight.x - 3} ${eyeRight.y + 1} Q ${eyeRight.x} ${eyeRight.y - 3} ${eyeRight.x + 3} ${eyeRight.y + 1}`}
            stroke={ink}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d={`M ${eyeLeft.x} ${mouthY - 2} Q ${cx} ${mouthY + 7} ${eyeRight.x} ${mouthY - 2}`}
            stroke={ink}
            strokeWidth="1.8"
            fill="none"
            strokeLinecap="round"
          />
        </g>
      )
    default:
      return <g />
  }
}

// -------------------- 状态强调徽标 --------------------

interface StateAccentProps {
  state: MascotState
  palette: MascotPalette
}

/**
 * 统一状态徽标：5 种状态对应 5 种徽标，跨形象位置一致。
 *  - recording：右上脉冲点
 *  - paused：右上暂停符
 *  - privacy：右下盾牌
 *  - ocr_scanning：全幅扫描线 + 右下放大镜
 *  - report_ready：左右上角闪光
 */
function StateAccent({ state, palette }: StateAccentProps): JSX.Element {
  const accent = palette.accent
  switch (state) {
    case 'recording':
      return <circle cx="104" cy="28" r="4" fill={accent} className="wm-mascot-pulse-dot" />
    case 'paused':
      return (
        <g className="wm-mascot-pause-mark">
          <rect x="100" y="24" width="3" height="9" rx="1" fill={accent} />
          <rect x="106" y="24" width="3" height="9" rx="1" fill={accent} />
        </g>
      )
    case 'privacy':
      // 盾牌（右下角）
      return (
        <path
          d="M102 86 L108 84 L108 95 Q108 99 102 101 Q96 99 96 95 L96 84 Z"
          fill={accent}
          opacity="0.92"
          stroke="#ffffff"
          strokeWidth="1"
        />
      )
    case 'ocr_scanning':
      return (
        <g>
          <rect
            x="18"
            y="48"
            width="84"
            height="2"
            rx="1"
            fill={accent}
            opacity="0.75"
            className="wm-mascot-scanline"
          />
          <g className="wm-mascot-magnifier">
            <circle cx="102" cy="92" r="6" fill="none" stroke={accent} strokeWidth="1.8" />
            <line
              x1="106"
              y1="96"
              x2="110"
              y2="100"
              stroke={accent}
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
        </g>
      )
    case 'report_ready':
      return (
        <g className="wm-mascot-sparkle">
          <path
            d="M20 28 L20 36 M16 32 L24 32"
            stroke={accent}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M102 36 L102 44 M98 40 L106 40"
            stroke={accent}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </g>
      )
    default:
      return <g />
  }
}

// -------------------- 便签形象 --------------------

function NoteFigure({ state }: { state: MascotState }): JSX.Element {
  const palette = getStatePalette(state)
  return (
    <svg viewBox="0 0 120 120" className="wm-mascot-svg" width="80" height="80">
      {/* 便签主体 */}
      <path
        d="M24 22 L82 22 L96 36 L96 100 L24 100 Z"
        fill={palette.surface}
        stroke={palette.border}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* 折角 */}
      <path
        d="M82 22 L82 36 L96 36 Z"
        fill={palette.surfaceAlt}
        stroke={palette.border}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* 装饰横线（便签内容） */}
      <line x1="34" y1="46" x2="86" y2="46" stroke={palette.text} strokeWidth="1" opacity="0.35" />
      <line x1="34" y1="54" x2="74" y2="54" stroke={palette.text} strokeWidth="1" opacity="0.35" />
      {/* 表情 */}
      <Expression
        state={state}
        geo={{ eyeLeft: { x: 50, y: 70 }, eyeRight: { x: 72, y: 70 }, mouthY: 82 }}
        palette={palette}
      />
      {/* 状态强调 */}
      <StateAccent state={state} palette={palette} />
    </svg>
  )
}

// -------------------- 胶片形象 --------------------

function FilmFigure({ state }: { state: MascotState }): JSX.Element {
  const palette = getStatePalette(state)
  return (
    <svg viewBox="0 0 120 120" className="wm-mascot-svg" width="80" height="80">
      {/* 胶片主体 */}
      <rect x="18" y="26" width="84" height="72" rx="6" fill={palette.surface} stroke={palette.border} strokeWidth="1.5" />
      {/* 上下齿孔 */}
      {[24, 36, 48, 60, 72, 84].map((x) => (
        <rect key={`top-${x}`} x={x} y="30" width="6" height="4" rx="1" fill={palette.text} opacity="0.55" />
      ))}
      {[24, 36, 48, 60, 72, 84].map((x) => (
        <rect key={`bot-${x}`} x={x} y="90" width="6" height="4" rx="1" fill={palette.text} opacity="0.55" />
      ))}
      {/* 中央画面区域 */}
      <rect x="28" y="42" width="64" height="44" rx="4" fill={palette.surfaceAlt} stroke={palette.border} strokeWidth="1" />
      {/* 表情（画面内） */}
      <Expression
        state={state}
        geo={{ eyeLeft: { x: 50, y: 60 }, eyeRight: { x: 72, y: 60 }, mouthY: 72 }}
        palette={palette}
      />
      {/* 状态强调 */}
      <StateAccent state={state} palette={palette} />
    </svg>
  )
}

// -------------------- 副驾驶形象 --------------------

function CopilotFigure({ state }: { state: MascotState }): JSX.Element {
  const palette = getStatePalette(state)
  return (
    <svg viewBox="0 0 120 120" className="wm-mascot-svg" width="80" height="80">
      {/* 天线 */}
      <line x1="60" y1="14" x2="60" y2="30" stroke={palette.border} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="60" cy="12" r="3" fill={palette.accent} />
      {/* 机器人头部主体 */}
      <rect x="28" y="30" width="64" height="58" rx="16" fill={palette.surface} stroke={palette.border} strokeWidth="1.5" />
      {/* 屏幕（脸） */}
      <rect x="36" y="38" width="48" height="34" rx="8" fill={palette.surfaceAlt} stroke={palette.border} strokeWidth="1" />
      {/* 表情（屏幕内） */}
      <Expression
        state={state}
        geo={{ eyeLeft: { x: 50, y: 52 }, eyeRight: { x: 72, y: 52 }, mouthY: 62 }}
        palette={palette}
      />
      {/* 底部装饰指示灯 */}
      <circle cx="44" cy="80" r="2" fill={palette.accent} />
      <circle cx="60" cy="80" r="2" fill={palette.text} opacity="0.3" />
      <circle cx="76" cy="80" r="2" fill={palette.accent} />
      {/* 状态强调 */}
      <StateAccent state={state} palette={palette} />
    </svg>
  )
}

// -------------------- 光标形象 --------------------

function CursorFigure({ state }: { state: MascotState }): JSX.Element {
  const palette = getStatePalette(state)
  return (
    <svg viewBox="0 0 120 120" className="wm-mascot-svg" width="80" height="80">
      {/* 涟漪背景 */}
      <circle cx="57" cy="48" r="30" fill="none" stroke={palette.accent} strokeWidth="1" opacity="0.3" className="wm-mascot-ripple" />
      <circle cx="57" cy="48" r="22" fill="none" stroke={palette.accent} strokeWidth="1" opacity="0.2" />
      {/* 光标箭头 */}
      <path
        d="M44 34 L44 70 L52 60 L58 76 L66 72 L60 56 L70 56 Z"
        fill={palette.surface}
        stroke={palette.border}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* 表情（箭头下方） */}
      <Expression
        state={state}
        geo={{ eyeLeft: { x: 50, y: 88 }, eyeRight: { x: 70, y: 88 }, mouthY: 96, eyeRadius: 2.2 }}
        palette={palette}
      />
      {/* 状态强调 */}
      <StateAccent state={state} palette={palette} />
    </svg>
  )
}

// -------------------- 纸页精灵形象 --------------------

function PaperFigure({ state }: { state: MascotState }): JSX.Element {
  const palette = getStatePalette(state)
  return (
    <svg viewBox="0 0 120 120" className="wm-mascot-svg" width="80" height="80">
      {/* 纸张主体 */}
      <path
        d="M28 18 L80 18 L94 32 L94 102 L28 102 Z"
        fill={palette.surface}
        stroke={palette.border}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* 折角 */}
      <path
        d="M80 18 L80 32 L94 32 Z"
        fill={palette.surfaceAlt}
        stroke={palette.border}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* 文字横线 */}
      <line x1="38" y1="44" x2="84" y2="44" stroke={palette.text} strokeWidth="1" opacity="0.3" />
      <line x1="38" y1="52" x2="84" y2="52" stroke={palette.text} strokeWidth="1" opacity="0.3" />
      <line x1="38" y1="60" x2="72" y2="60" stroke={palette.text} strokeWidth="1" opacity="0.3" />
      {/* 精灵表情 */}
      <Expression
        state={state}
        geo={{ eyeLeft: { x: 52, y: 78 }, eyeRight: { x: 72, y: 78 }, mouthY: 88 }}
        palette={palette}
      />
      {/* 状态强调 */}
      <StateAccent state={state} palette={palette} />
    </svg>
  )
}

// -------------------- 状态指示器 --------------------

function StateIndicator({ state }: { state: MascotState }): JSX.Element {
  const labels: Record<MascotState, string> = {
    recording: '记录中',
    paused: '已暂停',
    privacy: '隐私模式',
    ocr_scanning: '识别中',
    report_ready: '日报就绪'
  }
  return (
    <div className={`wm-mascot-indicator wm-mascot-indicator-${state}`}>
      <span className="wm-mascot-indicator-dot" />
      <span className="wm-mascot-indicator-text">{labels[state]}</span>
    </div>
  )
}

// -------------------- 气泡 --------------------

interface MascotBubbleProps {
  title: string
  message: string
  action?: string
  onClose: () => void
}

function MascotBubble({ title, message, action, onClose }: MascotBubbleProps): JSX.Element {
  const handleClick = useCallback((): void => {
    if (action) {
      void window.workmemory.mascot.navigate(action)
    }
    onClose()
  }, [action, onClose])

  return (
    <div className="wm-mascot-bubble wm-acrylic-bubble">
      <button className="wm-mascot-bubble-close" onClick={onClose} title="关闭">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
      <div className="wm-mascot-bubble-title">{title}</div>
      <div className="wm-mascot-bubble-message">{message}</div>
      {action && (
        <button className="wm-mascot-bubble-action" onClick={handleClick}>
          查看详情 →
        </button>
      )}
    </div>
  )
}
