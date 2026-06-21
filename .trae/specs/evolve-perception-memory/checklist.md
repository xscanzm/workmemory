# Checklist — 感知与记忆引擎进化 Sprint

> 验收清单：对应 spec.md 全部 Requirement 与 tasks.md 全部任务。任何一项不通过即视为 Sprint 未完成。检查方法：Read 相关代码 + Grep 搜索 + 运行 typecheck/build + 构造场景验证。

## Phase 1：感知增强 — 让"看见"从文字升级到行为语义

### Task P1：ActivityClassifier 活动类型识别器
- [x] `electron/capture/ActivityClassifier.ts` 存在，导出 `classifyActivity(segment): { activityType, confidence }`
- [x] `ActivityType` 枚举覆盖 9 类：coding/writing/reading/browsing/chatting/designing/meeting/managing/idle
- [x] 分类规则：应用名优先 + 窗口标题增强 + OCR 文本模式验证
- [x] 置信度计算：≥0.6 才赋值，否则 'idle'
- [x] 单元测试覆盖：coding/chatting/browsing/reading/idle 5 类场景

### Task P2：ContentClassifier 内容类型分类器
- [x] `electron/capture/ContentClassifier.ts` 存在，导出 `classifyContent(segment): { contentType, contentData, confidence }`
- [x] `ContentType` 枚举覆盖 8 类：chat/webpage/document/code/video/forum/product/other
- [x] chat 类型提取 `{ participants, messageCount, keyMessages, platform }`
- [x] webpage 类型提取 `{ url, pageTitle, domain, keyParagraphs }`
- [x] video 类型提取 `{ platform, title, duration, subtitles }`
- [x] forum 类型提取 `{ threadTitle, posts, authors }`
- [x] product 类型提取 `{ name, price, source }`
- [x] 单元测试覆盖：chat/webpage/video/forum 5 类场景

### Task P3：BrowserContextCollector 浏览器 URL 采集
- [x] `electron/capture/BrowserContextCollector.ts` 存在，导出 `collectBrowserUrl(windowInfo): { url, method, confidence }`
- [x] 标题解析通道：Chrome/Edge/Firefox 窗口标题解析页面标题
- [x] 无痕模式检测：IncognitoDetector 检测到无痕时返回空 URL
- [x] 非浏览器进程返回 `{ method: 'none' }`
- [x] 单元测试覆盖：Chrome 标题解析、无痕跳过、非浏览器返回 none

### Task P4：LayoutAnalyzer UI 布局分析器
- [x] `electron/capture/LayoutAnalyzer.ts` 存在，导出 `analyzeLayout(ocrBlocks): { layoutType, regions, confidence }`
- [x] `LayoutType` 枚举覆盖 7 类：form/list/article/editor/chat/dashboard/other
- [x] form 识别：标签+输入框交替 + 按钮文字
- [x] article 识别：长段落连续排列，无交互元素
- [x] chat 识别：左右分栏对话气泡 + 头像区域
- [x] editor 识别：代码缩进/行号 + 等宽字体区域
- [x] 单元测试覆盖：form/article/chat/editor 4 类场景

### Task P5：ActionFlowInferrer 操作流推断器
- [x] `electron/capture/ActionFlowInferrer.ts` 存在，导出 `inferActionFlow(prev, curr): { actionFlow, evidence }`
- [x] `ActionFlow` 枚举覆盖 6 类：copy-paste/switch-context/scroll-deep/edit-continuous/browse-linear/unknown
- [x] copy-paste 推断：prev 文本段在 curr 出现 + 时间间隔 <2min
- [x] switch-context 推断：appName 或 windowTitle 变化
- [x] edit-continuous 推断：同应用同窗口 + 连续 ≥3 segment + OCR 渐进变化
- [x] 单元测试覆盖：copy-paste/switch-context/edit-continuous 3 类场景

### Task P6：WorkSegment 类型与数据库迁移
- [x] `src/types/index.ts` `WorkSegment` 新增 `activityType?`/`contentType?`/`contentData?`/`browserUrl?`/`layoutType?`/`actionFlow?`
- [x] `electron/db/schema.ts` segments 表新增 6 列：activity_type/content_type/content_data/browser_url/layout_type/action_flow
- [x] `electron/db/migrations.ts` CURRENT_VERSION 5→6，v6 迁移幂等
- [x] `SegmentRepository` `SegmentRow`/`rowToSegment`/`SegmentInsertParams`/`segmentToParams`/INSERT/UPDATE SQL 映射新字段
- [x] typecheck 通过；迁移成功；新字段可读写

