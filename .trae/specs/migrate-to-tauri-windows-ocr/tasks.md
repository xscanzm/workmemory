# Tasks — 迁移至 Tauri + Windows OCR API

> 原则：渲染进程（React + Vite）保持不变，仅替换 IPC 调用层；主进程从 Electron/Node.js 迁移至 Tauri/Rust；OCR 引擎从 PP-OCRv6 切换为 Windows OCR API。每个任务必须真实可用、完整闭环，禁止 TODO/占位符/mock/空实现。`cargo check` + `npm run typecheck` + `npm run build` 通过是所有任务的前置。
>
> 本 Sprint 分 8 个 Phase，Phase 0 为 P0 阻塞性修复（在现有 Electron 架构上完成），Phase 1-6 为 Tauri 迁移主线（按依赖关系推进），Phase 7 为 P2/P3 工程质量改进（可与 Phase 4-6 并行）。

## Phase 0：P0 验证与阻塞性修复（在 Electron 现有架构上完成）

- [ ] Task P0.1：验证模板字面量插值问题
  - [ ] P0.1.1 运行 `npm run typecheck`，记录编译错误
  - [ ] P0.1.2 运行 `npm run build`，记录构建错误
  - [ ] P0.1.3 若编译通过，确认 P0 描述的"模板字面量插值缺失"为 E2B 读取工具的渲染问题，非真实代码缺陷；若编译失败，定位并修复
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
  - [ ] P0.3.4 `app.on('window-all-closed')` 仅保留 `if (process.platform !== 'darwin') app.quit()`，移除停止序列
  - [ ] P0.3.5 验证退出时每个 Manager 的 `stop()` 仅被调用一次（可加临时计数日志）

- [ ] Task P0.4：修复 `PrivacyGuard.seedDefaultRules()` 双重调用
  - [ ] P0.4.1 从 `bootstrap()` 第 77 行移除 `captureManager.getPrivacyGuard().seedDefaultRules()`
  - [ ] P0.4.2 保留 `CaptureManager.startCapture()` 第 82 行的 `this.privacyGuard.seedDefaultRules()`
  - [ ] P0.4.3 验证启动后 `privacy_rules` 表中默认规则仅播种一次

- [ ] Task P0.5：修复 Bootstrap 失败用户无感知
  - [ ] P0.5.1 在 `electron/main/index.ts` 顶部 import `dialog` from `electron`
  - [ ] P0.5.2 修改 `bootstrap().catch()` 块：调用 `dialog.showErrorBox('WorkMemory 启动失败', errorSummary)`
  - [ ] P0.5.3 `errorSummary` 包含错误类型 + `e.message` + 建议操作（如"请检查磁盘空间或查看日志"）
  - [ ] P0.5.4 移除 `createMainWindow()` 兜底调用（不再创建空白窗口）
  - [ ] P0.5.5 验证模拟数据库初始化失败时弹出错误对话框

## Phase 1：Tauri 壳搭建

- [ ] Task T1.1：初始化 Tauri 项目
  - [ ] T1.1.1 在项目根运行 `npm create tauri-app@latest -- --template react-ts`（或手动创建 `src-tauri/`）
  - [ ] T1.1.2 配置 `src-tauri/Cargo.toml`：`name = "workmemory"`、`version = "0.3.0"`
  - [ ] T1.1.3 配置 `src-tauri/tauri.conf.json`：`productName: "WorkMemory"`、`appId: "com.workmemory.app"`
  - [ ] T1.1.4 验证 `npm run tauri dev` 可启动空白 Tauri 窗口

- [ ] Task T1.2：配置主窗口
  - [ ] T1.2.1 `tauri.conf.json` `app.windows[0]`：`title: "WorkMemory 今日记忆"`、`width: 1280`、`height: 800`、`minWidth: 960`、`minHeight: 640`、`decorations: false`、`transparent: false`、`visible: false`（启动后显示）
  - [ ] T1.2.2 配置 `titleBarStyle: "Overlay"`（Windows 上实现自定义标题栏）
  - [ ] T1.2.3 验证主窗口无边框、可拖拽、最小化/最大化/关闭按钮通过 `invoke('window:*')` 工作

- [ ] Task T1.3：配置 Mascot 透明窗口
  - [ ] T1.3.1 `tauri.conf.json` `app.windows` 新增第二个窗口：`label: "mascot"`、`url: "index.html#/mascot"`、`width: 340`、`height: 146`、`decorations: false`、`transparent: true`、`alwaysOnTop: true`、`skipTaskbar: true`、`visible: false`
  - [ ] T1.3.2 验证 Mascot 窗口透明、置顶、不在任务栏显示

