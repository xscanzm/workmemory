# 迁移至 Tauri + Windows OCR API + 功能与伙伴大升级 Spec

## Why

当前 WorkMemory 存在三类核心问题：

1. **运行时过重**：Electron + PP-OCRv6 安装包 ~300MB，启动内存 ~200MB，与"常驻后台工作记忆助手"定位相悖。Windows 10+ 内置 Windows OCR API 可替代 PP-OCRv6（~200MB 模型 + Python runtime），Tauri/Rust 可替代 Electron。
2. **P0–P3 工程缺陷累积**：`runtimeLog.ts` 缺失导致 OCR 模块编译失败、服务停止逻辑双重执行、日志体系分裂、Bootstrap 失败无感知、IPC 边界类型缺失、sandbox 关闭、CSP 硬编码、无 test 脚本等。
3. **功能层缺失核心能力**：捕获层无专注连续时长统计、Episode 无跨天连续性、无手动记忆入口、无待办提取；搜索层无时间语义与人物时间线；报告层无站会模板与自动发送；Wiki 层无图谱可视化与过期提醒；洞察层无实时专注感知与目标对齐；Today 页面无时间轴视图。
4. **桌面伙伴体验单薄**：无首次启动引导、无呼吸动画、状态视觉区分不清、无情绪维度、气泡无 Action Button、无免打扰时段、形象缺乏角色人格、无深色模式、未与主窗口状态同步。

本变更将主进程从 Electron/Node.js 迁移至 Tauri/Rust，OCR 引擎切换为 Windows OCR API，修复 P0–P3 工程缺陷，并新增功能层能力与桌面伙伴大升级。渲染进程（React + Vite）保持不变，仅替换 IPC 调用层并新增页面/组件。

## What Changes

### Phase 0：P0 验证与阻塞性修复（在 Electron 现有架构上完成）
- **新增** `electron/runtimeLog.ts`：被 `electron/ocr/OcrQueue.ts` 与 `electron/ocr/PpOcrEngine.ts` 引用但文件不存在，导致 OCR 模块编译失败。统一日志写入 `app.getPath('userData')/runtime.log`，使用 `app.getName()` 而非硬编码 `'WorkMemory'`。
- **运行** `npm run typecheck && npm run build` 验证 P0 描述的"模板字面量插值缺失"问题。经源码核查，`OpenAIClient.ts` 的 `getChatCompletionsUrl`、`Authorization` 头、`migrations.ts` 的 `addSegmentColumn`、`validatedHandler.ts` 的 `unwrapResult`、`main/index.ts` 的 `logMain` 调用中模板字面量在源码中均存在且正确，疑似 E2B 读取工具的渲染问题。仍需以编译输出为准。
- **验证结论（P0.1 已完成）**：`npm install --ignore-scripts` 后运行 `npm run typecheck`，编译输出仅报 `electron/ocr/OcrQueue.ts` 与 `electron/ocr/PpOcrEngine.ts` 的 `Cannot find module '../runtimeLog'` 错误（即 P0.2），无任何模板字面量插值相关错误。确认"模板字面量插值缺失"为 E2B 读取工具渲染问题，非真实代码缺陷。创建 `electron/runtimeLog.ts` 后 typecheck 完全通过。
- **修复** `electron/main/index.ts` 服务停止逻辑双重执行：提取 `stopAllServices()` 公共函数，仅在 `before-quit` 中执行。
- **修复** `PrivacyGuard.seedDefaultRules()` 双重调用：从 `bootstrap()` 移除直接调用，统一由 `CaptureManager.startCapture()` 负责。
- **修复** Bootstrap 失败用户无感知：`bootstrap().catch()` 中通过 `dialog.showErrorBox()` 展示错误摘要。
- **BREAKING** 删除 `electron/runtimeLog.ts` 中对 `process.env.APPDATA` 的依赖。

### Phase 1：Tauri 壳搭建
- **新增** `src-tauri/` 目录：`Cargo.toml`、`tauri.conf.json`、`build.rs`、`src/main.rs`、`src/lib.rs`。
- **新增** Tauri 配置：无边框主窗口（`decorations: false`）、最小尺寸 960×640、初始 1280×800、`titleBarStyle: 'Overlay'`。
- **新增** Tauri 透明置顶 Mascot 窗口配置（`transparent: true`、`alwaysOnTop: true`、`skipTaskbar: true`）。
- **新增** `src-tauri/Cargo.toml` 依赖：`tauri`、`rusqlite`（bundled）、`windows`（Win32_Graphics_Gdi、Win32_UI_WindowsAndMessaging、Media_Ocr、Graphics_Imaging、Foundation）、`reqwest`、`tokio`、`serde`、`ort`（ONNX Runtime）。
- **BREAKING** 移除 `electron`、`electron-builder`、`vite-plugin-electron`、`better-sqlite3`、`koffi` 依赖。
- **BREAKING** `package.json` `main` 字段移除，`scripts.dev` 改为 `tauri dev`，`scripts.dist` 改为 `tauri build`。

### Phase 2：核心原生模块迁移（Rust 实现）
- **新增** `src-tauri/src/db/`：用 `rusqlite` 重写 `database.rs`、`migrations.rs`、`schema.rs`、`fts_tokenizer.rs`，保持与现有 18 个迁移版本号一致。
- **新增** `src-tauri/src/db/repositories/`：逐个迁移 18 个 Repository。
- **新增** `src-tauri/src/capture/window_watcher.rs`：用 `windows` crate 调用 `user32.dll` 替换 `koffi` FFI。
- **新增** `src-tauri/src/capture/screenshot.rs`：用 `windows` crate 的 `Win32_Graphics_Gdi` 实现截图，替换 `desktopCapturer`。
- **新增** `src-tauri/src/capture/` 其余模块：`capture_manager.rs`、`capture_decision.rs`、`privacy_guard.rs`、`incognito_detector.rs`、`episode_builder.rs`、`episode_manager.rs`、`activity_classifier.rs`、`content_classifier.rs`、`browser_context_collector.rs`、`layout_analyzer.rs`、`action_flow_inferrer.rs`、`one_line_summary.rs`、`entity_extractor.rs`。
- **新增** `src-tauri/src/events/bus.rs`：用 `tokio::sync::broadcast` 替换 Node `EventEmitter`。

