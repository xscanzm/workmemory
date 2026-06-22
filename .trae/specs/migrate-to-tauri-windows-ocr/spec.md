# 迁移至 Tauri + Windows OCR API Spec

## Why

当前 WorkMemory 基于 Electron 构建，存在三个核心问题：

1. **运行时体积与资源占用过重**：Electron 安装包含完整 Chromium + Node.js，启动内存占用高，与"常驻后台的工作记忆助手"定位相悖。
2. **OCR 引擎过重且依赖外部 Python runtime**：当前使用 PP-OCRv6（PaddleOCR）通过 `child_process.spawn` 调用外部 CLI，需打包 ~200MB 模型 + Python runtime，冷启动慢、子进程管理复杂（server 模式/单次 CLI 回退/超时保护层层兜底）。Windows 10+ 内置的 Windows OCR API（`Windows.Media.Ocr`）已支持中英文、无需额外模型文件、由系统维护，是更合适的轻量后端。
3. **P0–P3 工程缺陷累积**：包括 `runtimeLog.ts` 缺失导致 OCR 模块编译失败、服务停止逻辑双重执行、日志体系分裂、Bootstrap 失败无用户感知、IPC 边界类型缺失、sandbox 关闭、CSP 硬编码、无 test 脚本等。

本变更将主进程从 Electron/Node.js 迁移至 Tauri/Rust，OCR 引擎切换为 Windows OCR API，并顺带修复 P0–P3 工程缺陷。迁移完成后渲染进程（React + Vite）保持不变，仅替换 IPC 调用层。

## What Changes

### Phase 0：P0 验证与阻塞性修复（在 Electron 现有架构上完成）
- **新增** `electron/runtimeLog.ts`：当前被 `electron/ocr/OcrQueue.ts` 与 `electron/ocr/PpOcrEngine.ts` 引用但文件不存在，导致 OCR 模块编译失败。统一日志写入 `app.getPath('userData')/runtime.log`，使用 `app.getName()` 而非硬编码 `'WorkMemory'`。
- **运行** `npm run typecheck && npm run build` 验证 P0 描述的"模板字面量插值缺失"问题。经源码核查，`OpenAIClient.ts` 的 `getChatCompletionsUrl`、`Authorization` 头、`migrations.ts` 的 `addSegmentColumn`、`validatedHandler.ts` 的 `unwrapResult`、`main/index.ts` 的 `logMain` 调用中模板字面量在源码中均存在且正确，疑似 E2B 读取工具的渲染问题。仍需以编译输出为准。
- **修复** `electron/main/index.ts` 服务停止逻辑双重执行：提取 `stopAllServices()` 公共函数，仅在 `before-quit` 中执行（`window-all-closed` 在所有平台都会触发 `before-quit`，包括 macOS）。
- **修复** `PrivacyGuard.seedDefaultRules()` 双重调用：从 `bootstrap()` 第 77 行移除直接调用，统一由 `CaptureManager.startCapture()` 负责。
- **修复** Bootstrap 失败用户无感知：`bootstrap().catch()` 中通过 `dialog.showErrorBox()` 展示错误摘要，不再只创建空白窗口。
- **BREAKING** 删除 `electron/runtimeLog.ts` 中对 `process.env.APPDATA` 的依赖（迁移后由 Tauri path API 提供）。

