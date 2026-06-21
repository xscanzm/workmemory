/**
 * 视觉验收测试数据种子脚本（B6.1）
 *
 * 用途：向 workmemory.db 注入 5 个 Episode + 20 个 Segment + 1 个 Report，
 * 用于 Today / Reports / Settings 三页截图验收。
 *
 * 用法：
 *   npx tsx scripts/seed-test-data.ts [dbPath]
 *
 * 不提供 dbPath 时，默认使用以下路径（按优先级查找）：
 *   1. %APPDATA%/WorkMemory/workmemory.db  (Windows)
 *   2. ~/.config/WorkMemory/workmemory.db  (Linux)
 *   3. ~/Library/Application Support/WorkMemory/workmemory.db  (macOS)
 *   4. ./workmemory.db  (当前目录，回退)
 *
 * 安全：脚本会先清空当天（今日）的 segments/episodes/reports 再插入，避免重复。
 * 不会触碰 wiki_pages / privacy_rules / settings。
 */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

// ========== 工具函数 ==========

function getDefaultDbPath(): string {
  const platform = os.platform()
  const home = os.homedir()
  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'WorkMemory', 'workmemory.db')
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'WorkMemory', 'workmemory.db')
  }
  return path.join(home, '.config', 'WorkMemory', 'workmemory.db')
}

function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function timeStr(h: number, m: number, s: number = 0): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ========== 测试数据定义 ==========

interface SeedSegment {
  appName: string
  processName: string
  windowTitle: string
  ocrText: string
  ocrSummary: string
  startHour: number
  startMin: number
  durationSec: number
  tags: string[]
  isImportant: boolean
}

interface SeedEpisode {
  title: string
  oneLineSummary: string
  startHour: number
  startMin: number
  endHour: number
  endMin: number
  topics: string[]
  entities: { type: 'person' | 'project' | 'document' | 'url'; name: string; confidence: number }[]
  segments: SeedSegment[]
}

