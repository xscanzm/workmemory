# Tasks — 迁移至 Tauri + Windows OCR API + 功能与伙伴大升级

> 原则：渲染进程（React + Vite）保持不变，仅替换 IPC 调用层并新增页面/组件；主进程从 Electron/Node.js 迁移至 Tauri/Rust；OCR 引擎从 PP-OCRv6 切换为 Windows OCR API；新增功能层能力与桌面伙伴大升级。每个任务必须真实可用、完整闭环，禁止 TODO/占位符/mock/空实现。`cargo check` + `npm run typecheck` + `npm run build` 通过是所有任务的前置。
>
> 本 Sprint 分 15 个 Phase，Phase 0 为 P0 阻塞性修复，Phase 1-6 为 Tauri 迁移主线，Phase 7 为 P2/P3 工程质量改进，Phase 8-12 为功能层增强，Phase 13 为桌面伙伴大升级，Phase 14 为端到端验证。

## Phase 0：P0 验证与阻塞性修复（在 Electron 现有架构上完成）

- [ ] Task P0.1：验证模板字面量插值问题
  - [ ] P0.1.1 运行 `npm run typecheck`，记录编译错误
  - [ ] P0.1.2 运行 `npm run build`，记录构建错误
  - [ ] P0.1.3 若编译通过，确认 P0 描述的"模板字面量插值缺失"为 E2B 读取工具的渲染问题；若编译失败，定位并修复
  - [ ] P0.1.4 在 spec.md 中记录验证结论

- [ ] Task P0.2：修复 `runtimeLog.ts` 缺失
  - [ ] P0.2.1 新增 `electron/runtimeLog.ts`：导出 `logRuntime(scope: string, message: string): void`
  - [ ] P0.2.2 日志路径使用 `app.getPath('userData')` + `runtime.log`（不使用 `process.env.APPDATA`）
  - [ ] P0.2.3 应用名使用 `app.getName()`（不硬编码 `'WorkMemory'`）
  - [ ] P0.2.4 每行格式 `[ISO8601] [scope] message`
  - [ ] P0.2.5 写入失败静默忽略（try-catch）
  - [ ] P0.2.6 验证 `npm run typecheck` 通过

- [ ] Task P0.3：修复服务停止逻辑双重执行
  - [ ] P0.3.1 在 `electron/main/index.ts` 提取 `stopAllServices(): void` 公共函数
  - [ ] P0.3.2 `stopAllServices` 依次调用 8 个 Manager 的 `stop()` + `closeDatabase()`，try-catch 包裹
  - [ ] P0.3.3 `app.on('before-quit', stopAllServices)` 注册一次
  - [ ] P0.3.4 `app.on('window-all-closed')` 仅保留 `if (process.platform !== 'darwin') app.quit()`
  - [ ] P0.3.5 验证退出时每个 Manager 的 `stop()` 仅被调用一次

- [ ] Task P0.4：修复 `PrivacyGuard.seedDefaultRules()` 双重调用
  - [ ] P0.4.1 从 `bootstrap()` 第 77 行移除 `captureManager.getPrivacyGuard().seedDefaultRules()`
  - [ ] P0.4.2 保留 `CaptureManager.startCapture()` 第 82 行的 `this.privacyGuard.seedDefaultRules()`
  - [ ] P0.4.3 验证启动后 `privacy_rules` 表中默认规则仅播种一次

- [ ] Task P0.5：修复 Bootstrap 失败用户无感知
  - [ ] P0.5.1 在 `electron/main/index.ts` 顶部 import `dialog` from `electron`
  - [ ] P0.5.2 修改 `bootstrap().catch()` 块：调用 `dialog.showErrorBox('WorkMemory 启动失败', errorSummary)`
  - [ ] P0.5.3 `errorSummary` 包含错误类型 + `e.message` + 建议操作
  - [ ] P0.5.4 移除 `createMainWindow()` 兜底调用
  - [ ] P0.5.5 验证模拟数据库初始化失败时弹出错误对话框

## Phase 1：Tauri 壳搭建

- [ ] Task T1.1：初始化 Tauri 项目
  - [ ] T1.1.1 在项目根创建 `src-tauri/` 目录：`Cargo.toml`、`tauri.conf.json`、`build.rs`、`src/main.rs`、`src/lib.rs`
  - [ ] T1.1.2 配置 `Cargo.toml`：`name = "workmemory"`、`version = "0.3.0"`
  - [ ] T1.1.3 配置 `tauri.conf.json`：`productName: "WorkMemory"`、`appId: "com.workmemory.app"`
  - [ ] T1.1.4 验证 `npm run tauri dev` 可启动空白 Tauri 窗口

- [ ] Task T1.2：配置主窗口
  - [ ] T1.2.1 `tauri.conf.json` `app.windows[0]`：`width: 1280`、`height: 800`、`minWidth: 960`、`minHeight: 640`、`decorations: false`、`visible: false`
  - [ ] T1.2.2 配置 `titleBarStyle: "Overlay"`
  - [ ] T1.2.3 验证主窗口无边框、可拖拽、最小化/最大化/关闭按钮通过 `invoke('window:*')` 工作

- [ ] Task T1.3：配置 Mascot 透明窗口
  - [ ] T1.3.1 `tauri.conf.json` `app.windows` 新增第二个窗口：`label: "mascot"`、`url: "index.html#/mascot"`、`width: 340`、`height: 146`、`decorations: false`、`transparent: true`、`alwaysOnTop: true`、`skipTaskbar: true`、`visible: false`
  - [ ] T1.3.2 验证 Mascot 窗口透明、置顶、不在任务栏显示

- [ ] Task T1.4：配置 Cargo 依赖
  - [ ] T1.4.1 `tauri = { version = "2", features = ["dialog", "clipboard-manager", "path", "tray-icon", "window-state"] }`
  - [ ] T1.4.2 `rusqlite = { version = "0.31", features = ["bundled"] }`
  - [ ] T1.4.3 `windows = { version = "0.58", features = ["Win32_Graphics_Gdi", "Win32_UI_WindowsAndMessaging", "Win32_System_Threading", "Media_Ocr", "Media_TextRecognition", "Graphics_Imaging", "Graphics_Imaging_Bitmap", "Foundation", "Storage_Streams", "Globalization"] }`
  - [ ] T1.4.4 `reqwest = { version = "0.12", features = ["json", "rustls-tls", "stream"] }`、`tokio = { version = "1", features = ["full"] }`
  - [ ] T1.4.5 `serde`、`serde_json`、`chrono`、`uuid`、`anyhow`、`thiserror`
  - [ ] T1.4.6 `ort = { version = "2", features = ["download-binaries"] }`、`image = "0.25"`、`jieba = "0.1"`（或 `tauri-winrtnotification`）
  - [ ] T1.4.7 验证 `cargo check` 通过

- [ ] Task T1.5：移除 Electron 依赖
  - [ ] T1.5.1 `package.json` `devDependencies` 移除 `electron`、`electron-builder`、`vite-plugin-electron`、`vite-plugin-electron-renderer`、`@types/better-sqlite3`
  - [ ] T1.5.2 `dependencies` 移除 `better-sqlite3`、`koffi`
  - [ ] T1.5.3 新增 `@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-clipboard-manager`
  - [ ] T1.5.4 `scripts.dev` 改为 `tauri dev`，`scripts.dist` 改为 `tauri build`
  - [ ] T1.5.5 移除 `package.json` 的 `build` 字段与 `main` 字段
  - [ ] T1.5.6 验证 `npm install` 无报错

