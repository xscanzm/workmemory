# Checklist — 迁移至 Tauri + Windows OCR API

> 验收清单：对应 spec.md 全部 Requirement 与 tasks.md 全部任务。任何一项不通过即视为 Sprint 未完成。检查方法：Read 相关代码 + Grep 搜索 + 运行 `cargo check` + `npm run typecheck` + `npm run build` + 构造场景验证。

## Phase 0：P0 验证与阻塞性修复

### Task P0.1：验证模板字面量插值问题
- [ ] 已运行 `npm run typecheck`，记录编译输出
- [ ] 已运行 `npm run build`，记录构建输出
- [ ] 已在 spec.md 中记录验证结论（确认 P0 描述的"模板字面量插值缺失"是 E2B 工具渲染问题还是真实代码缺陷）

### Task P0.2：修复 `runtimeLog.ts` 缺失
- [ ] `electron/runtimeLog.ts` 文件存在，导出 `logRuntime(scope: string, message: string): void`
- [ ] 日志路径使用 `app.getPath('userData')` + `runtime.log`（Grep 确认无 `process.env.APPDATA`）
- [ ] 应用名使用 `app.getName()`（Grep 确认无硬编码 `'WorkMemory'` 字符串作为路径组成部分）
- [ ] 每行格式 `[ISO8601] [scope] message`
- [ ] 写入失败静默忽略（try-catch）
- [ ] `npm run typecheck` 通过

### Task P0.3：修复服务停止逻辑双重执行
- [ ] `electron/main/index.ts` 存在 `stopAllServices()` 函数
- [ ] `stopAllServices()` 依次调用 8 个 Manager 的 `stop()` + `closeDatabase()`
- [ ] `app.on('before-quit', stopAllServices)` 注册一次
- [ ] `app.on('window-all-closed')` 中不再包含 `stop()` 调用（仅 `if (process.platform !== 'darwin') app.quit()`）
- [ ] Grep 确认 `getMascotManager().stop()` 在 `index.ts` 中仅出现一次（在 `stopAllServices` 内）

### Task P0.4：修复 `PrivacyGuard.seedDefaultRules()` 双重调用
- [ ] `bootstrap()` 中不再直接调用 `captureManager.getPrivacyGuard().seedDefaultRules()`
- [ ] `CaptureManager.startCapture()` 中保留 `this.privacyGuard.seedDefaultRules()`
- [ ] Grep 确认 `seedDefaultRules()` 在 `electron/main/index.ts` 中出现 0 次，在 `CaptureManager.ts` 中出现 1 次

### Task P0.5：修复 Bootstrap 失败用户无感知
- [ ] `electron/main/index.ts` 顶部 import `dialog` from `electron`
- [ ] `bootstrap().catch()` 块调用 `dialog.showErrorBox('WorkMemory 启动失败', errorSummary)`
- [ ] `errorSummary` 包含错误类型 + `e.message` + 建议操作
- [ ] `bootstrap().catch()` 块不再调用 `createMainWindow()`（不创建空白窗口）
- [ ] 模拟数据库初始化失败时弹出错误对话框

## Phase 1：Tauri 壳搭建

### Task T1.1：初始化 Tauri 项目
- [ ] `src-tauri/` 目录存在，包含 `Cargo.toml`、`tauri.conf.json`、`build.rs`、`src/main.rs`、`src/lib.rs`
- [ ] `Cargo.toml` `name = "workmemory"`、`version = "0.3.0"`
- [ ] `tauri.conf.json` `productName: "WorkMemory"`、`appId: "com.workmemory.app"`
- [ ] `npm run tauri dev` 可启动 Tauri 窗口

### Task T1.2：配置主窗口
- [ ] `tauri.conf.json` `app.windows[0]`：`width: 1280`、`height: 800`、`minWidth: 960`、`minHeight: 640`、`decorations: false`
- [ ] `titleBarStyle: "Overlay"`
- [ ] 主窗口无边框、可拖拽
- [ ] `invoke('window:minimize')`、`invoke('window:maximize')`、`invoke('window:close')`、`invoke('window:isMaximized')` 正常工作

### Task T1.3：配置 Mascot 透明窗口
- [ ] `tauri.conf.json` `app.windows` 包含 `label: "mascot"` 窗口
- [ ] Mascot 窗口 `transparent: true`、`alwaysOnTop: true`、`skipTaskbar: true`、`width: 340`、`height: 146`
- [ ] Mascot 窗口加载 `index.html#/mascot` 路由
- [ ] Mascot 窗口不在任务栏显示