### Phase 3：OCR 引擎迁移至 Windows OCR API
- **新增** `src-tauri/src/ocr/windows_ocr_engine.rs`：通过 `windows` crate 的 `Media::Ocr::OcrEngine` 调用系统 OCR。`OcrEngine::TryCreateFromUserProfileLanguages()` 获取引擎，`SoftwareBitmap::CreateCopyFromBuffer()` 转 bitmap，`engine.RecognizeAsync(bitmap).await` 返回 `OcrResult`。
- **新增** `src-tauri/src/ocr/ocr_queue.rs`、`ocr_manager.rs`、`ocr_text_cleaner.rs`、`ocr_runtime_manager.rs`：保持现有接口契约，仅替换底层引擎。
- **BREAKING** 删除 `electron/ocr/` 全部文件、`resources/ocr/` 目录、`scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`。
- **BREAKING** `OcrModel` 保留但仅作占位（Windows OCR API 无 tiny/small 之分）。
- **BREAKING** `BackendStatus.type` 改为 `'windows_ocr' | 'unconfigured'`。

### Phase 4：业务模块迁移
- **新增** `src-tauri/src/ai/`：`openai_client.rs`（含流式）、`ai_manager.rs`、`distill_manager.rs`、`daily_distill_manager.rs`、`weekly_pattern_detector.rs`、`reflection_engine.rs`、`skill_evolver.rs`、`report_generator.rs`、`report_exporter.rs`、`html_exporter.rs`、`feedback_loop.rs`、`proactive_advisor.rs`、`hour_context_pack_builder.rs`、`sensitive_masker.rs`、`templates.rs`、`distill_prompt.rs`、`schemas/distill_event_schema.rs`。
- **新增** `src-tauri/src/ai/openai_client.rs` 流式输出：`chat_completion_stream()` 通过 Tauri `app_handle.emit()` 将 delta 推送至渲染进程（解决 P3-17）。
- **新增** `src-tauri/src/memory/`：`embedding_service.rs`（用 `ort` crate 加载 multilingual-e5-small）、`mem_cell.rs`、`mem_cell_indexer.rs`、`mem_scene_clusterer.rs`、`user_profile_evolver.rs`。
- **新增** `src-tauri/src/wiki/`、`src-tauri/src/insights/`、`src-tauri/src/mascot/`。
- **新增** `src-tauri/src/main.rs` bootstrap：用 Tauri `Builder::default().setup()` 替换 `app.whenReady().then(bootstrap)`。

### Phase 5：IPC 层迁移
- **新增** `src-tauri/src/ipc/`：将 `electron/main/ipc.ts` 中所有 `validatedHandler` 注册迁移为 `#[tauri::command]` 函数。命令名保持与现有 `*Channels` 常量一致。
- **新增** `src-tauri/src/ipc/schemas.rs`：用 `serde` 反序列化 + 手写校验替换 Zod schema。
- **修改** `src/hooks/useIpc.ts`：`window.workmemory.xxx.yyy()` 替换为 `invoke('xxx:yyy', { ... })`。
- **修改** `src/store/recordingStore.ts`：`refreshTrigger: number` 改为事件型刷新标识（解决 P3-15）：`RefreshFlags { segments: number; episodes: number; wiki: number }`。
- **BREAKING** 删除 `electron/preload/index.ts`、`electron/types/ipc.ts` 中的通道常量（保留类型定义供渲染进程复用，迁移至 `src/types/ipc.ts`）。
- **修改** `src/types/index.ts`：将 preload 中 `unknown` 类型替换为具体类型（解决 P1-6）。
- **修改** 渲染进程事件监听：`ipcRenderer.on(...)` 替换为 `listen(...)`。

### Phase 6：构建与打包
- **新增** `src-tauri/tauri.conf.json` 完整配置：`bundle.targets: ['nsis']`，NSIS 配置与现有 electron-builder 对齐。
- **修改** `vite.config.ts`：移除 `vite-plugin-electron` 与 `vite-plugin-electron-renderer`。
- **修改** CSP：使用 Tauri `tauri.conf.json` 的 `app.security.csp`，开发环境保留 `localhost:5173`，生产环境移除（解决 P2-8）。
- **BREAKING** 删除 `package.json` 的 `build` 字段。

### Phase 7：P2/P3 工程质量改进
- **修改** `tsconfig.json`：`exactOptionalPropertyTypes` 改为 `true`（P2-9）。
- **修改** `package.json` `scripts`：新增 `"test": "vitest run"` 与 `"test:watch": "vitest"`（P2-10）。
- **修改** `.eslintrc.cjs`：`ignorePatterns` 仅保留 `['dist', 'dist-electron', 'release', 'node_modules']`（P2-11）；`no-empty` 改为 `['warn', { allowEmptyCatch: false }]`（P2-13）。
- **修改** `src/App.tsx`：为每个主路由增加 `<ErrorBoundary>` 包裹（P3-16）。
- **修改** `src-tauri/src/db/database.rs`：WAL 模式下新增 `wal_checkpoint(TRUNCATE)` 策略（P3-18）。
- **修改** `src-tauri/src/main.rs` bootstrap：将 `evolveProfile`、`distillDay`、`detectPatterns` 三项独立任务改为 `tokio::join!` 并行执行（P3-14）。
- **Tauri 默认沙箱**：自动解决 P2-7 `sandbox: false`。
- **移除** `setMainWindow` 导出（P2-12）。

### Phase 8：捕获与理解层增强 — 让"看见"更有意义
- **新增** `src-tauri/src/capture/focus_streak_tracker.rs`：在 WindowWatcher 层记录每个窗口的连续专注时段（不中断时长），存入 `Segment.metadata.focusStreak`，供 WeeklyPatternDetector 分析"碎片化程度"趋势。
- **新增** `src-tauri/src/capture/episode_manager.rs` cross-day linker：对同一天内 Episode 计算 title embedding，检测与过去 7 天内 Episode 的相似度 > 0.8，建立 `relatedEpisodeIds[]` 字段。
- **修改** `episodes` 表 schema：新增 `related_episode_ids TEXT NOT NULL DEFAULT '[]'`（迁移版本 19）。
- **新增** `src/pages/Today.tsx` "+ 添加记忆" 按钮：支持标题/标签/关联项目/自由文本，写入 Episode（`source: 'manual'`、`reportEligible: true`），不触发 OCR。
- **修改** `episodes` 表 schema：`source` 字段增加 `'manual'` 枚举值。
- **新增** `src-tauri/src/capture/todo_extractor.rs`：在 EpisodeBuilder 中正则 + 简单 AI 提取 OCR 文本中的待办条目（TODO/待办/下一步/Action Item 关键词），存入 `Episode.todos[]`。
- **修改** `src/pages/Today.tsx` 侧栏：展示当日待办汇总，支持一键勾选完成，触发 `triggerEpisodeRefresh`。
- **新增** IPC 命令 `episode:addManual`、`episode:toggleTodo`、`episode:getRelated`。