### Phase 1：Tauri 壳搭建
- **新增** `src-tauri/` 目录：`Cargo.toml`、`tauri.conf.json`、`build.rs`、`src/main.rs`、`src/lib.rs`。
- **新增** Tauri 配置：无边框主窗口（`decorations: false`）、最小尺寸 960×640、初始 1280×800、`titleBarStyle: 'Overlay'`。
- **新增** Tauri 透明置顶 Mascot 窗口配置（`transparent: true`、`alwaysOnTop: true`、`skipTaskbar: true`）。
- **新增** `src-tauri/Cargo.toml` 依赖：`tauri`（features: `dialog`、`clipboard-manager`、`path`、`tray-icon`、`window-state`）、`rusqlite`（features: `bundled`）、`windows`（features: `Win32_Graphics_Gdi`、`Win32_UI_WindowsAndMessaging`、`Media_Ocr`、`Graphics_Imaging`、`Foundation`）、`reqwest`（features: `json`、`rustls-tls`）、`tokio`、`serde`、`serde_json`、`zod` 校验等价改用 `serde` + 手写校验。
- **BREAKING** 移除 `electron`、`electron-builder`、`vite-plugin-electron`、`vite-plugin-electron-renderer`、`better-sqlite3`、`@types/better-sqlite3`、`koffi` 依赖。
- **BREAKING** `package.json` `main` 字段移除，`scripts.dev` 改为 `tauri dev`，`scripts.dist` 改为 `tauri build`。

### Phase 2：核心原生模块迁移（Rust 实现）
- **新增** `src-tauri/src/db/`：用 `rusqlite` 重写 `database.rs`、`migrations.rs`、`schema.rs`、`fts_tokenizer.rs`，保持与现有 18 个迁移版本号一致，复用现有 SQL DDL。
- **新增** `src-tauri/src/db/repositories/`：逐个迁移 18 个 Repository（SegmentRepository、EpisodeRepository、CleanEpisodeRepository、WikiRepository、ReportRepository、PrivacyRuleRepository、SearchRepository、SemanticSearchRepository、EmbeddingRepository、MemCellRepository、MemSceneRepository、CausalChainRepository、DailyDistillRepository、FeedbackEventRepository、ReflectionReportRepository、SkillRepository、UserProfileRepository、WeeklyPatternRepository）。
- **新增** `src-tauri/src/capture/window_watcher.rs`：用 `windows` crate 调用 `user32.dll`（`GetForegroundWindow`、`GetWindowTextW`、`GetWindowThreadProcessId`、`QueryFullProcessImageNameW`）替换 `koffi` FFI。
- **新增** `src-tauri/src/capture/screenshot.rs`：用 `windows` crate 的 `Win32_Graphics_Gdi`（`BitBlt` + `CreateCompatibleBitmap`）实现窗口/整屏截图，替换 `desktopCapturer`。
- **新增** `src-tauri/src/capture/` 其余模块：`capture_manager.rs`、`capture_decision.rs`、`privacy_guard.rs`、`incognito_detector.rs`、`episode_builder.rs`、`episode_manager.rs`、`activity_classifier.rs`、`content_classifier.rs`、`browser_context_collector.rs`、`layout_analyzer.rs`、`action_flow_inferrer.rs`、`one_line_summary.rs`、`entity_extractor.rs`。
- **新增** `src-tauri/src/events/bus.rs`：用 `tokio::sync::broadcast` 替换 Node `EventEmitter`。

### Phase 3：OCR 引擎迁移至 Windows OCR API
- **新增** `src-tauri/src/ocr/windows_ocr_engine.rs`：通过 `windows` crate 的 `Media::Ocr::OcrEngine` 调用系统 OCR。
  - `OcrEngine::TryCreateFromUserProfileLanguages()` 获取引擎实例（自动使用用户系统语言包，含中文）。
  - `SoftwareBitmap::CreateCopyFromBuffer()` 将 PNG Buffer 转为 `SoftwareBitmap`。
  - `engine.RecognizeAsync(bitmap).await` 返回 `OcrResult`，提取 `Lines[].Text` 拼接为完整文本，提取 `Lines[].Words[].BoundingRect` 作为 boxes。
