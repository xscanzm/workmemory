# Tasks — 感知与记忆引擎进化 Sprint

> 原则：将"看见"从文字升级到行为语义，将"记忆"从存储升级到自组织+反思+进化。每个任务必须真实可用、完整闭环，禁止 TODO/占位符/mock/空实现。typecheck/build 通过是所有任务的前置。
>
> 本 Sprint 分 6 个 Phase，Phase 1-2 为本 Sprint 核心交付（感知增强 + 记忆结构化），Phase 3-5 为递进扩展（层级理解 + 反思进化 + 日报升级），Phase 6 为验证。Phase 1 任务最细粒度，后续 Phase 按依赖关系推进。

## Phase 1：感知增强 — 让"看见"从文字升级到行为语义

- [ ] Task P1：ActivityClassifier 活动类型识别器
  - [ ] P1.1 新增 `electron/capture/ActivityClassifier.ts`：导出 `classifyActivity(segment: { appName, windowTitle, ocrText, ocrBlocks }): { activityType: ActivityType; confidence: number }`
  - [ ] P1.2 `ActivityType` 枚举：`coding | writing | reading | browsing | chatting | designing | meeting | managing | idle`
  - [ ] P1.3 分类规则：应用名优先（VS Code→coding 候选，微信/飞书/Slack→chatting 候选，Chrome/Edge→browsing 候选）+ 窗口标题增强 + OCR 文本模式验证（代码关键词/对话气泡/段落结构）
  - [ ] P1.4 置信度计算：匹配规则数 / 总规则数，≥0.6 才赋值，否则 'idle'
  - [ ] P1.5 单元测试 `electron/capture/__tests__/ActivityClassifier.test.ts`：覆盖 coding/chatting/browsing/reading/idle 5 类场景

- [ ] Task P2：ContentClassifier 内容类型分类器
  - [ ] P2.1 新增 `electron/capture/ContentClassifier.ts`：导出 `classifyContent(segment): { contentType: ContentType; contentData: Record<string, unknown>; confidence: number }`
  - [ ] P2.2 `ContentType` 枚举：`chat | webpage | document | code | video | forum | product | other`
  - [ ] P2.3 类型特定结构化提取：
    - chat: `{ participants, messageCount, keyMessages, platform }`（基于 OCR 块的对话气泡布局 + 昵称模式）
    - webpage: `{ url, pageTitle, domain, keyParagraphs }`（基于窗口标题 + URL 采集 + 正文段落）
    - video: `{ platform, title, duration, subtitles }`（基于播放器控件/进度条/字幕 OCR）
    - forum: `{ threadTitle, posts, authors }`（基于帖子列表布局）
    - product: `{ name, price, source }`（基于商品页价格/标题模式）
  - [ ] P2.4 单元测试 `electron/capture/__tests__/ContentClassifier.test.ts`：覆盖 chat/webpage/video/forum 5 类场景

- [ ] Task P3：BrowserContextCollector 浏览器 URL 采集
  - [ ] P3.1 新增 `electron/capture/BrowserContextCollector.ts`：导出 `collectBrowserUrl(windowInfo: { processName, windowTitle }): { url: string; method: 'title_parse' | 'extension' | 'none'; confidence: number }`
  - [ ] P3.2 标题解析通道：Chrome/Edge/Firefox 窗口标题格式通常为 "页面标题 - 浏览器名"，解析页面标题，与浏览器历史 URL 匹配（需浏览器扩展或历史 API，首期仅记录 pageTitle 与 domain 推断）
  - [ ] P3.3 隐私模式检测：IncognitoDetector 已检测无痕模式，无痕时返回空 URL
  - [ ] P3.4 单元测试 `electron/capture/__tests__/BrowserContextCollector.test.ts`：覆盖 Chrome 标题解析、无痕模式跳过、非浏览器进程返回 none