### Phase 9：搜索层增强 — 让"查找"更自然
- **新增** `src-tauri/src/ai/query_parser.rs`：轻量 query parser（单次 AI 调用，<100 tokens），解析时间语义（"上周五下午" → 时间范围）、实体语义（"和张三开会的时候" → entity:张三 + type:meeting）、聚合语义（"做 XX 项目最长的那天" → 按 project 聚合时长排序）。
- **修改** `src-tauri/src/db/repositories/search_repository.rs`：`hybrid` 命令支持解析后的结构化查询条件（时间范围 + entity + type + 聚合维度）。
- **新增** `SearchRepository.get_by_entity(name: String) -> Vec<Episode>`：按实体（人/项目）聚合返回相关 Episode。
- **新增** `src/components/EntityTimeline.tsx`：Search 页面增加"人物时间线"视图，按实体聚合展示所有相关 Episode 的时间轴。
- **修改** `src/pages/Search.tsx`：增加实体维度切换（关键词搜索 / 人物时间线）。

### Phase 10：报告层增强 — 让"输出"更实用
- **新增** `src-tauri/src/ai/templates.rs` `standup` 模板：昨天做了什么（Yesterday）/ 今天计划做什么（Today，从 todos 字段提取）/ 有什么阻塞（Blockers，从 CleanEpisode.blockers[] 提取），输出纯文本适合粘贴群聊。
- **修改** `episodes` 表 schema：新增 `blockers TEXT NOT NULL DEFAULT '[]'`（迁移版本 20），供 standup 模板提取。
- **新增** `src-tauri/src/insights/reminder_scheduler.rs` 周报自动提醒：每周五 17:30 推送 Mascot 气泡"本周报告已就绪，点击查看"；可配置周报/日报自动生成时间。
- **新增** 报告导出格式：`.md` 文件 / 复制到剪贴板（复用现有 `writeClipboard` IPC）。
- **新增** `src/pages/Reports.tsx` "对比模式"：选择两份日报/周报左右对比展示，高亮新增项目、消失项目、时间占比变化。数据源：`daily_distills` + `weekly_patterns` 表。
- **新增** `src/components/ReportCompare.tsx`：对比视图组件。

### Phase 11：Wiki 知识层增强 — 让"沉淀"更可用
- **修改** `src/pages/Graph.tsx` 增强：节点大小 = 被引用次数，节点颜色 = `wiki_type`（人/项目/决策/问题），点击节点右侧预览 WikiPage 内容，悬停边显示 Episode 引用来源。
- **修改** `wiki_pages` 表 schema：新增 `last_accessed_at TEXT`（迁移版本 21）。
- **新增** `WikiRepository.touch_accessed(id)`：Episode 引用 WikiPage 时更新 `last_accessed_at`。
- **新增** `WikiRepository.get_stale(days: i64)`：返回超过 N 天未被引用的 WikiPage，标记为"待复核"。
- **修改** `src/pages/Insights.tsx`：新增"知识库健康度"卡片（陈旧 / 活跃 / 近期新增）。
- **新增** `src/pages/Settings.tsx` "导入笔记"功能：支持 `.md` 文件夹（Obsidian vault）/ Notion export zip，解析 `[[双链]]` 语法转为 WikiPage backlinks，与 WikiIngestManager confirm 流程对接（先进审核队列）。
- **新增** `src-tauri/src/wiki/note_importer.rs`：Markdown 解析 + 双链转换 + 审核队列注入。

### Phase 12：洞察层增强 — 让"建议"更聪明
- **新增** `src-tauri/src/insights/focus_state_detector.rs`：连续专注同一窗口 > 25min → Mascot 提示"休息一下（番茄钟）"；窗口切换频率 > 10次/5min → 提示"检测到注意力分散"。
- **修改** `src-tauri/src/mascot/mascot_manager.rs`：状态机新增 `state: 'focused'`，与 FocusStateDetector 集成。
- **新增** `goals` 表（迁移版本 22）：`{ id, week_start, goal_text, created_at }`，存储用户每周设定的 3 条周目标。
- **新增** `src-tauri/src/insights/goal_alignment_analyzer.rs`：用户设定 3 条周目标（自然语言），每天的 CleanEpisode 自动打标"与目标 N 相关"，WeeklyPattern 报告增加"目标达成情况"章节。
- **新增** `src/pages/Settings.tsx` 周目标设置入口。
- **修改** `src/pages/Today.tsx`：增加 24h 时间轴视图（参考 Timing/RescueTime），色块 = Episode 类型，宽度 = 时长，点击色块右侧展示 Episode 详情，空白区域 = 未记录时段点击可手动补充。
- **新增** `src/components/Timeline24h.tsx`：24 小时时间轴组件。
- **修改** `src/pages/Insights.tsx` 或 `src/pages/Settings.tsx`：新增"记录健康度"卡片：OCR 识别率、今日记录覆盖率、Wiki 知识库大小 & 增长趋势、AI 调用次数 & token 消耗。
- **新增** `ai_usage` 表（迁移版本 23）：`{ id, called_at, model, prompt_tokens, completion_tokens, feature }`，记录 AI 调用成本。

### Phase 13：桌面伙伴大升级 — 存在感、情感、主动触达、视觉、集成

#### 13.1 存在感设计
- **新增** `src/pages/Mascot.tsx` 首次启动引导动画：伙伴从屏幕底部"飞入"停在右下角，气泡依次展示自我介绍（"嗨！我是你的工作记忆助手"、"我会在后台记录你的工作"、"点击我随时查看今日记忆，或右键呼出菜单"），轻轻抖动等待用户点击。
- **新增** `src/pages/Mascot.css` 呼吸动画：录制中 `breathing`（scale 1.0↔1.04）、扫描中 `scanning`（opacity 0.6↔1.0）、空闲 `floating`（translateY 0↔-4px）。
- **修改** Mascot 5 种状态视觉信号：`recording`（小红点 + 呼吸动画 + 绿色光晕）、`paused`（灰度滤镜 + 暂停图标角标）、`privacy`（双手捂眼动作 / 遮眼拉帘）、`ocr_scanning`（扫描线动画 + 眼睛追踪）、`report_ready`（金色高亮 + 弹跳提示 + 角标数字）。

#### 13.2 情感与个性设计
- **新增** `MascotEmotion` 类型：`happy | focused | concerned | curious | proud | sleepy`，与功能状态独立叠加，影响眼睛形状、气泡语气、动画速度。
- **新增** 上下文感知问候语生成器：`morning_start`、`after_focus`、`report_ready`、`late_night`、`monday_morning`、`first_episode` 等场景化问候。
- **修改** Mascot 点击互动分层：左键单击（有未读报告→跳转报告页；有待办→展示今日待办气泡；否则→随机励志短句 2s 消失）；右键单击上下文菜单（今日记忆/暂停记录/快速记一笔/设置/隐藏 10min）；右键双击触发 Ghost 捕获（动画强化）；悬停展示今日摘要 tooltip + 眼神追踪。

