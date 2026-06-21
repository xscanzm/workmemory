# WorkMemory V0.4 Trust & Beauty Sprint Spec

> 范围说明：本 Spec 是对 `workmemory-mvp`（V0.3 终极完全体）的**收敛与加固**，不新增大功能模块。Sprint 目标四句话：**真的能跑、真的安全、真的好看、真的能生成并导出日报**。审查报告指出 V0.3 "打勾过多"，多处只是适配层、规则启发式、前端实现或过渡方案；本 Sprint 把这些"看起来全有"改成"核心链路真的好用"。明确不做：不新增第 9 个页面、不引入团队/云同步、不重写已建议保留的模块（Electron 骨架、SQLite Repository、PrivacyRuleRepository 匹配规则、Mascot 窗口架构、Wiki Review Queue 方向、Graph 数据构建思路）。

## Why

V0.3 覆盖面广但真实性不足：OCR 只有适配层无 runtime、API Key 明文落盘、活跃窗口截图失败会自动降级整屏（隐私风险）、IPC 入参无校验、UI 内联样式堆砌无组件体系、报告复制非富文本、Word 导出是 HTML `.doc` 而非 `.docx`、搜索名为"语义"实为关键词。这些问题与"本地优先、可信、隐私安全、颜值即正义"的产品定位直接冲突，必须先收紧到可信精品，再谈扩展。

## What Changes

### Phase A：可信可运行（P0 安全与可用性）
- **MODIFIED** OCR 引擎：启动容错，无 runtime 时进入"未配置"状态而非崩溃；新增 OCR runtime 管理与健康检查。
- **MODIFIED** API Key 存储：改用 Electron `safeStorage` 加密，`settings.json` 不再出现明文 key；UI 永不回填完整 key；提供清空入口。
- **MODIFIED** 截图降级策略：**BREAKING** 禁止活跃窗口截图失败后自动整屏截图；默认返回 `screenshot_failed` 状态跳过；整屏降级改为用户显式开启且默认关闭。
- **MODIFIED** IPC 入参校验：所有 IPC handler 引入 Zod schema 校验；删除不必要的 insert/update 直通通道，改为业务 action；`settings.set` 限制可写字段；`system.saveFile` 限制扩展名。
- 修复 TypeScript 严格模式零错误，`npm run typecheck` 与 `npm run build` 在干净环境通过。

### Phase B：颜值第一落地（UI 组件体系）
- **ADDED** 统一组件库 `src/ui/`：Button、IconButton、Card、Dialog、Toast、SegmentedControl、Switch、TextField、Select、Tooltip、Badge、Timeline、MemoryCard。
- **ADDED** 统一图标库（Lucide React），替换页面内手写 SVG。
- **ADDED** Radix UI 基础原语（Dialog/Tooltip/Popover/Menu）用于无障碍与状态管理。
- **MODIFIED** TitleBar / IconSidebar / 全部 8 大页面：迁移到统一组件库，移除大段内联 `<style>`。
- **MODIFIED** Mascot 视觉：5 种形象重绘为统一风格（保留 SVG 路线但统一描边/配色/状态语言），或引入 AI 生图资产。
- **ADDED** 截图级视觉验收基线（Today/Reports/Settings 三页）。

### Phase C：产品主链路打磨（日报闭环）
- **MODIFIED** 报告复制：**BREAKING** 新增"复制富文本"，剪贴板同时写入 `text/html` 与 `text/plain`，粘贴到 Word/飞书保留标题、列表、段落。
- **MODIFIED** Word 导出：**BREAKING** 升级为真实 `.docx`（用 `docx` 库生成），Word 可打开且格式正确；旧 HTML `.doc` 方案移除。
- **MODIFIED** AI 上传确认面板：发送内容可展开预览、可逐条删除、可对敏感词脱敏。
- **MODIFIED** 日历 ↔ 报告联动：日历点击日期可反查当天日报与 Episode。
- **MODIFIED** 报告类型字段：新增 `reportType`（daily/weekly/review），UI 文案 P0 诚实称为"日报中心"，P1 再扩展周报/复盘入口。

