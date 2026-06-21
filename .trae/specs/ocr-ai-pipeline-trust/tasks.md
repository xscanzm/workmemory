# Tasks — OCR / AI 管线可信化 Sprint

> 原则：纵深加固 V0.4 的 OCR/AI 管线，不新增页面、不新增大功能模块。每个任务必须真实可用、完整闭环，禁止 TODO/占位符/mock/空实现。typecheck/build 通过是所有任务的前置。

## Phase A：OCR 文本可用性（去噪 + 结构化摘要）

- [x] Task A1：OcrTextCleaner 去噪模块
  - [x] A1.1 新增 `electron/ocr/OcrTextCleaner.ts`：实现 `clean(rawText: string): { cleanedText: string; noiseScore: number }`
  - [x] A1.2 UI 通用噪声词表：菜单栏（文件/编辑/视图/收藏/工具/帮助/设置/窗口）、状态栏（时间格式/电池/网络）、浏览器地址栏（http/https URL 残片）、通用按钮（确定/取消/保存/关闭/刷新/返回/搜索/登录/注册）
  - [x] A1.3 行级合并：连续短行（每行 ≤15 字且无句号/问号/感叹号）合并为一行，不同段落间保留空行
  - [x] A1.4 去重：完全相同的行只保留首次出现
  - [x] A1.5 噪声评分：`noiseScore = 噪声行数 / 总行数`（0-1），空文本返回 1
  - [x] A1.6 单元测试 `electron/ocr/__tests__/OcrTextCleaner.test.ts`：覆盖中文菜单栏去除、英文 UI 去除、碎片行合并、URL 残片去除、噪声评分、空文本

- [x] Task A2：OcrQueue 集成 OcrTextCleaner
  - [x] A2.1 修改 `electron/ocr/OcrQueue.ts` `onOcrSuccess`：调用 `OcrTextCleaner.clean(result.text)` 得到 `{ cleanedText, noiseScore }`
  - [x] A2.2 `ocrText` 存储清洗后文本（`cleanedText`）；`ocrSummary` 改为清洗后前 200 字（去重行后截断，不再是 100 字硬截断）
  - [x] A2.3 `sourceQuality` 评级调整：`noiseScore > 0.7` → 'low'；`noiseScore > 0.4` → 'medium'；否则保留原 confidence 评级（high/medium）
  - [x] A2.4 `ocrConfidence` 仍存储 OCR 引擎返回的 confidence（不受 noiseScore 影响）
  - [x] A2.5 当 `saveScreenshots=true` 时，`ocrRawText` 字段保留原始 OCR 文本（审计用）；默认 false 不保留
  - [x] A2.6 验证：构造含 UI 噪声的 OCR 输出，确认 segment.ocrText 不含菜单栏文字、ocrSummary 为去重后 200 字

- [x] Task A3：WorkSegment 类型与数据库迁移
  - [x] A3.1 修改 `src/types/index.ts` `WorkSegment`：新增 `ocrRawText?: string`、`noiseScore?: number`
  - [x] A3.2 修改 `electron/db/schema.ts` segments 表：新增 `ocr_raw_text TEXT`、`noise_score REAL` 列
  - [x] A3.3 修改 `electron/db/migrations.ts`：新增迁移脚本添加两列（ALTER TABLE ADD COLUMN，SQLite 支持）
  - [x] A3.4 修改 `electron/db/repositories/SegmentRepository.ts`：`toSegment`/`fromSegment` 映射新字段
  - [x] A3.5 验证：typecheck 通过；启动应用数据库迁移成功；新字段可读写