- [ ] Task P4：LayoutAnalyzer UI 布局分析器
  - [ ] P4.1 新增 `electron/capture/LayoutAnalyzer.ts`：导出 `analyzeLayout(ocrBlocks: OcrBlock[]): { layoutType: LayoutType; regions: LayoutRegion[]; confidence: number }`
  - [ ] P4.2 `LayoutType` 枚举：`form | list | article | editor | chat | dashboard | other`
  - [ ] P4.3 布局识别规则（基于 OCR 块坐标分布）：
    - form: "标签 + 输入框"交替排列 + 按钮文字
    - list: 多行等间距短文本块
    - article: 长段落连续排列，无交互元素
    - editor: 代码缩进/行号特征 + 等宽字体区域
    - chat: 左右分栏对话气泡 + 头像区域
    - dashboard: 网格布局 + 数据卡片
  - [ ] P4.4 单元测试 `electron/capture/__tests__/LayoutAnalyzer.test.ts`：覆盖 form/article/chat/editor 4 类场景

- [ ] Task P5：ActionFlowInferrer 操作流推断器
  - [ ] P5.1 新增 `electron/capture/ActionFlowInferrer.ts`：导出 `inferActionFlow(prev: Segment, curr: Segment): { actionFlow: ActionFlow; evidence: string }`
  - [ ] P5.2 `ActionFlow` 枚举：`copy-paste | switch-context | scroll-deep | edit-continuous | browse-linear | unknown`
  - [ ] P5.3 推断规则：
    - copy-paste: prev 的某段文本（≥10 字）在 curr 中出现，且时间间隔 <2min
    - switch-context: appName 或 windowTitle 变化
    - scroll-deep: 同窗口，OCR 文本重叠率 >50% 但有新增内容，时间间隔 <1min
    - edit-continuous: 同应用同窗口，连续 ≥3 segment，OCR 文本渐进变化
    - browse-linear: 同浏览器，URL/标题变化，时间间隔 <2min
  - [ ] P5.4 单元测试 `electron/capture/__tests__/ActionFlowInferrer.test.ts`：覆盖 copy-paste/switch-context/edit-continuous 3 类场景

- [ ] Task P6：WorkSegment 类型与数据库迁移
  - [ ] P6.1 修改 `src/types/index.ts` `WorkSegment`：新增 `activityType?: ActivityType`、`contentType?: ContentType`、`contentData?: Record<string, unknown>`、`browserUrl?: string`、`layoutType?: LayoutType`、`actionFlow?: ActionFlow`
  - [ ] P6.2 修改 `electron/db/schema.ts` segments 表：新增 `activity_type TEXT`、`content_type TEXT`、`content_data TEXT`（JSON）、`browser_url TEXT`、`layout_type TEXT`、`action_flow TEXT` 列
  - [ ] P6.3 修改 `electron/db/migrations.ts`：CURRENT_VERSION 5→6，新增 v6 迁移（ALTER TABLE ADD COLUMN，幂等）
  - [ ] P6.4 修改 `electron/db/repositories/SegmentRepository.ts`：`SegmentRow`/`rowToSegment`/`SegmentInsertParams`/`segmentToParams`/INSERT/UPDATE SQL 映射新字段
  - [ ] P6.5 验证：typecheck 通过；迁移成功；新字段可读写

- [x] Task P7：OcrQueue 集成感知增强分类器
  - [x] P7.1 修改 `electron/ocr/OcrQueue.ts` `onOcrSuccess`：OCR 清洗后，依次调用 `ActivityClassifier.classifyActivity`、`ContentClassifier.classifyContent`、`LayoutAnalyzer.analyzeLayout`（基于 ocrBlocks）、`BrowserContextCollector.collectBrowserUrl`
  - [x] P7.2 `ActionFlowInferrer.inferActionFlow` 需要前一个 segment，OcrQueue 维护 `lastSegment` 引用（按窗口/时间）
  - [x] P7.3 新字段写入 segment 更新：activityType、contentType、contentData（JSON 序列化）、browserUrl、layoutType、actionFlow
  - [x] P7.4 验证：构造含代码/聊天/网页 OCR 的 segment，确认分类结果正确写入