## Phase 2：核心原生模块迁移（Rust 实现）

- [ ] Task T2.1：SQLite 持久层迁移
  - [ ] T2.1.1 新增 `src-tauri/src/db/database.rs`：`init_database`、`get_database`、`close_database`、`wal_checkpoint`
  - [ ] T2.1.2 数据库路径使用 `app.path().app_data_dir()?.join("workmemory.db")`
  - [ ] T2.1.3 pragma：`journal_mode = WAL`、`foreign_keys = ON`、`synchronous = NORMAL`
  - [ ] T2.1.4 新增 `src-tauri/src/db/migrations.rs`：`CURRENT_VERSION = 18`（后续 Phase 8-12 会升级到 24），`run_migrations`
  - [ ] T2.1.5 新增 `src-tauri/src/db/schema.rs`：`SCHEMA_SQL`
  - [ ] T2.1.6 新增 `src-tauri/src/db/fts_tokenizer.rs`：用 `jieba` crate 实现中文分词
  - [ ] T2.1.7 新增 `src-tauri/src/db/json.rs`
  - [ ] T2.1.8 验证：在现有 `workmemory.db` 上运行迁移，`PRAGMA user_version` 为 18，无数据丢失

- [ ] Task T2.2：Repository 迁移（18 个）
  - [ ] T2.2.1 `segment_repository.rs`：11 个方法
  - [ ] T2.2.2 `episode_repository.rs`：12 个方法
  - [ ] T2.2.3 `clean_episode_repository.rs`：5 个方法
  - [ ] T2.2.4 `wiki_repository.rs`：15 个方法
  - [ ] T2.2.5 `report_repository.rs`：6 个方法
  - [ ] T2.2.6 `privacy_rule_repository.rs`：7 个方法（含 `seed_default_rules`）
  - [ ] T2.2.7 `search_repository.rs`：`fts`、`hybrid`（Phase 9 会扩展）
  - [ ] T2.2.8 `semantic_search_repository.rs`
  - [ ] T2.2.9 `embedding_repository.rs`
  - [ ] T2.2.10 `mem_cell_repository.rs`、`mem_scene_repository.rs`
  - [ ] T2.2.11 `causal_chain_repository.rs`、`daily_distill_repository.rs`、`feedback_event_repository.rs`、`reflection_report_repository.rs`、`skill_repository.rs`、`user_profile_repository.rs`、`weekly_pattern_repository.rs`
  - [ ] T2.2.12 `settings_store.rs`：6 个方法
  - [ ] T2.2.13 `data_manager.rs`：4 个方法
  - [ ] T2.2.14 验证：每个 Repository 方法与现有 TypeScript 版本行为一致

- [ ] Task T2.3：WindowWatcher 迁移
  - [ ] T2.3.1 新增 `src-tauri/src/capture/window_watcher.rs`：`start()`、`stop()`
  - [ ] T2.3.2 用 `windows` crate 调用 `GetForegroundWindow`、`GetWindowTextW`、`GetWindowThreadProcessId`、`OpenProcess`、`QueryFullProcessImageNameW`、`CloseHandle`
  - [ ] T2.3.3 轮询间隔 2 秒，`tokio::spawn` 异步循环
  - [ ] T2.3.4 检测窗口切换/标题改变/关键帧（5 分钟），`tokio::sync::mpsc` 发送事件
  - [ ] T2.3.5 `WindowInfo` struct：`hwnd`、`process_name`、`process_path`、`window_title`、`app_name`
  - [ ] T2.3.6 验证：切换窗口时事件正确触发

- [ ] Task T2.4：Screenshot 迁移
  - [ ] T2.4.1 新增 `src-tauri/src/capture/screenshot.rs`：`capture_window`、`capture_screen`
  - [ ] T2.4.2 用 `windows` crate 的 `Win32_Graphics_Gdi`：`GetWindowDC`、`CreateCompatibleDC`、`CreateCompatibleBitmap`、`BitBlt`、`GetDIBits`
  - [ ] T2.4.3 编码为 PNG（`image` crate），返回 `Vec<u8>`
  - [ ] T2.4.4 dHash：`calculate_image_hash`、`hamming_distance`、`is_similar`
  - [ ] T2.4.5 临时/持久截图管理：`save_temp_screenshot`、`delete_temp_screenshot`、`save_screenshot`、`clean_expired_screenshots`
  - [ ] T2.4.6 `ScreenshotResult` enum 与现有 TypeScript 版本结构一致
  - [ ] T2.4.7 验证：截图功能端到端可用

- [ ] Task T2.5：事件总线迁移
  - [ ] T2.5.1 新增 `src-tauri/src/events/bus.rs`：`EventBus` 封装 `tokio::sync::broadcast`
  - [ ] T2.5.2 事件类型：`SegmentCreated`、`SegmentMerged`、`PrivacyPlaceholder`、`StateChange`、`OcrCompleted`、`OcrFailed`、`EpisodesRebuilt`、`MemCellCreated`
  - [ ] T2.5.3 `subscribe` + `publish`
  - [ ] T2.5.4 验证：事件发布/订阅在多模块间正常工作

## Phase 3：OCR 引擎迁移至 Windows OCR API

- [ ] Task T3.1：WindowsOcrEngine 实现
  - [ ] T3.1.1 新增 `src-tauri/src/ocr/windows_ocr_engine.rs`：`WindowsOcrEngine` struct
  - [ ] T3.1.2 `initialize()`：`OcrEngine::TryCreateFromUserProfileLanguages()`，返回 `None` 时进入"未配置"状态
  - [ ] T3.1.3 `recognize(image_buffer)`：解码 PNG → `SoftwareBitmap::CreateCopyFromBuffer` → `engine.RecognizeAsync(&bitmap).await`
  - [ ] T3.1.4 拼接 `result.Lines().iter().map(|l| l.Text()).collect::<Vec<_>>().join("\n")`
  - [ ] T3.1.5 提取 `result.Lines().iter().flat_map(|l| l.Words()).map(|w| BoundingRect -> OcrBox).collect()`
  - [ ] T3.1.6 `OcrResult`：`text`、`boxes`、`confidence`（固定 1.0）、`elapsed`
  - [ ] T3.1.7 `release()`、`is_available()`
  - [ ] T3.1.8 验证：中英文混合截图识别准确率不低于 80%

- [ ] Task T3.2：OcrQueue 迁移
  - [ ] T3.2.1 新增 `src-tauri/src/ocr/ocr_queue.rs`：`OcrQueue` 封装 `tokio::sync::mpsc` + worker task
  - [ ] T3.2.2 `start()`、`stop()`、`enqueue(segment_id)`、`get_queue_size()`
  - [ ] T3.2.3 worker：取 segment → 读取截图 → `WindowsOcrEngine.recognize` → 更新数据库 → 触发 `OcrCompleted`
  - [ ] T3.2.4 OCR 完成后调用 5 个分类器（ActivityClassifier 等）
  - [ ] T3.2.5 失败：更新 `source_status = 'failed'`，触发 `OcrFailed`
  - [ ] T3.2.6 验证：连续入队 10 个 segment 全部被处理

