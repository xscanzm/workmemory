/**
 * Task 6.8：设置 (Settings) 页
 * 6 个分区卡片：通用 / OCR / AI / 隐私 / 桌面伙伴 / 数据管理
 * - 通用：开机自启、保存截图开关、截图保留天数（0-7）、整屏降级
 * - OCR：本地 OCR 后端状态、模型选择、测试识别
 * - AI：API Key（加密存储）、Base URL、Model Name、测试连接
 * - 隐私：隐私规则列表（CRUD）
 * - 桌面伙伴：形象样式选择
 * - 数据管理：数据统计、一键瘦身、清空当天、清空全部
 * 已迁移到统一 UI 组件库（Button/Card/Badge/Switch/Select/Dialog/IconButton/Toast + lucide 图标）。
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRecordingStore } from '../store/recordingStore'
import { getTodayDate } from '../utils/datetime'
import type {
  AppSettings,
  MascotStyle,
  OcrModel,
  PrivacyRule,
  PrivacyRuleType,
  PrivacyMatchMode
} from '@/types'
import type {
  DataStats,
  OcrRuntimeStatus,
  OcrTestRecognizeResult
} from '../types/ipc'
import {
  Button,
  Card,
  Badge,
  Switch,
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
  IconButton,
  toast,
  SlidersHorizontal,
  ScanText,
  Bot,
  Shield,
  Sparkles,
  Database,
  StickyNote,
  Film,
  Compass,
  MousePointer,
  FileText,
  Trash2,
  AlertTriangle,
  Check,
  XCircle,
  Loader2
} from '@/ui'
import './Settings.css'

// ===================== 类型定义 =====================

type ConfirmActionType =
  | 'cleanup'
  | 'clearDay'
  | 'clearAll'
  | 'enableFallback'
  | 'resetSettings'
  | 'clearApiKey'
  | 'deleteRule'

interface ConfirmConfig {
  title: string
  message: string
  confirmLabel: string
  danger: boolean
}

// ===================== 常量 =====================

const MASCOT_STYLES: Array<{ id: MascotStyle; label: string; description: string; icon: React.ReactNode }> = [
  { id: 'note', label: '便签', description: '简约便签风格', icon: <StickyNote size={28} /> },
  { id: 'film', label: '胶片', description: '胶片记录风格', icon: <Film size={28} /> },
  { id: 'copilot', label: '副驾', description: '副驾助手风格', icon: <Compass size={28} /> },
  { id: 'cursor', label: '光标', description: '光标跟随风格', icon: <MousePointer size={28} /> },
  { id: 'paper', label: '纸张', description: '纸张文档风格', icon: <FileText size={28} /> }
]

const OCR_MODELS: Array<{ id: OcrModel; label: string; description: string }> = [
  { id: 'tiny', label: 'Tiny', description: '默认内置，适合屏幕文字，资源占用低' },
  { id: 'small', label: 'Small', description: '预留高精度模式，需额外模型资源' }
]

const PRIVACY_TYPES: Array<{ id: PrivacyRuleType; label: string; action: string }> = [
  { id: 'app_name', label: '应用名', action: '跳过截图' },
  { id: 'process_name', label: '进程名', action: '跳过截图' },
  { id: 'window_title', label: '窗口标题', action: '占位记录' },
  { id: 'url', label: 'URL', action: '占位记录' }
]

const PRIVACY_MODES: Array<{ id: PrivacyMatchMode; label: string }> = [
  { id: 'contains', label: '包含' },
  { id: 'equals', label: '完全相等' },
  { id: 'regex', label: '正则匹配' }
]

const OCR_BACKEND_LABELS: Record<OcrRuntimeStatus['type'], string> = {
  paddleocr: 'PP-OCRv6',
  tesseract: 'Tesseract',
  unconfigured: '未配置'
}

/** 根据确认动作类型返回 Dialog 配置 */
function getConfirmConfig(
  action: ConfirmActionType | null,
  clearDayDate: string
): ConfirmConfig | null {
  if (!action) return null
  switch (action) {
    case 'cleanup':
      return {
        title: '确认执行一键瘦身',
        message: '将物理删除已软删的片段、过期截图、孤立事件与失效 Wiki 引用。此操作不可撤销。',
        confirmLabel: '执行瘦身',
        danger: false
      }
    case 'clearDay':
      return {
        title: `确认清空 ${clearDayDate} 的数据`,
        message: `将删除 ${clearDayDate} 的全部片段与事件及其截图。此操作不可撤销。`,
        confirmLabel: '确认清空',
        danger: true
      }
    case 'clearAll':
      return {
        title: '确认清空全部数据',
        message: '将删除所有片段、事件、Wiki 页、报告及全部截图（保留隐私规则）。此操作不可撤销。',
        confirmLabel: '确认清空',
        danger: true
      }
    case 'enableFallback':
      return {
        title: '确认开启整屏降级？',
        message: '开启后，当无法截取活跃窗口时将截取整屏，可能包含其他窗口的私密内容，确认开启？',
        confirmLabel: '确认开启',
        danger: true
      }
    case 'resetSettings':
      return {
        title: '确认重置设置',
        message: '确定重置所有设置为默认值吗？',
        confirmLabel: '重置',
        danger: true
      }
    case 'clearApiKey':
      return {
        title: '确认清空 API Key',
        message: '清空后 AI 日报生成将不可用，需重新配置。',
        confirmLabel: '清空',
        danger: true
      }
    case 'deleteRule':
      return {
        title: '确认删除规则',
        message: '确定删除此隐私规则吗？',
        confirmLabel: '删除',
        danger: true
      }
    default:
      return null
  }
}