#### 13.3 主动触达升级
- **新增** `ReminderTrigger` 枚举：时间驱动 `SCHEDULED`；行为驱动 `FOCUS_25MIN`、`FRAGMENTED_5MIN`、`IDLE_30MIN`、`LATE_WORK`；事件驱动 `REPORT_READY`、`WIKI_REVIEW_DUE`、`SKILL_UNLOCKED`。
- **修改** `BubblePayload`：新增 `actions?: Array<{ label: string; page?: string; action?: string }>`，气泡支持 Action Button（如"查看报告"/"稍后提醒"），点击通过 `invoke(MascotChannels.Navigate)` 路由。
- **新增** `src/pages/Settings.tsx` 桌面伙伴设置区：启用主动提醒、免打扰时段（如 09:00–11:00 深度工作保护）、提醒间隔下限（30 分钟防刷屏）、工作日仅工作时间提醒（09:00–18:00）。
- **修改** `app_settings` 表：新增 `mascot_dnd_start`、`mascot_dnd_end`、`mascot_min_interval_min`、`mascot_work_hours_only` 字段（迁移版本 24）。

#### 13.4 视觉设计提升
- **新增** 5 种形象角色人格设计：`note`（备忘录小鸟，认真负责）、`film`（胶片小熊，浪漫文艺）、`copilot`（宇航员猫，高效专业）、`cursor`（光标精灵，灵动活泼）、`paper`（折纸狐狸，智慧温和）。每种形象含默认站姿 + 6-8 帧循环动画 + 专属气泡颜色/字体 + 专属问候语风格。
- **修改** `src/pages/Mascot.css` 气泡 UI 精致化：磨砂玻璃效果（`backdrop-filter: blur(12px)`）、圆角 16px、阴影、`bubble-in` 出现动画（cubic-bezier 弹性）。
- **修改** MascotWindow 拖拽吸附边缘：`dragEnd` 时检测位置自动吸附到最近边缘（margin 20px），平滑动画过渡。
- **新增** 深色模式适配：跟随系统主题（Tauri `window.theme()`），气泡深色背景 + 浅色字，伙伴形象深色变体。

#### 13.5 集成感 — 与主窗口打通
- **新增** Mascot 右键菜单"悬浮卡片"：不打开主窗口展示今日记忆摘要（最近 3 条 Episode + 专注时长 + 切换次数 + "打开完整视图"按钮）。
- **修改** Mascot 状态与主窗口同步：用户在设置页关闭 OCR → 伙伴气泡"已切换到纯截图模式"；用户暂停记录 → 伙伴进入 `paused` 状态，30min 后主动提醒"已暂停 30 分钟，要恢复吗？"；报告生成完成 → 伙伴状态切换 `report_ready`，角标 +1。

### Phase 14：端到端验证
- 验证 Tauri 构建的 NSIS 包完整流程：启动 → 捕获 → OCR → Episode → 日报 → 退出 → 重启数据完整。
- 验证从 Electron 版本升级：现有 `workmemory.db` 升级到 Tauri 版本后数据无丢失。
- 验证全部新增功能（FocusStreakTracker、跨天任务、手动记忆、待办提取、时间语义搜索、人物时间线、站会模板、周报自动提醒、报告对比、Wiki 图谱、知识过期、外部导入、专注感知、目标对齐、Today 时间轴、数据健康、Mascot 大升级）端到端可用。

## Impact

- **Affected specs**：`evolve-perception-memory`（感知与记忆引擎进化）— 该 spec 涉及的全部 `electron/` 模块均需在 Tauri/Rust 中重新实现，逻辑契约保持不变。
- **Affected code**：
  - 全部 `electron/` 目录（删除）
  - 全部 `resources/ocr/` 目录（删除）
  - `scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`（删除）
  - `src/hooks/useIpc.ts`、`src/store/recordingStore.ts`、`src/types/index.ts`、`src/App.tsx`（修改）
  - `src/pages/Today.tsx`、`Search.tsx`、`Reports.tsx`、`Graph.tsx`、`Insights.tsx`、`Settings.tsx`、`Mascot.tsx`（修改）
  - `src/components/`：新增 `ErrorBoundary.tsx`、`EntityTimeline.tsx`、`ReportCompare.tsx`、`Timeline24h.tsx`
  - `package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`.eslintrc.cjs`（修改）
  - 新增 `src-tauri/` 目录（Rust 实现）
- **Affected database**：迁移版本从 18 升级到 24，新增 `related_episode_ids`、`blockers`、`last_accessed_at`、`goals` 表、`ai_usage` 表、`app_settings` 扩展字段。
- **Affected build**：构建工具链从 `vite-plugin-electron` + `electron-builder` 切换为 `tauri build`；CI 环境需安装 Rust toolchain + Windows SDK。
- **Affected runtime**：安装包体积从 ~300MB 降至 ~15MB；启动内存从 ~200MB 降至 ~50MB。
- **Affected platform support**：Windows OCR API 仅在 Windows 10+ 可用，本变更后项目仅支持 Windows（与现有 `koffi` 调 `user32.dll` 的 Windows 强依赖一致）。

## ADDED Requirements

### Requirement: Tauri 主进程壳
系统 SHALL 提供 `src-tauri/` Rust 主进程，承载原 Electron 主进程的全部职责。

#### Scenario: 主窗口启动
- **WHEN** 用户启动 WorkMemory
- **THEN** Tauri 创建无边框主窗口（1280×800，最小 960×640），加载 React 渲染进程
- **AND** 渲染进程通过 `invoke('window:isMaximized')` 等命令与主进程通信

#### Scenario: Mascot 透明窗口
- **WHEN** Tauri 主进程 bootstrap 完成
- **THEN** 创建透明置顶 Mascot 窗口（340×146，初始位于屏幕右下角留 20px 边距）
- **AND** 该窗口 `skipTaskbar: true`、`alwaysOnTop: true`、`transparent: true`

### Requirement: Windows OCR API 引擎
系统 SHALL 通过 Windows OCR API（`Windows.Media.Ocr.OcrEngine`）实现 OCR，替换 PP-OCRv6 与 Tesseract 后端。

#### Scenario: 中英文识别
- **WHEN** CaptureManager 产生新 pending Segment
- **THEN** OcrQueue 将截图 PNG 传入 `OcrEngine::TryCreateFromUserProfileLanguages()`
- **AND** 调用 `RecognizeAsync(SoftwareBitmap)` 返回 `OcrResult`
- **AND** 拼接 `result.Lines[].Text` 为完整文本写入 `segments.ocr_text`
- **AND** 提取 `result.Lines[].Words[].BoundingRect` 写入 `segments.ocr_blocks`

#### Scenario: 系统未安装中文语言包
- **WHEN** 用户系统未安装中文 OCR 语言包
- **THEN** `OcrEngine::TryCreateFromUserProfileLanguages()` 仍返回可用引擎（仅英文）
- **AND** 在设置页展示"建议安装中文 OCR 语言包"提示，不抛错

#### Scenario: 无可用 OCR 引擎
- **WHEN** `OcrEngine::TryCreateFromUserProfileLanguages()` 返回 `None`
- **THEN** OcrManager 进入"未配置"状态（`configured: false`）
- **AND** 截图功能正常，segment 保持 `pending` 状态
- **AND** 不抛未捕获异常

### Requirement: Tauri IPC 命令
系统 SHALL 通过 `#[tauri::command]` 暴露与现有 `*Channels` 常量同名的命令。