- [ ] Task T3.3：OcrManager 迁移
  - [ ] T3.3.1 新增 `src-tauri/src/ocr/ocr_manager.rs`：`OcrManager` 单例
  - [ ] T3.3.2 `initialize`、`get_status`、`get_model`、`get_runtime_status`、`set_model`、`reprocess`、`recognize_image_path`、`stop`
  - [ ] T3.3.3 `BackendStatus.type` 为 `'windows_ocr' | 'unconfigured'`
  - [ ] T3.3.4 验证：接口契约与现有 `OcrManager` 一致

- [ ] Task T3.4：OcrTextCleaner 迁移
  - [ ] T3.4.1 新增 `src-tauri/src/ocr/ocr_text_cleaner.rs`：`clean_ocr_text(text)`
  - [ ] T3.4.2 实现与现有 TS 版本相同的清洗规则
  - [ ] T3.4.3 验证：对同一输入，输出与 TS 版本一致

- [ ] Task T3.5：删除旧 OCR 资源
  - [ ] T3.5.1 删除 `electron/ocr/` 目录
  - [ ] T3.5.2 删除 `resources/ocr/` 目录
  - [ ] T3.5.3 删除 `scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`
  - [ ] T3.5.4 验证：`cargo check` + `npm run typecheck` 通过，无悬空引用

## Phase 4：业务模块迁移

- [ ] Task T4.1：OpenAIClient 迁移（含流式）
  - [ ] T4.1.1 新增 `src-tauri/src/ai/openai_client.rs`：`OpenAIClient`
  - [ ] T4.1.2 `chat_completion`：`reqwest` POST，超时 30 秒，429/5xx 重试 2 次指数退避
  - [ ] T4.1.3 `chat_completion_stream`：`stream: true`，解析 SSE delta，`app_handle.emit("ai:streamDelta", chunk)` 推送，结束 emit `ai:streamDone`
  - [ ] T4.1.4 `test_connection`
  - [ ] T4.1.5 `OpenAiApiError`：`status_code`、`is_retryable`、`reason_code`
  - [ ] T4.1.6 reasoning_content 兜底逻辑
  - [ ] T4.1.7 验证：非流式与流式调用均正常

- [ ] Task T4.2：AI 管理器与引擎迁移
  - [ ] T4.2.1 `ai_manager.rs`、`distill_manager.rs`、`daily_distill_manager.rs`、`weekly_pattern_detector.rs`、`reflection_engine.rs`、`skill_evolver.rs`
  - [ ] T4.2.2 `report_generator.rs`、`report_exporter.rs`、`html_exporter.rs`、`feedback_loop.rs`、`proactive_advisor.rs`、`hour_context_pack_builder.rs`、`sensitive_masker.rs`、`templates.rs`、`distill_prompt.rs`
  - [ ] T4.2.3 `schemas/distill_event_schema.rs`：`serde` + 手写校验
  - [ ] T4.2.4 验证：日报生成、小时级 distill、周级模式检测、反思、技能进化流程完整

- [ ] Task T4.3：记忆模块迁移
  - [ ] T4.3.1 `embedding_service.rs`：`ort` crate 加载 `multilingual-e5-small`，`embed(text) -> Vec<f32>`
  - [ ] T4.3.2 `mem_cell.rs`、`mem_cell_indexer.rs`、`mem_scene_clusterer.rs`、`user_profile_evolver.rs`
  - [ ] T4.3.3 验证：MemCell 创建 → embedding → 向量检索 → 用户画像演进流程完整

- [ ] Task T4.4：Wiki 与 Insights 模块迁移
  - [ ] T4.4.1 `wiki/wiki_ingest_manager.rs`、`wiki_extractor.rs`、`wiki_link_engine.rs`、`high_value_signal_detector.rs`
  - [ ] T4.4.2 `insights/insights_manager.rs`、`anomaly_detector.rs`、`reminder_scheduler.rs`、`time_audit_engine.rs`
  - [ ] T4.4.3 验证：Wiki 扫描/提取/审核/入库、Insights 审计/异常/趋势/推送流程完整

- [ ] Task T4.5：Mascot 与 Tray 迁移
  - [ ] T4.5.1 `mascot/mascot_window.rs`：`WebviewWindowBuilder` 加载 `index.html#/mascot`，透明置顶
  - [ ] T4.5.2 拖拽与边缘吸附（<50px 吸附 + opacity 0.5）
  - [ ] T4.5.3 `mascot_manager.rs`、`mascot_notifier.rs`、`frequency_limiter.rs`
  - [ ] T4.5.4 `mascot/tray_manager.rs`：`TrayIconBuilder` 创建托盘
  - [ ] T4.5.5 验证：Mascot 显示/隐藏/拖拽/吸附/气泡/右键菜单/托盘退出全部可用

- [ ] Task T4.6：Capture 全链路迁移
  - [ ] T4.6.1 `capture/capture_manager.rs`：编排 WindowWatcher + Screenshot + CaptureDecision + PrivacyGuard + IncognitoDetector
  - [ ] T4.6.2 `capture_decision.rs`、`privacy_guard.rs`、`incognito_detector.rs`、`episode_builder.rs`、`episode_manager.rs`
  - [ ] T4.6.3 `activity_classifier.rs`、`content_classifier.rs`、`browser_context_collector.rs`、`layout_analyzer.rs`、`action_flow_inferrer.rs`、`one_line_summary.rs`、`entity_extractor.rs`
  - [ ] T4.6.4 `start_capture`、`stop_capture`、`pause`、`resume`、`get_state`
  - [ ] T4.6.5 系统空闲检测：`GetLastInputInfo`，3 分钟无活动进入 idle
  - [ ] T4.6.6 验证：完整捕获流程端到端可用

- [ ] Task T4.7：Bootstrap 迁移
  - [ ] T4.7.1 `src-tauri/src/main.rs` `setup` 钩子：完整启动序列
  - [ ] T4.7.2 `evolveProfile`、`distillDay`、`detectPatterns` 三项独立任务用 `tokio::join!` 并行执行（P3-14）
  - [ ] T4.7.3 `reflect` 与 `evolveSkills` 保持串行依赖
  - [ ] T4.7.4 bootstrap 失败时通过 `dialog::MessageDialog` 展示错误
  - [ ] T4.7.5 `before-quit` 事件执行 `stop_all_services()` + `wal_checkpoint(TRUNCATE)`
  - [ ] T4.7.6 验证：完整启动流程无错误，退出时服务正确停止

## Phase 5：IPC 层迁移

- [ ] Task T5.1：Tauri 命令注册
  - [ ] T5.1.1 `src-tauri/src/ipc/mod.rs`：`register_ipc_handlers(app: &AppHandle)`
  - [ ] T5.1.2 16 个命令分组文件：`window_commands.rs`、`segment_commands.rs`、`episode_commands.rs`、`clean_episode_commands.rs`、`wiki_commands.rs`、`report_commands.rs`、`privacy_commands.rs`、`capture_commands.rs`、`ocr_commands.rs`、`ai_commands.rs`、`mascot_commands.rs`、`settings_commands.rs`、`data_commands.rs`、`system_commands.rs`、`insights_commands.rs`、`search_commands.rs`
  - [ ] T5.1.3 每个命令入参用 `serde::Deserialize` + 手写校验
  - [ ] T5.1.4 `IpcResult<T>` enum：`Ok(T)` | `ValidationError { details }` | `InternalError { message }`，实现 `Serialize`
  - [ ] T5.1.5 验证：渲染进程 `invoke('segment:getByDate', { date: '2026-06-22' })` 返回正确数据