- [ ] Task T1.4：配置 Cargo 依赖
  - [ ] T1.4.1 `src-tauri/Cargo.toml` `[dependencies]`：`tauri = { version = "2", features = ["dialog", "clipboard-manager", "path", "tray-icon", "window-state"] }`
  - [ ] T1.4.2 `rusqlite = { version = "0.31", features = ["bundled"] }`
  - [ ] T1.4.3 `windows = { version = "0.58", features = ["Win32_Graphics_Gdi", "Win32_UI_WindowsAndMessaging", "Win32_System_Threading", "Media_Ocr", "Media_TextRecognition", "Graphics_Imaging", "Graphics_Imaging_Bitmap", "Foundation", "Storage_Streams", "Globalization"] }`
  - [ ] T1.4.4 `reqwest = { version = "0.12", features = ["json", "rustls-tls", "stream"] }`、`tokio = { version = "1", features = ["full"] }`
  - [ ] T1.4.5 `serde = { version = "1", features = ["derive"] }`、`serde_json = "1"`、`chrono = { version = "0.4", features = ["serde"] }`、`uuid = { version = "1", features = ["v4"] }`、`anyhow = "1"`、`thiserror = "1"`
  - [ ] T1.4.6 `ort = { version = "2", features = ["download-binaries"] }`（用于 Embedding 推理）
  - [ ] T1.4.7 验证 `cargo check` 通过

- [ ] Task T1.5：移除 Electron 依赖
  - [ ] T1.5.1 `package.json` `devDependencies` 移除 `electron`、`electron-builder`、`vite-plugin-electron`、`vite-plugin-electron-renderer`、`@types/better-sqlite3`
  - [ ] T1.5.2 `dependencies` 移除 `better-sqlite3`、`koffi`
  - [ ] T1.5.3 新增 `@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-clipboard-manager` 到 `dependencies`
  - [ ] T1.5.4 `scripts.dev` 改为 `tauri dev`，`scripts.build` 改为 `tsc --noEmit && vite build`，`scripts.dist` 改为 `tauri build`
  - [ ] T1.5.5 移除 `package.json` 的 `build` 字段（electron-builder 配置）与 `main` 字段
  - [ ] T1.5.6 验证 `npm install` 无报错

## Phase 2：核心原生模块迁移（Rust 实现）

- [ ] Task T2.1：SQLite 持久层迁移
  - [ ] T2.1.1 新增 `src-tauri/src/db/database.rs`：`init_database(app: &AppHandle) -> Result<Connection>`、`get_database() -> Result<&Connection>`、`close_database()`、`wal_checkpoint()`
  - [ ] T2.1.2 数据库路径使用 `app.path().app_data_dir()?.join("workmemory.db")`
  - [ ] T2.1.3 pragma 配置：`journal_mode = WAL`、`foreign_keys = ON`、`synchronous = NORMAL`
  - [ ] T2.1.4 新增 `src-tauri/src/db/migrations.rs`：`CURRENT_VERSION = 18`、`run_migrations(conn: &Connection)`，迁移 SQL 从 `electron/db/migrations.ts` 逐版本搬运
  - [ ] T2.1.5 新增 `src-tauri/src/db/schema.rs`：`SCHEMA_SQL` 常量，从 `electron/db/schema.ts` 搬运
  - [ ] T2.1.6 新增 `src-tauri/src/db/fts_tokenizer.rs`：用 Rust 实现中文分词（`jieba` crate 或简单字符级分词），注册为 SQLite 函数
  - [ ] T2.1.7 新增 `src-tauri/src/db/json.rs`：JSON 序列化/反序列化辅助
  - [ ] T2.1.8 验证：在现有 `workmemory.db` 上运行迁移，`PRAGMA user_version` 应为 18，无数据丢失