### Task T1.4：配置 Cargo 依赖
- [ ] `Cargo.toml` 包含 `tauri`（features: `dialog`、`clipboard-manager`、`path`、`tray-icon`、`window-state`）
- [ ] `rusqlite`（features: `bundled`）
- [ ] `windows`（features: `Win32_Graphics_Gdi`、`Win32_UI_WindowsAndMessaging`、`Win32_System_Threading`、`Media_Ocr`、`Graphics_Imaging`、`Foundation`、`Storage_Streams`、`Globalization`）
- [ ] `reqwest`（features: `json`、`rustls-tls`、`stream`）、`tokio`（features: `full`）
- [ ] `serde`、`serde_json`、`chrono`、`uuid`、`anyhow`、`thiserror`
- [ ] `ort`（features: `download-binaries`）
- [ ] `cargo check` 通过

### Task T1.5：移除 Electron 依赖
- [ ] `package.json` `devDependencies` 不含 `electron`、`electron-builder`、`vite-plugin-electron`、`vite-plugin-electron-renderer`、`@types/better-sqlite3`
- [ ] `dependencies` 不含 `better-sqlite3`、`koffi`
- [ ] `dependencies` 包含 `@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-clipboard-manager`
- [ ] `scripts.dev` 为 `tauri dev`，`scripts.dist` 为 `tauri build`
- [ ] `package.json` 不含 `build` 字段（electron-builder 配置）与 `main` 字段
- [ ] `npm install` 无报错

## Phase 2：核心原生模块迁移

### Task T2.1：SQLite 持久层迁移
- [ ] `src-tauri/src/db/database.rs` 存在，导出 `init_database`、`get_database`、`close_database`、`wal_checkpoint`
- [ ] 数据库路径使用 `app.path().app_data_dir()?.join("workmemory.db")`
- [ ] pragma 配置：`journal_mode = WAL`、`foreign_keys = ON`、`synchronous = NORMAL`
- [ ] `src-tauri/src/db/migrations.rs` `CURRENT_VERSION = 18`，迁移 SQL 与 `electron/db/migrations.ts` 一致
- [ ] `src-tauri/src/db/schema.rs` `SCHEMA_SQL` 与 `electron/db/schema.ts` 一致
- [ ] `src-tauri/src/db/fts_tokenizer.rs` 实现中文分词并注册为 SQLite 函数
- [ ] 在现有 `workmemory.db` 上运行迁移，`PRAGMA user_version` 为 18，无数据丢失

### Task T2.2：Repository 迁移（18 个）
- [ ] 18 个 Repository 文件存在于 `src-tauri/src/db/repositories/`
- [ ] 每个 Repository 的方法签名与现有 TypeScript 版本一致
- [ ] `SegmentRepository` 全部 11 个方法实现
- [ ] `EpisodeRepository` 全部 12 个方法实现
- [ ] `WikiRepository` 全部 15 个方法实现
- [ ] `SettingsStore` 全部 6 个方法实现
- [ ] `DataManager` 全部 4 个方法实现
- [ ] 单元测试或集成测试验证行为一致性

### Task T2.3：WindowWatcher 迁移
- [ ] `src-tauri/src/capture/window_watcher.rs` 存在，实现 `start()`、`stop()`
- [ ] 使用 `windows` crate 调用 `GetForegroundWindow`、`GetWindowTextW`、`GetWindowThreadProcessId`、`QueryFullProcessImageNameW`
- [ ] 轮询间隔 2 秒
- [ ] `WindowInfo` struct 字段：`hwnd`、`process_name`、`process_path`、`window_title`、`app_name`
- [ ] 切换窗口时事件正确触发

### Task T2.4：Screenshot 迁移
- [ ] `src-tauri/src/capture/screenshot.rs` 存在，实现 `capture_window`、`capture_screen`
- [ ] 使用 `windows` crate 的 `Win32_Graphics_Gdi`（`BitBlt` + `CreateCompatibleBitmap`）
- [ ] 编码为 PNG（`image` crate）
- [ ] dHash 实现：`calculate_image_hash`、`hamming_distance`、`is_similar`
- [ ] `ScreenshotResult` enum 与现有 TypeScript 版本结构一致
- [ ] 截图功能端到端可用