- [ ] Task P8：EpisodeBuilder activityType 感知聚类
  - [ ] P8.1 修改 `electron/capture/EpisodeBuilder.ts` `isSemanticallySimilar`：新增 activityType 感知——不同 activityType（如 reading vs coding）即使关键词重叠也不合并
  - [ ] P8.2 `createEpisodeFromCluster`：Episode 新增 `dominantActivityType` 字段（聚类内多数 activityType）
  - [ ] P8.3 修改 `src/types/index.ts` `Episode`：新增 `dominantActivityType?: ActivityType`
  - [ ] P8.4 验证：构造"读代码文档"与"写代码"相邻 segment（关键词重叠但 activityType 不同），确认不被误合并

## Phase 2：记忆结构化 — 借鉴 EverOS MemCell

- [ ] Task M1：MemCell 类型与数据库表
  - [ ] M1.1 新增 `electron/memory/MemCell.ts`：定义 `MemCell` 接口 `{ id, cleanEpisodeId, episode: string, facts: string[], foresight: Foresight[], metadata: MemCellMetadata, createdAt }`，`Foresight = { statement, validFrom, validTo, confidence }`
  - [ ] M1.2 修改 `electron/db/schema.ts`：新增 `memory_cells` 表（id, clean_episode_id, episode, facts JSON, foresight JSON, metadata JSON, created_at）
  - [ ] M1.3 修改 `electron/db/migrations.ts`：v6 迁移含 memory_cells 表创建
  - [ ] M1.4 新增 `electron/db/repositories/MemCellRepository.ts`：`insert`/`getById`/`getByCleanEpisodeId`/`getByDateRange`/`deleteByHour`
  - [ ] M1.5 验证：typecheck 通过；表创建成功；CRUD 可用

- [ ] Task M2：DistillManager 输出 MemCell
  - [ ] M2.1 修改 `electron/ai/schemas/DistillEventSchema.ts`：`DistillEventSchema` 扩展 `episode`（第三人称叙事）、`facts`（字符串数组）、`foresight`（带 validFrom/validTo 的对象数组）字段
  - [ ] M2.2 修改 `electron/ai/DistillPrompt.ts`：systemPrompt 增加 MemCell 结构说明，要求 AI 输出 episode/facts/foresight
  - [ ] M2.3 修改 `electron/ai/DistillManager.ts` `distillHour`：AI 返回后，除写 CleanEpisode 外，还写 MemCell（episode/facts/foresight 从 AI 输出提取，metadata 含 segmentIds/timestamp/confidence）
  - [ ] M2.4 验证：mock OpenAIClient 返回含 episode/facts/foresight 的 JSON，确认 MemCell 写入 memory_cells 表

- [ ] Task M3：EmbeddingService 本地语义向量
  - [ ] M3.1 新增 `electron/memory/EmbeddingService.ts`：导出 `EmbeddingService` 单例，`embed(text: string): Promise<Float32Array>`、`embedBatch(texts: string[]): Promise<Float32Array[]>`、`cosineSimilarity(a, b): number`
  - [ ] M3.2 模型加载：本地 ONNX 模型（multilingual-e5-small 或 bge-small-zh，放 `resources/embedding/`），通过 `onnxruntime-node` 推理
  - [ ] M3.3 模型降级：模型文件不存在时 `embed` 抛错，调用方降级到仅 FTS5 检索
  - [ ] M3.4 修改 `electron/db/schema.ts`：新增 `embeddings` 表（id, memory_cell_id, embedding BLOB, model_version, created_at）
  - [ ] M3.5 新增 `electron/db/repositories/EmbeddingRepository.ts`：`insert`/`getByMemoryCellId`/`searchBySimilarity(queryEmbedding, limit)`（余弦相似度，SQLite 存 BLOB，内存计算）
  - [ ] M3.6 验证：模型加载成功；embed 返回 384/768 维向量；cosineSimilarity 正确