- [ ] Task T2.2：Repository 迁移（18 个）
  - [ ] T2.2.1 `src-tauri/src/db/repositories/segment_repository.rs`：`get_by_id`、`get_by_date`、`get_active_by_date`、`update`、`set_selected_for_report`、`set_important`、`soft_delete`、`hard_delete`、`get_private_by_date`、`insert`、`get_pending_for_ocr`
  - [ ] T2.2.2 `src-tauri/src/db/repositories/episode_repository.rs`：`insert`、`update`、`get_by_id`、`get_by_date`、`set_one_line_summary`、`set_report_eligible`、`set_wiki_eligible`、`get_daily_summary`、`set_daily_summary`、`confirm_entity`、`correct_entity`、`ignore_entity`
  - [ ] T2.2.3 `src-tauri/src/db/repositories/clean_episode_repository.rs`：`get_by_id`、`get_by_date`、`get_by_hour`、`get_by_date_range`、`update`
  - [ ] T2.2.4 `src-tauri/src/db/repositories/wiki_repository.rs`：全部 15 个方法
  - [ ] T2.2.5 `src-tauri/src/db/repositories/report_repository.rs`：`update`、`save_draft`、`get_by_id`、`get_by_date`、`get_all_history`、`set_status`
  - [ ] T2.2.6 `src-tauri/src/db/repositories/privacy_rule_repository.rs`：`insert`、`update`、`delete`、`get_all`、`get_enabled`、`match_rule`、`seed_default_rules`
  - [ ] T2.2.7 `src-tauri/src/db/repositories/search_repository.rs`：`fts`、`hybrid`
  - [ ] T2.2.8 `src-tauri/src/db/repositories/semantic_search_repository.rs`：语义检索相关
  - [ ] T2.2.9 `src-tauri/src/db/repositories/embedding_repository.rs`：embedding 存储/查询
  - [ ] T2.2.10 `src-tauri/src/db/repositories/mem_cell_repository.rs`、`mem_scene_repository.rs`：MemCell/MemScene 持久化
  - [ ] T2.2.11 `src-tauri/src/db/repositories/causal_chain_repository.rs`、`daily_distill_repository.rs`、`feedback_event_repository.rs`、`reflection_report_repository.rs`、`skill_repository.rs`、`user_profile_repository.rs`、`weekly_pattern_repository.rs`
  - [ ] T2.2.12 `src-tauri/src/db/settings_store.rs`：`get`、`set`、`reset`、`set_api_key`、`clear_api_key`、`get_api_key`
  - [ ] T2.2.13 `src-tauri/src/db/data_manager.rs`：`cleanup`、`clear_day`、`clear_all`、`get_stats`
  - [ ] T2.2.14 验证：每个 Repository 方法与现有 TypeScript 版本行为一致（通过单元测试或集成测试）

- [ ] Task T2.3：WindowWatcher 迁移
  - [ ] T2.3.1 新增 `src-tauri/src/capture/window_watcher.rs`：`WindowWatcher` struct，实现 `start()`、`stop()`
  - [ ] T2.3.2 用 `windows` crate 调用 `GetForegroundWindow`、`GetWindowTextW`、`GetWindowThreadProcessId`、`OpenProcess`、`QueryFullProcessImageNameW`、`CloseHandle`
  - [ ] T2.3.3 轮询间隔 2 秒（与现有 `WindowWatcher` 一致），通过 `tokio::spawn` 异步循环
  - [ ] T2.3.4 检测窗口切换/标题改变/关键帧（5 分钟），通过 `tokio::sync::mpsc` 发送事件
  - [ ] T2.3.5 `WindowInfo` struct：`hwnd: isize`、`process_name: String`、`process_path: String`、`window_title: String`、`app_name: String`
  - [ ] T2.3.6 验证：切换窗口时事件正确触发，进程名/标题正确获取

- [ ] Task T2.4：Screenshot 迁移
  - [ ] T2.4.1 新增 `src-tauri/src/capture/screenshot.rs`：`capture_window(hwnd: isize) -> ScreenshotResult`、`capture_screen() -> ScreenshotResult`
  - [ ] T2.4.2 用 `windows` crate 的 `Win32_Graphics_Gdi`：`GetWindowDC`、`CreateCompatibleDC`、`CreateCompatibleBitmap`、`BitBlt`、`GetDIBits` 获取像素数据
  - [ ] T2.4.3 编码为 PNG（用 `image` crate），返回 `Vec<u8>`
  - [ ] T2.4.4 dHash 感知哈希：`calculate_image_hash(buffer: &[u8]) -> String`、`hamming_distance(h1: &str, h2: &str) -> usize`、`is_similar(h1: &str, h2: &str, threshold: usize) -> bool`
  - [ ] T2.4.5 临时/持久截图管理：`save_temp_screenshot`、`delete_temp_screenshot`、`save_screenshot`、`clean_expired_screenshots`
  - [ ] T2.4.6 `ScreenshotResult` enum：`Ok { buffer, width, height, source, display_bounds }` | `Failed { reason, error }`
  - [ ] T2.4.7 验证：能截取指定窗口与整屏，dHash 计算结果与现有 JS 版本一致