### Task T2.5：事件总线迁移
- [ ] `src-tauri/src/events/bus.rs` 存在，封装 `tokio::sync::broadcast`
- [ ] 事件类型覆盖：`SegmentCreated`、`SegmentMerged`、`PrivacyPlaceholder`、`StateChange`、`OcrCompleted`、`OcrFailed`、`EpisodesRebuilt`、`MemCellCreated`
- [ ] `subscribe` + `publish` 在多模块间正常工作

## Phase 3：OCR 引擎迁移至 Windows OCR API

### Task T3.1：WindowsOcrEngine 实现
- [ ] `src-tauri/src/ocr/windows_ocr_engine.rs` 存在
- [ ] `initialize()` 调用 `OcrEngine::TryCreateFromUserProfileLanguages()`
- [ ] `recognize(image_buffer)` 通过 `SoftwareBitmap` + `RecognizeAsync` 返回 `OcrResult`
- [ ] `OcrResult` 包含 `text`、`boxes`、`confidence`、`elapsed`
- [ ] 中英文混合截图识别准确率不低于 80%（与 PP-OCRv6 对比）
- [ ] 系统未安装中文语言包时仍返回英文引擎，不抛错
- [ ] 无可用引擎时进入"未配置"状态，不抛错

### Task T3.2：OcrQueue 迁移
- [ ] `src-tauri/src/ocr/ocr_queue.rs` 存在
- [ ] `start()`、`stop()`、`enqueue(segment_id)`、`get_queue_size()` 实现
- [ ] worker 逻辑：取 segment → 读取截图 → 调用 `WindowsOcrEngine.recognize` → 更新数据库 → 触发 `OcrCompleted` 事件
- [ ] OCR 完成后调用 5 个分类器（ActivityClassifier 等）
- [ ] 失败时更新 `source_status = 'failed'`，触发 `OcrFailed` 事件

### Task T3.3：OcrManager 迁移
- [ ] `src-tauri/src/ocr/ocr_manager.rs` 存在，单例实现
- [ ] `initialize`、`get_status`、`get_model`、`get_runtime_status`、`set_model`、`reprocess`、`recognize_image_path`、`stop` 全部实现
- [ ] `BackendStatus.type` 为 `'windows_ocr' | 'unconfigured'`（Grep 确认无 `'paddleocr'`、`'tesseract'`）
- [ ] 接口契约与现有 `OcrManager` 一致

### Task T3.4：OcrTextCleaner 迁移
- [ ] `src-tauri/src/ocr/ocr_text_cleaner.rs` 存在
- [ ] `clean_ocr_text(text)` 实现与现有 TS 版本相同的清洗规则
- [ ] 对同一输入，输出与 TS 版本一致

### Task T3.5：删除旧 OCR 资源
- [ ] `electron/ocr/` 目录已删除
- [ ] `resources/ocr/` 目录已删除
- [ ] `scripts/build-ocr-runtime.ps1` 已删除
- [ ] `ppocr_cli.spec` 已删除
- [ ] `cargo check` + `npm run typecheck` 通过，无悬空引用

## Phase 4：业务模块迁移

### Task T4.1：OpenAIClient 迁移（含流式）
- [ ] `src-tauri/src/ai/openai_client.rs` 存在
- [ ] `chat_completion` 用 `reqwest` 实现，超时 30 秒，429/5xx 重试 2 次指数退避
- [ ] `chat_completion_stream` 实现 `stream: true`，通过 `app_handle.emit("ai:streamDelta", chunk)` 推送
- [ ] 流结束 emit `ai:streamDone`
- [ ] `test_connection` 实现
- [ ] `OpenAiApiError` 携带 `status_code`、`is_retryable`、`reason_code`
- [ ] reasoning_content 兜底逻辑实现
- [ ] 鉴权失败返回 401 错误

### Task T4.2：AI 管理器与引擎迁移
- [ ] `src-tauri/src/ai/` 目录包含全部 16 个模块文件
- [ ] `distill_event_schema.rs` 用 `serde` + 手写校验替换 Zod
- [ ] 日报生成流程端到端可用
- [ ] 小时级 distill 流程端到端可用
- [ ] 周级模式检测 + 反思 + 技能进化流程端到端可用

