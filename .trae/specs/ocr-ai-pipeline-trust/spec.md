# OCR / AI 管线可信化 Spec

> 范围说明：本 Spec 是对 `workmemory-v04-trust-beauty` 的**纵深加固**，不新增页面、不新增大功能模块。Sprint 目标三句话：**OCR 出来的内容真的能用、AI 收到/产出的 JSON 真的稳、端到端管线真的跑得通没有 bug**。审查发现 V0.4 把"可信"做到了启动容错与 IPC 校验层，但 OCR 文本本身仍是"原始噪声 + 截断 100 字"的粗料，AI 两条路径（DistillManager JSON / ReportGenerator Markdown）输入输出契约不一致且无 schema 校验，整条 OCR → Episode → Report 链路在真实数据下经常退化到 `raw_fallback`。本 Sprint 把这些"看起来能跑"改成"真实数据下真的好用"。明确不做：不替换 PP-OCRv6 / Tesseract 后端、不引入向量数据库、不重写 React 页面、不新增第 9 个页面。

## Why

V0.4 完成了"启动不崩 + IPC 不被注入"的表层可信，但核心数据管线仍有三类硬伤：

1. **OCR 内容不可用**：`OcrQueue.onOcrSuccess` 把识别文本原样存入 `ocrText`，`ocrSummary` 只是前 100 字截断——既不是摘要也不去噪。屏幕 OCR 输出天然包含大量 UI 噪声（菜单栏、状态栏、按钮文字、地址栏、时间戳），这些噪声直接灌进 `EpisodeBuilder.extractKeywords`（TF 单字/双字统计）和 `ReportGenerator.buildTimeline`，导致 Episode 标题是"文件 编辑 视图"这类无意义关键词拼接，日报 timeline 是"内容摘要：文件 编辑 视图 收藏 帮助..."。