#### Scenario: 命令注册
- **WHEN** Tauri 主进程启动
- **THEN** 注册全部现有 IPC 通道为 `#[tauri::command]`
- **AND** 每个命令的入参经 `serde` 反序列化校验，失败返回 `{ ok: false, error: 'VALIDATION_ERROR', details }`
- **AND** 命令抛错时返回 `{ ok: false, error: 'INTERNAL_ERROR', message }`

#### Scenario: 渲染进程调用
- **WHEN** 渲染进程调用 `await invoke('segment:getByDate', { date: '2026-06-22' })`
- **THEN** 返回与现有 `SegmentRepository.getByDate()` 相同结构的 JSON
- **AND** TypeScript 类型推断正确（preload 层 `unknown` 替换为具体类型）

### Requirement: Rust SQLite 持久层
系统 SHALL 使用 `rusqlite`（bundled 模式）替换 `better-sqlite3`，保持数据库 schema、迁移版本号、FTS5 配置完全一致。

#### Scenario: 现有数据库升级
- **WHEN** 用户从 Electron 版本升级到 Tauri 版本，启动时打开现有 `workmemory.db`
- **THEN** `runMigrations()` 检测 `PRAGMA user_version` 为 18
- **AND** 依次执行迁移 19–24（新增字段与表）
- **AND** 全部现有数据可正常读写

#### Scenario: WAL checkpoint
- **WHEN** 应用退出（`before-quit` 事件）或运行满 6 小时
- **THEN** 执行 `PRAGMA wal_checkpoint(TRUNCATE)`
- **AND** WAL 文件被截断

### Requirement: OpenAI 流式输出
系统 SHALL 提供 `chat_completion_stream()` 方法，通过 Tauri `app_handle.emit()` 将 delta 推送至渲染进程。

#### Scenario: 日报生成流式
- **WHEN** 用户点击"生成日报"
- **THEN** OpenAIClient 发起 `stream: true` 的 chat/completions 请求
- **AND** 每个 SSE delta 通过 `app_handle.emit('ai:streamDelta', { chunk })` 推送
- **AND** 渲染进程通过 `listen('ai:streamDelta', cb)` 接收并增量渲染
- **AND** 流结束后通过 `app_handle.emit('ai:streamDone', { usage })` 通知

### Requirement: Bootstrap 失败用户感知
系统 SHALL 在 bootstrap 失败时通过 `dialog` 插件向用户展示错误摘要。

#### Scenario: 数据库初始化失败
- **WHEN** `initDatabase()` 抛错
- **THEN** `bootstrap().catch()` 捕获错误
- **AND** 调用 `dialog.message('WorkMemory 启动失败', error_summary).show()`
- **AND** 不创建空白窗口

### Requirement: 专注连续时段追踪（FocusStreakTracker）
系统 SHALL 在 WindowWatcher 层记录每个窗口的连续专注时段，存入 `Segment.metadata.focusStreak`。

#### Scenario: 连续专注同一窗口
- **WHEN** 用户在窗口 A 连续工作 25 分钟未切换
- **THEN** FocusStreakTracker 记录 `focusStreak: { windowTitle, appName, durationSec: 1500, startedAt, endedAt }`
- **AND** 该数据存入对应 Segment 的 metadata
- **AND** WeeklyPatternDetector 可读取 focusStreak 分析"碎片化程度"趋势

#### Scenario: 频繁切换窗口
- **WHEN** 用户在 5 分钟内切换窗口 > 10 次
- **THEN** FocusStreakTracker 记录每段极短的 focusStreak
- **AND** WeeklyPatternDetector 据此判定为"碎片化时段"

### Requirement: 跨天任务连续性识别
系统 SHALL 在 EpisodeManager 中对同一天内 Episode 计算 title embedding，检测与过去 7 天内 Episode 的相似度 > 0.8，建立 `relatedEpisodeIds[]` 字段。

#### Scenario: 跨天关联
- **WHEN** 用户今天创建 Episode "重构模块 X"
- **THEN** EpisodeManager 计算 title embedding
- **AND** 检测到昨天有 Episode "重构模块 X（续）" 相似度 > 0.8
- **AND** 在今天 Episode 的 `relatedEpisodeIds` 中记录昨天 Episode 的 id
- **AND** Today 页面展示"昨天也做了这个"的连续性提示

### Requirement: 手动记忆创建入口
系统 SHALL 在 Today 页面提供"+ 添加记忆"按钮，支持用户主动记录。

#### Scenario: 用户手动添加记忆
- **WHEN** 用户点击"+ 添加记忆"按钮，填写标题/标签/关联项目/自由文本
- **THEN** 写入 Episode（`source: 'manual'`、`reportEligible: true`）
- **AND** 不触发 OCR，不依赖截图
- **AND** 新 Episode 立即出现在 Today 页面列表

### Requirement: 待办事项自动提取
系统 SHALL 在 EpisodeBuilder 中通过正则 + 简单 AI 提取 OCR 文本中的待办条目，存入 `Episode.todos[]`。

#### Scenario: OCR 文本含 TODO
- **WHEN** OCR 识别文本包含 "TODO: 修复登录 bug" 或 "Action Item: 跟进设计稿"
- **THEN** TodoExtractor 提取为 `{ text: "修复登录 bug", done: false }` 等
- **AND** 存入对应 Episode 的 `todos` 字段
- **AND** Today 侧栏展示当日待办汇总
- **AND** 用户可一键勾选完成，触发 `triggerEpisodeRefresh`