- **新增** `src-tauri/src/ocr/ocr_queue.rs`、`ocr_manager.rs`、`ocr_text_cleaner.rs`、`ocr_runtime_manager.rs`：保持现有接口契约，仅替换底层引擎。
- **BREAKING** 删除 `electron/ocr/PpOcrEngine.ts`、`electron/ocr/OcrQueue.ts`、`electron/ocr/OcrManager.ts`、`electron/ocr/OcrTextCleaner.ts`、`electron/ocr/OcrRuntimeManager.ts`。
- **BREAKING** 删除 `resources/ocr/` 目录（PP-OCRv6 模型、runtime、ppocr_cli.py、paddlex 子目录），安装包体积预计减少 ~200MB。
- **BREAKING** 删除 `scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`。
- **BREAKING** `OcrModel` 类型保留但仅作占位（Windows OCR API 无 tiny/small 之分），`setModel` IPC 保留兼容但不再切换实际模型。
- **BREAKING** `BackendStatus.type` 改为 `'windows_ocr' | 'unconfigured'`，移除 `'paddleocr'` 与 `'tesseract'`。

### Phase 4：业务模块迁移
- **新增** `src-tauri/src/ai/`：`openai_client.rs`（用 `reqwest` 替换 Node `https`/`http`）、`ai_manager.rs`、`distill_manager.rs`、`daily_distill_manager.rs`、`weekly_pattern_detector.rs`、`reflection_engine.rs`、`skill_evolver.rs`、`report_generator.rs`、`report_exporter.rs`、`html_exporter.rs`、`feedback_loop.rs`、`proactive_advisor.rs`、`hour_context_pack_builder.rs`、`sensitive_masker.rs`、`templates.rs`、`distill_prompt.rs`、`schemas/distill_event_schema.rs`。
- **新增** `src-tauri/src/ai/openai_client.rs` 流式输出：`chat_completion_stream()` 通过 Tauri `app_handle.emit()` 将 delta 推送至渲染进程（解决 P3-17）。
- **新增** `src-tauri/src/memory/`：`embedding_service.rs`、`mem_cell.rs`、`mem_cell_indexer.rs`、`mem_scene_clusterer.rs`、`user_profile_evolver.rs`。Embedding 模型改用 Rust 的 `ort` crate（ONNX Runtime）加载同一份 multilingual-e5-small 模型。
- **新增** `src-tauri/src/wiki/`：`wiki_ingest_manager.rs`、`wiki_extractor.rs`、`wiki_link_engine.rs`、`high_value_signal_detector.rs`。
- **新增** `src-tauri/src/insights/`：`insights_manager.rs`、`anomaly_detector.rs`、`reminder_scheduler.rs`、`time_audit_engine.rs`。
- **新增** `src-tauri/src/mascot/`：`mascot_window.rs`、`mascot_manager.rs`、`mascot_notifier.rs`、`frequency_limiter.rs`、`tray_manager.rs`。Mascot 透明窗口通过 Tauri `WebviewWindowBuilder` 创建。
- **新增** `src-tauri/src/main.rs` bootstrap：用 Tauri `Builder::default().setup()` 替换 `app.whenReady().then(bootstrap)`，启动序列与现有 `bootstrap()` 一致。

### Phase 5：IPC 层迁移
- **新增** `src-tauri/src/ipc/`：将 `electron/main/ipc.ts` 中所有 `validatedHandler` 注册迁移为 `#[tauri::command]` 函数。命令名保持与现有 `*Channels` 常量一致（如 `segment:update`、`ocr:recognize`、`ai:generateReport`）。
- **新增** `src-tauri/src/ipc/schemas.rs`：用 `serde` 反序列化 + 手写校验替换 Zod schema。校验失败返回与现有 `IpcResult` 同构的 `{ ok: false, error: 'VALIDATION_ERROR', details }`。
- **修改** `src/hooks/useIpc.ts`：将 `window.workmemory.xxx.yyy()` 调用替换为 `invoke('xxx:yyy', { ... })`。
- **修改** `src/store/recordingStore.ts`：将 `refreshTrigger: number` 改为事件型刷新标识（解决 P3-15）：
  ```ts
  interface RefreshFlags { segments: number; episodes: number; wiki: number }
  ```