2. **AI JSON 契约不稳**：`DistillManager` 用 `parseJsonFromModel` 解析 AI 返回的 JSON，但提示词只口头要求"只输出严格 JSON"，未使用 OpenAI `response_format: { type: 'json_object' }`，AI 偶尔返回带 ```json 代码块或前后解释文字时虽能兜底，但字段缺失/类型错误时只在 `normalizeEvent` 静默丢弃，无重试、无 schema 校验、无错误回流。`ReportGenerator` 则完全不用 JSON，直接要 Markdown，与 DistillManager 的结构化路径割裂，且 `crossValidate` 用启发式正则提取"项目名/任务号"，误报率高。

3. **端到端经常退化**：`ReportGenerator.generate` 优先走 `reportInputSnapshot`（CleanEpisode 路径），但 `DistillManager` 只在用户授权 `aiAutoDistillEnabled` 后整点跑，且失败后 `CleanEpisodeRepository` 为空，于是 ReportGenerator 退到 `raw_fallback`，用 `EpisodeBuilder` 的规则启发式片段生成日报——而 EpisodeBuilder 本身依赖未清洗的 OCR 文本，产出质量低。整条链路在"OCR 噪声 → 启发式 Episode → 降级日报"之间循环，没有真正的可信出口。

## What Changes

### Phase A：OCR 文本可用性（去噪 + 结构化摘要）
- **ADDED** `electron/ocr/OcrTextCleaner.ts`：对原始 OCR 文本执行去噪（去除 UI 通用短语、菜单项、状态栏时间、URL 残片、重复空行）+ 行级合并（同段连续短行合并为一句）+ 噪声评分（输出 `noiseScore` 0-1）。
- **MODIFIED** `OcrQueue.onOcrSuccess`：识别成功后调用 `OcrTextCleaner.clean(rawText)` 得到 `cleanedText`，存入 `ocrText`（清洗后），`ocrSummary` 改为 `cleanedText` 的前 200 字且去重行后截断（不再是 100 字硬截断）；`noiseScore` 写入 `sourceQuality` 评级（noiseScore > 0.7 → 'low'）。
- **ADDED** `WorkSegment` 字段 `ocrRawText`（可选，仅当 `saveScreenshots=true` 时保留原始 OCR 文本用于审计；默认不存以节省空间）。
- **MODIFIED** `EpisodeBuilder.segmentText`：使用 `ocrText`（已清洗）而非原始文本；`extractKeywords` 增加 UI 噪声词表过滤。

### Phase B：AI JSON 契约加固（输入 + 输出 schema 化）
- **MODIFIED** `OpenAIClient.chatCompletion`：新增可选参数 `responseFormat?: { type: 'json_object' | 'text' }`，当为 `json_object` 时在请求体加入 `response_format` 字段；同时新增 `jsonSchema?: object`（OpenAI Structured Outputs），存在时加入 `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`。
- **MODIFIED** `DistillPrompt.buildDistillMessages`：提示词强化"只输出 JSON，不要 Markdown 代码块，不要任何解释文字"；附上严格 JSON Schema 描述。
- **MODIFIED** `DistillManager.distillHour`：调用 `OpenAIClient` 时传 `responseFormat: { type: 'json_object' }`；`parseJsonFromModel` 增强为 `parseJsonStrict`——先剥 ```json 围栏，再 `JSON.parse`，失败时尝试提取首个 `{` 到最后一个 `}` 的子串；解析后用 Zod schema `DistillEventSchema` 校验单条 event，校验失败的 event 跳过并记录，全部失败则重试 1 次（提示词追加"上次返回无法解析，请严格输出 JSON"）。
- **ADDED** `electron/ai/schemas/DistillEventSchema.ts`：Zod schema 定义 `DistillEvent`（title/summary/startTime/endTime/memoryKind/project/entities/topics/materials/outputs/todos/blockers/segmentIds/evidenceRefs/sourceQuality/confidence/reportEligible/wikiEligible/wikiStatus），导出 `parseDistillResponse(content): { events: DistillEvent[]; raw: unknown }`。
- **MODIFIED** `ReportGenerator.generate`：新增可选参数 `responseFormat: 'json_object'` 路径——当模板配置 `structuredOutput: true` 时，要求 AI 返回 JSON `{ "title": "...", "sections": [{ "heading": "...", "items": ["..."] }], "summary": "..." }`，再由 `HtmlExporter`/`ReportExporter` 渲染为 Markdown；保留旧 Markdown 直出路径作为 fallback。3 个内置模板默认 `structuredOutput: false`（保持兼容），新增第 4 个内部模板 `structured` 用于验证。

### Phase C：端到端管线真实可用（去降级 + 证据回流）
- **MODIFIED** `EpisodeBuilder.rebuildEpisodesForDate`：当 OCR 文本清洗后 `noiseScore` 高且无任务单号/项目名时，Episode 标题降级为 `${appName} - ${windowTitle关键词}` 而非无意义关键词拼接；`generateOneLineSummary` 在无有效动作词时返回 `查看 ${appName} 相关内容` 而非"推进关键词"。
- **MODIFIED** `ReportGenerator.buildTimeline`：timeline 文本中每条 Episode 增加 `证据片段` 字段——取该 Episode 下 `ocrText` 清洗后前 2 条非空行（每条 ≤80 字），让 AI 有真实证据可引用，而非只看 `oneLineSummary`。
- **MODIFIED** `ReportGenerator.crossValidate`：从"启发式正则提取项目名"改为"基于 `digests` 中实际出现的实体/任务号白名单"——只校验任务单号（`extractTaskIds` 已有），移除项目名模糊匹配（误报率高）；警告文案改为"以下任务单号未在原始片段中出现"。
- **ADDED** `DistillManager` 失败回流：当 `distillHour` 失败（AI 错误/JSON 解析失败）时，在 `distill_runs.error_message` 记录失败原因，并在 `ReportGenerator` 走 `raw_fallback` 时把该失败原因显示在确认面板（"小时级理解未就绪：{原因}，当前使用原始片段降级生成"），让用户知道为什么降级。
- **MODIFIED** `ReportGenerator` 的 `raw_fallback` 路径：当 `CleanEpisodeRepository` 为空但 `EpisodeRepository` 有数据时，使用 `Episode`（而非 CleanEpisode）构建 snapshot，并在 timeline 中标注 `来源质量: medium（基于窗口标题 + 清洗后 OCR）`，不再显示 `raw_fallback` 警告除非 Episode 也没有。

