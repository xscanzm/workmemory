# Checklist — OCR / AI 管线可信化 Sprint

> 验收清单：对应 spec.md 全部 Requirement 与 tasks.md 全部任务。任何一项不通过即视为 Sprint 未完成。检查方法：Read 相关代码 + Grep 搜索 + 运行 typecheck/build + 构造场景验证。

## Phase A：OCR 文本可用性

### Task A1：OcrTextCleaner 去噪模块
- [x] `electron/ocr/OcrTextCleaner.ts` 存在，导出 `clean(rawText: string): { cleanedText: string; noiseScore: number }`
- [x] UI 噪声词表覆盖菜单栏（文件/编辑/视图/收藏/工具/帮助/设置/窗口）、状态栏、浏览器地址栏 URL 残片、通用按钮（确定/取消/保存/关闭/刷新/返回/搜索/登录/注册）
- [x] 连续短行（≤15 字且无句号/问号/感叹号）合并为一行
- [x] 完全相同的行只保留首次出现
- [x] `noiseScore = 噪声行数 / 总行数`（0-1），空文本返回 1
- [x] 单元测试覆盖：中文菜单栏去除、英文 UI 去除、碎片行合并、URL 残片去除、噪声评分、空文本

### Task A2：OcrQueue 集成 OcrTextCleaner
- [x] `OcrQueue.onOcrSuccess` 调用 `OcrTextCleaner.clean(result.text)`
- [x] `segment.ocrText` 存储清洗后文本（`cleanedText`）
- [x] `segment.ocrSummary` 存储清洗后前 200 字（去重行后截断，非 100 字硬截断）
- [x] `sourceQuality` 评级：`noiseScore > 0.7` → 'low'；`noiseScore > 0.4` → 'medium'；否则保留原 confidence 评级
- [x] `ocrConfidence` 仍存储 OCR 引擎返回的 confidence
- [x] `saveScreenshots=true` 时 `ocrRawText` 保留原始文本；默认 false 不保留
- [x] 构造含 UI 噪声的 OCR 输出，确认 segment.ocrText 不含菜单栏文字

### Task A3：WorkSegment 类型与数据库迁移
- [x] `src/types/index.ts` `WorkSegment` 新增 `ocrRawText?: string`、`noiseScore?: number`
- [x] `electron/db/schema.ts` segments 表新增 `ocr_raw_text TEXT`、`noise_score REAL` 列
- [x] `electron/db/migrations.ts` 新增迁移脚本（ALTER TABLE ADD COLUMN）
- [x] `SegmentRepository.toSegment`/`fromSegment` 映射新字段
- [x] typecheck 通过；启动应用数据库迁移成功；新字段可读写

### Task A4：EpisodeBuilder 使用清洗后文本
- [x] `EpisodeBuilder.segmentText` 使用 `segment.ocrText`（已清洗）
- [x] `extractKeywords` 过滤 UI 噪声词（与 OcrTextCleaner 词表一致）
- [x] `generateTitle` 无任务单号/项目名/动作词时降级为 `${appName} - ${windowTitle前20字}`
- [x] `generateOneLineSummary` 无有效动作词时返回 `查看 ${appName} 相关内容`（非"推进关键词"）
- [x] 构造纯 UI 噪声 OCR 的 segment，确认 Episode 标题/摘要不再是"推进文件编辑"

## Phase B：AI JSON 契约加固

### Task B1：OpenAIClient 支持 response_format
- [x] `ChatCompletionParams` 新增 `responseFormat?: { type: 'json_object' | 'text' }`、`jsonSchema?: { name: string; schema: object }`
- [x] `createChatCompletionRequest` 当 `responseFormat` 存在时加入请求体 `response_format`
- [x] `jsonSchema` 存在时加入 `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`
- [x] `testConnection` 不受影响（仍用 text 模式）
- [x] typecheck 通过；构造 json_object 请求确认请求体含 `response_format`

### Task B2：DistillEventSchema Zod 定义
- [x] `electron/ai/schemas/DistillEventSchema.ts` 存在，导出 `DistillEventSchema`、`DistillResponseSchema`、`parseDistillResponse`
- [x] `DistillEventSchema` 字段完整（title/summary/startTime/endTime/memoryKind/project/entities/topics/materials/outputs/todos/blockers/segmentIds/evidenceRefs/sourceQuality/confidence/reportEligible/wikiEligible/wikiStatus）
- [x] `parseDistillResponse` 先剥 ```json 围栏，再 `JSON.parse`，失败时提取首个 `{` 到最后一个 `}`
- [x] 合法 event 入 `events`，不合法的计入 `skipped`
- [x] 单元测试覆盖：合法 JSON 通过、字段缺失跳过、类型错误跳过、空 events 数组、非 JSON 输入抛错

### Task B3：DistillPrompt 强化 JSON 约束
- [x] systemPrompt 含"只输出 JSON 对象，不要 Markdown 代码块，不要任何解释文字，第一个字符必须是 {"
- [x] userPrompt JSON 示例带字段约束注释（segmentIds 必须来自输入、confidence 0-1 等）
- [x] 提示词文本含"第一个字符必须是 {"约束

### Task B4：DistillManager 集成 schema 校验与重试
- [x] `distillHour` 调用 OpenAIClient 时传 `responseFormat: { type: 'json_object' }`
- [x] 使用 `parseDistillResponse` 替换 `parseJsonFromModel`
- [x] `events.length === 0 && skipped > 0` 时重试 1 次，提示词追加"上次返回无法解析"
- [x] 重试仍失败则 `upsertRun` status='failed'，error_message 记录跳过数
- [x] `normalizeEvent` 保留（segmentIds 白名单、默认值），类型校验由 Zod 完成
- [x] mock OpenAIClient 返回带 ```json 围栏输出，确认能解析；返回缺字段 event 确认跳过

