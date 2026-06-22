# Checklist — 迁移至 Tauri + Windows OCR API + 功能与伙伴大升级

> 验收清单：对应 spec.md 全部 Requirement 与 tasks.md 全部任务。任何一项不通过即视为 Sprint 未完成。检查方法：Read 相关代码 + Grep 搜索 + 运行 `cargo check` + `npm run typecheck` + `npm run build` + 构造场景验证。

## Phase 0：P0 验证与阻塞性修复

### Task P0.1：验证模板字面量插值问题
- [ ] 已运行 `npm run typecheck`，记录编译输出
- [ ] 已运行 `npm run build`，记录构建输出
- [ ] 已在 spec.md 中记录验证结论

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
- [ ] `app.on('window-all-closed')` 中不再包含 `stop()` 调用
- [ ] Grep 确认 `getMascotManager().stop()` 在 `index.ts` 中仅出现一次

### Task P0.4：修复 `PrivacyGuard.seedDefaultRules()` 双重调用
- [ ] `bootstrap()` 中不再直接调用 `captureManager.getPrivacyGuard().seedDefaultRules()`
- [ ] `CaptureManager.startCapture()` 中保留 `this.privacyGuard.seedDefaultRules()`
- [ ] Grep 确认 `seedDefaultRules()` 在 `electron/main/index.ts` 中出现 0 次，在 `CaptureManager.ts` 中出现 1 次

### Task P0.5：修复 Bootstrap 失败用户无感知
- [ ] `electron/main/index.ts` 顶部 import `dialog` from `electron`
- [ ] `bootstrap().catch()` 块调用 `dialog.showErrorBox('WorkMemory 启动失败', errorSummary)`
- [ ] `errorSummary` 包含错误类型 + `e.message` + 建议操作
- [ ] `bootstrap().catch()` 块不再调用 `createMainWindow()`
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
- [ ] `ort`（features: `download-binaries`）、`image`、`jieba`
- [ ] `cargo check` 通过

### Task T1.5：移除 Electron 依赖
- [ ] `package.json` `devDependencies` 不含 `electron`、`electron-builder`、`vite-plugin-electron`、`vite-plugin-electron-renderer`、`@types/better-sqlite3`
- [ ] `dependencies` 不含 `better-sqlite3`、`koffi`
- [ ] `dependencies` 包含 `@tauri-apps/api`、`@tauri-apps/plugin-dialog`、`@tauri-apps/plugin-clipboard-manager`
- [ ] `scripts.dev` 为 `tauri dev`，`scripts.dist` 为 `tauri build`
- [ ] `package.json` 不含 `build` 字段与 `main` 字段
- [ ] `npm install` 无报错

## Phase 2：核心原生模块迁移

### Task T2.1：SQLite 持久层迁移
- [ ] `src-tauri/src/db/database.rs` 存在，导出 `init_database`、`get_database`、`close_database`、`wal_checkpoint`
- [ ] 数据库路径使用 `app.path().app_data_dir()?.join("workmemory.db")`
- [ ] pragma 配置：`journal_mode = WAL`、`foreign_keys = ON`、`synchronous = NORMAL`
- [ ] `src-tauri/src/db/migrations.rs` `CURRENT_VERSION = 18`（后续会升级到 24）
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
- [ ] 中英文混合截图识别准确率不低于 80%
- [ ] 系统未安装中文语言包时仍返回英文引擎，不抛错
- [ ] 无可用引擎时进入"未配置"状态，不抛错

### Task T3.2：OcrQueue 迁移
- [ ] `src-tauri/src/ocr/ocr_queue.rs` 存在
- [ ] `start()`、`stop()`、`enqueue(segment_id)`、`get_queue_size()` 实现
- [ ] worker 逻辑：取 segment → 读取截图 → 调用 `WindowsOcrEngine.recognize` → 更新数据库 → 触发 `OcrCompleted` 事件
- [ ] OCR 完成后调用 5 个分类器
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
- [ ] 完整捕获流程端到端可用

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
- [ ] 全部 9 个页面 IPC 调用正常

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

## Phase 8：捕获与理解层增强