const EPISODES: SeedEpisode[] = [
  {
    title: 'WorkMemory V0.4 Sprint 计划评审',
    oneLineSummary: '与团队对齐 V0.4 Trust & Beauty Sprint 的优先级，确认 OCR 容错与 UI 组件库为 P0。',
    startHour: 9,
    startMin: 0,
    endHour: 10,
    endMin: 30,
    topics: ['Sprint计划', '优先级评审', 'V0.4'],
    entities: [
      { type: 'person', name: '张伟', confidence: 0.85 },
      { type: 'person', name: '李娜', confidence: 0.78 },
      { type: 'project', name: 'WorkMemory V0.4', confidence: 0.92 },
      { type: 'document', name: 'Sprint计划.md', confidence: 0.88 }
    ],
    segments: [
      {
        appName: '飞书',
        processName: 'feishu.exe',
        windowTitle: '飞书 - WorkMemory V0.4 Sprint 评审群',
        ocrText: 'WorkMemory V0.4 Trust & Beauty Sprint\n\n优先级排序：\n1. OCR 启动容错（P0）\n2. API Key 加密存储（P0）\n3. 截图隐私修复（P0）\n4. IPC schema 校验（P0）\n5. UI 组件库（P0）\n6. Today + Reports 重构\n7. 富文本复制 + .docx 导出\n8. 视觉验收',
        ocrSummary: 'V0.4 Sprint 优先级评审，确认 8 项 P0 任务',
        startHour: 9,
        startMin: 0,
        durationSec: 1800,
        tags: ['会议', 'Sprint'],
        isImportant: true
      },
      {
        appName: 'VS Code',
        processName: 'code.exe',
        windowTitle: 'spec.md - WorkMemory - Visual Studio Code',
        ocrText: '## Phase A：可信可运行\n- Task A0：环境基线\n- Task A1：OCR 启动容错\n- Task A2：API Key 加密\n- Task A3：截图降级修复\n- Task A4：IPC schema 校验',
        ocrSummary: '查看 spec.md 中 Phase A 任务清单',
        startHour: 9,
        startMin: 30,
        durationSec: 1200,
        tags: ['文档', 'spec'],
        isImportant: false
      },
      {
        appName: '飞书',
        processName: 'feishu.exe',
        windowTitle: '飞书 - 张伟',
        ocrText: '张伟：OCR 容错这块我觉得要先做，不然新机器直接崩\n李娜：同意，API Key 加密也要同步推进\n张伟：那 IPC 校验放 A4，跟在前面三个后面',
        ocrSummary: '与张伟李娜讨论 OCR 与 API Key 优先级',
        startHour: 10,
        startMin: 0,
        durationSec: 1800,
        tags: ['沟通', '优先级'],
        isImportant: true
      }
    ]
  },
  {
    title: 'UI 组件库开发',
    oneLineSummary: '完成 Button/Card/Dialog/Toast 等 13 个统一组件，建立 src/ui/ 组件体系。',
    startHour: 10,
    startMin: 45,
    endHour: 12,
    endMin: 30,
    topics: ['UI组件库', 'Radix UI', '设计系统'],
    entities: [
      { type: 'project', name: 'src/ui/', confidence: 0.95 },
      { type: 'url', name: 'https://radix-ui.com', confidence: 0.9 }
    ],
    segments: [
      {
        appName: 'VS Code',
        processName: 'code.exe',
        windowTitle: 'Button.tsx - workmemory - Visual Studio Code',
        ocrText: 'export const Button = forwardRef<HTMLButtonElement, ButtonProps>(\n  ({ variant, size, loading, leftIcon, rightIcon, fullWidth, ...props }, ref) => {\n    // variants: primary/secondary/ghost/danger\n    // sizes: sm/md/lg\n  }\n)',
        ocrSummary: '编写 Button 组件，支持 4 变体 3 尺寸',
        startHour: 10,
        startMin: 45,
        durationSec: 2400,
        tags: ['编码', 'Button'],
        isImportant: true
      },
      {
        appName: 'Chrome',
        processName: 'chrome.exe',
        windowTitle: 'Radix UI Primitives — Documentation',
        ocrText: 'Radix UI\n\nAccessible, unstyled, open-source React primitives.\n\nComponents: Dialog, Tooltip, Popover, Menu, Switch, Select, Tabs, Toast...\n\n"An unstyled component library"',
        ocrSummary: '查阅 Radix UI 文档，确认可用组件',
        startHour: 11,
        startMin: 30,
        durationSec: 900,
        tags: ['调研', 'Radix'],
        isImportant: false
      },
      {
        appName: 'VS Code',
        processName: 'code.exe',
        windowTitle: 'Dialog.tsx - workmemory - Visual Studio Code',
        ocrText: 'import * as DialogPrimitive from "@radix-ui/react-dialog"\n\nexport const DialogContent = forwardRef<...>(({ children, ...props }, ref) => (\n  <DialogPrimitive.Portal>\n    <DialogPrimitive.Overlay className="wm-ui-dialog-overlay" />\n    <DialogPrimitive.Content ref={ref} className="wm-ui-dialog-content" {...props}>\n      {children}\n      <DialogPrimitive.Close className="wm-ui-dialog-close">\n        <X size={16} />\n      </DialogPrimitive.Close>\n    </DialogPrimitive.Content>\n  </DialogPrimitive.Portal>\n))',
        ocrSummary: '实现 Dialog 组件，基于 Radix Dialog',
        startHour: 11,
        startMin: 45,
        durationSec: 2700,
        tags: ['编码', 'Dialog'],
        isImportant: true
      }
    ]
  },
  {
    title: 'API Key 加密存储实现',
    oneLineSummary: '使用 Electron safeStorage 加密 API Key，settings.json 不再出现明文。',
    startHour: 14,
    startMin: 0,
    endHour: 15,
    endMin: 30,
    topics: ['安全', 'safeStorage', 'API Key'],
    entities: [
      { type: 'document', name: 'SettingsStore.ts', confidence: 0.93 },
      { type: 'url', name: 'https://electron.org/docs/api/safeStorage', confidence: 0.85 }
    ],
    segments: [
      {
        appName: 'VS Code',
        processName: 'code.exe',
        windowTitle: 'SettingsStore.ts - workmemory - Visual Studio Code',
        ocrText: 'import { safeStorage } from "electron"\n\nfunction encryptApiKey(plain: string): string {\n  if (safeStorage.isEncryptionAvailable()) {\n    return safeStorage.encryptString(plain).toString("base64")\n  }\n  // Linux sandbox 回退：XOR 混淆\n  return xorFallback(plain)\n}',
        ocrSummary: '实现 API Key 加密，使用 safeStorage + XOR 回退',
        startHour: 14,
        startMin: 0,
        durationSec: 3000,
        tags: ['编码', '加密'],
        isImportant: true
      },
      {
        appName: 'Chrome',
        processName: 'chrome.exe',
        windowTitle: 'safeStorage | Electron Documentation',
        ocrText: 'safeStorage\n\nProcess: Main\n\nThis module allows you to easily protect user data stored on disk by using OS-level encryption.\n\nOn Windows: uses DPAPI\nOn macOS: uses Keychain\nOn Linux: uses libsecret',
        ocrSummary: '查阅 Electron safeStorage 文档',
        startHour: 14,
        startMin: 50,
        durationSec: 600,
        tags: ['调研', '文档'],
        isImportant: false
      },
      {
        appName: '终端',
        processName: 'powershell.exe',
        windowTitle: 'PowerShell - workmemory',
        ocrText: '> npm run typecheck\n> tsc --noEmit\n\n> npm run lint\n> eslint . --ext .ts,.tsx --max-warnings 0\n\n> npm run build\n> vite build\n✓ built in 3.95s',
        ocrSummary: '运行 typecheck/lint/build 验证',
        startHour: 15,
        startMin: 0,
        durationSec: 1800,
        tags: ['验证', '构建'],
        isImportant: false
      }
    ]
  },
  {
    title: 'FTS5 全文搜索实现',
    oneLineSummary: '为 segments/episodes/wiki 添加 SQLite FTS5 虚拟表与同步触发器，Search 页改用 MATCH 查询。',
    startHour: 16,
    startMin: 0,
    endHour: 17,
    endMin: 15,
    topics: ['FTS5', '搜索', 'SQLite'],
    entities: [
      { type: 'document', name: 'SearchRepository.ts', confidence: 0.9 },
      { type: 'project', name: 'fts_segments', confidence: 0.88 }
    ],
    segments: [
      {
        appName: 'VS Code',
        processName: 'code.exe',
        windowTitle: 'schema.ts - workmemory - Visual Studio Code',
        ocrText: 'CREATE VIRTUAL TABLE IF NOT EXISTS fts_segments USING fts5(\n  segment_id UNINDEXED,\n  ocr_text,\n  tokenize = "unicode61"\n);\n\nCREATE TRIGGER fts_segments_ai AFTER INSERT ON segments BEGIN\n  INSERT INTO fts_segments(segment_id, ocr_text) VALUES (new.id, new.ocr_text);\nEND;',
        ocrSummary: '编写 FTS5 虚拟表与同步触发器',
        startHour: 16,
        startMin: 0,
        durationSec: 2400,
        tags: ['编码', 'FTS5'],
        isImportant: true
      },
      {
        appName: 'SQLite Browser',
        processName: 'sqlitebrowser.exe',
        windowTitle: 'DB Browser for SQLite - workmemory.db',
        ocrText: 'SELECT segment_id, snippet(fts_segments, 1, "«", "»", "...", 10) as preview\nFROM fts_segments\nWHERE fts_segments MATCH "API Key"\nORDER BY rank;\n\n-- 结果：\n-- seg_xxx | «API» «Key» 加密存储实现...使用 safeStorage',
        ocrSummary: '测试 FTS5 MATCH 查询与 snippet 函数',
        startHour: 16,
        startMin: 40,
        durationSec: 1500,
        tags: ['测试', 'FTS5'],
        isImportant: false
      }
    ]
  },
  {
    title: '日报生成与导出验证',
    oneLineSummary: '生成今日日报，复制富文本到飞书，导出 .docx 用 Word 打开，格式正确。',
    startHour: 17,
    startMin: 30,
    endHour: 18,
    endMin: 30,
    topics: ['日报', '导出', '验证'],
    entities: [
      { type: 'document', name: '日报_2026-06-20.docx', confidence: 0.92 },
      { type: 'person', name: '王芳', confidence: 0.65 }
    ],
    segments: [
      {
        appName: 'WorkMemory',
        processName: 'workmemory.exe',
        windowTitle: 'WorkMemory - 日报中心',
        ocrText: '今日日报\n2026年6月20日\n\n## 今日完成\n1. WorkMemory V0.4 Sprint 计划评审（9:00-10:30）\n2. UI 组件库开发（10:45-12:30）\n3. API Key 加密存储实现（14:00-15:30）\n4. FTS5 全文搜索实现（16:00-17:15）\n\n## 明日计划\n- 富文本复制验证\n- .docx 导出验证\n- 视觉截图验收',
        ocrSummary: '生成今日日报，包含 4 项完成 + 3 项明日计划',
        startHour: 17,
        startMin: 30,
        durationSec: 1800,
        tags: ['日报', '生成'],
        isImportant: true
      },
      {
        appName: '飞书',
        processName: 'feishu.exe',
        windowTitle: '飞书 - 工作日报群',
        ocrText: '王芳：今天的日报看起来很完整\n我：是的，富文本复制过来格式保留了\n王芳：标题和列表都在，不错',
        ocrSummary: '将日报粘贴到飞书，格式保留',
        startHour: 18,
        startMin: 0,
        durationSec: 1800,
        tags: ['沟通', '验证'],
        isImportant: false
      }
    ]
  }
]