// ===================== 主组件 =====================

export function Settings(): JSX.Element {
  const setContextItem = useRecordingStore((s) => s.setContextItem)
  const refreshTrigger = useRecordingStore((s) => s.refreshTrigger)

  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [privacyRules, setPrivacyRules] = useState<PrivacyRule[]>([])
  const [dataStats, setDataStats] = useState<DataStats | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  // 测试连接状态
  const [testing, setTesting] = useState<boolean>(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  // API Key 新输入（永不回填明文，输入框始终为空直到用户输入新 key）
  const [newApiKey, setNewApiKey] = useState<string>('')

  // OCR runtime 状态与测试
  const [ocrRuntimeStatus, setOcrRuntimeStatus] = useState<OcrRuntimeStatus | null>(null)
  const [ocrTesting, setOcrTesting] = useState<boolean>(false)
  const [ocrTestResult, setOcrTestResult] = useState<OcrTestRecognizeResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 新建隐私规则表单
  const [newRuleType, setNewRuleType] = useState<PrivacyRuleType>('app_name')
  const [newRulePattern, setNewRulePattern] = useState<string>('')
  const [newRuleMode, setNewRuleMode] = useState<PrivacyMatchMode>('contains')

  // 危险操作确认
  const [confirmAction, setConfirmAction] = useState<ConfirmActionType | null>(null)
  const [pendingDeleteRuleId, setPendingDeleteRuleId] = useState<string | null>(null)
  const [clearDayDate, setClearDayDate] = useState<string>(getTodayDate())

  // 加载数据
  const loadData = useCallback(async (): Promise<void> => {
    try {
      const [s, rules, stats] = await Promise.all([
        window.workmemory.settings.get(),
        window.workmemory.privacy.getAll(),
        window.workmemory.data.getStats()
      ])
      setSettings(s)
      setPrivacyRules(rules)
      setDataStats(stats)
    } catch (e) {
      console.error('[Settings] 加载数据失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData, refreshTrigger])

  // 加载 OCR runtime 状态
  const loadOcrRuntimeStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await window.workmemory.ocr.getRuntimeStatus()
      setOcrRuntimeStatus(status)
    } catch (e) {
      console.error('[Settings] 加载 OCR runtime 状态失败:', e)
    }
  }, [])

  useEffect(() => {
    void loadOcrRuntimeStatus()
  }, [loadOcrRuntimeStatus, settings?.ocrModel])

  useEffect(() => {
    setContextItem(null)
  }, [setContextItem])

  // ===================== 设置更新 =====================

  const updateSettings = useCallback(async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const updated = await window.workmemory.settings.set(patch)
      setSettings(updated)
      toast.success('设置已保存')
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : String(e))
    }
  }, [])

  const handleResetSettings = useCallback(async (): Promise<void> => {
    try {
      const reset = await window.workmemory.settings.reset()
      setSettings(reset)
      // 同步重置 Mascot 形象到默认值
      void window.workmemory.mascot.setStyle(reset.mascotStyle)
      toast.success('已重置为默认设置')
    } catch (e) {
      toast.error('重置失败', e instanceof Error ? e.message : String(e))
    } finally {
      setConfirmAction(null)
    }
  }, [])

  // ===================== 桌面伙伴形象切换 =====================

  const handleMascotStyleChange = useCallback(async (style: MascotStyle): Promise<void> => {
    try {
      // 1. 通知 MascotManager 切换形象（更新 Mascot 窗口 + 托盘 + 持久化）
      await window.workmemory.mascot.setStyle(style)
      // 2. 更新本地设置状态（刷新 UI 选中态）
      const updated = await window.workmemory.settings.set({ mascotStyle: style })
      setSettings(updated)
      toast.success('伙伴形象已切换')
    } catch (e) {
      toast.error('切换失败', e instanceof Error ? e.message : String(e))
    }
  }, [])

  // ===================== AI 测试连接 =====================

  const handleTestConnection = useCallback(async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.workmemory.ai.testConnection()
      setTestResult(result)
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }, [])

  // ===================== API Key 加密保存 / 清空 =====================

  const handleSaveApiKey = useCallback(async (): Promise<void> => {
    const key = newApiKey.trim()
    if (!key) {
      toast.warning('请输入 API Key')
      return
    }
    try {
      await window.workmemory.settings.setApiKey(key)
      setNewApiKey('')
      // 刷新 settings 以更新掩码显示
      const updated = await window.workmemory.settings.get()
      setSettings(updated)
      toast.success('API Key 已加密保存')
    } catch (e) {
      toast.error('保存失败', e instanceof Error ? e.message : String(e))
    }
  }, [newApiKey])

  const handleClearApiKey = useCallback(async (): Promise<void> => {
    try {
      await window.workmemory.settings.clearApiKey()
      setNewApiKey('')
      const updated = await window.workmemory.settings.get()
      setSettings(updated)
      toast.success('API Key 已清空')
    } catch (e) {
      toast.error('清空失败', e instanceof Error ? e.message : String(e))
    } finally {
      setConfirmAction(null)
    }
  }, [])

  // ===================== OCR 测试识别 =====================

  const handleTestOcrClick = useCallback((): void => {
    setOcrTestResult(null)
    fileInputRef.current?.click()
  }, [])

  const handleOcrFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0]
      // Reset input so the same file can be selected again
      e.target.value = ''
      if (!file) return

      // Electron extends File with a `path` property (absolute file path)
      const imagePath = (file as File & { path: string }).path
      if (!imagePath) {
        setOcrTestResult({ ok: false, error: '无法获取图片路径' })
        return
      }

      setOcrTesting(true)
      try {
        const result = await window.workmemory.ocr.testRecognize(imagePath)
        setOcrTestResult(result)
        // 测试后刷新 runtime 状态（可能首次初始化后端）
        void loadOcrRuntimeStatus()
      } catch (err) {
        setOcrTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
      } finally {
        setOcrTesting(false)
      }
    },
    [loadOcrRuntimeStatus]
  )

  const handleOpenInstallDir = useCallback(async (): Promise<void> => {
    try {
      const result = await window.workmemory.ocr.openInstallDir()
      if (!result.ok) {
        toast.error('打开目录失败', result.error ?? '未知错误')
      }
    } catch (e) {
      toast.error('打开目录失败', e instanceof Error ? e.message : String(e))
    }
  }, [])

  // ===================== 隐私规则 CRUD =====================

  const handleAddRule = useCallback(async (): Promise<void> => {
    const pattern = newRulePattern.trim()
    if (!pattern) {
      toast.warning('请输入规则匹配内容')
      return
    }
    try {
      await window.workmemory.privacy.insert({
        type: newRuleType,
        pattern,
        matchMode: newRuleMode,
        enabled: true
      })
      setNewRulePattern('')
      toast.success('已添加隐私规则')
      await loadData()
    } catch (e) {
      toast.error('添加失败', e instanceof Error ? e.message : String(e))
    }
  }, [newRuleType, newRulePattern, newRuleMode, loadData])

  const handleToggleRule = useCallback(
    async (rule: PrivacyRule): Promise<void> => {
      try {
        await window.workmemory.privacy.update(rule.id, { enabled: !rule.enabled })
        await loadData()
      } catch (e) {
        toast.error('更新失败', e instanceof Error ? e.message : String(e))
      }
    },
    [loadData]
  )

  const handleDeleteRule = useCallback(
    async (id: string): Promise<void> => {
      try {
        await window.workmemory.privacy.delete(id)
        toast.success('已删除规则')
        await loadData()
      } catch (e) {
        toast.error('删除失败', e instanceof Error ? e.message : String(e))
      } finally {
        setConfirmAction(null)
        setPendingDeleteRuleId(null)
      }
    },
    [loadData]
  )

  // ===================== 数据管理 =====================

  const handleCleanup = useCallback(async (): Promise<void> => {
    try {
      const stats = await window.workmemory.data.cleanup()
      toast.success(
        '瘦身完成',
        `删除 ${stats.deletedSegments} 片段、${stats.deletedEpisodes} 孤立事件、${stats.deletedScreenshots} 截图、${stats.orphanWikiSources} 失效引用`
      )
      await loadData()
    } catch (e) {
      toast.error('瘦身失败', e instanceof Error ? e.message : String(e))
    } finally {
      setConfirmAction(null)
    }
  }, [loadData])

  const handleClearDay = useCallback(async (): Promise<void> => {
    try {
      const result = await window.workmemory.data.clearDay(clearDayDate)
      toast.success(`已清空 ${clearDayDate}`, `${result.segments} 片段、${result.episodes} 事件`)
      await loadData()
    } catch (e) {
      toast.error('清空失败', e instanceof Error ? e.message : String(e))
    } finally {
      setConfirmAction(null)
    }
  }, [clearDayDate, loadData])

  const handleClearAll = useCallback(async (): Promise<void> => {
    try {
      const result = await window.workmemory.data.clearAll()
      toast.success(
        '已清空全部数据',
        `${result.segments} 片段、${result.episodes} 事件、${result.wikiPages ?? 0} Wiki、${result.reports ?? 0} 报告`
      )
      await loadData()
    } catch (e) {
      toast.error('清空失败', e instanceof Error ? e.message : String(e))
    } finally {
      setConfirmAction(null)
    }
  }, [loadData])

  // ===================== 整屏降级开关（首次开启弹风险提示） =====================

  /**
   * 整屏降级开关切换：
   *  - 关闭 → 开启：弹出风险提示 Dialog，用户确认后才真正开启
   *  - 开启 → 关闭：直接关闭（无需提示）
   * 默认关闭以保护隐私（窗口截图失败即跳过，绝不自动整屏）。
   */
  const handleToggleFullScreenshotFallback = useCallback(
    (nextValue: boolean): void => {
      if (!settings) return
      if (nextValue && !settings.allowFullScreenshotFallback) {
        setConfirmAction('enableFallback')
        return
      }
      void updateSettings({ allowFullScreenshotFallback: nextValue })
    },
    [settings, updateSettings]
  )

  const handleConfirmEnableFallback = useCallback(async (): Promise<void> => {
    try {
      await updateSettings({ allowFullScreenshotFallback: true })
    } finally {
      setConfirmAction(null)
    }
  }, [updateSettings])

  // ===================== 确认对话框 =====================

  const handleConfirm = useCallback((): void => {
    switch (confirmAction) {
      case 'cleanup':
        void handleCleanup()
        break
      case 'clearDay':
        void handleClearDay()
        break
      case 'clearAll':
        void handleClearAll()
        break
      case 'enableFallback':
        void handleConfirmEnableFallback()
        break
      case 'resetSettings':
        void handleResetSettings()
        break
      case 'clearApiKey':
        void handleClearApiKey()
        break
      case 'deleteRule':
        if (pendingDeleteRuleId) void handleDeleteRule(pendingDeleteRuleId)
        break
    }
  }, [
    confirmAction,
    pendingDeleteRuleId,
    handleCleanup,
    handleClearDay,
    handleClearAll,
    handleConfirmEnableFallback,
    handleResetSettings,
    handleClearApiKey,
    handleDeleteRule
  ])

  const closeConfirm = useCallback((): void => {
    setConfirmAction(null)
    setPendingDeleteRuleId(null)
  }, [])

  const confirmConfig = getConfirmConfig(confirmAction, clearDayDate)

  // ===================== 渲染 =====================

  if (loading || !settings) {
    return (
      <div className="wm-settings">
        <div className="wm-settings-loading">
          <Loader2 size={16} className="wm-settings-loading-spinner" />
          <span>正在加载设置...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="wm-settings">
      <header className="wm-settings-header">
        <div className="wm-settings-titles">
          <h1 className="wm-settings-title">设置</h1>
          <span className="wm-settings-subtitle">Settings</span>
        </div>
        <div className="wm-settings-header-actions">
          <Button variant="ghost" size="sm" onClick={() => setConfirmAction('resetSettings')}>
            重置为默认
          </Button>
        </div>
      </header>

      {/* 1. 通用 */}
      <SettingsCard
        title="通用"
        subtitle="General"
        icon={<SlidersHorizontal size={18} />}
        accent="var(--wm-color-accent)"
      >
        <SettingsRow
          label="开机自启"
          description="系统登录时自动启动 WorkMemory（以隐藏模式运行）"
        >
          <Switch
            checked={settings.autoStart}
            onCheckedChange={(v) => void updateSettings({ autoStart: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="保存截图"
          description="OCR 识别后保留截图文件，关闭则识别后立即删除"
        >
          <Switch
            checked={settings.saveScreenshots}
            onCheckedChange={(v) => void updateSettings({ saveScreenshots: v })}
          />
        </SettingsRow>
        <SettingsRow
          label="截图保留天数"
          description="超过此天数的截图将在瘦身时自动删除（0-7 天，0 表示 OCR 后即删）"
        >
          <input
            type="number"
            min={0}
            max={7}
            className="wm-settings-number-input"
            value={settings.screenshotRetentionDays}
            onChange={(e) => {
              const v = Math.max(0, Math.min(7, parseInt(e.target.value, 10) || 0))
              void updateSettings({ screenshotRetentionDays: v })
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="允许整屏降级"
          description="默认关闭。开启后，当无法截取活跃窗口时将截取整屏，可能包含其他窗口的私密内容；首次开启需确认"
        >
          <Switch
            checked={settings.allowFullScreenshotFallback}
            onCheckedChange={(v) => handleToggleFullScreenshotFallback(v)}
          />
        </SettingsRow>
      </SettingsCard>

      {/* 2. OCR */}
      <SettingsCard
        title="本地 OCR"
        subtitle="OCR"
        icon={<ScanText size={18} />}
        accent="var(--wm-color-cyan)"
      >
        <SettingsRow
          label="OCR 后端"
          description={'当前可用的 OCR 推理后端，无后端时进入"未配置"状态（截图正常，仅跳过 OCR）'}
        >
          <Badge variant={ocrRuntimeStatus?.available ? 'success' : 'danger'} size="sm">
            {ocrRuntimeStatus ? OCR_BACKEND_LABELS[ocrRuntimeStatus.type] : '检测中...'}
          </Badge>
        </SettingsRow>
        {ocrRuntimeStatus?.modelPath && (
          <SettingsRow
            label="模型路径"
            description="当前模型标记目录；实际 PP-OCRv6 tiny 模型随应用内置"
          >
            <span className="wm-settings-ocr-model-path" title={ocrRuntimeStatus.modelPath}>
              {ocrRuntimeStatus.modelPath}
            </span>
          </SettingsRow>
        )}
        <SettingsRow
          label="OCR 模型"
          description="选择本地 OCR 推理模型，切换后立即生效"
        >
          <div className="wm-settings-radio-group">
            {OCR_MODELS.map((m) => (
              <label
                key={m.id}
                className={`wm-settings-radio-card ${settings.ocrModel === m.id ? 'wm-settings-radio-card-active' : ''}`}
              >
                <input
                  type="radio"
                  name="ocr-model"
                  checked={settings.ocrModel === m.id}
                  onChange={() => void updateSettings({ ocrModel: m.id })}
                />
                <div className="wm-settings-radio-info">
                  <span className="wm-settings-radio-label">{m.label}</span>
                  <span className="wm-settings-radio-desc">{m.description}</span>
                </div>
              </label>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow
          label="测试 OCR"
          description="选择一张图片测试 OCR 识别能力，显示识别文本与耗时"
        >
          <div className="wm-settings-ocr-test-area">
            <Button
              variant="primary"
              size="sm"
              onClick={handleTestOcrClick}
              loading={ocrTesting}
            >
              {ocrTesting ? '识别中...' : '测试 OCR'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void handleOpenInstallDir()}>
              查看资源目录
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => void handleOcrFileSelected(e)}
            />
          </div>
        </SettingsRow>
        {ocrTestResult && (
          <div
            className={`wm-settings-ocr-test-result ${
              ocrTestResult.ok ? 'wm-settings-ocr-test-ok' : 'wm-settings-ocr-test-fail'
            }`}
          >
            {ocrTestResult.ok ? (
              <>
                <div className="wm-settings-ocr-test-meta">
                  识别成功，耗时 {ocrTestResult.elapsedMs ?? 0}ms
                </div>
                {ocrTestResult.text && (
                  <pre className="wm-settings-ocr-test-text">{ocrTestResult.text}</pre>
                )}
              </>
            ) : (
              <div className="wm-settings-ocr-test-meta">
                识别失败：{ocrTestResult.error ?? '未知错误'}
              </div>
            )}
          </div>
        )}
        {ocrRuntimeStatus && !ocrRuntimeStatus.available && (
          <div className="wm-settings-ocr-hint">
            未检测到内置 PP-OCRv6 runtime。请查看资源目录，或安装 Tesseract（tesseract-ocr）后重启应用。
          </div>
        )}
      </SettingsCard>

      {/* 3. AI */}
      <SettingsCard
        title="AI 大模型"
        subtitle="AI"
        icon={<Bot size={18} />}
        accent="var(--wm-color-warning)"
      >
        <SettingsRow
          label="API Base URL"
          description="OpenAI 兼容接口地址，例如 https://api.openai.com/v1；也支持完整 /chat/completions 地址"
        >
          <input
            type="text"
            className="wm-settings-text-input"
            value={settings.apiBaseUrl}
            onChange={(e) => void updateSettings({ apiBaseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </SettingsRow>
        <SettingsRow
          label="API Key"
          description="OpenAI 兼容 API Key，经 safeStorage 加密本地存储，永不回填明文"
        >
          <div className="wm-settings-apikey-area">
            <Badge variant={settings.apiKeyMasked ? 'success' : 'danger'} size="sm">
              {settings.apiKeyMasked ? `已配置：${settings.apiKeyMasked}` : '未配置'}
            </Badge>
            <input
              type="password"
              className="wm-settings-text-input"
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              placeholder="输入新的 API Key（sk-...）"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newApiKey.trim()) {
                  e.preventDefault()
                  void handleSaveApiKey()
                }
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSaveApiKey()}
              disabled={!newApiKey.trim()}
            >
              保存
            </Button>
            {settings.apiKeyMasked && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmAction('clearApiKey')}
              >
                清空 API Key
              </Button>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          label="模型名称"
          description="调用的大模型名称，例如 gpt-4o-mini、qwen-plus 等"
        >
          <input
            type="text"
            className="wm-settings-text-input"
            value={settings.modelName}
            onChange={(e) => void updateSettings({ modelName: e.target.value })}
            placeholder="gpt-4o-mini"
          />
        </SettingsRow>
        <SettingsRow
          label="连接测试"
          description="发送一个极简请求验证 API Key、接口地址与模型名称是否可用"
        >
          <div className="wm-settings-test-area">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleTestConnection()}
              loading={testing}
            >
              {testing ? '测试中...' : '测试连接'}
            </Button>
            {testResult && (
              <span className={`wm-settings-test-result ${testResult.ok ? 'wm-settings-test-ok' : 'wm-settings-test-fail'}`}>
                {testResult.ok ? <Check size={12} /> : <XCircle size={12} />}
                {testResult.message}
              </span>
            )}
          </div>
        </SettingsRow>
      </SettingsCard>

      {/* 4. 隐私 */}
      <SettingsCard
        title="隐私规则"
        subtitle="Privacy"
        icon={<Shield size={18} />}
        accent="var(--wm-color-privacy)"
      >
        <div className="wm-settings-privacy-add">
          <Select value={newRuleType} onValueChange={(v) => setNewRuleType(v as PrivacyRuleType)}>
            <SelectTrigger className="wm-settings-privacy-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIVACY_TYPES.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.label}（{t.action}）</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            type="text"
            className="wm-settings-text-input wm-settings-privacy-pattern"
            value={newRulePattern}
            onChange={(e) => setNewRulePattern(e.target.value)}
            placeholder="匹配内容（应用名/进程名/窗口标题/URL）"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleAddRule()
              }
            }}
          />
          <Select value={newRuleMode} onValueChange={(v) => setNewRuleMode(v as PrivacyMatchMode)}>
            <SelectTrigger className="wm-settings-privacy-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIVACY_MODES.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="primary" size="sm" onClick={() => void handleAddRule()}>
            添加
          </Button>
        </div>
        {privacyRules.length === 0 ? (
          <div className="wm-settings-privacy-empty">
            暂无隐私规则。添加后，匹配的窗口将被跳过或占位记录，不会进入 OCR 与日报。
          </div>
        ) : (
          <ul className="wm-settings-privacy-list">
            {privacyRules.map((rule) => {
              const typeMeta = PRIVACY_TYPES.find((t) => t.id === rule.type)
              const modeMeta = PRIVACY_MODES.find((m) => m.id === rule.matchMode)
              return (
                <li key={rule.id} className={`wm-settings-privacy-item ${!rule.enabled ? 'wm-settings-privacy-item-disabled' : ''}`}>
                  <div className="wm-settings-privacy-item-info">
                    <div className="wm-settings-privacy-item-row">
                      <Badge variant="privacy" size="sm">{typeMeta?.label ?? rule.type}</Badge>
                      <span className="wm-settings-privacy-item-pattern" title={rule.pattern}>{rule.pattern}</span>
                      <span className="wm-settings-privacy-item-mode">{modeMeta?.label ?? rule.matchMode}</span>
                      <span className="wm-settings-privacy-item-action">{typeMeta?.action ?? ''}</span>
                    </div>
                  </div>
                  <div className="wm-settings-privacy-item-actions">
                    <Switch
                      checked={rule.enabled}
                      onCheckedChange={() => void handleToggleRule(rule)}
                    />
                    <IconButton
                      label="删除"
                      icon={<Trash2 size={12} />}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setPendingDeleteRuleId(rule.id)
                        setConfirmAction('deleteRule')
                      }}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </SettingsCard>

      {/* 5. 桌面伙伴 */}
      <SettingsCard
        title="桌面伙伴"
        subtitle="Mascot"
        icon={<Sparkles size={18} />}
        accent="var(--wm-color-success)"
      >
        <SettingsRow
          label="伙伴形象"
          description="选择桌面伙伴的视觉风格，切换后立即生效"
        >
          <div className="wm-settings-mascot-grid">
            {MASCOT_STYLES.map((m) => (
              <button
                key={m.id}
                className={`wm-settings-mascot-card ${settings.mascotStyle === m.id ? 'wm-settings-mascot-card-active' : ''}`}
                onClick={() => void handleMascotStyleChange(m.id)}
              >
                <span className="wm-settings-mascot-icon">{m.icon}</span>
                <span className="wm-settings-mascot-label">{m.label}</span>
                <span className="wm-settings-mascot-desc">{m.description}</span>
              </button>
            ))}
          </div>
        </SettingsRow>
      </SettingsCard>

      {/* 6. 数据管理 */}
      <SettingsCard
        title="数据管理"
        subtitle="Data"
        icon={<Database size={18} />}
        accent="var(--wm-color-danger)"
      >
        {dataStats && (
          <div className="wm-settings-data-stats">
            <DataStatCard label="原始片段" value={dataStats.segmentCount} />
            <DataStatCard label="工作事件" value={dataStats.episodeCount} />
            <DataStatCard label="Wiki 页" value={dataStats.wikiCount} />
            <DataStatCard label="日报" value={dataStats.reportCount} />
            <DataStatCard label="截图文件" value={dataStats.screenshotCount} />
            <DataStatCard label="数据库大小" value={formatBytes(dataStats.dbSizeBytes)} />
          </div>
        )}
        <div className="wm-settings-data-actions">
          <div className="wm-settings-data-action-row">
            <div className="wm-settings-data-action-info">
              <span className="wm-settings-data-action-title">一键瘦身</span>
              <span className="wm-settings-data-action-desc">
                清理已删除片段、过期截图、孤立事件、失效 Wiki 引用
              </span>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setConfirmAction('cleanup')}>
              执行瘦身
            </Button>
          </div>
          <div className="wm-settings-data-action-row">
            <div className="wm-settings-data-action-info">
              <span className="wm-settings-data-action-title">清空指定日期</span>
              <span className="wm-settings-data-action-desc">
                删除某天的全部片段与事件（不可恢复）
              </span>
            </div>
            <div className="wm-settings-data-action-form">
              <input
                type="date"
                className="wm-settings-date-input"
                value={clearDayDate}
                onChange={(e) => setClearDayDate(e.target.value)}
              />
              <Button variant="danger" size="sm" onClick={() => setConfirmAction('clearDay')}>
                清空该日
              </Button>
            </div>
          </div>
          <div className="wm-settings-data-action-row">
            <div className="wm-settings-data-action-info">
              <span className="wm-settings-data-action-title">清空全部数据</span>
              <span className="wm-settings-data-action-desc">
                删除所有片段、事件、Wiki、报告（保留隐私规则，不可恢复）
              </span>
            </div>
            <Button variant="danger" size="sm" onClick={() => setConfirmAction('clearAll')}>
              清空全部
            </Button>
          </div>
        </div>
      </SettingsCard>

      {/* 危险操作确认 Dialog */}
      <Dialog open={confirmAction !== null} onOpenChange={(open) => { if (!open) closeConfirm() }}>
        <DialogContent className="wm-settings-confirm-dialog">
          <DialogHeader>
            <div
              className="wm-settings-confirm-icon"
              style={{ color: confirmConfig?.danger ? 'var(--wm-color-danger)' : 'var(--wm-color-warning)' }}
            >
              <AlertTriangle size={28} />
            </div>
            <DialogTitle>{confirmConfig?.title ?? '确认操作'}</DialogTitle>
            <DialogDescription>{confirmConfig?.message ?? ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={closeConfirm}>取消</Button>
            <Button
              variant={confirmConfig?.danger ? 'danger' : 'primary'}
              size="sm"
              onClick={handleConfirm}
            >
              {confirmConfig?.confirmLabel ?? '确认'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  )
}

// ===================== 设置卡片容器 =====================

interface SettingsCardProps {
  title: string
  subtitle: string
  icon: React.ReactNode
  accent: string
  children: React.ReactNode
}

function SettingsCard({ title, subtitle, icon, accent, children }: SettingsCardProps): JSX.Element {
  return (
    <Card variant="acrylic" padding="md" className="wm-settings-card">
      <header className="wm-settings-card-header">
        <div className="wm-settings-card-icon" style={{ color: accent, background: `${accent}1a` }}>
          {icon}
        </div>
        <div className="wm-settings-card-titles">
          <h2 className="wm-settings-card-title">{title}</h2>
          <span className="wm-settings-card-subtitle">{subtitle}</span>
        </div>
      </header>
      <div className="wm-settings-card-body">{children}</div>
    </Card>
  )
}

// ===================== 设置行 =====================

interface SettingsRowProps {
  label: string
  description: string
  children: React.ReactNode
}

function SettingsRow({ label, description, children }: SettingsRowProps): JSX.Element {
  return (
    <div className="wm-settings-row">
      <div className="wm-settings-row-info">
        <span className="wm-settings-row-label">{label}</span>
        <span className="wm-settings-row-desc">{description}</span>
      </div>
      <div className="wm-settings-row-control">{children}</div>
    </div>
  )
}

// ===================== 数据统计卡 =====================

function DataStatCard({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="wm-settings-data-stat">
      <span className="wm-settings-data-stat-label">{label}</span>
      <span className="wm-settings-data-stat-value">{value}</span>
    </div>
  )
}

// ===================== 工具函数 =====================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}