- [ ] Task T2.5：事件总线迁移
  - [ ] T2.5.1 新增 `src-tauri/src/events/bus.rs`：`EventBus` struct，封装 `tokio::sync::broadcast`
  - [ ] T2.5.2 事件类型：`SegmentCreated`、`SegmentMerged`、`PrivacyPlaceholder`、`StateChange`、`OcrCompleted`、`OcrFailed`、`EpisodesRebuilt`、`MemCellCreated`
  - [ ] T2.5.3 `subscribe(event_type) -> Receiver<Event>`、`publish(event: Event)`
  - [ ] T2.5.4 验证：事件发布/订阅在多模块间正常工作

## Phase 3：OCR 引擎迁移至 Windows OCR API

- [ ] Task T3.1：WindowsOcrEngine 实现
  - [ ] T3.1.1 新增 `src-tauri/src/ocr/windows_ocr_engine.rs`：`WindowsOcrEngine` struct
  - [ ] T3.1.2 `initialize() -> Result<()>`：调用 `OcrEngine::TryCreateFromUserProfileLanguages()`，存为实例字段；返回 `None` 时进入"未配置"状态
  - [ ] T3.1.3 `recognize(image_buffer: &[u8]) -> Result<OcrResult>`：
    - 用 `image` crate 解码 PNG 为 `DynamicImage`，转为 BGRA8
    - 创建 `SoftwareBitmap::Create_copy_from_buffer(buffer, BitmapPixelFormat::Bgra8, width, height, BitmapAlphaMode::Premultiplied)`
    - 调用 `engine.RecognizeAsync(&bitmap).await?`
    - 拼接 `result.Lines().iter().map(|l| l.Text()).collect::<Vec<_>>().join("\n")`
    - 提取 `result.Lines().iter().flat_map(|l| l.Words()).map(|w| BoundingRect -> OcrBox).collect()`
  - [ ] T3.1.4 `OcrResult` struct：`text: String`、`boxes: Vec<OcrBox>`、`confidence: f64`（Windows OCR API 不返回 confidence，固定为 1.0）、`elapsed: u64`
  - [ ] T3.1.5 `release()`：释放引擎资源
  - [ ] T3.1.6 `is_available() -> bool`：检测 `OcrEngine::TryCreateFromUserProfileLanguages()` 是否返回 `Some`
  - [ ] T3.1.7 验证：对中英文混合截图识别，输出文本与 PP-OCRv6 结果对比，准确率不低于 80%

- [ ] Task T3.2：OcrQueue 迁移
  - [ ] T3.2.1 新增 `src-tauri/src/ocr/ocr_queue.rs`：`OcrQueue` struct，封装 `tokio::sync::mpsc` + worker task
  - [ ] T3.2.2 `start()`、`stop()`、`enqueue(segment_id: String)`、`get_queue_size() -> usize`
  - [ ] T3.2.3 worker 逻辑：从 channel 取 segment_id → 读取截图 → 调用 `WindowsOcrEngine.recognize` → 更新 `segments.ocr_text/ocr_blocks/ocr_confidence` → 触发 `OcrCompleted` 事件
  - [ ] T3.2.4 OCR 完成后调用 `ActivityClassifier`、`ContentClassifier`、`LayoutAnalyzer`、`BrowserContextCollector`、`ActionFlowInferrer`（与现有 `OcrQueue.onOcrSuccess` 一致）
  - [ ] T3.2.5 失败处理：更新 `segments.source_status = 'failed'`，触发 `OcrFailed` 事件
  - [ ] T3.2.6 验证：连续入队 10 个 segment，全部被处理，事件正确触发

- [ ] Task T3.3：OcrManager 迁移
  - [ ] T3.3.1 新增 `src-tauri/src/ocr/ocr_manager.rs`：`OcrManager` 单例（用 `once_cell::sync::Lazy` 或 `tokio::sync::Mutex`）
  - [ ] T3.3.2 `initialize(model: OcrModel) -> Result<()>`：创建引擎 + 启动队列 + 订阅 `SegmentCreated` 事件
  - [ ] T3.3.3 `get_status() -> OcrManagerStatus`、`get_model() -> OcrModel`、`get_runtime_status() -> BackendStatus`
  - [ ] T3.3.4 `set_model(model: OcrModel) -> bool`：Windows OCR API 无模型切换，保留接口但仅更新内部字段
  - [ ] T3.3.5 `reprocess(segment_id: String) -> bool`、`recognize_image_path(path: String) -> Result<String>`
  - [ ] T3.3.6 `stop()`：停止队列 + 释放引擎
  - [ ] T3.3.7 `BackendStatus.type` 改为 `'windows_ocr' | 'unconfigured'`
  - [ ] T3.3.8 验证：与现有 `OcrManager` 接口契约完全一致