### Phase D：可观测性与验证
- **ADDED** `electron/ocr/OcrTextCleaner` 单元测试覆盖：UI 噪声去除、行合并、噪声评分、中文/英文混合。
- **ADDED** `electron/ai/schemas/DistillEventSchema` 单元测试覆盖：合法 JSON 通过、字段缺失跳过、类型错误跳过、空 events 数组拒绝。
- **ADDED** 端到端验证脚本 `scripts/verify-ocr-ai-pipeline.ts`：构造 1 小时模拟 segments（含 UI 噪声 OCR 文本）→ 跑 OcrTextCleaner → 跑 EpisodeBuilder → 跑 DistillManager（mock OpenAIClient 返回合法 JSON）→ 跑 ReportGenerator → 断言 timeline 含证据片段、无"推进关键词"类无意义摘要、无 `raw_fallback` 警告。

## Impact
- Affected specs: `workmemory-v04-trust-beauty`（V0.4）——本 Sprint 修改其 OCR 推理、Episode 合并、Report 生成、Distill 等 Requirement 的实现细节，但不改变其对外契约（IPC 通道、设置项、UI 文案）。
- Affected code:
  - `electron/ocr/OcrTextCleaner.ts`（新增）—— OCR 文本去噪与结构化
  - `electron/ocr/OcrQueue.ts` —— `onOcrSuccess` 调用 cleaner，存储清洗后文本
  - `electron/ocr/PpOcrEngine.ts` —— `OcrResult` 新增 `rawText` 字段（可选，保留原始）
  - `electron/capture/EpisodeBuilder.ts` —— `segmentText`/`extractKeywords` 使用清洗后文本，标题/摘要降级策略
  - `electron/ai/OpenAIClient.ts` —— `chatCompletion` 支持 `responseFormat`/`jsonSchema`
  - `electron/ai/DistillPrompt.ts` —— 提示词强化 JSON 约束
  - `electron/ai/DistillManager.ts` —— 使用 `responseFormat`、`parseJsonStrict`、Zod 校验、失败回流
  - `electron/ai/schemas/DistillEventSchema.ts`（新增）—— Zod schema
  - `electron/ai/ReportGenerator.ts` —— timeline 增加证据片段、crossValidate 简化、raw_fallback 路径优化
  - `electron/ai/templates.ts` —— 模板新增 `structuredOutput` 字段
  - `src/types/index.ts` —— `WorkSegment` 新增 `ocrRawText?`、`noiseScore?`；`ReportTemplateDef` 新增 `structuredOutput`
  - `electron/db/schema.ts`、`migrations.ts` —— segments 表新增 `ocr_raw_text`、`noise_score` 列
  - `scripts/verify-ocr-ai-pipeline.ts`（新增）—— 端到端验证
- 关键新增依赖：无（`zod` 已在 V0.4 引入）。

## ADDED Requirements

### Requirement: OCR 文本去噪与结构化
系统 SHALL 在 OCR 识别成功后对原始文本执行去噪处理，去除 UI 通用噪声并合并碎片行，输出可用于下游 Episode/Report 的清洗文本。

#### Scenario: UI 噪声去除
- **GIVEN** OCR 原始文本包含"文件 编辑 视图 收藏 工具 帮助"等菜单栏文字
- **WHEN** `OcrTextCleaner.clean(rawText)` 执行
- **THEN** 菜单栏通用短语被移除
- **AND** 输出 `cleanedText` 不再包含这些噪声词作为独立行
- **AND** 输出 `noiseScore` 反映噪声占比（>0.7 视为低质量）