### Task F8.1：FocusStreakTracker 专注连续时段追踪
- [ ] `src-tauri/src/capture/focus_streak_tracker.rs` 存在
- [ ] `FocusStreak` struct 包含 `window_title`、`app_name`、`duration_sec`、`started_at`、`ended_at`
- [ ] `on_window_change` 在窗口切换时结算上一段 focusStreak
- [ ] focusStreak 存入对应 Segment 的 metadata（JSON 字段）
- [ ] `get_switch_count_in_window(minutes)` 统计 N 分钟内窗口切换次数
- [ ] 连续专注 25 分钟后 Segment.metadata.focusStreak.durationSec ≈ 1500

### Task F8.2：跨天任务连续性识别
- [ ] 数据库迁移版本 19：`episodes` 表新增 `related_episode_ids TEXT NOT NULL DEFAULT '[]'`
- [ ] `episode_manager.rs` Episode 创建后计算 title embedding
- [ ] 检测与过去 7 天内 Episode 的 title embedding 余弦相似度 > 0.8
- [ ] 建立 `relatedEpisodeIds[]` 字段，双向关联
- [ ] IPC 命令 `episode:getRelated` 实现
- [ ] `src/pages/Today.tsx` 展示"昨天也做了这个"的连续性提示
- [ ] 今天创建与昨天相似 title 的 Episode 后，Today 页面显示连续性提示

### Task F8.3：手动记忆创建入口
- [ ] `episodes.source` 字段类型定义增加 `'manual'` 枚举值
- [ ] IPC 命令 `episode:addManual` 实现，入参 `{ title, tags, project, content }`
- [ ] 写入 Episode（`source: 'manual'`、`reportEligible: true`），不触发 OCR
- [ ] `src/pages/Today.tsx` 增加"+ 添加记忆"按钮与表单
- [ ] 手动添加的 Episode 立即出现在 Today 页面

### Task F8.4：待办事项自动提取
- [ ] `src-tauri/src/capture/todo_extractor.rs` 存在
- [ ] `extract_todos(ocr_text)` 正则匹配 `TODO`、`待办`、`下一步`、`Action Item`、`TBD`、`FIXME`
- [ ] `Todo` struct 包含 `text`、`done`
- [ ] `EpisodeBuilder` OCR 完成后调用 `TodoExtractor`，存入 `Episode.todos[]`
- [ ] IPC 命令 `episode:toggleTodo` 实现
- [ ] `src/pages/Today.tsx` 侧栏展示当日待办汇总，支持一键勾选完成
- [ ] OCR 文本含 "TODO: 修复登录 bug" 后，Today 侧栏显示该待办，勾选后状态持久化

## Phase 9：搜索层增强

### Task F9.1：时间语义搜索
- [ ] `src-tauri/src/ai/query_parser.rs` 存在
- [ ] `ParsedQuery` struct 包含 `time_range`、`entity`、`type`、`project`、`aggregate_by`
- [ ] 轻量 AI 调用（<100 tokens）解析自然语言查询
- [ ] 时间语义："上周五下午" → 时间范围
- [ ] 实体语义："和张三开会的时候" → `entity: 张三 + type: meeting`
- [ ] 聚合语义："做 XX 项目最长的那天" → `project: XX + aggregate_by: duration`
- [ ] `SearchRepository.hybrid` 支持 `ParsedQuery` 结构化查询条件
- [ ] 三种语义查询均返回正确结果

### Task F9.2：人物时间线视图
- [ ] `SearchRepository.get_by_entity(name)` 实现
- [ ] IPC 命令 `search:getByEntity` 实现
- [ ] `src/components/EntityTimeline.tsx` 存在
- [ ] `src/pages/Search.tsx` 增加维度切换（关键词搜索 / 人物时间线）
- [ ] 搜索"张三"后切换到人物时间线，展示所有相关 Episode 的时间轴

## Phase 10：报告层增强

### Task F10.1：站会报告模板
- [ ] 数据库迁移版本 20：`episodes` 或 `clean_episodes` 表新增 `blockers TEXT NOT NULL DEFAULT '[]'`
- [ ] `src-tauri/src/ai/templates.rs` 新增 `standup` 模板
- [ ] 模板结构：Yesterday / Today（从 `todos` 提取）/ Blockers（从 `blockers` 提取）
- [ ] 输出纯文本格式
- [ ] 生成 standup 报告输出三段式纯文本