- **BREAKING** 删除 `electron/preload/index.ts`、`electron/types/ipc.ts` 中的通道常量（保留类型定义供渲染进程复用，迁移至 `src/types/ipc.ts`）。
- **修改** `src/types/index.ts`：将 preload 中 `unknown` 类型替换为具体类型（解决 P1-6），所有 `invoke` 调用入参/返回值均带类型。
- **修改** 渲染进程事件监听：`ipcRenderer.on(...)` 替换为 `listen(...)`（来自 `@tauri-apps/api/event`）。

### Phase 6：构建与打包
- **新增** `src-tauri/tauri.conf.json` 完整配置：`bundle.targets: ['nsis']`、`bundle.windows.wix` 或 `bundle.windows.nsis` 配置（与现有 electron-builder NSIS 配置对齐：`oneClick: false`、`allowToChangeInstallationDirectory: true`、`createDesktopShortcut: true`、`createStartMenuShortcut: true`、`shortcutName: 'WorkMemory'`）。
- **修改** `vite.config.ts`：移除 `vite-plugin-electron` 与 `vite-plugin-electron-renderer`，保留 React 插件与 `@` alias。
- **修改** `index.html` CSP：使用 Tauri `tauri.conf.json` 的 `app.security.csp` 配置，开发环境保留 `localhost:5173`，生产环境移除（解决 P2-8）。
- **BREAKING** 删除 `package.json` 的 `build` 字段（electron-builder 配置）。
- **新增** `.github/workflows/` 或本地构建脚本：`tauri build` 替换 `npm run dist`。

### Phase 7：P2/P3 工程质量改进
- **修改** `tsconfig.json`：`exactOptionalPropertyTypes` 改为 `true`，修复随之暴露的类型错误（P2-9）。
- **修改** `package.json` `scripts`：新增 `"test": "vitest run"` 与 `"test:watch": "vitest"`（P2-10）。
- **修改** `.eslintrc.cjs`：`ignorePatterns` 仅保留 `['dist', 'dist-electron', 'release', 'node_modules']`，将 `*.config.ts` 纳入 lint（P2-11）；`no-empty` 改为 `['warn', { allowEmptyCatch: false }]`，要求 catch 块至少有 `console.warn` 或日志记录（P2-13）。
- **修改** `src/App.tsx`：为每个主路由增加 `<ErrorBoundary>` 包裹，或至少在 `<AppLayout>` 外层加全局兜底 Boundary（P3-16）。
- **修改** `src-tauri/src/db/database.rs`：WAL 模式下新增 `wal_checkpoint(TRUNCATE)` 策略，在 `before-quit` 前与每 6 小时定期执行（P3-18）。
- **修改** `src-tauri/src/main.rs` bootstrap：将 `evolveProfile`、`distillDay`、`detectPatterns` 三项独立任务改为 `tokio::join!` 并行执行（P3-14），`reflect` 与 `evolveSkills` 保持串行依赖。
- **Tauri 默认沙箱**：Tauri 的 webview 默认启用沙箱，无需额外配置（自动解决 P2-7 `sandbox: false`）。
- **移除** `setMainWindow` 导出（P2-12）：Tauri 通过 `AppHandle::get_webview_window` 获取窗口引用，无需外部 setter。

## Impact

- **Affected specs**：`evolve-perception-memory`（感知与记忆引擎进化）— 该 spec 涉及的全部 `electron/` 模块均需在 Tauri/Rust 中重新实现，逻辑契约保持不变。
- **Affected code**：
  - 全部 `electron/` 目录（删除）
  - 全部 `resources/ocr/` 目录（删除）
  - `scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`（删除）
  - `src/hooks/useIpc.ts`、`src/store/recordingStore.ts`、`src/types/index.ts`、`src/App.tsx`（修改）
  - `package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`、`.eslintrc.cjs`（修改）
  - 新增 `src-tauri/` 目录（Rust 实现）