#### Scenario: 碎片行合并
- **GIVEN** OCR 原始文本中同一语义段落被识别为多个短行（如"订单退款" "流程优化" "方案讨论" 各占一行）
- **WHEN** `OcrTextCleaner.clean(rawText)` 执行
- **THEN** 连续短行（每行 ≤15 字且无句号）被合并为一行
- **AND** 合并后行之间保留空行分隔不同段落

#### Scenario: 噪声评分驱动质量分级
- **GIVEN** OCR 文本清洗后 `noiseScore > 0.7`
- **WHEN** `OcrQueue.onOcrSuccess` 写入 segment
- **THEN** `sourceQuality` 设为 `'low'`
- **AND** `ocrSummary` 仍写入清洗后前 200 字（不因低质量而清空）

### Requirement: AI JSON 输出 Schema 校验
系统 SHALL 对 DistillManager 的 AI JSON 输出执行 Zod schema 校验，校验失败的单条 event 跳过并记录，全部失败时重试 1 次。

#### Scenario: 合法 JSON 通过
- **GIVEN** AI 返回 `{ "events": [{ "title": "...", "summary": "...", "segmentIds": ["..."], ... }] }`
- **WHEN** `parseDistillResponse(content)` 执行
- **THEN** 返回 `{ events: DistillEvent[], raw: unknown }`
- **AND** 每个 event 通过 `DistillEventSchema` 校验

#### Scenario: 字段缺失跳过
- **GIVEN** AI 返回的 events 数组中某条缺少 `summary` 字段
- **WHEN** `parseDistillResponse(content)` 执行
- **THEN** 该条 event 被跳过
- **AND** 其他合法 event 正常返回
- **AND** 控制台记录被跳过的 event 索引与原因

#### Scenario: 全部失败重试
- **GIVEN** AI 返回的内容解析后所有 event 都不合法或 events 数组为空
- **WHEN** `DistillManager.distillHour` 处理
- **THEN** 重试 1 次，提示词追加"上次返回无法解析，请严格输出 JSON"
- **AND** 重试仍失败则记录 `distill_runs.status='failed'` 与错误原因

#### Scenario: response_format 强制 JSON
- **GIVEN** DistillManager 调用 OpenAIClient
- **WHEN** 发送请求
- **THEN** 请求体包含 `response_format: { type: 'json_object' }`
- **AND** AI 返回非 JSON 时由 `parseJsonStrict` 兜底解析

### Requirement: Report timeline 含真实证据片段
系统 SHALL 在生成日报的 timeline 文本中，为每个 Episode 附带从清洗后 OCR 文本提取的真实证据片段，供 AI 引用。

#### Scenario: 证据片段提取
- **GIVEN** 一个 Episode 下有 3 个 segment，ocrText 清洗后含多行文本
- **WHEN** `ReportGenerator.buildTimeline` 构建 timeline
- **THEN** 每个 Episode 块包含 `- 证据片段：` 行
- **AND** 证据片段取清洗后 ocrText 前 2 条非空行（每条 ≤80 字）
- **AND** 若 ocrText 为空则不输出证据片段行

### Requirement: 端到端管线去降级
系统 SHALL 在 CleanEpisode 为空但 Episode 有数据时，使用 Episode 构建日报 snapshot，避免不必要的 `raw_fallback` 警告。

#### Scenario: Episode 兜底
- **GIVEN** `CleanEpisodeRepository` 为空（Distill 未跑或失败），`EpisodeRepository` 有当日数据
- **WHEN** `ReportGenerator.generate` 构建 snapshot
- **THEN** 使用 Episode 数据构建 `ReportInputSnapshot`
- **AND** `sourceType` 设为 `'raw_fallback'` 但 timeline 标注 `来源质量: medium`
- **AND** 不再追加"使用原始/启发式片段降级生成"警告（除非 Episode 也为空）