### Task F10.2：周报自动发送与定时提醒
- [ ] `reminder_scheduler.rs` 新增每周五 17:30 周报提醒
- [ ] 推送 Mascot 气泡含 Action Button
- [ ] 可配置周报/日报自动生成时间（存入 `app_settings`）
- [ ] 报告导出格式增加 `.md` 文件 / 复制到剪贴板
- [ ] 周五 17:30 推送提醒，点击"查看报告"跳转 Reports 页面

### Task F10.3：报告历史对比
- [ ] `src/components/ReportCompare.tsx` 存在
- [ ] `src/pages/Reports.tsx` 增加"对比模式"入口
- [ ] 选择两份日报/周报左右对比展示
- [ ] 高亮新增项目、消失项目、时间占比变化
- [ ] 数据源为 `daily_distills` + `weekly_patterns` 表
- [ ] 对比 6 月 21 日与 22 日日报，正确高亮差异

## Phase 11：Wiki 知识层增强

### Task F11.1：Wiki 知识图谱可视化
- [ ] `src/pages/Graph.tsx` 节点大小 = 被引用次数（backlinks 数量）
- [ ] 节点颜色 = `wiki_type`（人/项目/决策/问题）
- [ ] 点击节点右侧预览 WikiPage 内容
- [ ] 悬停边显示 Episode 引用来源
- [ ] Graph 页面展示完整知识图谱，交互正常

### Task F11.2：知识卡片过期提醒
- [ ] 数据库迁移版本 21：`wiki_pages` 表新增 `last_accessed_at TEXT`
- [ ] `WikiRepository.touch_accessed(id)` 实现
- [ ] `WikiRepository.get_stale(days)` 实现
- [ ] `src/pages/Insights.tsx` 新增"知识库健康度"卡片（陈旧 / 活跃 / 近期新增）
- [ ] 陈旧卡片标记"待复核"
- [ ] 超过 30 天未引用的 WikiPage 在 Insights 页面标记"待复核"

### Task F11.3：外部知识导入
- [ ] `src-tauri/src/wiki/note_importer.rs` 存在
- [ ] `import_markdown_dir(path)` 解析 `.md` 文件，提取标题、内容、`[[双链]]` 语法
- [ ] `[[双链]]` 转为 WikiPage backlinks
- [ ] 导入的页面注入 WikiIngestManager 审核队列
- [ ] IPC 命令 `wiki:importNotes` 实现
- [ ] `src/pages/Settings.tsx` 增加"导入笔记"入口
- [ ] 导入 Obsidian vault 后，页面进入审核队列，人工确认后入库

## Phase 12：洞察层增强

### Task F12.1：实时专注状态感知
- [ ] `src-tauri/src/insights/focus_state_detector.rs` 存在
- [ ] 订阅 FocusStreakTracker 事件
- [ ] 连续专注同一窗口 > 25min → 触发 `FOCUS_25MIN`
- [ ] 5 分钟内窗口切换 > 10 次 → 触发 `FRAGMENTED_5MIN`
- [ ] 与 MascotManager 集成，触发提醒时调用 `mascot_manager.show_bubble`
- [ ] `mascot_manager.rs` 状态机新增 `state: 'focused'`
- [ ] 连续专注 25 分钟后 Mascot 提示"休息一下"

### Task F12.2：目标对齐度评分
- [ ] 数据库迁移版本 22：新增 `goals` 表
- [ ] `src-tauri/src/insights/goal_alignment_analyzer.rs` 存在
- [ ] 用户设定 3 条周目标，存入 `goals` 表
- [ ] 每天的 CleanEpisode 自动打标"与目标 N 相关"（基于 embedding 相似度）
- [ ] WeeklyPattern 报告增加"目标达成情况"章节
- [ ] IPC 命令 `goals:set`、`goals:getByWeek`、`goals:getAlignment` 实现
- [ ] `src/pages/Settings.tsx` 增加周目标设置入口
- [ ] 设定周目标后，周报含"目标达成情况"章节

### Task F12.3：Today 页面 24h 时间轴视图
- [ ] `src/components/Timeline24h.tsx` 存在
- [ ] 色块 = Episode 类型，宽度 = 时长
- [ ] 点击色块右侧展示 Episode 详情
- [ ] 空白区域点击可手动补充（调用 `episode:addManual`）
- [ ] `src/pages/Today.tsx` 增加时间轴视图切换（列表 / 时间轴）
- [ ] Today 页面展示 24h 时间轴，色块与 Episode 类型对应