### Task T4.3：记忆模块迁移
- [ ] `src-tauri/src/memory/` 目录包含 5 个模块文件
- [ ] `embedding_service.rs` 用 `ort` crate 加载 `multilingual-e5-small` 模型
- [ ] MemCell 创建 → embedding 生成 → 向量检索 → 用户画像演进流程完整

### Task T4.4：Wiki 与 Insights 模块迁移
- [ ] `src-tauri/src/wiki/` 目录包含 4 个模块文件
- [ ] `src-tauri/src/insights/` 目录包含 4 个模块文件
- [ ] Wiki 扫描/提取/审核/入库流程完整
- [ ] Insights 审计/异常/趋势/推送流程完整

### Task T4.5：Mascot 与 Tray 迁移
- [ ] `src-tauri/src/mascot/` 目录包含 5 个模块文件
- [ ] Mascot 透明窗口通过 `WebviewWindowBuilder` 创建
- [ ] 拖拽与边缘吸附（<50px 吸附 + opacity 0.5）实现
- [ ] 系统托盘通过 `TrayIconBuilder` 创建，菜单项与现有 `TrayManager` 一致
- [ ] Mascot 显示/隐藏/拖拽/吸附/气泡/右键菜单/托盘退出全部可用

### Task T4.6：Capture 全链路迁移
- [ ] `src-tauri/src/capture/` 目录包含全部 13 个模块文件
- [ ] `start_capture`、`stop_capture`、`pause`、`resume`、`get_state` 实现
- [ ] 系统空闲检测用 `GetLastInputInfo`，3 分钟无活动进入 idle
- [ ] 完整捕获流程（窗口切换 → 截图 → OCR → Episode 聚合 → 事件广播）端到端可用

### Task T4.7：Bootstrap 迁移
- [ ] `src-tauri/src/main.rs` `setup` 钩子实现完整启动序列
- [ ] `evolveProfile`、`distillDay`、`detectPatterns` 三项独立任务用 `tokio::join!` 并行执行（P3-14）
- [ ] `reflect` 与 `evolveSkills` 保持串行依赖
- [ ] bootstrap 失败时通过 `dialog::MessageDialog` 展示错误
- [ ] `before-quit` 事件执行 `stop_all_services()` + `wal_checkpoint(TRUNCATE)`
- [ ] 完整启动流程无错误，退出时服务正确停止

## Phase 5：IPC 层迁移

### Task T5.1：Tauri 命令注册
- [ ] `src-tauri/src/ipc/mod.rs` 存在 `register_ipc_handlers(app: &AppHandle)`
- [ ] 16 个命令分组文件存在于 `src-tauri/src/ipc/`
- [ ] 每个命令的入参用 `serde::Deserialize` + 手写校验
- [ ] `IpcResult<T>` enum 实现 `Serialize`，三态 `Ok` | `ValidationError` | `InternalError`
- [ ] 渲染进程 `invoke('segment:getByDate', { date: '2026-06-22' })` 返回正确数据

### Task T5.2：渲染进程 IPC 调用迁移
- [ ] `src/types/ipc.ts` 存在，从 `electron/types/ipc.ts` 搬运通道名常量与类型
- [ ] `src/hooks/useIpc.ts` 全部 `window.workmemory.xxx.yyy()` 替换为 `invoke('xxx:yyy', payload)`
- [ ] 全部 `unknown` 类型替换为具体类型（Grep 确认 `invoke` 调用入参无 `unknown`）
- [ ] 事件监听全部用 `listen(channel, cb)` 替换 `ipcRenderer.on`
- [ ] `electron/preload/index.ts` 已删除
- [ ] 全部 9 个页面（Today/Calendar/Search/Insights/Wiki/Graph/Reports/Settings/Mascot）IPC 调用正常

### Task T5.3：refreshTrigger 改为事件型刷新（P3-15）
- [ ] `src/store/recordingStore.ts` `refreshTrigger: number` 改为 `RefreshFlags { segments: number; episodes: number; wiki: number }`
- [ ] `triggerRefresh()` 拆分为 `triggerSegmentRefresh`、`triggerEpisodeRefresh`、`triggerWikiRefresh`
- [ ] 订阅组件按需选择订阅的 flag
- [ ] segment 更新不会触发 wiki 组件重新查询

## Phase 6：构建与打包