- [ ] Task M4：MemCell 向量索引
  - [ ] M4.1 修改 `electron/ai/DistillManager.ts`：MemCell 写入后，调用 `EmbeddingService.embed(memCell.episode + ' ' + memCell.facts.join(' '))`，存入 embeddings 表
  - [ ] M4.2 新增 `electron/memory/MemCellIndexer.ts`：监听 `memcell-created` 事件，异步生成 embedding 并存储，失败不阻塞主流程
  - [ ] M4.3 批量补建：新增 `rebuildEmbeddings(dateRange)` 方法，为历史 MemCell 补建 embedding
  - [ ] M4.4 验证：DistillManager 成功后 embeddings 表有对应记录

- [x] Task M5：SemanticSearchRepository 混合检索
  - [x] M5.1 新增 `electron/db/repositories/SemanticSearchRepository.ts`：导出 `hybridSearch(query: string, options: { limit, semanticWeight, keywordWeight }): SearchResult[]`
  - [x] M5.2 混合检索逻辑：FTS5 关键词匹配（已有）+ 语义向量余弦相似度（EmbeddingService.embed(query) → EmbeddingRepository.searchBySimilarity），按 `score = keywordWeight * ftsScore + semanticWeight * semanticScore` 排序
  - [x] M5.3 去重：同一 memory_cell_id 合并，取最高分
  - [x] M5.4 降级：EmbeddingService 不可用时退化为纯 FTS5
  - [x] M5.5 修改 `src/pages/Search.tsx`：搜索结果展示匹配原因（关键词匹配 / 语义相似 / 混合）
  - [x] M5.6 验证：构造"前端组件开发"查询，确认返回"UI 组件库实现"MemCell（语义匹配）

- [ ] Task M6：MemSceneClusterer 主题自组织聚类
  - [ ] M6.1 新增 `electron/memory/MemSceneClusterer.ts`：导出 `clusterMemCell(memCell: MemCell): Promise<{ sceneId: string; isNew: boolean }>`，增量聚类
  - [ ] M6.2 聚类算法：计算新 MemCell embedding 与所有现有 MemScene 质心的余弦相似度，最大值 >0.8 则归并（更新质心为成员均值），否则新建 MemScene
  - [ ] M6.3 修改 `electron/db/schema.ts`：新增 `memory_scenes` 表（id, title, centroid_embedding BLOB, member_cell_ids JSON, summary, created_at, updated_at）
  - [ ] M6.4 新增 `electron/db/repositories/MemSceneRepository.ts`：`insert`/`update`/`getById`/`getAll`/`addMember`/`updateCentroid`
  - [ ] M6.5 MemScene 标题生成：新建时用 AI 生成标题（基于首个 MemCell episode），归并时保留原标题
  - [ ] M6.6 修改 `MemCellIndexer`：embedding 生成后触发 `MemSceneClusterer.clusterMemCell`
  - [ ] M6.7 验证：构造 3 个同主题 MemCell，确认归并到同一 MemScene；构造 1 个不同主题，确认新建 MemScene

- [ ] Task M7：UserProfileEvolver 用户画像演进
  - [ ] M7.1 新增 `electron/memory/UserProfileEvolver.ts`：导出 `evolveProfile(date: string): Promise<void>`，从当日 MemScene 摘要提取画像
  - [ ] M7.2 画像提取规则：活动类型频率→稳定特质（primary_activity）；当前主题→瞬态状态（current_focus）；常用应用→稳定特质（preferred_apps）
  - [ ] M7.3 修改 `electron/db/schema.ts`：新增 `user_profile` 表（key, value, type: stable|transient, confidence, valid_to, sources JSON, updated_at）
  - [ ] M7.4 新增 `electron/db/repositories/UserProfileRepository.ts`：`upsert`/`get`/`getStable`/`getTransient`/`getAll`
  - [ ] M7.5 触发：每日首次启动时调用 `evolveProfile(yesterday)`
  - [ ] M7.6 验证：构造 7 天编码活动 MemScene，确认 user_profile 含 `primary_activity=coding, type=stable`