// ========== 种子逻辑 ==========

function seed(dbPath: string): void {
  console.log(`[seed] 数据库路径: ${dbPath}`)
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  const today = todayStr()
  console.log(`[seed] 今日: ${today}`)

  // 清空今日数据（仅 segments/episodes/reports，不动 wiki/settings/privacy_rules）
  console.log('[seed] 清空今日 segments/episodes/reports...')
  db.prepare(`DELETE FROM segments WHERE date = ?`).run(today)
  db.prepare(`DELETE FROM episodes WHERE date = ?`).run(today)
  db.prepare(`DELETE FROM reports WHERE date = ?`).run(today)

  // 插入 segments + episodes
  let segmentCount = 0
  for (const ep of EPISODES) {
    const episodeId = randomUUID()
    const segmentIds: string[] = []

    for (const seg of ep.segments) {
      const segId = randomUUID()
      const startTotalSec = seg.startHour * 3600 + seg.startMin * 60
      const endTotalSec = startTotalSec + seg.durationSec
      const endHour = Math.floor(endTotalSec / 3600)
      const endMin = Math.floor((endTotalSec % 3600) / 60)
      const endSec = endTotalSec % 60

      db.prepare(
        `INSERT INTO segments (
          id, date, start_time, end_time, duration_seconds, app_name, process_name,
          window_title, ocr_text, ocr_summary, image_hash, screenshot_path,
          is_selected_for_report, is_private, is_important, is_deleted, source_status,
          user_title, user_summary, user_note, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        segId,
        today,
        timeStr(seg.startHour, seg.startMin),
        timeStr(endHour, endMin, endSec),
        seg.durationSec,
        seg.appName,
        seg.processName,
        seg.windowTitle,
        seg.ocrText,
        seg.ocrSummary,
        randomUUID().slice(0, 16),
        '',
        1,
        0,
        seg.isImportant ? 1 : 0,
        0,
        'ocr_done',
        '',
        '',
        '',
        JSON.stringify(seg.tags)
      )
      segmentIds.push(segId)
      segmentCount++
    }

    db.prepare(
      `INSERT INTO episodes (
        id, date, start_time, end_time, title, one_line_summary,
        segment_ids, entities, topics, user_edited, report_eligible, wiki_eligible
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      episodeId,
      today,
      timeStr(ep.startHour, ep.startMin),
      timeStr(ep.endHour, ep.endMin),
      ep.title,
      ep.oneLineSummary,
      JSON.stringify(segmentIds),
      JSON.stringify(ep.entities),
      JSON.stringify(ep.topics),
      0,
      1,
      1
    )

    console.log(`[seed] Episode: ${ep.title} (${segmentIds.length} segments)`)
  }

  // 插入一份今日日报草稿
  const reportId = randomUUID()
  const reportMarkdown = `# 今日日报 — ${today}

## 今日完成

1. **WorkMemory V0.4 Sprint 计划评审**（9:00-10:30）
   - 与团队对齐 V0.4 Trust & Beauty Sprint 的优先级
   - 确认 OCR 容错与 UI 组件库为 P0

2. **UI 组件库开发**（10:45-12:30）
   - 完成 Button/Card/Dialog/Toast 等 13 个统一组件
   - 建立 src/ui/ 组件体系

3. **API Key 加密存储实现**（14:00-15:30）
   - 使用 Electron safeStorage 加密 API Key
   - settings.json 不再出现明文

4. **FTS5 全文搜索实现**（16:00-17:15）
   - 为 segments/episodes/wiki 添加 FTS5 虚拟表
   - Search 页改用 MATCH 查询

## 明日计划

- 富文本复制验证
- .docx 导出验证
- 视觉截图验收

## 风险与阻塞

- 无
`

  db.prepare(
    `INSERT INTO reports (
      id, date, template_id, template_name, segment_ids, ai_input_snapshot,
      markdown_content, status, report_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    reportId,
    today,
    'enhanced',
    '增强版日报',
    '[]',
    '',
    reportMarkdown,
    'draft',
    'daily'
  )

  console.log(`[seed] Report: 日报草稿 (${reportMarkdown.length} chars)`)
  console.log(`[seed] 完成！共 ${EPISODES.length} Episodes + ${segmentCount} Segments + 1 Report`)

  db.close()
}

// ========== 入口 ==========

const dbPath = process.argv[2] || getDefaultDbPath()
try {
  seed(dbPath)
} catch (err) {
  console.error('[seed] 失败:', err)
  process.exit(1)
}