- [ ] Task T3.4：OcrTextCleaner 迁移
  - [ ] T3.4.1 新增 `src-tauri/src/ocr/ocr_text_cleaner.rs`：`clean_ocr_text(text: &str) -> String`
  - [ ] T3.4.2 实现与现有 `OcrTextCleaner.ts` 相同的清洗规则（去多余空白、合并断行、去 OCR 噪声字符）
  - [ ] T3.4.3 验证：对同一输入文本，输出与 TS 版本一致

- [ ] Task T3.5：删除旧 OCR 资源
  - [ ] T3.5.1 删除 `electron/ocr/PpOcrEngine.ts`、`electron/ocr/OcrQueue.ts`、`electron/ocr/OcrManager.ts`、`electron/ocr/OcrTextCleaner.ts`、`electron/ocr/OcrRuntimeManager.ts`
  - [ ] T3.5.2 删除 `electron/ocr/__tests__/` 目录
  - [ ] T3.5.3 删除 `resources/ocr/` 目录（含 models、paddlex、ppocr_cli.py）
  - [ ] T3.5.4 删除 `scripts/build-ocr-runtime.ps1`、`ppocr_cli.spec`
  - [ ] T3.5.5 验证：`cargo check` + `npm run typecheck` 通过，无悬空引用

## Phase 4：业务模块迁移

- [ ] Task T4.1：OpenAIClient 迁移（含流式）
  - [ ] T4.1.1 新增 `src-tauri/src/ai/openai_client.rs`：`OpenAIClient` struct
  - [ ] T4.1.2 `chat_completion(params: ChatCompletionParams) -> Result<ChatCompletionResult>`：用 `reqwest` 发起 POST，超时 30 秒，429/5xx 重试 2 次指数退避
  - [ ] T4.1.3 `chat_completion_stream(params, app_handle) -> Result<TokenUsage>`：`stream: true`，解析 SSE delta，通过 `app_handle.emit("ai:streamDelta", chunk)` 推送，结束 emit `ai:streamDone`
  - [ ] T4.1.4 `test_connection(params) -> { ok, message }`
  - [ ] T4.1.5 错误处理：`OpenAiApiError` 携带 `status_code`、`is_retryable`、`reason_code`
  - [ ] T4.1.6 reasoning_content 兜底逻辑：仅返回 reasoning_content 时追加 user message 重试
  - [ ] T4.1.7 验证：非流式与流式调用均正常，鉴权失败返回 401 错误

- [ ] Task T4.2：AI 管理器与引擎迁移
  - [ ] T4.2.1 `src-tauri/src/ai/ai_manager.rs`、`distill_manager.rs`、`daily_distill_manager.rs`、`weekly_pattern_detector.rs`、`reflection_engine.rs`、`skill_evolver.rs`
  - [ ] T4.2.2 `src-tauri/src/ai/report_generator.rs`、`report_exporter.rs`、`html_exporter.rs`、`feedback_loop.rs`、`proactive_advisor.rs`、`hour_context_pack_builder.rs`、`sensitive_masker.rs`、`templates.rs`、`distill_prompt.rs`
  - [ ] T4.2.3 `src-tauri/src/ai/schemas/distill_event_schema.rs`：用 `serde` 反序列化 + 手写校验替换 Zod
  - [ ] T4.2.4 验证：日报生成、小时级 distill、周级模式检测、反思、技能进化流程完整可用

- [ ] Task T4.3：记忆模块迁移
  - [ ] T4.3.1 `src-tauri/src/memory/embedding_service.rs`：用 `ort` crate 加载 `multilingual-e5-small` ONNX 模型，`embed(text: &str) -> Result<Vec<f32>>`
  - [ ] T4.3.2 `src-tauri/src/memory/mem_cell.rs`、`mem_cell_indexer.rs`、`mem_scene_clusterer.rs`、`user_profile_evolver.rs`
  - [ ] T4.3.3 验证：MemCell 创建 → embedding 生成 → 向量检索 → 用户画像演进流程完整

- [ ] Task T4.4：Wiki 与 Insights 模块迁移
  - [ ] T4.4.1 `src-tauri/src/wiki/wiki_ingest_manager.rs`、`wiki_extractor.rs`、`wiki_link_engine.rs`、`high_value_signal_detector.rs`
  - [ ] T4.4.2 `src-tauri/src/insights/insights_manager.rs`、`anomaly_detector.rs`、`reminder_scheduler.rs`、`time_audit_engine.rs`
  - [ ] T4.4.3 验证：Wiki 扫描/提取/审核/入库、Insights 审计/异常/趋势/推送流程完整