## Phase 3：层级化理解 — 小时→日→周→月

- [ ] Task H1：DailyDistillManager 日级理解
  - [ ] H1.1 新增 `electron/ai/DailyDistillManager.ts`：导出 `distillDay(date: string): Promise<DayDistillResult>`
  - [ ] H1.2 输入：当日所有 MemCell + MemScene + 用户画像
  - [ ] H1.3 输出：日级摘要 + 跨小时主题 + 当日模式（深度工作时长/碎片化时段/切换次数）
  - [ ] H1.4 修改 `electron/db/schema.ts`：新增 `daily_distills` 表（id, date, summary, themes JSON, patterns JSON, memcell_ids JSON, created_at）
  - [ ] H1.5 触发：每日 23:00 或次日首次启动
  - [ ] H1.6 验证：构造 1 天多小时 MemCell，确认日级摘要含跨小时主题

- [ ] Task H2：WeeklyPatternDetector 周级模式发现
  - [ ] H2.1 新增 `electron/ai/WeeklyPatternDetector.ts`：导出 `detectPatterns(weekStart: string): Promise<WeeklyPattern[]>`
  - [ ] H2.2 输入：近 7 天 daily_distills
  - [ ] H2.3 输出：工作模式（深度工作时段/碎片化时段/常用应用组合/效率趋势/注意力热点）
  - [ ] H2.4 修改 `electron/db/schema.ts`：新增 `weekly_patterns` 表（id, week_start, patterns JSON, trend JSON, created_at）
  - [ ] H2.5 触发：每周一首次启动
  - [ ] H2.6 验证：构造 7 天 daily_distills，确认模式含"每日 14:00 碎片化"

- [ ] Task H3：CausalChainBuilder 跨 Episode 因果链
  - [ ] H3.1 新增 `electron/ai/CausalChainBuilder.ts`：导出 `buildChains(date: string): Promise<CausalChain[]>`
  - [ ] H3.2 输入：当日 MemCell（按时间排序）
  - [ ] H3.3 输出：因果关系 `{cause_cell_id, effect_cell_id, relation: leads_to|blocks|enables, confidence, evidence}`
  - [ ] H3.4 AI 推断：构建提示词，让 AI 从相邻 MemCell 中识别因果（"查阅 safeStorage 文档" enables "实现 API Key 加密"）
  - [ ] H3.5 修改 `electron/db/schema.ts`：新增 `causal_chains` 表（id, cause_cell_id, effect_cell_id, relation, confidence, evidence, created_at）
  - [ ] H3.6 触发：DailyDistillManager 完成后触发
  - [ ] H3.7 验证：构造"查阅文档→实现功能"相邻 MemCell，确认 causal_chain 关系为 enables

## Phase 4：反思与进化

- [ ] Task R1：ReflectionEngine 反思引擎
  - [ ] R1.1 新增 `electron/ai/ReflectionEngine.ts`：导出 `reflect(weekStart: string): Promise<ReflectionReport>`
  - [ ] R1.2 输入：weekly_patterns + user_profile + causal_chains
  - [ ] R1.3 输出：反思报告 `{ patterns: {description, severity, evidence}[], suggestions: {title, rationale, action}[], trends: {metric, direction, comparison}[] }`
  - [ ] R1.4 修改 `electron/db/schema.ts`：新增 `reflection_reports` 表（id, week_start, report JSON, created_at）
  - [ ] R1.5 触发：每周一 WeeklyPatternDetector 完成后，或用户主动触发
  - [ ] R1.6 验证：构造"下午碎片化"模式，确认反思报告含改进建议