#### Scenario: Distill 失败原因回流
- **GIVEN** `distill_runs` 表中存在当日失败记录
- **WHEN** ReportGenerator 走 `raw_fallback` 路径
- **THEN** 确认面板显示"小时级理解未就绪：{失败原因}，当前使用工作记忆事件降级生成"
- **AND** 失败原因为空时显示"小时级理解尚未运行"

## MODIFIED Requirements

### Requirement: 本地 OCR 推理（修改自 V0.4）
系统 SHALL 在本地完成 OCR 并对原始文本执行去噪，输出清洗后文本与噪声评分。**修改点**：OCR 成功后不再原样存储文本，而是经过 `OcrTextCleaner` 清洗；`ocrSummary` 从 100 字硬截断改为清洗后 200 字去重行截断；新增 `noiseScore` 字段驱动 `sourceQuality` 评级。

#### Scenario: 清洗后存储（修改）
- **WHEN** `OcrQueue.onOcrSuccess` 处理识别结果
- **THEN** `ocrText` 存储清洗后文本
- **AND** `ocrSummary` 存储清洗后前 200 字（去重行）
- **AND** `noiseScore` 写入 segment（可选字段）
- **AND** `sourceQuality` 根据 `noiseScore` 评级（>0.7 → 'low'，>0.4 → 'medium'，否则保留原 confidence 评级）

#### Scenario: 原始文本保留（新增）
- **GIVEN** 用户在设置中开启 `saveScreenshots`
- **WHEN** OCR 成功
- **THEN** `ocrRawText` 字段保留原始 OCR 文本（用于审计）
- **AND** 默认（`saveScreenshots=false`）不保留 `ocrRawText` 以节省空间

### Requirement: Episode 语义合并（修改自 V0.4）
系统 SHALL 基于清洗后 OCR 文本执行 Episode 合并，并在无有效语义信号时降级为窗口标题驱动的标题/摘要。**修改点**：`segmentText` 使用清洗后 `ocrText`；`extractKeywords` 过滤 UI 噪声词；标题/摘要生成在无任务单号/项目名/动作词时降级为 `${appName} - ${windowTitle关键词}` 而非无意义关键词拼接。

#### Scenario: 无语义信号降级（修改）
- **GIVEN** 一个 Episode 的 segment 清洗后 ocrText 噪声高，无任务单号、无项目名、无动作词
- **WHEN** `generateTitle`/`generateOneLineSummary` 执行
- **THEN** 标题降级为 `${appName} - ${windowTitle前20字}`
- **AND** 摘要降级为 `查看 ${appName} 相关内容`
- **AND** 不再输出"推进关键词"类无意义摘要

### Requirement: 日报交叉校验（修改自 V0.4）
系统 SHALL 仅校验任务单号是否虚构，移除项目名模糊匹配（误报率高）。**修改点**：`crossValidate` 只检查任务单号（`extractTaskIds`），不再从 Markdown 标题/加粗提取项目名做模糊匹配；警告文案改为"以下任务单号未在原始片段中出现"。

#### Scenario: 仅校验任务单号（修改）
- **GIVEN** 生成的 Markdown 中出现任务单号 `ORD-123`
- **WHEN** `crossValidate` 执行
- **THEN** 检查 `ORD-123` 是否在原片段 `extractTaskIds` 集合中
- **AND** 不在则追加警告"任务单号：ORD-123 未在原始片段中出现"
- **AND** 不再对项目名做模糊匹配

## REMOVED Requirements

### Requirement: ReportGenerator 项目名模糊交叉校验
**Reason**: 启发式正则从 Markdown 标题/加粗提取"项目名"并做子串匹配，误报率高（"核心产出"被误判为项目名），且 AI 在"汇报优化版"模板下会把工作改写为业务价值陈述， legitimately 出现新表述，模糊匹配无法区分虚构与合理改写。
**Migration**: 保留任务单号校验（精确匹配，低误报），移除项目名校验。用户对项目名虚构的担忧由"内容真实不虚构"系统提示词 + 证据片段引用共同保障。