- [x] Task A4：EpisodeBuilder 使用清洗后文本
  - [x] A4.1 修改 `electron/capture/EpisodeBuilder.ts` `segmentText`：使用 `segment.ocrText`（已清洗）
  - [x] A4.2 修改 `extractKeywords`：新增 UI 噪声词表过滤（菜单项、按钮文字、状态栏词），与 OcrTextCleaner 词表一致
  - [x] A4.3 修改 `generateTitle`：当无任务单号、无项目名、无动作词时，降级为 `${appName} - ${windowTitle前20字}` 而非无意义关键词拼接
  - [x] A4.4 修改 `generateOneLineSummary`：当无有效动作词时，返回 `查看 ${appName} 相关内容` 而非"推进关键词"
  - [x] A4.5 验证：构造纯 UI 噪声 OCR 的 segment，确认 Episode 标题/摘要不再是"推进文件编辑"

## Phase B：AI JSON 契约加固（输入 + 输出 schema 化）

- [x] Task B1：OpenAIClient 支持 response_format
  - [x] B1.1 修改 `electron/ai/OpenAIClient.ts` `ChatCompletionParams`：新增 `responseFormat?: { type: 'json_object' | 'text' }`、`jsonSchema?: { name: string; schema: object }`
  - [x] B1.2 修改 `createChatCompletionRequest`：当 `responseFormat` 存在时加入请求体 `response_format`；当 `jsonSchema` 存在时加入 `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`
  - [x] B1.3 `testConnection` 不受影响（仍用 text 模式）
  - [x] B1.4 验证：typecheck 通过；构造 json_object 请求确认请求体含 `response_format`

- [x] Task B2：DistillEventSchema Zod 定义
  - [x] B2.1 新增 `electron/ai/schemas/DistillEventSchema.ts`：用 Zod 定义 `DistillEventSchema`（字段：title/summary/startTime/endTime/memoryKind/project/entities/topics/materials/outputs/todos/blockers/segmentIds/evidenceRefs/sourceQuality/confidence/reportEligible/wikiEligible/wikiStatus）
  - [x] B2.2 导出 `DistillResponseSchema = z.object({ events: z.array(DistillEventSchema) })`
  - [x] B2.3 导出 `parseDistillResponse(content: string): { events: DistillEvent[]; skipped: number; raw: unknown }`：先剥 ```json 围栏，再 `JSON.parse`，失败时尝试提取首个 `{` 到最后一个 `}`；解析后用 schema 校验，合法 event 入 `events`，不合法的计入 `skipped`
  - [x] B2.4 单元测试 `electron/ai/schemas/__tests__/DistillEventSchema.test.ts`：合法 JSON 通过、字段缺失跳过、类型错误跳过、空 events 数组返回 skipped=0/events=[]、非 JSON 输入抛错

- [x] Task B3：DistillPrompt 强化 JSON 约束
  - [x] B3.1 修改 `electron/ai/DistillPrompt.ts` `buildDistillMessages`：systemPrompt 强化"只输出 JSON 对象，不要 Markdown 代码块，不要任何解释文字，第一个字符必须是 {"
  - [x] B3.2 userPrompt 中的 JSON 示例改为带注释说明每个字段的约束（如 `segmentIds 必须来自输入`、`confidence 0-1`）
  - [x] B3.3 验证：提示词文本含"第一个字符必须是 {"约束

- [x] Task B4：DistillManager 集成 schema 校验与重试
  - [x] B4.1 修改 `electron/ai/DistillManager.ts` `distillHour`：调用 `OpenAIClient.chatCompletion` 时传 `responseFormat: { type: 'json_object' }`
  - [x] B4.2 替换 `parseJsonFromModel` 为 `parseDistillResponse`，得到 `{ events, skipped, raw }`
  - [x] B4.3 当 `events.length === 0 && skipped > 0` 时重试 1 次：提示词追加"上次返回无法解析（{skipped} 条被跳过），请严格输出 JSON 对象，第一个字符必须是 {"
  - [x] B4.4 重试仍失败则 `upsertRun` status='failed'，error_message 记录"AI JSON 解析失败，跳过 {skipped} 条"
  - [x] B4.5 `normalizeEvent` 逻辑保留（处理 segmentIds 白名单过滤、默认值），但类型校验由 Zod 完成
  - [x] B4.6 验证：mock OpenAIClient 返回带 ```json 围栏的输出，确认 parseDistillResponse 能解析；返回缺字段 event 确认跳过