### Task P7：OcrQueue 集成感知增强分类器
- [x] `OcrQueue.onOcrSuccess` 调用 `ActivityClassifier.classifyActivity`
- [x] `OcrQueue.onOcrSuccess` 调用 `ContentClassifier.classifyContent`
- [x] `OcrQueue.onOcrSuccess` 调用 `LayoutAnalyzer.analyzeLayout`
- [x] `OcrQueue.onOcrSuccess` 调用 `BrowserContextCollector.collectBrowserUrl`
- [x] `OcrQueue.onOcrSuccess` 调用 `ActionFlowInferrer.inferActionFlow`（基于 lastSegment）
- [x] 新字段写入 segment 更新
- [x] 构造含代码/聊天/网页 OCR 的 segment，确认分类结果正确写入

### Task P8：EpisodeBuilder activityType 感知聚类
- [x] `EpisodeBuilder.isSemanticallySimilar` 新增 activityType 感知——不同 activityType 不合并
- [x] `Episode` 新增 `dominantActivityType?` 字段
- [x] `createEpisodeFromCluster` 设置 `dominantActivityType`（聚类内多数 activityType）
- [x] 构造"读代码文档"与"写代码"相邻 segment，确认不被误合并

## Phase 2：记忆结构化 — 借鉴 EverOS MemCell

### Task M1：MemCell 类型与数据库表
- [x] `electron/memory/MemCell.ts` 存在，定义 `MemCell` 接口（id/cleanEpisodeId/episode/facts/foresight/metadata/createdAt）
- [x] `Foresight` 接口含 `statement/validFrom/validTo/confidence`
- [x] `electron/db/schema.ts` 新增 `memory_cells` 表
- [x] `electron/db/migrations.ts` v6 迁移含 memory_cells 表创建
- [x] `electron/db/repositories/MemCellRepository.ts` 存在，CRUD 可用
- [x] typecheck 通过；表创建成功；CRUD 可用

### Task M2：DistillManager 输出 MemCell
- [x] `DistillEventSchema` 扩展 `episode`/`facts`/`foresight` 字段
- [x] `DistillPrompt` systemPrompt 含 MemCell 结构说明
- [x] `DistillManager.distillHour` 写 CleanEpisode 外还写 MemCell
- [x] MemCell 的 episode/facts/foresight 从 AI 输出提取
- [x] mock OpenAIClient 返回含 episode/facts/foresight 的 JSON，确认 MemCell 写入

### Task M3：EmbeddingService 本地语义向量
- [x] `electron/memory/EmbeddingService.ts` 存在，导出 `embed`/`embedBatch`/`cosineSimilarity`
- [x] 模型加载：本地 ONNX 模型（multilingual-e5-small 或 bge-small-zh）
- [x] 模型降级：文件不存在时 `embed` 抛错，调用方降级到 FTS5
- [x] `electron/db/schema.ts` 新增 `embeddings` 表
- [x] `electron/db/repositories/EmbeddingRepository.ts` 存在，CRUD + `searchBySimilarity` 可用
- [x] 模型加载成功；embed 返回正确维度向量；cosineSimilarity 正确

### Task M4：MemCell 向量索引
- [x] `DistillManager` MemCell 写入后调用 `EmbeddingService.embed` 生成向量
- [x] `electron/memory/MemCellIndexer.ts` 存在，监听 `memcell-created` 事件异步生成 embedding
- [x] 失败不阻塞主流程
- [x] `rebuildEmbeddings(dateRange)` 方法可为历史 MemCell 补建
- [x] DistillManager 成功后 embeddings 表有对应记录

### Task M5：SemanticSearchRepository 混合检索
- [x] `electron/db/repositories/SemanticSearchRepository.ts` 存在，导出 `hybridSearch`
- [x] 混合检索：FTS5 关键词 + 语义向量余弦相似度，按综合分数排序
- [x] 同一 memory_cell_id 去重，取最高分
- [x] EmbeddingService 不可用时退化为纯 FTS5
- [x] `src/pages/Search.tsx` 展示匹配原因（关键词/语义/混合）
- [x] 构造"前端组件开发"查询，确认返回"UI 组件库实现"MemCell

### Task M6：MemSceneClusterer 主题自组织聚类
- [x] `electron/memory/MemSceneClusterer.ts` 存在，导出 `clusterMemCell`
- [x] 增量聚类：相似度 >0.8 归并，否则新建
- [x] `electron/db/schema.ts` 新增 `memory_scenes` 表
- [x] `electron/db/repositories/MemSceneRepository.ts` 存在，CRUD + `addMember`/`updateCentroid`
- [x] 新建 MemScene 时 AI 生成标题
- [x] `MemCellIndexer` embedding 生成后触发 `clusterMemCell`
- [x] 构造 3 个同主题 MemCell，确认归并；1 个不同主题，确认新建