- **Affected build**：构建工具链从 `vite-plugin-electron` + `electron-builder` 切换为 `tauri build`；CI 环境需安装 Rust toolchain + Windows SDK。
- **Affected runtime**：安装包体积从 ~300MB（Electron + PP-OCRv6）降至 ~15MB（Tauri + 系统 OCR）；启动内存从 ~200MB 降至 ~50MB。
- **Affected platform support**：Windows OCR API 仅在 Windows 10+ 可用，本变更后项目仅支持 Windows（与现有 `koffi` 调 `user32.dll` 的 Windows 强依赖一致，无跨平台回归）。

## ADDED Requirements

### Requirement: Tauri 主进程壳
系统 SHALL 提供 `src-tauri/` Rust 主进程，承载原 Electron 主进程的全部职责（窗口管理、IPC、数据库、捕获、OCR、AI、记忆、Wiki、洞察、Mascot）。

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
系统 SHALL 通过 `#[tauri::command]` 暴露与现有 `*Channels` 常量同名的命令，渲染进程通过 `invoke('command:name', payload)` 调用。

#### Scenario: 命令注册
- **WHEN** Tauri 主进程启动
- **THEN** 注册全部现有 IPC 通道（`window:*`、`segment:*`、`episode:*`、`cleanEpisode:*`、`wiki:*`、`report:*`、`privacy:*`、`capture:*`、`ocr:*`、`ai:*`、`mascot:*`、`settings:*`、`data:*`、`system:*`、`insights:*`、`search:*`）为 `#[tauri::command]`
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
- **AND** 不执行任何迁移（已是最新版本）
- **AND** 全部现有数据（segments、episodes、clean_episodes、wiki_pages、reports、privacy_rules、memory_cells、embeddings 等）可正常读写

#### Scenario: WAL checkpoint
- **WHEN** 应用退出（`before-quit` 事件）或运行满 6 小时
- **THEN** 执行 `PRAGMA wal_checkpoint(TRUNCATE)`
- **AND** WAL 文件被截断，避免磁盘占用异常增长

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
- **WHEN** `initDatabase()` 抛错（如磁盘满、文件锁占用）
- **THEN** `bootstrap().catch()` 捕获错误
- **AND** 调用 `dialog.message('WorkMemory 启动失败', error_summary).show()`
- **AND** 错误摘要包含错误类型与建议操作（如"请检查磁盘空间或关闭其他 WorkMemory 实例"）
- **AND** 不创建空白窗口

## MODIFIED Requirements

### Requirement: 服务停止序列
系统 SHALL 在 `before-quit` 事件中执行一次完整的服务停止序列，`window-all-closed` 仅负责触发 `app.quit()`（非 macOS）。

#### Scenario: 退出时停止服务
- **WHEN** 用户关闭主窗口或点击托盘退出
- **THEN** `before-quit` 事件触发 `stopAllServices()`
- **AND** 依次停止 MascotManager、InsightsManager、WikiIngestManager、MemCellIndexer、DistillManager、EpisodeManager、OcrManager、CaptureManager
- **AND** 执行 `wal_checkpoint(TRUNCATE)` 后关闭数据库
- **AND** 每个 Manager 的 `stop()` 仅被调用一次（不重复）

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

## REMOVED Requirements

### Requirement: PP-OCRv6 OCR 后端
**Reason**: Windows OCR API 已内置于 Windows 10+，无需打包 ~200MB 模型 + Python runtime；PP-OCRv6 的 server 模式/单次 CLI 回退/超时保护等复杂逻辑不再需要。
**Migration**: 
- 删除 `electron/ocr/PpOcrEngine.ts`、`electron/ocr/OcrQueue.ts`、`electron/ocr/OcrManager.ts`、`electron/ocr/OcrTextCleaner.ts`、`electron/ocr/OcrRuntimeManager.ts`
- 删除 `resources/ocr/` 全部内容
- 删除 `scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`
- `OcrManager` 在 Rust 中重新实现，对外接口契约（`getStatus`、`setModel`、`reprocess`、`recognizeImagePath`、`getRuntimeStatus`）保持不变
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