### Phase D：高级能力降噪（诚实化）
- **MODIFIED** 搜索命名：**BREAKING** UI 文案从"语义搜索"改为"记忆搜索（关键词 + 时间）"；匹配原因必须明确显示 OCR/时间/项目/人物。
- **ADDED** SQLite FTS5 全文索引（segments.ocr_text / episodes.title / wiki_pages.content），提升搜索质量与可解释性。
- **MODIFIED** Wiki 自动提取：自动生成默认 `review_status='needs_review'` 草稿，UI 展示置信度与"为什么建议保存"；低置信（<0.5）不进入默认选择。
- **MODIFIED** EntityExtractor：所有自动实体带 `confidence` 字段；低置信实体不进入 Wiki/报告默认选择；支持用户确认/修正。
- **MODIFIED** 图谱：节点数上限（默认 100）+ 布局缓存；超过上限降级为"关系预览"提示；P0 文案诚实称"关系预览"。
- **MODIFIED** Insights 主动推送：默认低频，不主动弹太多。

## Impact
- Affected specs: `workmemory-mvp`（V0.3）——本 Sprint 修改其 OCR、API Key、Screenshot、IPC、视觉治理、搜索、报告复制/导出、Wiki 提取、EntityExtractor、图谱等 Requirement。
- Affected code:
  - `electron/ocr/PpOcrEngine.ts`、`electron/ocr/OcrManager.ts` — runtime 管理、健康检查、启动容错
  - `electron/db/SettingsStore.ts` — safeStorage 加密
  - `electron/capture/Screenshot.ts` — 移除整屏自动降级
  - `electron/preload/index.ts`、`electron/main/ipc.ts`、`electron/types/ipc.ts` — Zod schema 校验、业务 action 化
  - `src/ui/`（新增）— 统一组件库
  - `src/components/*`、`src/pages/*` — 迁移到组件库
  - `electron/ai/ReportExporter.ts` — `.docx` 升级
  - `src/pages/Reports.tsx` — 富文本复制
  - `src/pages/Search.tsx` — 命名诚实化
  - `electron/db/schema.ts`、`electron/db/migrations.ts` — FTS5 索引、reportType 字段、entity confidence
  - `electron/capture/EntityExtractor.ts` — confidence
  - `electron/wiki/WikiExtractor.ts`、`WikiIngestManager.ts` — 草稿默认、置信度展示
  - `src/pages/Graph.tsx` — 节点上限、布局缓存
- 关键新增依赖：`zod`（IPC 校验）、`docx`（Word 导出）、`lucide-react`（图标）、`@radix-ui/react-dialog`/`tooltip`/`popover`/`menu`（无障碍原语）。

## ADDED Requirements

### Requirement: OCR Runtime 管理与健康检查
系统 SHALL 在无 OCR runtime 时正常启动，并提供 runtime 检测、健康检查与测试识别能力。

#### Scenario: 无 runtime 时正常启动
- **GIVEN** `resources/ocr/` 没有 `ppocr_cli.exe` 且系统无 `tesseract`
- **WHEN** 用户启动应用
- **THEN** 主窗口正常打开
- **AND** OCR 状态显示"未配置"
- **AND** 记录功能可暂停
- **AND** 用户可进入设置配置 OCR
- **AND** 应用不崩溃、不抛未捕获异常

#### Scenario: OCR runtime 管理页
- **GIVEN** 用户打开设置 → OCR
- **THEN** 显示当前后端：PP-OCRv6 / Tesseract / 未配置
- **AND** 显示模型路径
- **AND** 支持测试图片识别（上传/选择图片 → 识别 → 显示结果与耗时）
- **AND** 支持打开 OCR 安装目录

#### Scenario: 测试 OCR 反馈
- **WHEN** 用户点击"测试 OCR"
- **THEN** 返回成功/失败原因（如"未找到 ppocr_cli"、"tesseract 未安装"、"识别成功，耗时 180ms"）

### Requirement: 统一 UI 组件库
系统 SHALL 提供统一组件库 `src/ui/`，所有页面使用统一组件，禁止页面内复制组件样式。

#### Scenario: 组件库覆盖
- **GIVEN** 新增或修改页面
- **WHEN** 使用 Button/Card/Dialog/Badge/Input/Select/Switch/Tooltip
- **THEN** 必须从 `src/ui/` 导入
- **AND** 不允许在页面内复制一套按钮/卡片样式