- [ ] Task T4.5：Mascot 与 Tray 迁移
  - [ ] T4.5.1 `src-tauri/src/mascot/mascot_window.rs`：通过 `WebviewWindowBuilder` 加载 `index.html#/mascot`，透明置顶，初始位置屏幕右下角
  - [ ] T4.5.2 拖拽与边缘吸附：监听 `window-drag` 事件，松开后检测靠近边缘（<50px），自动吸附 + opacity 0.5
  - [ ] T4.5.3 `src-tauri/src/mascot/mascot_manager.rs`、`mascot_notifier.rs`、`frequency_limiter.rs`
  - [ ] T4.5.4 `src-tauri/src/mascot/tray_manager.rs`：用 `tauri::tray::TrayIconBuilder` 创建系统托盘，菜单项与现有 `TrayManager` 一致
  - [ ] T4.5.5 验证：Mascot 显示/隐藏/拖拽/吸附/气泡/右键菜单/托盘退出全部可用

- [ ] Task T4.6：Capture 全链路迁移
  - [ ] T4.6.1 `src-tauri/src/capture/capture_manager.rs`：编排 `WindowWatcher` + `Screenshot` + `CaptureDecision` + `PrivacyGuard` + `IncognitoDetector`
  - [ ] T4.6.2 `src-tauri/src/capture/capture_decision.rs`、`privacy_guard.rs`、`incognito_detector.rs`、`episode_builder.rs`、`episode_manager.rs`
  - [ ] T4.6.3 `src-tauri/src/capture/activity_classifier.rs`、`content_classifier.rs`、`browser_context_collector.rs`、`layout_analyzer.rs`、`action_flow_inferrer.rs`、`one_line_summary.rs`、`entity_extractor.rs`
  - [ ] T4.6.4 `start_capture()`、`stop_capture()`、`pause()`、`resume()`、`get_state() -> RecordingState`
  - [ ] T4.6.5 系统空闲检测：用 `GetLastInputInfo` 替换 `powerMonitor`，3 分钟无活动进入 idle
  - [ ] T4.6.6 验证：完整捕获流程（窗口切换 → 截图 → OCR → Episode 聚合 → 事件广播）端到端可用

- [ ] Task T4.7：Bootstrap 迁移
  - [ ] T4.7.1 `src-tauri/src/main.rs` `setup` 钩子：`init_database` → `register_ipc_handlers` → `create_main_window` → `ocr_manager.initialize` → `episode_manager.initialize` → `distill_manager.initialize` → `mem_cell_indexer.start` → `evolve_profile`（异步）→ `distill_day`（异步）→ `detect_patterns` + `reflect` + `evolve_skills`（异步）→ `wiki_ingest_manager.initialize` → `insights_manager.initialize` → `mascot_manager.initialize` → `capture_manager.start_capture`
  - [ ] T4.7.2 启动序列中 `evolveProfile`、`distillDay`、`detectPatterns` 三项独立任务用 `tokio::join!` 并行执行（P3-14）
  - [ ] T4.7.3 `reflect` 与 `evolveSkills` 保持串行依赖
  - [ ] T4.7.4 bootstrap 失败时通过 `tauri::plugin::dialog::MessageDialog` 展示错误
  - [ ] T4.7.5 `before-quit` 事件执行 `stop_all_services()` + `wal_checkpoint(TRUNCATE)`
  - [ ] T4.7.6 验证：完整启动流程无错误，退出时服务正确停止

## Phase 5：IPC 层迁移

- [ ] Task T5.1：Tauri 命令注册
  - [ ] T5.1.1 `src-tauri/src/ipc/mod.rs`：`register_ipc_handlers(app: &AppHandle)`，注册全部 `#[tauri::command]`
  - [ ] T5.1.2 命令分组：`window_commands.rs`、`segment_commands.rs`、`episode_commands.rs`、`clean_episode_commands.rs`、`wiki_commands.rs`、`report_commands.rs`、`privacy_commands.rs`、`capture_commands.rs`、`ocr_commands.rs`、`ai_commands.rs`、`mascot_commands.rs`、`settings_commands.rs`、`data_commands.rs`、`system_commands.rs`、`insights_commands.rs`、`search_commands.rs`
  - [ ] T5.1.3 每个命令的入参用 `serde::Deserialize` + 手写校验，失败返回 `IpcResult::ValidationError`
  - [ ] T5.1.4 命令抛错时返回 `IpcResult::InternalError`，正常返回 `IpcResult::Ok(data)`
  - [ ] T5.1.5 `IpcResult<T>` enum：`Ok(T)` | `ValidationError { details }` | `InternalError { message }`，实现 `Serialize`
  - [ ] T5.1.6 验证：渲染进程 `invoke('segment:getByDate', { date: '2026-06-22' })` 返回正确数据