### Task T6.1：Tauri 打包配置
- [ ] `tauri.conf.json` `bundle.targets: ["nsis"]`
- [ ] `bundle.windows.nsis` 配置与现有 electron-builder NSIS 对齐
- [ ] `npm run dist`（即 `tauri build`）生成 NSIS 安装包

### Task T6.2：CSP 配置（P2-8）
- [ ] `tauri.conf.json` `app.security.csp` 配置生产环境 CSP
- [ ] `app.security.devCsp` 保留开发环境 `localhost:5173`
- [ ] `index.html` 中无硬编码 CSP meta（Grep 确认）
- [ ] 生产构建 CSP 不含 `localhost:5173`

### Task T6.3：Vite 配置简化
- [ ] `vite.config.ts` 不含 `vite-plugin-electron` 与 `vite-plugin-electron-renderer`
- [ ] 保留 `@vitejs/plugin-react` 与 `@` alias
- [ ] `npm run build` 生成 `dist/` 目录

## Phase 7：P2/P3 工程质量改进

### Task T7.1：TypeScript 严格性（P2-9）
- [ ] `tsconfig.json` `exactOptionalPropertyTypes` 为 `true`
- [ ] `npm run typecheck` 通过，无类型错误

### Task T7.2：测试脚本（P2-10）
- [ ] `package.json` `scripts` 包含 `"test": "vitest run"` 与 `"test:watch": "vitest"`
- [ ] `npm test` 可运行现有 `__tests__` 目录中的测试

### Task T7.3：ESLint 配置（P2-11、P2-13）
- [ ] `.eslintrc.cjs` `ignorePatterns` 不含 `'*.config.ts'`
- [ ] `no-empty` 为 `['warn', { allowEmptyCatch: false }]`
- [ ] 现有 `} catch { /* ignore */ }` 已补充 `console.warn` 或日志记录
- [ ] `npm run lint` 通过

### Task T7.4：React Error Boundary（P3-16）
- [ ] `src/components/ErrorBoundary.tsx` 存在
- [ ] `src/App.tsx` 在 `<AppLayout>` 外层包裹 `<ErrorBoundary>`
- [ ] 模拟组件抛错时显示降级 UI 而非白屏

### Task T7.5：SQLite WAL checkpoint（P3-18）
- [ ] `src-tauri/src/db/database.rs` 存在 `wal_checkpoint` 函数
- [ ] `before-quit` 事件中调用 `wal_checkpoint`
- [ ] tokio 定时任务每 6 小时执行一次 `wal_checkpoint`
- [ ] 长时间运行后 WAL 文件大小被截断

### Task T7.6：移除 setMainWindow 导出（P2-12）
- [ ] 渲染进程无 `setMainWindow` 调用
- [ ] 窗口引用通过 `app_handle.get_webview_window("main")` 获取

## Phase 8：端到端验证

### Task T8.1：完整流程验证
- [ ] Tauri 构建的 NSIS 包可安装并启动
- [ ] 主窗口、Mascot、托盘正常显示
- [ ] 切换窗口 3 次后 segments 表有 3 条新记录，ocr_text 非空
- [ ] 等待 1 小时后 clean_episodes 表有 distill 记录
- [ ] 设置页配置 API Key 后生成日报，流式输出正常
- [ ] 退出应用时 `wal_checkpoint` 执行，WAL 文件被截断
- [ ] 重新启动数据完整无丢失

### Task T8.2：从 Electron 版本升级验证
- [ ] Electron 版本 `workmemory.db` `PRAGMA user_version` 为 18
- [ ] 卸载 Electron 版本（保留 userData），安装 Tauri 版本
- [ ] Tauri 版本启动后 `PRAGMA user_version` 仍为 18，无迁移执行
- [ ] 各表行数与升级前一致
- [ ] OCR 功能正常（Windows OCR API 替代 PP-OCRv6）

## 全局验收

- [ ] `cargo check` 通过，无警告
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 通过
- [ ] `npm run lint` 通过
- [ ] `npm test` 通过
- [ ] `npm run dist` 生成 NSIS 安装包
- [ ] 安装包体积显著小于原 Electron 版本（目标 <30MB）
- [ ] 启动内存显著低于原 Electron 版本（目标 <80MB）
- [ ] `electron/` 目录已删除
- [ ] `resources/ocr/` 目录已删除
- [ ] `package.json` 不含 `electron`、`better-sqlite3`、`koffi` 依赖