- [ ] Task T5.2：渲染进程 IPC 调用迁移
  - [ ] T5.2.1 新增 `src/types/ipc.ts`：从 `electron/types/ipc.ts` 搬运通道名常量与类型
  - [ ] T5.2.2 修改 `src/hooks/useIpc.ts`：`window.workmemory.xxx.yyy()` 替换为 `invoke('xxx:yyy', payload)`
  - [ ] T5.2.3 替换全部 `unknown` 类型为具体类型（P1-6）
  - [ ] T5.2.4 事件监听迁移：`ipcRenderer.on` 替换为 `listen`（`@tauri-apps/api/event`）
  - [ ] T5.2.5 `onMaximizeChange`、`onStateChange`、`onIncognitoDetected`、`onIncognitoCleared`、`onStateChanged`、`onStyleChanged`、`onBubbleShow`、`onNavigate` 全部迁移
  - [ ] T5.2.6 删除 `electron/preload/index.ts`
  - [ ] T5.2.7 验证：全部 9 个页面 IPC 调用正常

- [ ] Task T5.3：refreshTrigger 改为事件型刷新（P3-15）
  - [ ] T5.3.1 修改 `src/store/recordingStore.ts`：`refreshTrigger: number` 改为 `RefreshFlags { segments: number; episodes: number; wiki: number }`
  - [ ] T5.3.2 `triggerRefresh()` 改为 `triggerSegmentRefresh()`、`triggerEpisodeRefresh()`、`triggerWikiRefresh()`
  - [ ] T5.3.3 订阅组件按需选择订阅的 flag
  - [ ] T5.3.4 验证：segment 更新不会触发 wiki 组件重新查询

## Phase 6：构建与打包

- [ ] Task T6.1：Tauri 打包配置
  - [ ] T6.1.1 `tauri.conf.json` `bundle`：`targets: ["nsis"]`、`icon: ["icons/icon.ico"]`
  - [ ] T6.1.2 `bundle.windows.nsis`：`installMode: "currentUser"`、`languages: ["SimpChinese", "English"]`
  - [ ] T6.1.3 验证 `npm run dist`（即 `tauri build`）生成 NSIS 安装包

- [ ] Task T6.2：CSP 配置（P2-8）
  - [ ] T6.2.1 `tauri.conf.json` `app.security.csp`：生产环境 CSP
  - [ ] T6.2.2 `app.security.devCsp` 保留开发环境 `localhost:5173`
  - [ ] T6.2.3 删除 `index.html` 中的硬编码 CSP meta
  - [ ] T6.2.4 验证：生产构建 CSP 不含 `localhost:5173`

- [ ] Task T6.3：Vite 配置简化
  - [ ] T6.3.1 `vite.config.ts` 移除 `vite-plugin-electron` 与 `vite-plugin-electron-renderer`
  - [ ] T6.3.2 保留 `@vitejs/plugin-react` 与 `@` alias
  - [ ] T6.3.3 验证 `npm run build` 生成 `dist/` 目录

## Phase 7：P2/P3 工程质量改进（可与 Phase 4-6 并行）

- [ ] Task T7.1：TypeScript 严格性（P2-9）
  - [ ] T7.1.1 `tsconfig.json` `exactOptionalPropertyTypes` 改为 `true`
  - [ ] T7.1.2 运行 `npm run typecheck`，修复暴露的类型错误
  - [ ] T7.1.3 验证 typecheck 通过

- [ ] Task T7.2：测试脚本（P2-10）
  - [ ] T7.2.1 `package.json` `scripts` 新增 `"test": "vitest run"`、`"test:watch": "vitest"`
  - [ ] T7.2.2 验证 `npm test` 可运行现有 `__tests__` 目录中的测试

- [ ] Task T7.3：ESLint 配置（P2-11、P2-13）
  - [ ] T7.3.1 `.eslintrc.cjs` `ignorePatterns` 改为 `['dist', 'dist-electron', 'release', 'node_modules']`
  - [ ] T7.3.2 `no-empty` 改为 `['warn', { allowEmptyCatch: false }]`
  - [ ] T7.3.3 审查现有 `} catch { /* ignore */ }`，补充 `console.warn` 或日志记录
  - [ ] T7.3.4 验证 `npm run lint` 通过

- [ ] Task T7.4：React Error Boundary（P3-16）
  - [ ] T7.4.1 新增 `src/components/ErrorBoundary.tsx`：class 组件，捕获子树错误，渲染降级 UI
  - [ ] T7.4.2 `src/App.tsx` 在 `<AppLayout>` 外层包裹 `<ErrorBoundary>`
  - [ ] T7.4.3 验证：模拟组件抛错时显示降级 UI 而非白屏

- [ ] Task T7.5：SQLite WAL checkpoint（P3-18）
  - [ ] T7.5.1 `src-tauri/src/db/database.rs` 新增 `wal_checkpoint(conn)`
  - [ ] T7.5.2 `before-quit` 事件中调用 `wal_checkpoint`
  - [ ] T7.5.3 tokio 定时任务每 6 小时执行一次 `wal_checkpoint`
  - [ ] T7.5.4 验证：长时间运行后 WAL 文件大小被截断

- [ ] Task T7.6：移除 setMainWindow 导出（P2-12）
  - [ ] T7.6.1 Tauri 通过 `app_handle.get_webview_window("main")` 获取窗口引用
  - [ ] T7.6.2 确认渲染进程无 `setMainWindow` 调用
  - [ ] T7.6.3 验证：窗口引用通过 Tauri API 正确获取

## Phase 8：捕获与理解层增强 — 让"看见"更有意义

- [ ] Task F8.1：FocusStreakTracker 专注连续时段追踪
  - [ ] F8.1.1 新增 `src-tauri/src/capture/focus_streak_tracker.rs`：`FocusStreakTracker` struct
  - [ ] F8.1.2 `on_window_change(window_info)`：记录当前窗口的连续专注时段，窗口切换时结算上一段
  - [ ] F8.1.3 `FocusStreak` struct：`{ window_title, app_name, duration_sec, started_at, ended_at }`
  - [ ] F8.1.4 将 focusStreak 存入对应 Segment 的 metadata（JSON 字段）
  - [ ] F8.1.5 `get_switch_count_in_window(minutes: u32) -> u32`：统计 N 分钟内窗口切换次数
  - [ ] F8.1.6 验证：连续专注 25 分钟后 Segment.metadata.focusStreak.durationSec ≈ 1500