### Task F12.4：数据健康仪表盘
- [ ] 数据库迁移版本 23：新增 `ai_usage` 表
- [ ] `OpenAIClient` 每次调用后记录到 `ai_usage` 表
- [ ] IPC 命令 `insights:getHealth` 实现，返回 `{ ocr_rate, coverage_today, wiki_size, wiki_growth, ai_calls, ai_tokens }`
- [ ] `src/pages/Insights.tsx` 新增"记录健康度"卡片
- [ ] 展示 OCR 识别率、今日记录覆盖率、Wiki 知识库大小 & 增长趋势、AI 调用次数 & token 消耗
- [ ] Insights 页面展示完整健康度卡片

## Phase 13：桌面伙伴大升级

### Task M13.1：首次启动引导动画
- [ ] `src/pages/Mascot.tsx` 检测 `app_settings.mascot_onboarded`
- [ ] 未完成时播放引导动画（从屏幕底部"飞入"）
- [ ] 气泡依次展示三条自我介绍
- [ ] 轻轻抖动等待用户点击
- [ ] 用户点击后调用 `invoke('settings:set', { mascot_onboarded: true })`
- [ ] 首次启动播放引导，第二次启动不再触发

### Task M13.2：呼吸动画与状态视觉
- [ ] `src/pages/Mascot.css` 新增 `breathing`、`scanning`、`floating` 关键帧
- [ ] `recording` 状态：小红点 + 呼吸动画 + 绿色光晕
- [ ] `paused` 状态：灰度滤镜 + 暂停图标角标
- [ ] `privacy` 状态：双手捂眼动作 / 遮眼拉帘效果
- [ ] `ocr_scanning` 状态：扫描线动画 + 眼睛追踪效果
- [ ] `report_ready` 状态：金色高亮 + 弹跳提示 + 角标数字
- [ ] 5 种状态视觉区分清晰

### Task M13.3：情绪状态机
- [ ] `src/types/index.ts` 新增 `MascotEmotion` 类型
- [ ] `mascot_manager.rs` 实现 `set_emotion(emotion)` 方法
- [ ] 情绪触发规则实现（连续专注 20min+ → `focused` 等 6 种）
- [ ] 情绪影响眼睛形状、气泡语气、动画速度
- [ ] 连续专注 20min 后 Mascot 情绪切换为 `focused`，视觉表现变化

### Task M13.4：上下文感知问候
- [ ] `src-tauri/src/mascot/greeting_generator.rs` 存在
- [ ] 场景化问候：`morning_start`、`after_focus`、`report_ready`、`late_night`、`monday_morning`、`first_episode`
- [ ] 问候语支持变量插值：`{min}`、`{hour}`、`{n}`、`{title}`
- [ ] 不同场景触发对应问候语

### Task M13.5：点击互动分层
- [ ] `left_click()` 实现：有未读报告→跳转报告页；有待办→展示待办气泡；否则→随机励志短句 2s 消失
- [ ] 右键上下文菜单：[📋 今日记忆] [⏸ 暂停记录] [📝 快速记一笔] [⚙️ 设置] [👁 隐藏 10min]
- [ ] 右键双击触发 Ghost 捕获（动画强化）
- [ ] 悬停展示今日摘要 tooltip + 眼神追踪效果
- [ ] 四种交互（左键/右键/右键双击/悬停）反馈正确

### Task M13.6：智能提醒分级
- [ ] `reminder_scheduler.rs` 新增 `ReminderTrigger` 枚举
- [ ] 时间驱动 `SCHEDULED`
- [ ] 行为驱动 `FOCUS_25MIN`、`FRAGMENTED_5MIN`、`IDLE_30MIN`、`LATE_WORK`
- [ ] 事件驱动 `REPORT_READY`、`WIKI_REVIEW_DUE`、`SKILL_UNLOCKED`
- [ ] 与 FocusStateDetector、OcrQueue、WikiIngestManager、SkillEvolver 事件源对接
- [ ] 各类触发条件满足时推送对应提醒

### Task M13.7：气泡 Action Button
- [ ] `BubblePayload` 新增 `actions?: Array<{ label: string; page?: string; action?: string }>`
- [ ] `src/pages/Mascot.tsx` 渲染 Action Button
- [ ] 点击通过 `invoke(MascotChannels.Navigate)` 路由
- [ ] "稍后提醒"action：关闭气泡，30 分钟后再次提醒
- [ ] 报告就绪气泡含 `[查看报告]` `[稍后提醒]` 按钮，点击行为正确