- [ ] Task R2：SkillEvolver 技能进化
  - [ ] R2.1 新增 `electron/ai/SkillEvolver.ts`：导出 `evolveSkills(): Promise<Skill[]>`
  - [ ] R2.2 输入：MemScene 中成员 ≥3 的主题（重复工作信号）
  - [ ] R2.3 输出：技能卡 `{id, title, steps, traps, insights, source_cell_ids, confidence, evolved_at}`
  - [ ] R2.4 AI 提炼：构建提示词，让 AI 从同主题 MemCell 中提炼 SOP 步骤、陷阱、洞察
  - [ ] R2.5 修改 `electron/db/schema.ts`：新增 `skills` 表（id, title, steps JSON, traps JSON, insights JSON, source_cell_ids JSON, confidence, evolved_at）
  - [ ] R2.6 触发：每周 ReflectionEngine 完成后
  - [ ] R2.7 验证：构造 3 个"数据库迁移"主题 MemCell，确认生成技能卡

- [ ] Task R3：FeedbackLoop 反馈回流
  - [ ] R3.1 新增 `electron/ai/FeedbackLoop.ts`：导出 `recordFeedback(event: FeedbackEvent): void`、`applyFeedback(): void`
  - [ ] R3.2 FeedbackEvent 类型：`{ type: 'episode_renamed'|'wiki_rejected'|'report_edited', targetId, before, after, timestamp }`
  - [ ] R3.3 修改 `electron/db/schema.ts`：新增 `feedback_events` 表（id, type, target_id, before, after, timestamp, applied）
  - [ ] R3.4 修改 `EpisodeBuilder`/`WikiIngestManager`/`ReportGenerator`：在用户编辑时调用 `recordFeedback`
  - [ ] R3.5 `applyFeedback`：分析反馈模式（如"推进"被频繁修改），调整关键词权重表（内存中的可调参数）
  - [ ] R3.6 验证：模拟用户 3 次将"推进文件编辑"改为其他标题，确认"推进"权重降低

- [ ] Task R4：ProactiveAdvisor 主动建议
  - [ ] R4.1 新增 `electron/ai/ProactiveAdvisor.ts`：导出 `checkAndAdvise(): Promise<Advice | null>`
  - [ ] R4.2 建议触发规则：
    - 当前活动匹配已有 skill → "要参考之前的经验吗"
    - 当前活动连续 >2h 且历史模式显示该时段效率低 → "建议休息"
    - 检测到与昨日相同的碎片化模式 → "今天又在频繁切换，要试试专注模式吗"
  - [ ] R4.3 修改 `electron/mascot/MascotNotifier.ts`：接收 advice 并通过桌面伙伴推送
  - [ ] R4.4 节流：同一建议 4 小时内不重复
  - [ ] R4.5 验证：构造当前活动匹配 skill 的场景，确认推送建议

## Phase 5：日报结构化升级

- [x] Task RP1：ReportGenerator 结构化日报
  - [x] RP1.1 修改 `electron/ai/templates.ts` `ReportTemplateDef`：新增 `structuredSections?: ReportSection[]` 配置，控制输出哪些分类要点
  - [x] RP1.2 默认 sections：`['butler_summary', 'what_i_did', 'what_i_saw', 'themes', 'timeline', 'chat_notes', 'web_notes', 'forum_notes', 'video_notes', 'product_notes', 'evidence', 'suggestions']`
  - [x] RP1.3 修改 `electron/ai/ReportGenerator.ts`：日报输入增加 MemCell + MemScene + causal_chains 上下文；提示词要求按 sections 结构输出
  - [x] RP1.4 分类要点生成：基于 segment.contentType 分组（chat→chat_notes, webpage→web_notes, video→video_notes, forum→forum_notes, product→product_notes），每组提取结构化摘要
  - [x] RP1.5 证据片段：从 MemCell.facts + segment.ocrText 提取，每条 ≤80 字
  - [x] RP1.6 优化建议：从 ReflectionEngine 当周报告提取（若有），否则 AI 生成
  - [x] RP1.7 修改 `src/pages/Reports.tsx`：渲染结构化日报，按 sections 分区展示
  - [x] RP1.8 验证：构造含聊天/网页/视频活动的一天，确认日报含对应分类要点章节