- [ ] Task F8.2：跨天任务连续性识别
  - [ ] F8.2.1 数据库迁移版本 19：`episodes` 表新增 `related_episode_ids TEXT NOT NULL DEFAULT '[]'`
  - [ ] F8.2.2 修改 `src-tauri/src/capture/episode_manager.rs`：Episode 创建后计算 title embedding
  - [ ] F8.2.3 检测与过去 7 天内 Episode 的 title embedding 余弦相似度 > 0.8
  - [ ] F8.2.4 建立 `relatedEpisodeIds[]` 字段，双向关联（今天→昨天，昨天→今天）
  - [ ] F8.2.5 新增 IPC 命令 `episode:getRelated`：返回指定 Episode 的关联 Episode 列表
  - [ ] F8.2.6 修改 `src/pages/Today.tsx`：展示"昨天也做了这个"的连续性提示
  - [ ] F8.2.7 验证：今天创建与昨天相似 title 的 Episode 后，Today 页面显示连续性提示

- [ ] Task F8.3：手动记忆创建入口
  - [ ] F8.3.1 数据库迁移：`episodes.source` 字段增加 `'manual'` 枚举值（无需 schema 变更，仅类型定义扩展）
  - [ ] F8.3.2 新增 IPC 命令 `episode:addManual`：入参 `{ title, tags, project, content }`，写入 Episode（`source: 'manual'`、`reportEligible: true`）
  - [ ] F8.3.3 修改 `src/pages/Today.tsx`：增加"+ 添加记忆"按钮，弹出表单（标题/标签/关联项目/自由文本）
  - [ ] F8.3.4 提交后调用 `invoke('episode:addManual', payload)`，成功后 `triggerEpisodeRefresh`
  - [ ] F8.3.5 验证：手动添加的 Episode 立即出现在 Today 页面，不触发 OCR

- [ ] Task F8.4：待办事项自动提取
  - [ ] F8.4.1 新增 `src-tauri/src/capture/todo_extractor.rs`：`extract_todos(ocr_text: &str) -> Vec<Todo>`
  - [ ] F8.4.2 正则匹配关键词：`TODO`、`待办`、`下一步`、`Action Item`、`TBD`、`FIXME`，提取后续文本作为待办内容
  - [ ] F8.4.3 简单 AI 提取（可选）：对长文本调用 OpenAI 提取待办（<100 tokens）
  - [ ] F8.4.4 `Todo` struct：`{ text: String, done: bool }`
  - [ ] F8.4.5 修改 `EpisodeBuilder`：OCR 完成后调用 `TodoExtractor`，存入 `Episode.todos[]`
  - [ ] F8.4.6 新增 IPC 命令 `episode:toggleTodo`：入参 `{ episodeId, todoIndex, done }`
  - [ ] F8.4.7 修改 `src/pages/Today.tsx` 侧栏：展示当日待办汇总，支持一键勾选完成
  - [ ] F8.4.8 验证：OCR 文本含 "TODO: 修复登录 bug" 后，Today 侧栏显示该待办，勾选后状态持久化

## Phase 9：搜索层增强 — 让"查找"更自然

- [ ] Task F9.1：时间语义搜索
  - [ ] F9.1.1 新增 `src-tauri/src/ai/query_parser.rs`：`parse_query(query: &str) -> ParsedQuery`
  - [ ] F9.1.2 `ParsedQuery` struct：`{ time_range?: { start, end }, entity?: String, type?: String, project?: String, aggregate_by?: String }`
  - [ ] F9.1.3 轻量 AI 调用（<100 tokens）：将自然语言查询解析为结构化 JSON
  - [ ] F9.1.4 时间语义解析："上周五下午" → `time_range: { start: "2026-06-13T12:00", end: "2026-06-13T18:00" }`
  - [ ] F9.1.5 实体语义解析："和张三开会的时候" → `entity: "张三", type: "meeting"`
  - [ ] F9.1.6 聚合语义解析："做 XX 项目最长的那天" → `project: "XX", aggregate_by: "duration"`
  - [ ] F9.1.7 修改 `SearchRepository.hybrid`：支持 `ParsedQuery` 结构化查询条件
  - [ ] F9.1.8 验证：三种语义查询均返回正确结果

- [ ] Task F9.2：人物时间线视图
  - [ ] F9.2.1 新增 `SearchRepository.get_by_entity(name: String) -> Vec<Episode>`：按实体聚合返回相关 Episode
  - [ ] F9.2.2 新增 IPC 命令 `search:getByEntity`：入参 `{ name }`
  - [ ] F9.2.3 新增 `src/components/EntityTimeline.tsx`：按实体聚合展示时间轴
  - [ ] F9.2.4 修改 `src/pages/Search.tsx`：增加维度切换（关键词搜索 / 人物时间线）
  - [ ] F9.2.5 验证：搜索"张三"后切换到人物时间线，展示所有相关 Episode 的时间轴

## Phase 10：报告层增强 — 让"输出"更实用

- [ ] Task F10.1：站会报告模板
  - [ ] F10.1.1 数据库迁移版本 20：`episodes` 表新增 `blockers TEXT NOT NULL DEFAULT '[]'`（或 `clean_episodes` 表）
  - [ ] F10.1.2 修改 `src-tauri/src/ai/templates.rs`：新增 `standup` 模板
  - [ ] F10.1.3 模板结构：Yesterday（从昨日 Episode 提取）/ Today（从当日 `todos` 字段提取）/ Blockers（从 `blockers` 字段提取）
  - [ ] F10.1.4 输出纯文本格式，适合粘贴群聊
  - [ ] F10.1.5 验证：生成 standup 报告输出三段式纯文本

- [ ] Task F10.2：周报自动发送与定时提醒
  - [ ] F10.2.1 修改 `src-tauri/src/insights/reminder_scheduler.rs`：新增每周五 17:30 周报提醒
  - [ ] F10.2.2 推送 Mascot 气泡"本周报告已就绪，点击查看"，含 Action Button（依赖 Phase 13.3）
  - [ ] F10.2.3 可配置：周报/日报自动生成时间（存入 `app_settings`）
  - [ ] F10.2.4 报告导出格式增加：`.md` 文件 / 复制到剪贴板（复用 `writeClipboard` IPC）
  - [ ] F10.2.5 验证：周五 17:30 推送提醒，点击"查看报告"跳转 Reports 页面

- [ ] Task F10.3：报告历史对比
  - [ ] F10.3.1 新增 `src/components/ReportCompare.tsx`：对比视图组件
  - [ ] F10.3.2 修改 `src/pages/Reports.tsx`：增加"对比模式"入口
  - [ ] F10.3.3 选择两份日报/周报 → 左右对比展示
  - [ ] F10.3.4 高亮：新增项目、消失项目、时间占比变化
  - [ ] F10.3.5 数据源：`daily_distills` + `weekly_patterns` 表
  - [ ] F10.3.6 验证：对比 6 月 21 日与 22 日日报，正确高亮差异

## Phase 11：Wiki 知识层增强 — 让"沉淀"更可用

- [ ] Task F11.1：Wiki 知识图谱可视化
  - [ ] F11.1.1 修改 `src/pages/Graph.tsx`：节点大小 = 被引用次数（backlinks 数量）
  - [ ] F11.1.2 节点颜色 = `wiki_type`（人/项目/决策/问题）
  - [ ] F11.1.3 点击节点 → 右侧预览 WikiPage 内容
  - [ ] F11.1.4 悬停边 → 显示 Episode 引用来源
  - [ ] F11.1.5 验证：Graph 页面展示完整知识图谱，交互正常