### Requirement: 时间语义搜索
系统 SHALL 通过轻量 query parser（单次 AI 调用，<100 tokens）解析搜索查询的时间/实体/聚合语义。

#### Scenario: 时间语义查询
- **WHEN** 用户搜索 "上周五下午"
- **THEN** query parser 解析为时间范围 `2026-06-13 12:00 ~ 18:00`
- **AND** SearchRepository 返回该时间范围内的 Episode

#### Scenario: 实体语义查询
- **WHEN** 用户搜索 "和张三开会的时候"
- **THEN** query parser 解析为 `entity: 张三 + type: meeting`
- **AND** SearchRepository 返回与张三相关的 meeting 类型 Episode

#### Scenario: 聚合语义查询
- **WHEN** 用户搜索 "做 XX 项目最长的那天"
- **THEN** query parser 解析为 `project: XX + 聚合: 时长排序`
- **AND** SearchRepository 按 project 聚合时长排序返回

### Requirement: 人物时间线视图
系统 SHALL 在 Search 页面提供按实体（人/项目）聚合的时间线视图。

#### Scenario: 查看某人的交互历史
- **WHEN** 用户在 Search 页面切换到"人物时间线"维度，输入"张三"
- **THEN** 调用 `SearchRepository.get_by_entity("张三")`
- **AND** EntityTimeline 组件按时间轴展示所有相关 Episode
- **AND** 支持复盘与某人的所有交互历史

### Requirement: 站会报告模板
系统 SHALL 提供 `standup` 报告模板，输出 Yesterday/Today/Blockers 三段式纯文本。

#### Scenario: 生成站会报告
- **WHEN** 用户在 Reports 页面选择 standup 模板生成报告
- **THEN** 从昨日 Episode 提取"昨天做了什么"
- **AND** 从当日 Episode 的 `todos` 字段提取"今天计划做什么"
- **AND** 从 CleanEpisode 的 `blockers` 字段提取"有什么阻塞"
- **AND** 输出纯文本格式，适合直接粘贴到群聊

### Requirement: 周报自动发送与定时提醒
系统 SHALL 在 ReminderScheduler 中增加周报自动提醒，并支持配置自动生成时间。

#### Scenario: 周五 17:30 推送周报提醒
- **WHEN** 每周五 17:30（且不在免打扰时段）
- **THEN** ReminderScheduler 推送 Mascot 气泡"本周报告已就绪，点击查看"
- **AND** 气泡含 Action Button `[查看报告]` `[稍后提醒]`
- **AND** 用户点击"查看报告"跳转 Reports 页面

#### Scenario: 报告导出
- **WHEN** 用户在 Reports 页面点击"导出"
- **THEN** 支持导出为 `.md` 文件或复制到剪贴板（复用 `writeClipboard` IPC）

### Requirement: 报告历史对比
系统 SHALL 在 Reports 页面提供"对比模式"，支持选择两份报告左右对比展示。

#### Scenario: 对比两份日报
- **WHEN** 用户在 Reports 页面进入对比模式，选择 6 月 21 日与 6 月 22 日的日报
- **THEN** 左右对比展示两份报告
- **AND** 高亮新增项目、消失项目、时间占比变化
- **AND** 数据源为 `daily_distills` 表

### Requirement: Wiki 知识图谱可视化
系统 SHALL 在 Graph 页面增强可视化：节点大小 = 被引用次数，节点颜色 = `wiki_type`，点击节点预览内容，悬停边显示引用来源。

#### Scenario: 浏览知识图谱
- **WHEN** 用户进入 Graph 页面
- **THEN** 展示所有 WikiPage 为节点
- **AND** 节点大小反映被引用次数（backlinks 数量）
- **AND** 节点颜色按 `wiki_type` 区分（人/项目/决策/问题）
- **AND** 点击节点右侧预览 WikiPage 内容
- **AND** 悬停边显示 Episode 引用来源

### Requirement: 知识卡片过期提醒
系统 SHALL 在 WikiPage 表新增 `last_accessed_at` 字段，超过 30 天未被引用的标记为"待复核"。

#### Scenario: 知识库健康度展示
- **WHEN** 用户进入 Insights 页面
- **THEN** 展示"知识库健康度"卡片
- **AND** 分类统计：陈旧（>30 天未引用）/ 活跃（7 天内引用）/ 近期新增（7 天内创建）
- **AND** 陈旧卡片标记"待复核"

### Requirement: 外部知识导入
系统 SHALL 在 Settings 页面提供"导入笔记"功能，支持 Obsidian vault / Notion export zip。

#### Scenario: 导入 Obsidian vault
- **WHEN** 用户在 Settings 页面选择"导入笔记"，指定 Obsidian vault 文件夹
- **THEN** NoteImporter 解析所有 `.md` 文件
- **AND** 解析 `[[双链]]` 语法转为 WikiPage backlinks
- **AND** 导入的页面进入 WikiIngestManager 审核队列
- **AND** 用户人工确认后入库

### Requirement: 实时专注状态感知
系统 SHALL 通过 FocusStateDetector 检测连续专注与注意力分散，与 MascotManager 集成。

#### Scenario: 连续专注 25 分钟
- **WHEN** 用户连续专注同一窗口 > 25 分钟
- **THEN** FocusStateDetector 触发 `FOCUS_25MIN` 提醒
- **AND** Mascot 展示气泡"休息一下（番茄钟）"
- **AND** Mascot 状态切换为 `focused`

#### Scenario: 注意力分散
- **WHEN** 用户在 5 分钟内切换窗口 > 10 次
- **THEN** FocusStateDetector 触发 `FRAGMENTED_5MIN` 提醒
- **AND** Mascot 展示气泡"检测到注意力分散"

### Requirement: 目标对齐度评分
系统 SHALL 提供 `goals` 表存储用户每周目标，GoalAlignmentAnalyzer 对当周实际工作做对齐度分析。

#### Scenario: 设定周目标
- **WHEN** 用户在 Settings 页面设定 3 条周目标（自然语言）
- **THEN** 存入 `goals` 表（`week_start`、`goal_text`）
- **AND** 每天的 CleanEpisode 自动打标"与目标 N 相关"

#### Scenario: 周报含目标达成情况
- **WHEN** WeeklyPatternDetector 生成周报
- **THEN** 报告包含"目标达成情况"章节
- **AND** 列出每个目标的相关工作时长与完成度

### Requirement: Today 页面 24h 时间轴视图
系统 SHALL 在 Today 页面增加 24 小时时间轴视图。

#### Scenario: 浏览当日时间轴
- **WHEN** 用户进入 Today 页面
- **THEN** 展示 24h 时间轴（参考 Timing/RescueTime）
- **AND** 色块 = Episode 类型，宽度 = 时长
- **AND** 点击色块右侧展示 Episode 详情
- **AND** 空白区域 = 未记录时段，点击可手动补充