- [x] Task B5：ReportGenerator 结构化输出路径（可选模板）
  - [x] B5.1 修改 `electron/ai/templates.ts` `ReportTemplateDef`：新增 `structuredOutput?: boolean`（默认 false）
  - [x] B5.2 3 个内置模板（enhanced/concise/okr）保持 `structuredOutput: false`（兼容）
  - [x] B5.3 修改 `electron/ai/ReportGenerator.ts` `generate`：当 `template.structuredOutput === true` 时，调用 OpenAIClient 传 `responseFormat: { type: 'json_object' }`，期望返回 `{ title, sections: [{ heading, items }], summary }`，再由 `renderStructuredToMarkdown` 转为 Markdown
  - [x] B5.4 新增 `renderStructuredToMarkdown(data: { title; sections; summary }): string`：渲染为标准 Markdown（# title / ## heading / - items / > summary）
  - [x] B5.5 结构化路径失败（JSON 解析失败）时 fallback 到 Markdown 直出路径，并记录警告
  - [x] B5.6 验证：typecheck 通过；structuredOutput=false 时行为不变

## Phase C：端到端管线真实可用（去降级 + 证据回流）

- [x] Task C1：ReportGenerator timeline 增加证据片段
  - [x] C1.1 修改 `electron/ai/ReportGenerator.ts` `buildTimeline`：每个 Episode 块新增 `- 证据片段：` 行
  - [x] C1.2 证据片段取该 Episode 下 segments 的 `ocrText`（清洗后）前 2 条非空行（每条 ≤80 字）
  - [x] C1.3 若 ocrText 为空则不输出证据片段行
  - [x] C1.4 同步修改 `buildSnapshotTimeline`：snapshot 路径也增加证据片段（从 `evidenceRefs.quote` 取，已有字段）
  - [x] C1.5 验证：构造含 ocrText 的 Episode，确认 timeline 含"证据片段："行

- [x] Task C2：crossValidate 简化为仅任务单号校验
  - [x] C2.1 修改 `electron/ai/ReportGenerator.ts` `crossValidate`：移除项目名模糊匹配逻辑（`projectInGenerated`/`suspiciousProjects`/`isGenericHeading`）
  - [x] C2.2 保留任务单号校验（`taskNumberPattern`/`knownTaskNumbers`/`suspiciousTaskNumbers`）
  - [x] C2.3 警告文案改为"⚠️ 注意：以下任务单号未在原始工作片段中出现：{任务单号列表}"
  - [x] C2.4 验证：生成的 Markdown 含 `## 核心产出` 不再触发项目名警告；含 `ORD-999`（未在原片段）触发任务单号警告

- [x] Task C3：raw_fallback 路径优化与 Distill 失败回流
  - [x] C3.1 修改 `electron/ai/ReportGenerator.ts` `generate`：当 `reportInputSnapshot` 为空且 `payload.episodeIds` 有数据时，从 `EpisodeRepository` 构建 snapshot（而非直接走 episodeIds 路径）
  - [x] C3.2 新增 `buildSnapshotFromEpisodes(episodes: Episode[]): ReportInputSnapshot`：把 Episode 转为 `ReportSnapshotItem`，`sourceType='raw_fallback'`，`sourceQuality='medium'`
  - [x] C3.3 修改 `raw_fallback` 警告逻辑：当 Episode 有数据时不追加"使用原始/启发式片段降级生成"警告；仅当 Episode 也为空时才警告
  - [x] C3.4 新增 `getDistillFailureReason(date: string): string | null`：查询 `distill_runs` 表当日失败记录的 `error_message`
  - [x] C3.5 ReportGenerator 走 `raw_fallback` 时，在 `warning` 字段附加"小时级理解未就绪：{失败原因}，当前使用工作记忆事件降级生成"（失败原因为空时显示"小时级理解尚未运行"）
  - [x] C3.6 验证：CleanEpisode 为空但 Episode 有数据时，snapshot 构建成功，warning 含 Distill 失败原因