#### Scenario: 图标统一
- **GIVEN** 任何页面需要图标
- **THEN** 使用 `lucide-react` 图标库
- **AND** 不再新增手写 SVG 图标（Mascot 形象除外）

### Requirement: 富文本复制
系统 SHALL 支持报告富文本复制，剪贴板同时包含 HTML 与纯文本。

#### Scenario: 复制富文本
- **GIVEN** 用户生成日报
- **WHEN** 用户点击"复制富文本"
- **THEN** 剪贴板包含 `text/html` 和 `text/plain`
- **AND** 粘贴到 Word/飞书时保留标题、列表、段落

### Requirement: SQLite FTS5 全文索引
系统 SHALL 对关键文本字段建立 FTS5 索引以提升搜索质量与可解释性。

#### Scenario: FTS5 索引建立
- **GIVEN** 数据库初始化
- **THEN** 建立 FTS5 虚拟表覆盖 segments.ocr_text、episodes.title、episodes.one_line_summary、wiki_pages.content
- **AND** 增删改时同步更新索引

## MODIFIED Requirements

### Requirement: 本地 OCR 推理 (PP-OCRv6)（修改自 V0.3）
系统 SHALL 在本地完成 OCR，默认使用 PP-OCRv6 Tiny。**修改点**：启动容错（无 runtime 不崩溃，进入"未配置"状态）；新增 runtime 管理与健康检查；保留 ≤300ms 与空闲释放约束。

#### Scenario: 启动容错（新增）
- **WHEN** OcrManager.initialize() 时无可用后端
- **THEN** 记录警告日志，状态置为"未配置"
- **AND** 不抛未捕获异常
- **AND** CaptureManager 仍可运行（截图照常，OCR 队列暂停，segment.source_status 停留 'pending'）

#### Scenario: 轻量推理性能约束（保留 V0.3）
- **WHEN** 截图文字较少时
- **THEN** 系统限制使用单核推理
- **AND** 最大耗时不超过 300ms

#### Scenario: 空闲内存清理（保留 V0.3）
- **WHEN** OCR 引擎完成一批处理队列后空闲超过 10 秒
- **THEN** 系统立即释放显存和垃圾堆内存

### Requirement: API Key 加密存储（修改自 V0.3 隐含的明文存储）
系统 SHALL 使用 Electron `safeStorage` 加密保存 API Key，`settings.json` 不得包含明文 key。

#### Scenario: 加密保存
- **GIVEN** 用户在设置页输入 API Key
- **WHEN** 设置保存并重启应用
- **THEN** `settings.json` 不包含明文 API Key（仅存 safeStorage 加密 blob 或 key alias）
- **AND** AI 调用仍可使用该 Key（运行时解密）
- **AND** UI 永不回填完整 Key（显示 `sk-****xxxx` 掩码）

#### Scenario: 清空 Key
- **WHEN** 用户点击"清空 API Key"
- **THEN** 加密 blob 从 settings 删除
- **AND** 后续 AI 调用失败并提示用户重新配置

#### Scenario: 日志不泄漏
- **WHEN** 任何日志输出
- **THEN** 不得打印 API Key 明文

### Requirement: 截图降级策略（修改自 V0.3 的整屏自动降级）
系统 SHALL NOT 在活跃窗口截图失败时自动降级到整屏截图。

#### Scenario: 活跃窗口截图失败（修改）
- **GIVEN** `captureWindow(hwnd)` 找不到目标窗口
- **WHEN** 捕获链路继续
- **THEN** 系统创建 `screenshot_failed` 状态或跳过该次捕获
- **AND** 不调用 `captureScreen()`
- **AND** 不保存任何整屏截图

#### Scenario: 整屏降级需显式开启（新增）
- **GIVEN** 用户希望允许整屏降级
- **WHEN** 用户在设置中开启"整屏降级"（默认关闭）
- **THEN** 首次开启时弹出风险提示
- **AND** 多屏时必须明确屏幕范围

### Requirement: IPC 入参校验（修改自 V0.3 的 unknown 直通）
系统 SHALL 对所有 IPC 入参进行 Zod schema 校验，非法 payload 拒绝并返回结构化错误。