### Task M7：UserProfileEvolver 用户画像演进
- [x] `electron/memory/UserProfileEvolver.ts` 存在，导出 `evolveProfile(date)`
- [x] 活动类型频率→稳定特质（primary_activity）
- [x] 当前主题→瞬态状态（current_focus）
- [x] 常用应用→稳定特质（preferred_apps）
- [x] `electron/db/schema.ts` 新增 `user_profile` 表
- [x] `electron/db/repositories/UserProfileRepository.ts` 存在，CRUD 可用
- [x] 每日首次启动触发 `evolveProfile(yesterday)`
- [x] 构造 7 天编码活动 MemScene，确认 `primary_activity=coding, type=stable`

## Phase 3：层级化理解 — 小时→日→周→月

### Task H1：DailyDistillManager 日级理解
- [x] `electron/ai/DailyDistillManager.ts` 存在，导出 `distillDay(date)`
- [x] 输入：当日所有 MemCell + MemScene + 用户画像
- [x] 输出：日级摘要 + 跨小时主题 + 当日模式
- [x] `electron/db/schema.ts` 新增 `daily_distills` 表
- [x] 触发：每日 23:00 或次日首次启动
- [x] 构造 1 天多小时 MemCell，确认日级摘要含跨小时主题

### Task H2：WeeklyPatternDetector 周级模式发现
- [x] `electron/ai/WeeklyPatternDetector.ts` 存在，导出 `detectPatterns(weekStart)`
- [x] 输入：近 7 天 daily_distills
- [x] 输出：深度工作时段/碎片化时段/常用应用组合/效率趋势/注意力热点
- [x] `electron/db/schema.ts` 新增 `weekly_patterns` 表
- [x] 触发：每周一首次启动
- [x] 构造 7 天 daily_distills，确认模式含"每日 14:00 碎片化"

### Task H3：CausalChainBuilder 跨 Episode 因果链
- [x] `electron/ai/CausalChainBuilder.ts` 存在，导出 `buildChains(date)`
- [x] 输入：当日 MemCell（按时间排序）
- [x] 输出：因果关系 `{cause_cell_id, effect_cell_id, relation, confidence, evidence}`
- [x] AI 推断相邻 MemCell 因果（leads_to/blocks/enables）
- [x] `electron/db/schema.ts` 新增 `causal_chains` 表
- [x] 触发：DailyDistillManager 完成后
- [x] 构造"查阅文档→实现功能"相邻 MemCell，确认关系为 enables

## Phase 4：反思与进化

### Task R1：ReflectionEngine 反思引擎
- [x] `electron/ai/ReflectionEngine.ts` 存在，导出 `reflect(weekStart)`
- [x] 输入：weekly_patterns + user_profile + causal_chains
- [x] 输出：反思报告 `{ patterns, suggestions, trends }`
- [x] `electron/db/schema.ts` 新增 `reflection_reports` 表
- [x] 触发：每周一 WeeklyPatternDetector 完成后，或用户主动触发
- [x] 构造"下午碎片化"模式，确认反思报告含改进建议

### Task R2：SkillEvolver 技能进化
- [x] `electron/ai/SkillEvolver.ts` 存在，导出 `evolveSkills()`
- [x] 输入：MemScene 中成员 ≥3 的主题
- [x] 输出：技能卡 `{title, steps, traps, insights, source_cell_ids, confidence}`
- [x] AI 从同主题 MemCell 提炼 SOP
- [x] `electron/db/schema.ts` 新增 `skills` 表
- [x] 触发：每周 ReflectionEngine 完成后
- [x] 构造 3 个"数据库迁移"主题 MemCell，确认生成技能卡

### Task R3：FeedbackLoop 反馈回流
- [x] `electron/ai/FeedbackLoop.ts` 存在，导出 `recordFeedback`/`applyFeedback`
- [x] FeedbackEvent 类型覆盖：episode_renamed/wiki_rejected/report_edited
- [x] `electron/db/schema.ts` 新增 `feedback_events` 表
- [x] EpisodeBuilder/WikiIngestManager/ReportGenerator 在用户编辑时调用 `recordFeedback`
- [x] `applyFeedback` 分析反馈模式调整关键词权重
- [x] 模拟 3 次"推进文件编辑"被修改，确认"推进"权重降低

### Task R4：ProactiveAdvisor 主动建议
- [x] `electron/ai/ProactiveAdvisor.ts` 存在，导出 `checkAndAdvise()`
- [x] 建议触发规则：skill 匹配 / 连续 >2h 低效时段 / 重复碎片化模式
- [x] `MascotNotifier` 接收 advice 并推送
- [x] 节流：同一建议 4 小时内不重复
- [x] 构造当前活动匹配 skill 的场景，确认推送建议