- [ ] Task T5.2：渲染进程 IPC 调用迁移
  - [ ] T5.2.1 新增 `src/types/ipc.ts`：从 `electron/types/ipc.ts` 搬运通道名常量与类型定义
  - [ ] T5.2.2 修改 `src/hooks/useIpc.ts`：`window.workmemory.xxx.yyy()` 替换为 `invoke('xxx:yyy', payload)`
  - [ ] T5.2.3 替换全部 `unknown` 类型为具体类型（P1-6）：`segment.update` 的 `patch: Partial<WorkSegment>`、`episode.insert` 的 `episode: Episode` 等
  - [ ] T5.2.4 事件监听迁移：`ipcRenderer.on(channel, cb)` 替换为 `listen(channel, cb)`（来自 `@tauri-apps/api/event`）
  - [ ] T5.2.5 `onMaximizeChange`、`onStateChange`、`onIncognitoDetected`、`onIncognitoCleared`、`onStateChanged`、`onStyleChanged`、`onBubbleShow`、`onNavigate` 全部迁移
  - [ ] T5.2.6 删除 `electron/preload/index.ts`
  - [ ] T5.2.7 验证：渲染进程全部页面（Today/Calendar/Search/Insights/Wiki/Graph/Reports/Settings/Mascot）IPC 调用正常

- [ ] Task T5.3：refreshTrigger 改为事件型刷新（P3-15）
  - [ ] T5.3.1 修改 `src/store/recordingStore.ts`：`refreshTrigger: number` 改为 `RefreshFlags { segments: number; episodes: number; wiki: number }`
  - [ ] T5.3.2 `triggerRefresh()` 改为 `triggerSegmentRefresh()`、`triggerEpisodeRefresh()`、`triggerWikiRefresh()`
  - [ ] T5.3.3 订阅组件按需选择订阅的 flag（如 SegmentList 仅订阅 `segments`）
  - [ ] T5.3.4 验证：segment 更新不会触发 wiki 组件重新查询

## Phase 6：构建与打包

- [ ] Task T6.1：Tauri 打包配置
  - [ ] T6.1.1 `src-tauri/tauri.conf.json` `bundle`：`targets: ["nsis"]`、`icon: ["icons/icon.ico"]`
  - [ ] T6.1.2 `bundle.windows.nsis`：`installMode: "currentUser"`、`languages: ["SimpChinese", "English"]`、`displayLanguageSelector: false`
  - [ ] T6.1.3 `bundle.resources`：无需额外资源（OCR 由系统提供）
  - [ ] T6.1.4 验证 `npm run dist`（即 `tauri build`）生成 NSIS 安装包

- [ ] Task T6.2：CSP 配置（P2-8）
  - [ ] T6.2.1 `tauri.conf.json` `app.security.csp`：生产环境 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: asset:; connect-src 'self' ipc: http://ipc.localhost`
  - [ ] T6.2.2 开发环境通过 `app.security.devCsp` 保留 `localhost:5173`
  - [ ] T6.2.3 删除 `index.html` 中的硬编码 CSP meta（由 Tauri 接管）
  - [ ] T6.2.4 验证：生产构建中 CSP 不含 `localhost:5173`

- [ ] Task T6.3：Vite 配置简化
  - [ ] T6.3.1 `vite.config.ts` 移除 `vite-plugin-electron` 与 `vite-plugin-electron-renderer`
  - [ ] T6.3.2 保留 `@vitejs/plugin-react` 与 `@` alias
  - [ ] T6.3.3 `build.outDir: "dist"`、`server.port: 5173`（Tauri dev 自动注入）
  - [ ] T6.3.4 验证 `npm run build` 生成 `dist/` 目录

## Phase 7：P2/P3 工程质量改进（可与 Phase 4-6 并行）

- [ ] Task T7.1：TypeScript 严格性（P2-9）
  - [ ] T7.1.1 `tsconfig.json` `exactOptionalPropertyTypes` 改为 `true`
  - [ ] T7.1.2 运行 `npm run typecheck`，修复暴露的类型错误
  - [ ] T7.1.3 验证 typecheck 通过

- [ ] Task T7.2：测试脚本（P2-10）
  - [ ] T7.2.1 `package.json` `scripts` 新增 `"test": "vitest run"`、`"test:watch": "vitest"`
  - [ ] T7.2.2 验证 `npm test` 可运行现有 `__tests__` 目录中的测试