#### Scenario: 非法 payload 拒绝
- **GIVEN** renderer 调用 `settings.set({ apiKey: 123 })`（类型错误）
- **WHEN** 主进程收到 IPC
- **THEN** 拒绝请求
- **AND** 返回结构化错误 `{ ok: false, error: 'VALIDATION_ERROR', details }`
- **AND** settings 文件不被污染

#### Scenario: 业务 action 化
- **GIVEN** renderer 需要写入数据
- **THEN** 删除不必要的 `insert/update` 直通通道
- **AND** 改为业务 action（如 `segment.markImportant(id)`、`wiki.confirmIngest(id)`）
- **AND** renderer 无法直接硬删全部 Wiki/Report，除非走确认过的业务动作

#### Scenario: system.saveFile 限制
- **GIVEN** renderer 调用 `system.saveFile`
- **THEN** 限制默认扩展名与文件名白名单
- **AND** 拒绝危险路径

### Requirement: 视觉设计治理（修改自 V0.3，强化组件体系）
系统 SHALL 通过统一组件库落地视觉治理，而非散落的 token 与内联样式。

#### Scenario: 组件库驱动（新增）
- **WHEN** 渲染任何页面
- **THEN** 使用 `src/ui/` 组件库
- **AND** 页面内联 CSS 减少到布局级
- **AND** 所有按钮/弹窗/卡片状态一致

#### Scenario: 截图级验收（新增）
- **GIVEN** 应用有 5 个 Episode、20 个 Segment
- **WHEN** 打开 Today 页并截图
- **THEN** 一眼能看到今日总结、记录状态、生成日报入口
- **AND** 不出现文字溢出和布局拥挤

#### Scenario: Fluent 材质与圆角（保留 V0.3）
- **WHEN** 渲染侧边栏、右侧详情面板、桌面伙伴背景
- **THEN** 使用高保真 Fluent 亚克力材质
- **AND** 卡片/弹窗 `8px` 圆角，按钮 `6px` 圆角

### Requirement: Word 导出（修改自 V0.3 的 HTML .doc）
系统 SHALL 导出真实 `.docx` 文件，而非 HTML `.doc`。

#### Scenario: 导出 .docx
- **GIVEN** 用户点击导出 Word
- **WHEN** 导出完成
- **THEN** 生成 `.docx` 文件
- **AND** Word 可打开
- **AND** 标题、列表、段落格式正确

### Requirement: 搜索能力命名诚实（修改自 V0.3 的"语义搜索"）
系统 SHALL 在 UI 文案中诚实命名搜索能力，当前为"记忆搜索（关键词 + 时间）"。

#### Scenario: 命名诚实
- **GIVEN** 当前只支持关键词/时间规则搜索
- **WHEN** UI 展示搜索能力
- **THEN** 文案不得写"语义搜索"
- **AND** 文案写"记忆搜索"或"关键词 + 时间搜索"
- **AND** 匹配原因必须明确显示 OCR/时间/项目/人物

### Requirement: Wiki 自动提取（修改自 V0.3，强化草稿与置信度）
系统 SHALL 将自动提取的 Wiki 默认设为草稿，并展示置信度与建议理由。

#### Scenario: 草稿默认
- **WHEN** WikiExtractor 自动生成 Wiki 候选
- **THEN** `review_status='needs_review'`
- **AND** UI 展示置信度与"为什么建议保存到 Wiki"
- **AND** 低置信（<0.5）不进入 Wiki/报告默认选择

### Requirement: EntityExtractor 置信度（修改自 V0.3）
系统 SHALL 为所有自动提取的实体附带 confidence 字段。

#### Scenario: 实体置信度
- **WHEN** EntityExtractor 提取实体
- **THEN** 每个实体带 `confidence`（0-1）
- **AND** 低置信实体不进入 Wiki/报告默认选择
- **AND** 支持用户确认/修正

### Requirement: 关系图谱稳定性（修改自 V0.3）
系统 SHALL 限制图谱节点数并提供布局缓存，超过上限降级为"关系预览"。

#### Scenario: 节点上限与降级
- **GIVEN** 选定范围节点数超过 100
- **WHEN** 渲染图谱
- **THEN** 降级为"关系预览"提示
- **AND** 文案诚实称"关系预览"
- **AND** 布局结果缓存避免重复抖动