- [x] Task C4：EpisodeBuilder 降级策略完善
  - [x] C4.1 修改 `electron/capture/EpisodeBuilder.ts` `generateTitle`：当 `cluster.keywords` 全为 UI 噪声词（被过滤后为空）时，降级为 `${appName} - ${windowTitle前20字}`
  - [x] C4.2 修改 `generateOneLineSummary`：当 `actions.length === 0 && topKeywords` 全为噪声时，返回 `查看 ${appName} 相关内容`
  - [x] C4.3 修改 `extractTitleKeywords`：去除应用名后缀后，若剩余文本为空则返回空字符串（不返回应用名本身）
  - [x] C4.4 验证：构造纯 UI 噪声 OCR 的 segment，确认 Episode 标题为"Chrome - 订单退款流程优化方案"而非"推进文件编辑"

## Phase D：可观测性与验证

- [x] Task D1：端到端验证脚本
  - [x] D1.1 新增 `scripts/verify-ocr-ai-pipeline.ts`：构造 1 小时模拟 segments（含 UI 噪声 OCR 文本）
  - [x] D1.2 跑 `OcrTextCleaner.clean` → 断言 cleanedText 不含菜单栏文字
  - [x] D1.3 跑 `EpisodeBuilder.rebuildEpisodesForDate` → 断言 Episode 标题/摘要非"推进关键词"
  - [x] D1.4 mock `OpenAIClient.chatCompletion` 返回合法 JSON → 跑 `DistillManager.distillHour` → 断言 CleanEpisode 写入成功
  - [x] D1.5 跑 `ReportGenerator.generate` → 断言 timeline 含"证据片段："行、无 `raw_fallback` 警告（Episode 有数据时）
  - [x] D1.6 脚本可通过 `npx tsx scripts/verify-ocr-ai-pipeline.ts` 运行

- [x] Task D2：构建与类型验证
  - [x] D2.1 `npm run typecheck` 零错误
  - [x] D2.2 `npm run build` 成功
  - [x] D2.3 `npm run lint` 零警告（业务代码）

## 验收修复（Verification Fix）

- [x] Task V1：修复 SegmentRepository.rowToSegment 字段映射缺失
  - [x] V1.1 修改 `electron/db/repositories/SegmentRepository.ts` `rowToSegment`：新增 `ocrRawText: row.ocr_raw_text ?? undefined`、`noiseScore: row.noise_score ?? undefined` 映射
  - [x] V1.2 验证：typecheck 通过；lint 通过；rowToSegment 返回的 WorkSegment 对象包含 ocrRawText/noiseScore 字段

# Task Dependencies

- Task A1（OcrTextCleaner）为 A2/A4 前置
- Task A2（OcrQueue 集成）依赖 A1
- Task A3（类型与迁移）为 A2 前置（字段定义）
- Task A4（EpisodeBuilder）依赖 A1（噪声词表）+ A2（清洗后文本）
- Task B1（OpenAIClient response_format）为 B4/B5 前置
- Task B2（DistillEventSchema）为 B4 前置
- Task B3（DistillPrompt）与 B4 联动，B3 先行
- Task B4（DistillManager 集成）依赖 B1/B2/B3
- Task B5（ReportGenerator 结构化）依赖 B1，可与 B4 并行
- Task C1（timeline 证据片段）依赖 A2（清洗后 ocrText）
- Task C2（crossValidate 简化）独立
- Task C3（raw_fallback 优化）依赖 A4（Episode 降级）+ B4（Distill 失败记录）
- Task C4（EpisodeBuilder 降级）依赖 A1（噪声词表）
- Task D1（端到端脚本）依赖 A/B/C 全部完成
- Task D2（构建验证）为最后审计