- [ ] Task F11.2：知识卡片过期提醒
  - [ ] F11.2.1 数据库迁移版本 21：`wiki_pages` 表新增 `last_accessed_at TEXT`
  - [ ] F11.2.2 新增 `WikiRepository.touch_accessed(id)`：Episode 引用 WikiPage 时更新 `last_accessed_at`
  - [ ] F11.2.3 新增 `WikiRepository.get_stale(days: i64) -> Vec<WikiPage>`：返回超过 N 天未被引用的 WikiPage
  - [ ] F11.2.4 修改 `src/pages/Insights.tsx`：新增"知识库健康度"卡片（陈旧 / 活跃 / 近期新增）
  - [ ] F11.2.5 陈旧卡片标记"待复核"
  - [ ] F11.2.6 验证：超过 30 天未引用的 WikiPage 在 Insights 页面标记"待复核"

- [ ] Task F11.3：外部知识导入
  - [ ] F11.3.1 新增 `src-tauri/src/wiki/note_importer.rs`：`import_markdown_dir(path) -> Vec<WikiPageDraft>`
  - [ ] F11.3.2 解析 `.md` 文件，提取标题、内容、`[[双链]]` 语法
  - [ ] F11.3.3 `[[双链]]` 转为 WikiPage backlinks
  - [ ] F11.3.4 导入的页面注入 WikiIngestManager 审核队列
  - [ ] F11.3.5 新增 IPC 命令 `wiki:importNotes`：入参 `{ path }`
  - [ ] F11.3.6 修改 `src/pages/Settings.tsx`：增加"导入笔记"入口（文件夹选择对话框）
  - [ ] F11.3.7 验证：导入 Obsidian vault 后，页面进入审核队列，人工确认后入库

## Phase 12：洞察层增强 — 让"建议"更聪明

- [ ] Task F12.1：实时专注状态感知
  - [ ] F12.1.1 新增 `src-tauri/src/insights/focus_state_detector.rs`：`FocusStateDetector`
  - [ ] F12.1.2 订阅 FocusStreakTracker 事件，检测连续专注同一窗口 > 25min → 触发 `FOCUS_25MIN`
  - [ ] F12.1.3 检测 5 分钟内窗口切换 > 10 次 → 触发 `FRAGMENTED_5MIN`
  - [ ] F12.1.4 与 MascotManager 集成：触发提醒时调用 `mascot_manager.show_bubble`
  - [ ] F12.1.5 修改 `src-tauri/src/mascot/mascot_manager.rs`：状态机新增 `state: 'focused'`
  - [ ] F12.1.6 验证：连续专注 25 分钟后 Mascot 提示"休息一下"

- [ ] Task F12.2：目标对齐度评分
  - [ ] F12.2.1 数据库迁移版本 22：新增 `goals` 表 `{ id TEXT PRIMARY KEY, week_start TEXT, goal_text TEXT, created_at TEXT }`
  - [ ] F12.2.2 新增 `src-tauri/src/insights/goal_alignment_analyzer.rs`：`GoalAlignmentAnalyzer`
  - [ ] F12.2.3 用户设定 3 条周目标（自然语言），存入 `goals` 表
  - [ ] F12.2.4 每天的 CleanEpisode 自动打标"与目标 N 相关"（基于 embedding 相似度）
  - [ ] F12.2.5 WeeklyPattern 报告增加"目标达成情况"章节
  - [ ] F12.2.6 新增 IPC 命令 `goals:set`、`goals:getByWeek`、`goals:getAlignment`
  - [ ] F12.2.7 修改 `src/pages/Settings.tsx`：增加周目标设置入口
  - [ ] F12.2.8 验证：设定周目标后，周报含"目标达成情况"章节

- [ ] Task F12.3：Today 页面 24h 时间轴视图
  - [ ] F12.3.1 新增 `src/components/Timeline24h.tsx`：24 小时时间轴组件
  - [ ] F12.3.2 色块 = Episode 类型（coding/writing/meeting/...），宽度 = 时长
  - [ ] F12.3.3 点击色块 → 右侧展示 Episode 详情
  - [ ] F12.3.4 空白区域 = 未记录时段，点击可手动补充（调用 `episode:addManual`）
  - [ ] F12.3.5 修改 `src/pages/Today.tsx`：增加时间轴视图切换（列表 / 时间轴）
  - [ ] F12.3.6 验证：Today 页面展示 24h 时间轴，色块与 Episode 类型对应

- [ ] Task F12.4：数据健康仪表盘
  - [ ] F12.4.1 数据库迁移版本 23：新增 `ai_usage` 表 `{ id TEXT PRIMARY KEY, called_at TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, feature TEXT }`
  - [ ] F12.4.2 修改 `OpenAIClient`：每次调用后记录到 `ai_usage` 表
  - [ ] F12.4.3 新增 IPC 命令 `insights:getHealth`：返回 `{ ocr_rate, coverage_today, wiki_size, wiki_growth, ai_calls, ai_tokens }`
  - [ ] F12.4.4 修改 `src/pages/Insights.tsx`：新增"记录健康度"卡片
  - [ ] F12.4.5 展示：OCR 识别率、今日记录覆盖率、Wiki 知识库大小 & 增长趋势、AI 调用次数 & token 消耗
  - [ ] F12.4.6 验证：Insights 页面展示完整健康度卡片

## Phase 13：桌面伙伴大升级

### 13.1 存在感设计

- [ ] Task M13.1：首次启动引导动画
  - [ ] M13.1.1 修改 `src/pages/Mascot.tsx`：检测 `app_settings.mascot_onboarded`，未完成时播放引导动画
  - [ ] M13.1.2 Mascot 从屏幕底部"飞入"停在右下角（CSS `transform` 动画）
  - [ ] M13.1.3 气泡依次展示："嗨！我是你的工作记忆助手"、"我会在后台记录你的工作"、"点击我随时查看今日记忆，或右键呼出菜单"
  - [ ] M13.1.4 轻轻抖动（`shake` 动画）等待用户点击
  - [ ] M13.1.5 用户点击后调用 `invoke('settings:set', { mascot_onboarded: true })` 记录完成
  - [ ] M13.1.6 验证：首次启动播放引导，第二次启动不再触发

- [ ] Task M13.2：呼吸动画与状态视觉
  - [ ] M13.2.1 修改 `src/pages/Mascot.css`：新增 `breathing`（scale 1.0↔1.04）、`scanning`（opacity 0.6↔1.0）、`floating`（translateY 0↔-4px）关键帧
  - [ ] M13.2.2 `recording` 状态：小红点 + 呼吸动画 + 绿色光晕（`box-shadow`）
  - [ ] M13.2.3 `paused` 状态：灰度滤镜（`filter: grayscale(1)`）+ 暂停图标角标
  - [ ] M13.2.4 `privacy` 状态：双手捂眼动作 / 遮眼拉帘效果
  - [ ] M13.2.5 `ocr_scanning` 状态：扫描线动画 + 眼睛追踪效果
  - [ ] M13.2.6 `report_ready` 状态：金色高亮 + 弹跳提示 + 角标数字（未读报告数）
  - [ ] M13.2.7 验证：5 种状态视觉区分清晰