- [ ] Task T7.3：ESLint 配置（P2-11、P2-13）
  - [ ] T7.3.1 `.eslintrc.cjs` `ignorePatterns` 改为 `['dist', 'dist-electron', 'release', 'node_modules']`（移除 `'*.config.ts'`）
  - [ ] T7.3.2 `no-empty` 改为 `['warn', { allowEmptyCatch: false }]`
  - [ ] T7.3.3 审查现有 `} catch { /* ignore */ }`，补充 `console.warn` 或日志记录
  - [ ] T7.3.4 验证 `npm run lint` 通过

- [ ] Task T7.4：React Error Boundary（P3-16）
  - [ ] T7.4.1 新增 `src/components/ErrorBoundary.tsx`：class 组件，捕获子树错误，渲染降级 UI（错误摘要 + "刷新"按钮）
  - [ ] T7.4.2 `src/App.tsx` 在 `<AppLayout>` 外层包裹 `<ErrorBoundary>`
  - [ ] T7.4.3 为 `Calendar`、`Wiki`、`Reports`、`Insights`、`Graph`、`Search`、`Settings` 各路由增加独立 `<ErrorBoundary>`（可选，至少全局兜底）
  - [ ] T7.4.4 验证：模拟组件抛错时显示降级 UI 而非白屏

- [ ] Task T7.5：SQLite WAL checkpoint（P3-18）
  - [ ] T7.5.1 `src-tauri/src/db/database.rs` 新增 `wal_checkpoint(conn: &Connection)`：执行 `PRAGMA wal_checkpoint(TRUNCATE)`
  - [ ] T7.5.2 `before-quit` 事件中调用 `wal_checkpoint`
  - [ ] T7.5.3 启动一个 tokio 定时任务，每 6 小时执行一次 `wal_checkpoint`
  - [ ] T7.5.4 验证：长时间运行后 WAL 文件大小被截断

- [ ] Task T7.6：移除 setMainWindow 导出（P2-12）
  - [ ] T7.6.1 Tauri 通过 `app_handle.get_webview_window("main")` 获取窗口引用，无需外部 setter
  - [ ] T7.6.2 确认渲染进程无 `setMainWindow` 调用
  - [ ] T7.6.3 验证：窗口引用通过 Tauri API 正确获取

## Phase 8：端到端验证

- [ ] Task T8.1：完整流程验证
  - [ ] T8.1.1 安装 Tauri 构建的 NSIS 包，启动 WorkMemory
  - [ ] T8.1.2 验证主窗口显示、Mascot 显示、托盘显示
  - [ ] T8.1.3 切换窗口 3 次，验证 segments 表有 3 条新记录，ocr_text 非空（Windows OCR API 工作）
  - [ ] T8.1.4 等待 1 小时，验证 clean_episodes 表有 distill 记录
  - [ ] T8.1.5 在设置页配置 OpenAI API Key，点击"生成日报"，验证流式输出
  - [ ] T8.1.6 退出应用，验证 `wal_checkpoint` 执行，WAL 文件被截断
  - [ ] T8.1.7 重新启动，验证数据完整无丢失

- [ ] Task T8.2：从 Electron 版本升级验证
  - [ ] T8.2.1 在已安装 Electron 版本的机器上，记录 `workmemory.db` 的 `PRAGMA user_version`（应为 18）与各表行数
  - [ ] T8.2.2 卸载 Electron 版本（保留 userData 目录），安装 Tauri 版本
  - [ ] T8.2.3 启动 Tauri 版本，验证 `PRAGMA user_version` 仍为 18，无迁移执行
  - [ ] T8.2.4 验证各表行数与升级前一致，数据可正常查询/编辑
  - [ ] T8.2.5 验证 OCR 功能正常（Windows OCR API 替代 PP-OCRv6）

# Task Dependencies

- Phase 0（P0 修复）独立于 Tauri 迁移，应最先完成
- Phase 1（Tauri 壳）依赖 Phase 0 完成（避免在已废弃的 Electron 架构上修 P0）
- Phase 2（核心原生模块）依赖 Phase 1 完成
- Phase 3（OCR 引擎）依赖 Phase 2 的 `windows` crate 依赖配置
- Phase 4（业务模块）依赖 Phase 2 + Phase 3 完成
- Phase 5（IPC 层）依赖 Phase 4 完成（命令需调用业务模块）
- Phase 6（构建打包）依赖 Phase 5 完成
- Phase 7（P2/P3 改进）可与 Phase 4-6 并行，但 T7.5（WAL checkpoint）依赖 Phase 2 的 database.rs
- Phase 8（端到端验证）依赖 Phase 6 + Phase 7 全部完成