### Requirement: 数据健康仪表盘
系统 SHALL 在 Insights 或 Settings 页面提供"记录健康度"卡片。

#### Scenario: 查看记录健康度
- **WHEN** 用户进入 Insights 页面
- **THEN** 展示"记录健康度"卡片
- **AND** 显示 OCR 识别率（identified / total segments）
- **AND** 显示今日记录覆盖率（有记录时长 / 工作时长）
- **AND** 显示 Wiki 知识库大小 & 增长趋势
- **AND** 显示 AI 调用次数 & token 消耗（来自 `ai_usage` 表）

### Requirement: Mascot 首次启动引导动画
系统 SHALL 在首次启动时播放 Mascot 自我介绍动画。

#### Scenario: 首次启动
- **WHEN** 用户首次安装并启动 WorkMemory
- **THEN** Mascot 从屏幕底部"飞入"停在右下角
- **AND** 气泡依次展示："嗨！我是你的工作记忆助手"、"我会在后台记录你的工作"、"点击我随时查看今日记忆，或右键呼出菜单"
- **AND** 轻轻抖动等待用户点击
- **AND** 用户点击后引导完成，记录到 `app_settings` 不再触发

### Requirement: Mascot 呼吸动画与状态视觉
系统 SHALL 为 Mascot 5 种状态设计专属视觉信号与持续微动画。

#### Scenario: 录制中状态
- **WHEN** Mascot 处于 `recording` 状态
- **THEN** 显示小红点 + 呼吸动画（scale 1.0↔1.04）+ 绿色光晕

#### Scenario: 扫描中状态
- **WHEN** Mascot 处于 `ocr_scanning` 状态
- **THEN** 显示扫描线动画 + 眼睛追踪效果（opacity 0.6↔1.0）

#### Scenario: 报告就绪状态
- **WHEN** Mascot 处于 `report_ready` 状态
- **THEN** 金色高亮 + 弹跳提示 + 角标数字（未读报告数）

### Requirement: Mascot 情绪状态机
系统 SHALL 在功能状态之上叠加情绪维度（`MascotEmotion`），影响眼睛形状、气泡语气、动画速度。

#### Scenario: 用户连续专注
- **WHEN** 用户连续专注 20min+
- **THEN** Mascot 情绪切换为 `focused`
- **AND** 眼睛形状变为专注态
- **AND** 动画速度略微放缓

#### Scenario: 生成了好报告
- **WHEN** AI 成功生成日报
- **THEN** Mascot 情绪切换为 `happy`
- **AND** 气泡语气变得欢快

### Requirement: Mascot 上下文感知问候
系统 SHALL 根据时间 + 状态 + 当日数据组合生成上下文感知的问候语。

#### Scenario: 早上首次启动
- **WHEN** 用户在早上 7:00–10:00 首次启动 WorkMemory
- **THEN** Mascot 展示问候"早上好！今天要做什么大事？☀️"或"新的一天，准备好了吗 👊"

#### Scenario: 连续专注后
- **WHEN** 用户连续专注 25 分钟后
- **THEN** Mascot 展示"刚才连续专注了 {min} 分钟，厉害！可以休息一下了 ☕"

#### Scenario: 深夜工作
- **WHEN** 用户在晚上 22:00 后仍在工作
- **THEN** Mascot 展示"都 {hour} 点了，注意休息哦 🌙"

### Requirement: Mascot 点击互动分层
系统 SHALL 为 Mascot 左键/右键/悬停设计分层互动反馈。

#### Scenario: 左键单击
- **WHEN** 用户左键单击 Mascot
- **THEN** 若有未读报告 → 直接跳转报告页
- **AND** 若有待办 → 展示今日待办气泡
- **AND** 否则 → 随机一条励志短句（2s 后自动消失）

#### Scenario: 右键上下文菜单
- **WHEN** 用户右键单击 Mascot
- **THEN** 展示菜单：[📋 今日记忆] [⏸ 暂停记录] [📝 快速记一笔] [⚙️ 设置] [👁 隐藏 10min]

#### Scenario: 悬停
- **WHEN** 用户鼠标悬停 Mascot
- **THEN** 展示今日摘要 tooltip："今日已记录 X 件事，专注 Xh"
- **AND** Mascot 微微抬头（眼神追踪效果）

### Requirement: Mascot 智能提醒分级
系统 SHALL 在 ReminderScheduler 中增加行为驱动与事件驱动两类提醒。

#### Scenario: 行为驱动提醒
- **WHEN** 用户连续专注 25 分钟（`FOCUS_25MIN`）
- **THEN** 触发番茄钟提醒
- **AND** 若 5 分钟内切换 > 8 次（`FRAGMENTED_5MIN`）触发注意力分散提醒
- **AND** 若空闲超 30 分钟（`IDLE_30MIN`）触发"是不是去开会了？"提醒
- **AND** 若晚上 9 点仍在工作（`LATE_WORK`）触发休息提醒

#### Scenario: 事件驱动提醒
- **WHEN** 当日报告可生成（`REPORT_READY`）
- **THEN** 触发报告就绪提醒
- **AND** 若知识库待审核积累 > 3 条（`WIKI_REVIEW_DUE`）触发审核提醒
- **AND** 若新技能卡生成（`SKILL_UNLOCKED`）触发技能解锁提醒

### Requirement: Mascot 气泡 Action Button
系统 SHALL 在 BubblePayload 中增加 `actions` 字段，气泡支持可点击的操作按钮。

#### Scenario: 报告就绪气泡
- **WHEN** Mascot 展示"今日报告已就绪"气泡
- **THEN** 气泡含 Action Button `[查看报告]` `[稍后提醒]`
- **AND** 点击"查看报告"通过 `invoke(MascotChannels.Navigate)` 跳转 Reports 页面
- **AND** 点击"稍后提醒"关闭气泡，30 分钟后再次提醒

### Requirement: Mascot 免打扰时段
系统 SHALL 支持配置免打扰时段、提醒间隔下限、工作日仅工作时间提醒。

#### Scenario: 免打扰时段
- **WHEN** 用户设置免打扰时段 09:00–11:00
- **AND** 当前时间在 09:00–11:00 内
- **THEN** ReminderScheduler 不推送任何提醒（深度工作保护）

#### Scenario: 提醒间隔下限
- **WHEN** 用户设置提醒间隔下限 30 分钟
- **AND** 距离上次提醒不足 30 分钟
- **THEN** ReminderScheduler 不推送新提醒（防刷屏）