### 13.2 情感与个性设计

- [ ] Task M13.3：情绪状态机
  - [ ] M13.3.1 修改 `src/types/index.ts`：新增 `MascotEmotion` 类型 `'happy' | 'focused' | 'concerned' | 'curious' | 'proud' | 'sleepy'`
  - [ ] M13.3.2 修改 `src-tauri/src/mascot/mascot_manager.rs`：`set_emotion(emotion)` 方法，与功能状态独立叠加
  - [ ] M13.3.3 情绪触发规则：连续专注 20min+ → `focused`；生成好报告 → `happy`；长时间未休息 → `concerned`；检测新应用 → `curious`；本周目标完成 → `proud`；夜间/系统闲置 → `sleepy`
  - [ ] M13.3.4 情绪影响：眼睛形状、气泡语气、动画速度
  - [ ] M13.3.5 验证：连续专注 20min 后 Mascot 情绪切换为 `focused`，视觉表现变化

- [ ] Task M13.4：上下文感知问候
  - [ ] M13.4.1 新增 `src-tauri/src/mascot/greeting_generator.rs`：`generate_greeting(context) -> String`
  - [ ] M13.4.2 场景化问候：`morning_start`（7:00–10:00）、`after_focus`（连续专注 25min 后）、`report_ready`（报告生成完成）、`late_night`（22:00 后）、`monday_morning`（周一早上）、`first_episode`（当日首条 Episode）
  - [ ] M13.4.3 问候语支持变量插值：`{min}`、`{hour}`、`{n}`、`{title}`
  - [ ] M13.4.4 验证：不同场景触发对应问候语

- [ ] Task M13.5：点击互动分层
  - [ ] M13.5.1 修改 `src-tauri/src/mascot/mascot_manager.rs` `left_click()`：
    - 有未读报告 → `navigate('reports')`
    - 有待办 → 展示今日待办气泡
    - 否则 → 随机励志短句（2s 后自动消失）
  - [ ] M13.5.2 右键上下文菜单：[📋 今日记忆] [⏸ 暂停记录] [📝 快速记一笔] [⚙️ 设置] [👁 隐藏 10min]
  - [ ] M13.5.3 右键双击触发 Ghost 捕获（动画强化）
  - [ ] M13.5.4 悬停：展示今日摘要 tooltip + 眼神追踪效果
  - [ ] M13.5.5 验证：四种交互（左键/右键/右键双击/悬停）反馈正确

### 13.3 主动触达升级

- [ ] Task M13.6：智能提醒分级
  - [ ] M13.6.1 修改 `src-tauri/src/insights/reminder_scheduler.rs`：新增 `ReminderTrigger` 枚举
  - [ ] M13.6.2 时间驱动：`SCHEDULED`（已有）
  - [ ] M13.6.3 行为驱动：`FOCUS_25MIN`、`FRAGMENTED_5MIN`、`IDLE_30MIN`、`LATE_WORK`
  - [ ] M13.6.4 事件驱动：`REPORT_READY`、`WIKI_REVIEW_DUE`、`SKILL_UNLOCKED`
  - [ ] M13.6.5 与 FocusStateDetector、OcrQueue、WikiIngestManager、SkillEvolver 事件源对接
  - [ ] M13.6.6 验证：各类触发条件满足时推送对应提醒

- [ ] Task M13.7：气泡 Action Button
  - [ ] M13.7.1 修改 `BubblePayload`：新增 `actions?: Array<{ label: string; page?: string; action?: string }>`
  - [ ] M13.7.2 修改 `src/pages/Mascot.tsx`：渲染 Action Button，点击通过 `invoke(MascotChannels.Navigate)` 路由
  - [ ] M13.7.3 "稍后提醒"action：关闭气泡，30 分钟后再次提醒
  - [ ] M13.7.4 验证：报告就绪气泡含 `[查看报告]` `[稍后提醒]` 按钮，点击行为正确

- [ ] Task M13.8：免打扰时段设置
  - [ ] M13.8.1 数据库迁移版本 24：`app_settings` 表新增 `mascot_dnd_start`、`mascot_dnd_end`、`mascot_min_interval_min`、`mascot_work_hours_only` 字段
  - [ ] M13.8.2 修改 `ReminderScheduler`：推送前检查免打扰时段、提醒间隔下限、工作日仅工作时间
  - [ ] M13.8.3 修改 `src/pages/Settings.tsx`：增加桌面伙伴设置区（启用主动提醒、免打扰时段、提醒间隔下限、工作日仅工作时间提醒）
  - [ ] M13.8.4 验证：免打扰时段内不推送提醒；距上次提醒不足间隔下限时不推送

### 13.4 视觉设计提升

- [ ] Task M13.9：形象角色人格设计
  - [ ] M13.9.1 为 5 种形象设计角色人格：`note`（备忘录小鸟，认真负责）、`film`（胶片小熊，浪漫文艺）、`copilot`（宇航员猫，高效专业）、`cursor`（光标精灵，灵动活泼）、`paper`（折纸狐狸，智慧温和）
  - [ ] M13.9.2 每种形象含：默认站姿（静止帧）+ 6-8 帧循环动画（CSS animation 或 Lottie）
  - [ ] M13.9.3 专属气泡颜色/字体
  - [ ] M13.9.4 专属问候语风格
  - [ ] M13.9.5 验证：切换形象后视觉与语气风格变化

- [ ] Task M13.10：气泡 UI 精致化
  - [ ] M13.10.1 修改 `src/pages/Mascot.css`：`.mascot-bubble` 磨砂玻璃效果（`backdrop-filter: blur(12px)`、`background: rgba(255,255,255,0.85)`）
  - [ ] M13.10.2 圆角 16px + 阴影（`box-shadow: 0 4px 24px rgba(0,0,0,0.12)`）
  - [ ] M13.10.3 `bubble-in` 出现动画（`cubic-bezier(0.34, 1.56, 0.64, 1)`，0.25s）
  - [ ] M13.10.4 验证：气泡出现时有弹性动画，视觉精致

- [ ] Task M13.11：拖拽边缘吸附
  - [ ] M13.11.1 修改 `src-tauri/src/mascot/mascot_window.rs`：`drag_end` 时检测位置
  - [ ] M13.11.2 自动吸附到最近边缘（左或右，margin 20px）
  - [ ] M13.11.3 平滑动画过渡（CSS `transition` 或 `requestAnimationFrame`）
  - [ ] M13.11.4 验证：拖拽到屏幕中间松开后自动吸附到边缘

- [ ] Task M13.12：深色模式适配
  - [ ] M13.12.1 修改 `src/pages/Mascot.tsx`：监听 Tauri `window.theme()` 变化
  - [ ] M13.12.2 深色模式：气泡深色背景 + 浅色字
  - [ ] M13.12.3 伙伴形象深色变体（或调整图层亮度 `filter: brightness(0.8)`）
  - [ ] M13.12.4 验证：系统切换深色模式后 Mascot 视觉适配

### 13.5 集成感 — 与主窗口打通