### Task M13.8：免打扰时段设置
- [ ] 数据库迁移版本 24：`app_settings` 表新增 `mascot_dnd_start`、`mascot_dnd_end`、`mascot_min_interval_min`、`mascot_work_hours_only` 字段
- [ ] `ReminderScheduler` 推送前检查免打扰时段、提醒间隔下限、工作日仅工作时间
- [ ] `src/pages/Settings.tsx` 增加桌面伙伴设置区
- [ ] 免打扰时段内不推送提醒
- [ ] 距上次提醒不足间隔下限时不推送

### Task M13.9：形象角色人格设计
- [ ] 5 种形象角色人格设计完成：`note`（备忘录小鸟）、`film`（胶片小熊）、`copilot`（宇航员猫）、`cursor`（光标精灵）、`paper`（折纸狐狸）
- [ ] 每种形象含默认站姿 + 6-8 帧循环动画
- [ ] 专属气泡颜色/字体
- [ ] 专属问候语风格
- [ ] 切换形象后视觉与语气风格变化

### Task M13.10：气泡 UI 精致化
- [ ] `src/pages/Mascot.css` `.mascot-bubble` 磨砂玻璃效果（`backdrop-filter: blur(12px)`、`background: rgba(255,255,255,0.85)`）
- [ ] 圆角 16px + 阴影
- [ ] `bubble-in` 出现动画（`cubic-bezier(0.34, 1.56, 0.64, 1)`，0.25s）
- [ ] 气泡出现时有弹性动画，视觉精致

### Task M13.11：拖拽边缘吸附
- [ ] `mascot_window.rs` `drag_end` 时检测位置
- [ ] 自动吸附到最近边缘（左或右，margin 20px）
- [ ] 平滑动画过渡
- [ ] 拖拽到屏幕中间松开后自动吸附到边缘

### Task M13.12：深色模式适配
- [ ] `src/pages/Mascot.tsx` 监听 Tauri `window.theme()` 变化
- [ ] 深色模式：气泡深色背景 + 浅色字
- [ ] 伙伴形象深色变体（或调整图层亮度）
- [ ] 系统切换深色模式后 Mascot 视觉适配

### Task M13.13：悬浮卡片通知中心
- [ ] `src/components/MascotHoverCard.tsx` 存在
- [ ] 右键菜单"今日记忆"触发悬浮卡片（不打开主窗口）
- [ ] 卡片含最近 3 条 Episode（时间 + 标题）+ 专注时长 + 切换次数 + "打开完整视图"按钮
- [ ] 右键选择"今日记忆"后展示悬浮卡片

### Task M13.14：Mascot 状态与主窗口同步
- [ ] 用户在设置页关闭 OCR → Mascot 展示气泡"已切换到纯截图模式"
- [ ] 用户暂停记录 → Mascot 进入 `paused` 状态，30min 后主动提醒"已暂停 30 分钟，要恢复吗？"
- [ ] 报告生成完成 → Mascot 状态切换 `report_ready`，角标 +1
- [ ] 三种主窗口操作均触发 Mascot 状态同步与反馈

## Phase 14：端到端验证

### Task V14.1：完整流程验证
- [ ] Tauri 构建的 NSIS 包可安装并启动
- [ ] 主窗口、Mascot、托盘正常显示
- [ ] 切换窗口 3 次后 segments 表有 3 条新记录，ocr_text 非空
- [ ] 等待 1 小时后 clean_episodes 表有 distill 记录
- [ ] 设置页配置 API Key 后生成日报，流式输出正常
- [ ] 退出应用时 `wal_checkpoint` 执行，WAL 文件被截断
- [ ] 重新启动数据完整无丢失

### Task V14.2：从 Electron 版本升级验证
- [ ] Electron 版本 `workmemory.db` `PRAGMA user_version` 为 18
- [ ] 卸载 Electron 版本（保留 userData），安装 Tauri 版本
- [ ] Tauri 版本启动后 `PRAGMA user_version` 升级到 24，无迁移错误
- [ ] 各表行数与升级前一致
- [ ] OCR 功能正常（Windows OCR API 替代 PP-OCRv6）

### Task V14.3：新增功能验证
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
- [ ] 数据库迁移版本从 18 升级到 24，无数据丢失
- [ ] 全部新增功能（Phase 8-13）端到端可用