## Phase 6：验证

- [x] Task V1：端到端验证脚本
  - [x] V1.1 新增 `scripts/verify-perception-memory.ts`：构造 1 天多类型活动 segments（编码/聊天/浏览/视频/论坛）
  - [x] V1.2 跑 ActivityClassifier + ContentClassifier + LayoutAnalyzer → 断言分类正确
  - [x] V1.3 跑 EpisodeBuilder → 断言不同 activityType 不被误合并
  - [x] V1.4 mock OpenAIClient → 跑 DistillManager → 断言 MemCell 写入（含 episode/facts/foresight）
  - [x] V1.5 跑 EmbeddingService → 断言向量生成；跑 SemanticSearchRepository → 断言语义检索返回概念相似结果
  - [x] V1.6 跑 MemSceneClusterer → 断言同主题归并、不同主题新建
  - [x] V1.7 跑 DailyDistillManager → 断言日级摘要含跨小时主题
  - [x] V1.8 跑 ReportGenerator → 断言日报含分类要点章节 + 证据片段
  - [x] V1.9 脚本可通过 `npx tsx scripts/verify-perception-memory.ts` 运行

- [ ] Task V2：构建与类型验证
  - [ ] V2.1 `npm run typecheck` 零错误
  - [ ] V2.2 `npm run build` 成功
  - [ ] V2.3 `npm run lint` 零警告（业务代码）

# Task Dependencies

## Phase 1 内部依赖
- Task P1（ActivityClassifier）独立
- Task P2（ContentClassifier）独立，可与 P1 并行
- Task P3（BrowserContextCollector）独立，可与 P1/P2 并行
- Task P4（LayoutAnalyzer）依赖已有 ocrBlocks（无外部依赖）
- Task P5（ActionFlowInferrer）独立，可与 P1-P4 并行
- Task P6（类型与迁移）依赖 P1/P2/P4/P5 的类型定义（ActivityType/ContentType/LayoutType/ActionFlow）
- Task P7（OcrQueue 集成）依赖 P1/P2/P3/P4/P5/P6
- Task P8（EpisodeBuilder 聚类）依赖 P1/P6

## Phase 2 内部依赖
- Task M1（MemCell 类型与表）独立
- Task M2（DistillManager 输出 MemCell）依赖 M1
- Task M3（EmbeddingService）独立，可与 M1/M2 并行
- Task M4（MemCell 向量索引）依赖 M1/M2/M3
- Task M5（SemanticSearchRepository）依赖 M3/M4
- Task M6（MemSceneClusterer）依赖 M3/M4
- Task M7（UserProfileEvolver）依赖 M6

## Phase 3 内部依赖
- Task H1（DailyDistillManager）依赖 Phase 2（M1/M2）
- Task H2（WeeklyPatternDetector）依赖 H1
- Task H3（CausalChainBuilder）依赖 M1/M2

## Phase 4 内部依赖
- Task R1（ReflectionEngine）依赖 H2（weekly_patterns）
- Task R2（SkillEvolver）依赖 M6（MemScene）
- Task R3（FeedbackLoop）独立，可与 R1/R2 并行
- Task R4（ProactiveAdvisor）依赖 R2（skills）+ M7（user_profile）

## Phase 5 内部依赖
- Task RP1（结构化日报）依赖 Phase 1（P2 ContentClassifier）+ Phase 2（M1 MemCell）+ Phase 4（R1 ReflectionEngine）

## Phase 6 内部依赖
- Task V1（端到端脚本）依赖 Phase 1-5 全部完成
- Task V2（构建验证）为最后审计

## 跨 Phase 依赖
- Phase 2 依赖 Phase 1（MemCell 需要 activityType/contentType 上下文）
- Phase 3 依赖 Phase 2（层级理解基于 MemCell）
- Phase 4 依赖 Phase 3（反思基于周级模式）
- Phase 5 依赖 Phase 1+2+4（日报整合所有层）
- Phase 6 依赖全部