### Requirement: Mascot 形象角色人格
系统 SHALL 为 5 种形象设计完整角色人格，含默认站姿 + 循环动画 + 专属气泡 + 专属问候语。

#### Scenario: 选择 note 形象
- **WHEN** 用户选择 `note` 形象（备忘录小鸟）
- **THEN** 展示认真负责性格的默认站姿
- **AND** 播放 6-8 帧循环动画
- **AND** 气泡颜色/字体为 note 专属
- **AND** 问候语风格为认真整理型

### Requirement: Mascot 气泡磨砂玻璃 UI
系统 SHALL 将 Mascot 气泡升级为磨砂玻璃效果。

#### Scenario: 气泡出现
- **WHEN** Mascot 展示气泡
- **THEN** 气泡背景 `rgba(255,255,255,0.85)` + `backdrop-filter: blur(12px)`
- **AND** 圆角 16px + 阴影
- **AND** 出现动画 `bubble-in`（cubic-bezier 弹性，0.25s）

### Requirement: Mascot 拖拽边缘吸附
系统 SHALL 在拖拽结束时自动吸附到最近屏幕边缘。

#### Scenario: 拖拽到屏幕中间
- **WHEN** 用户拖拽 Mascot 到屏幕中间松开
- **THEN** 检测当前位置，自动吸附到最近边缘（左或右，margin 20px）
- **AND** 平滑动画过渡到吸附位置

### Requirement: Mascot 深色模式适配
系统 SHALL 跟随系统主题适配深色模式。

#### Scenario: 系统切换深色模式
- **WHEN** 系统主题切换为深色
- **THEN** Mascot 气泡切换为深色背景 + 浅色字
- **AND** 伙伴形象切换为深色变体（或调整图层亮度）

### Requirement: Mascot 悬浮卡片通知中心
系统 SHALL 在 Mascot 右键菜单提供"悬浮卡片"，不打开主窗口展示今日摘要。

#### Scenario: 查看悬浮卡片
- **WHEN** 用户右键 Mascot 选择"今日记忆"
- **THEN** 展示悬浮卡片（不打开主窗口）
- **AND** 卡片含最近 3 条 Episode（时间 + 标题）
- **AND** 显示专注时长 + 切换次数
- **AND** 含"打开完整视图"按钮

### Requirement: Mascot 状态与主窗口同步
系统 SHALL 在用户操作主窗口时同步 Mascot 状态并给出反馈。

#### Scenario: 用户关闭 OCR
- **WHEN** 用户在设置页关闭 OCR
- **THEN** Mascot 展示气泡"已切换到纯截图模式，不再识别文字"

#### Scenario: 用户暂停记录
- **WHEN** 用户暂停记录
- **THEN** Mascot 进入 `paused` 状态
- **AND** 30min 后主动提醒"已暂停 30 分钟，要恢复吗？"

#### Scenario: 报告生成完成
- **WHEN** AI 报告生成完成
- **THEN** Mascot 状态切换为 `report_ready`
- **AND** 角标 +1

## MODIFIED Requirements

### Requirement: 服务停止序列
系统 SHALL 在 `before-quit` 事件中执行一次完整的服务停止序列，`window-all-closed` 仅负责触发 `app.quit()`（非 macOS）。

#### Scenario: 退出时停止服务
- **WHEN** 用户关闭主窗口或点击托盘退出
- **THEN** `before-quit` 事件触发 `stopAllServices()`
- **AND** 依次停止 MascotManager、InsightsManager、WikiIngestManager、MemCellIndexer、DistillManager、EpisodeManager、OcrManager、CaptureManager
- **AND** 执行 `wal_checkpoint(TRUNCATE)` 后关闭数据库
- **AND** 每个 Manager 的 `stop()` 仅被调用一次

### Requirement: 日志统一
系统 SHALL 提供统一的日志模块，替换原 `logMain`/`logWindow`/`logMascot`/`logRuntime` 四套并行实现。

#### Scenario: 各层日志写入
- **WHEN** 主进程、窗口管理、Mascot、OCR 任一层产生日志
- **THEN** 通过 `src-tauri/src/logging.rs` 的 `log(scope, message)` 写入
- **AND** 日志路径为 `app_handle.path().app_log_dir()?/runtime.log`
- **AND** 每行格式为 `[ISO8601] [scope] message`
- **AND** 不使用 `process.env.APPDATA` 或硬编码 `'WorkMemory'`

### Requirement: PrivacyGuard 默认规则播种
系统 SHALL 仅在 `CaptureManager.startCapture()` 中调用 `PrivacyGuard.seedDefaultRules()` 一次。

#### Scenario: 启动时播种
- **WHEN** bootstrap 完成，调用 `captureManager.startCapture()`
- **THEN** `seedDefaultRules()` 被调用一次
- **AND** `bootstrap()` 中不再直接调用 `seedDefaultRules()`

### Requirement: refreshTrigger 事件型刷新
系统 SHALL 将 `refreshTrigger: number` 改为事件型刷新标识 `RefreshFlags { segments: number; episodes: number; wiki: number }`。

#### Scenario: segment 更新
- **WHEN** segment 数据更新
- **THEN** 仅触发 `triggerSegmentRefresh()`
- **AND** wiki 组件不重新查询

## REMOVED Requirements

### Requirement: PP-OCRv6 OCR 后端
**Reason**: Windows OCR API 已内置于 Windows 10+，无需打包 ~200MB 模型 + Python runtime。
**Migration**: 
- 删除 `electron/ocr/` 全部文件、`resources/ocr/` 全部内容、`scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`
- `OcrManager` 在 Rust 中重新实现，对外接口契约保持不变
- `BackendStatus.type` 从 `'paddleocr' | 'tesseract' | 'unconfigured'` 改为 `'windows_ocr' | 'unconfigured'`

### Requirement: Tesseract 降级后端
**Reason**: Windows OCR API 是系统内置后端，无需第三方降级方案。
**Migration**: 删除 `TesseractBackend` 类及其检测逻辑。

### Requirement: Electron 主进程
**Reason**: 迁移至 Tauri/Rust 后，Electron 主进程、preload、contextBridge、ipcMain/ipcRenderer 全部不再需要。
**Migration**:
- 删除 `electron/` 目录全部内容
- 删除 `electron`、`electron-builder`、`vite-plugin-electron`、`vite-plugin-electron-renderer`、`better-sqlite3`、`@types/better-sqlite3`、`koffi` 依赖
- 渲染进程 IPC 调用从 `window.workmemory.xxx.yyy()` 改为 `invoke('xxx:yyy', payload)`
- 事件监听从 `ipcRenderer.on(channel, cb)` 改为 `listen(channel, cb)`