- [ ] Task M13.13：悬浮卡片通知中心
  - [ ] M13.13.1 新增 `src/components/MascotHoverCard.tsx`：悬浮卡片组件
  - [ ] M13.13.2 右键菜单"今日记忆"触发悬浮卡片（不打开主窗口）
  - [ ] M13.13.3 卡片内容：最近 3 条 Episode（时间 + 标题）+ 专注时长 + 切换次数 + "打开完整视图"按钮
  - [ ] M13.13.4 验证：右键选择"今日记忆"后展示悬浮卡片

- [ ] Task M13.14：Mascot 状态与主窗口同步
  - [ ] M13.14.1 用户在设置页关闭 OCR → Mascot 展示气泡"已切换到纯截图模式"
  - [ ] M13.14.2 用户暂停记录 → Mascot 进入 `paused` 状态，30min 后主动提醒"已暂停 30 分钟，要恢复吗？"
  - [ ] M13.14.3 报告生成完成 → Mascot 状态切换 `report_ready`，角标 +1
  - [ ] M13.14.4 验证：三种主窗口操作均触发 Mascot 状态同步与反馈

## Phase 14：端到端验证

- [ ] Task V14.1：完整流程验证
  - [ ] V14.1.1 安装 Tauri 构建的 NSIS 包，启动 WorkMemory
  - [ ] V14.1.2 验证主窗口、Mascot、托盘正常显示
  - [ ] V14.1.3 切换窗口 3 次，验证 segments 表有 3 条新记录，ocr_text 非空
  - [ ] V14.1.4 等待 1 小时，验证 clean_episodes 表有 distill 记录
  - [ ] V14.1.5 在设置页配置 OpenAI API Key，点击"生成日报"，验证流式输出
  - [ ] V14.1.6 退出应用，验证 `wal_checkpoint` 执行，WAL 文件被截断
  - [ ] V14.1.7 重新启动，验证数据完整无丢失

- [ ] Task V14.2：从 Electron 版本升级验证
  - [ ] V14.2.1 在已安装 Electron 版本的机器上，记录 `workmemory.db` 的 `PRAGMA user_version`（应为 18）与各表行数
  - [ ] V14.2.2 卸载 Electron 版本（保留 userData 目录），安装 Tauri 版本
  - [ ] V14.2.3 启动 Tauri 版本，验证 `PRAGMA user_version` 升级到 24
  - [ ] V14.2.4 验证各表行数与升级前一致，数据可正常查询/编辑
  - [ ] V14.2.5 验证 OCR 功能正常（Windows OCR API 替代 PP-OCRv6）

- [ ] Task V14.3：新增功能验证
  - [ ] V14.3.1 FocusStreakTracker：连续专注 25 分钟后 Segment.metadata.focusStreak 正确记录
  - [ ] V14.3.2 跨天任务：今天创建与昨天相似 title 的 Episode 后，Today 页面显示连续性提示
  - [ ] V14.3.3 手动记忆：Today 页面"+ 添加记忆"按钮可用，新 Episode 立即出现
  - [ ] V14.3.4 待办提取：OCR 文本含 TODO 后，Today 侧栏显示待办，勾选后状态持久化
  - [ ] V14.3.5 时间语义搜索："上周五下午"返回正确时间范围的 Episode
  - [ ] V14.3.6 人物时间线：搜索"张三"切换人物时间线，展示所有相关 Episode
  - [ ] V14.3.7 站会模板：生成 standup 报告输出三段式纯文本
  - [ ] V14.3.8 周报自动提醒：周五 17:30 推送 Mascot 气泡
  - [ ] V14.3.9 报告对比：对比两份日报高亮差异
  - [ ] V14.3.10 Wiki 图谱：Graph 页面节点大小/颜色/交互正确
  - [ ] V14.3.11 知识过期：超过 30 天未引用的 WikiPage 标记"待复核"
  - [ ] V14.3.12 外部导入：导入 Obsidian vault 后页面进入审核队列
  - [ ] V14.3.13 专注感知：连续专注 25 分钟后 Mascot 提示"休息一下"
  - [ ] V14.3.14 目标对齐：设定周目标后周报含"目标达成情况"章节
  - [ ] V14.3.15 Today 时间轴：24h 时间轴色块与 Episode 类型对应
  - [ ] V14.3.16 数据健康：Insights 页面展示完整健康度卡片
  - [ ] V14.3.17 Mascot 首次启动引导：首次启动播放引导，第二次不再触发
  - [ ] V14.3.18 Mascot 呼吸动画：5 种状态视觉区分清晰
  - [ ] V14.3.19 Mascot 情绪状态机：连续专注 20min 后情绪切换为 `focused`
  - [ ] V14.3.20 Mascot 上下文问候：不同场景触发对应问候语
  - [ ] V14.3.21 Mascot 点击分层：四种交互反馈正确
  - [ ] V14.3.22 Mascot 智能提醒：各类触发条件满足时推送对应提醒
  - [ ] V14.3.23 Mascot 气泡 Action Button：报告就绪气泡含按钮，点击行为正确
  - [ ] V14.3.24 Mascot 免打扰：免打扰时段内不推送提醒
  - [ ] V14.3.25 Mascot 形象人格：切换形象后视觉与语气风格变化
  - [ ] V14.3.26 Mascot 气泡磨砂玻璃：气泡出现时有弹性动画
  - [ ] V14.3.27 Mascot 拖拽吸附：拖拽到屏幕中间松开后自动吸附到边缘
  - [ ] V14.3.28 Mascot 深色模式：系统切换深色模式后 Mascot 视觉适配
  - [ ] V14.3.29 Mascot 悬浮卡片：右键选择"今日记忆"后展示悬浮卡片
  - [ ] V14.3.30 Mascot 状态同步：三种主窗口操作均触发 Mascot 状态同步

# Task Dependencies

- Phase 0（P0 修复）独立于 Tauri 迁移，应最先完成
- Phase 1（Tauri 壳）依赖 Phase 0 完成
- Phase 2（核心原生模块）依赖 Phase 1 完成
- Phase 3（OCR 引擎）依赖 Phase 2 的 `windows` crate 依赖配置
- Phase 4（业务模块）依赖 Phase 2 + Phase 3 完成
- Phase 5（IPC 层）依赖 Phase 4 完成
- Phase 6（构建打包）依赖 Phase 5 完成
- Phase 7（P2/P3 改进）可与 Phase 4-6 并行，但 T7.5（WAL checkpoint）依赖 Phase 2 的 database.rs
- Phase 8（捕获与理解层增强）依赖 Phase 4 + Phase 5 完成（需 EpisodeManager、IPC、Today 页面）
- Phase 9（搜索层增强）依赖 Phase 5 + Phase 8 完成（需 SearchRepository、query parser）
- Phase 10（报告层增强）依赖 Phase 5 + Phase 8 完成（需 templates、ReminderScheduler、todos 字段）
- Phase 11（Wiki 知识层增强）依赖 Phase 5 完成（需 WikiRepository、Graph 页面）
- Phase 12（洞察层增强）依赖 Phase 5 + Phase 8 完成（需 FocusStateDetector、goals 表、ai_usage 表）
- Phase 13（桌面伙伴大升级）依赖 Phase 5 + Phase 12 完成（需 MascotManager、FocusStateDetector、ReminderScheduler）
- Phase 14（端到端验证）依赖 Phase 6 + Phase 7 + Phase 8-13 全部完成