## Phase 5：日报结构化升级

### Task RP1：ReportGenerator 结构化日报
- [x] `ReportTemplateDef` 新增 `structuredSections?: ReportSection[]`
- [x] 默认 sections 覆盖 12 类：butler_summary/what_i_did/what_i_saw/themes/timeline/chat_notes/web_notes/forum_notes/video_notes/product_notes/evidence/suggestions
- [x] `ReportGenerator` 输入增加 MemCell + MemScene + causal_chains 上下文
- [x] 分类要点基于 segment.contentType 分组生成
- [x] 证据片段从 MemCell.facts + segment.ocrText 提取
- [x] 优化建议从 ReflectionEngine 当周报告提取
- [x] `src/pages/Reports.tsx` 按 sections 分区渲染
- [x] 构造含聊天/网页/视频活动的一天，确认日报含对应分类要点章节

## Phase 6：验证

### Task V1：端到端验证脚本
- [x] `scripts/verify-perception-memory.ts` 存在
- [x] 构造 1 天多类型活动 segments（编码/聊天/浏览/视频/论坛）
- [x] 跑 ActivityClassifier + ContentClassifier + LayoutAnalyzer → 断言分类正确
- [x] 跑 EpisodeBuilder → 断言不同 activityType 不被误合并
- [x] mock OpenAIClient → 跑 DistillManager → 断言 MemCell 写入（含 episode/facts/foresight）
- [x] 跑 EmbeddingService → 断言向量生成；SemanticSearchRepository → 断言语义检索返回概念相似结果
- [x] 跑 MemSceneClusterer → 断言同主题归并、不同主题新建
- [x] 跑 DailyDistillManager → 断言日级摘要含跨小时主题
- [x] 跑 ReportGenerator → 断言日报含分类要点章节 + 证据片段
- [x] 脚本可通过 `npx tsx scripts/verify-perception-memory.ts` 运行

### Task V2：构建与类型验证
- [x] `npm run typecheck` 零错误
- [x] `npm run build` 成功
- [x] `npm run lint` 零警告（业务代码）

## Sprint 总体验收（对照 spec.md Requirement）

- [x] Requirement：活动类型识别（P1）
- [x] Requirement：内容类型分类与结构化提取（P2）
- [x] Requirement：浏览器 URL 采集（P3）
- [x] Requirement：UI 布局分析（P4）
- [x] Requirement：截图间操作流推断（P5）
- [x] Requirement：MemCell 结构化记忆原语（M1/M2）
- [x] Requirement：语义向量检索（M3/M4/M5）
- [x] Requirement：MemScene 主题自组织聚类（M6）
- [x] Requirement：用户画像演进（M7）
- [x] Requirement：层级化理解（日/周/月）（H1/H2）
- [x] Requirement：跨 Episode 因果链（H3）
- [x] Requirement：反思引擎（R1）
- [x] Requirement：技能进化（R2）
- [x] Requirement：反馈回流（R3）
- [x] Requirement：主动建议（R4）
- [x] Requirement：结构化日报（RP1）
- [x] MODIFIED：Episode 语义合并（activityType 感知）（P8）
- [x] MODIFIED：本地 OCR 推理（清洗后调用分类器）（P7）
- [x] MODIFIED：小时级 AI 理解（输出 MemCell）（M2）
- [x] MODIFIED：全文搜索（混合检索）（M5）
- [x] REMOVED：静态阈值告警被 ReflectionEngine 替代（R1）

## 兼听学习验收（对照 Windrecorder / EverOS）

### 从 Windrecorder 学习
- [x] 仅索引变化场景（已有 dHash 相似度合并，P7 增强分类）
- [x] 浏览器 URL 记录（P3 BrowserContextCollector）
- [x] 前台窗口进程名记录（已有 processName）
- [x] 活动统计/时间轴（已有 Episode 时间线，RP1 增强结构化）
- [x] 多模态搜索（M5 混合检索：关键词 + 语义向量）

### 从 EverOS 学习
- [x] MemCell 记忆原语 E+F+P+M（M1/M2）
- [x] 三阶段记忆生命周期：编码（M2）→巩固（M6）→检索（M5）
- [x] MemScene 主题自组织聚类（M6）
- [x] 用户画像演进（稳定特质 vs 瞬态状态）（M7）
- [x] 自进化技能 Case→聚类→Skill（R2）
- [x] mRAG 混合检索（M5）
- [x] 必要且充分检索原则（M5 混合分数排序）
- [x] 反思与改进建议（R1）