### Task B5：ReportGenerator 结构化输出路径
- [x] `ReportTemplateDef` 新增 `structuredOutput?: boolean`（默认 false）
- [x] 3 个内置模板保持 `structuredOutput: false`（兼容）
- [x] `generate` 当 `structuredOutput === true` 时传 `responseFormat: { type: 'json_object' }`，期望 `{ title, sections, summary }`
- [x] `renderStructuredToMarkdown` 渲染为标准 Markdown（# title / ## heading / - items / > summary）
- [x] 结构化路径失败时 fallback 到 Markdown 直出，记录警告
- [x] typecheck 通过；structuredOutput=false 时行为不变

## Phase C：端到端管线真实可用

### Task C1：ReportGenerator timeline 增加证据片段
- [x] `buildTimeline` 每个 Episode 块新增 `- 证据片段：` 行
- [x] 证据片段取该 Episode 下 segments 的 `ocrText`（清洗后）前 2 条非空行（每条 ≤80 字）
- [x] ocrText 为空时不输出证据片段行
- [x] `buildSnapshotTimeline` 也增加证据片段（从 `evidenceRefs.quote` 取）
- [x] 构造含 ocrText 的 Episode，确认 timeline 含"证据片段："行

### Task C2：crossValidate 简化为仅任务单号校验
- [x] 移除项目名模糊匹配逻辑（`projectInGenerated`/`suspiciousProjects`/`isGenericHeading`）
- [x] 保留任务单号校验（`taskNumberPattern`/`knownTaskNumbers`/`suspiciousTaskNumbers`）
- [x] 警告文案改为"⚠️ 注意：以下任务单号未在原始工作片段中出现：{任务单号列表}"
- [x] 生成的 Markdown 含 `## 核心产出` 不再触发项目名警告
- [x] 含 `ORD-999`（未在原片段）触发任务单号警告

### Task C3：raw_fallback 路径优化与 Distill 失败回流
- [x] `reportInputSnapshot` 为空且 `payload.episodeIds` 有数据时，从 `EpisodeRepository` 构建 snapshot
- [x] `buildSnapshotFromEpisodes` 把 Episode 转为 `ReportSnapshotItem`，`sourceType='raw_fallback'`，`sourceQuality='medium'`
- [x] Episode 有数据时不追加"使用原始/启发式片段降级生成"警告
- [x] `getDistillFailureReason(date)` 查询 `distill_runs` 表当日失败记录
- [x] `raw_fallback` 时 warning 附加"小时级理解未就绪：{失败原因}，当前使用工作记忆事件降级生成"
- [x] CleanEpisode 为空但 Episode 有数据时，snapshot 构建成功，warning 含 Distill 失败原因

### Task C4：EpisodeBuilder 降级策略完善
- [x] `generateTitle` 当 `cluster.keywords` 全为 UI 噪声词时，降级为 `${appName} - ${windowTitle前20字}`
- [x] `generateOneLineSummary` 当 `actions.length === 0 && topKeywords` 全为噪声时，返回 `查看 ${appName} 相关内容`
- [x] `extractTitleKeywords` 去除应用名后缀后剩余为空则返回空字符串
- [x] 构造纯 UI 噪声 OCR 的 segment，确认 Episode 标题为"Chrome - 订单退款流程优化方案"而非"推进文件编辑"

## Phase D：可观测性与验证

### Task D1：端到端验证脚本
- [x] `scripts/verify-ocr-ai-pipeline.ts` 存在
- [x] 构造 1 小时模拟 segments（含 UI 噪声 OCR 文本）
- [x] 跑 `OcrTextCleaner.clean` → 断言 cleanedText 不含菜单栏文字
- [x] 跑 `EpisodeBuilder.rebuildEpisodesForDate` → 断言标题/摘要非"推进关键词"
- [x] mock `OpenAIClient.chatCompletion` 返回合法 JSON → 跑 `DistillManager.distillHour` → 断言 CleanEpisode 写入成功
- [x] 跑 `ReportGenerator.generate` → 断言 timeline 含"证据片段："行、无 `raw_fallback` 警告（Episode 有数据时）
- [x] 脚本可通过 `npx tsx scripts/verify-ocr-ai-pipeline.ts` 运行

### Task D2：构建与类型验证
- [x] `npm run typecheck` 零错误
- [x] `npm run build` 成功
- [x] `npm run lint` 零警告（业务代码）

## Sprint 总体验收（对照 spec.md 6 个 Requirement）

- [x] Requirement 1：OCR 文本去噪与结构化（A1/A2）
- [x] Requirement 2：AI JSON 输出 Schema 校验（B2/B4）
- [x] Requirement 3：Report timeline 含真实证据片段（C1）
- [x] Requirement 4：端到端管线去降级（C3）
- [x] Requirement 5：本地 OCR 推理（修改自 V0.4，清洗后存储）（A2/A3）
- [x] Requirement 6：Episode 语义合并（修改自 V0.4，降级策略）（A4/C4）
- [x] Requirement 7：日报交叉校验（修改自 V0.4，仅任务单号）（C2）
- [x] REMOVED：ReportGenerator 项目名模糊交叉校验已移除（C2）
