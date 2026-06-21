# 感知与记忆引擎进化 Spec

## Why

当前 WorkMemory 的核心能力停留在"截图 + OCR 文字 + 关键词聚类 + 小时级 AI 理解 + FTS5 检索"层面。距离用户期望的"真正能看见发生了什么、智能整理、反思进化"有本质差距：

- **感知层**：只看到"屏幕上有哪些字"，看不到"用户在做什么"——无 UI 结构识别、无操作流追踪、无图像语义、无 URL 采集、无活动类型分类。
- **记忆层**：只"存储 + 关键词检索"，不"自组织 + 反思 + 进化"——无语义向量检索、无跨时间因果链、无模式反思、无自我优化、无层级化理解（小时→日→周→月）。
- **整理层**：日报结构扁平，无法产出用户期望的"聊天/网页/论坛/视频/商品"分类要点、证据片段、优化建议等结构化输出。

本 Sprint 借鉴 Windrecorder（多模态屏幕记录 + 仅索引变化场景）与 EverOS（MemCell 结构化记忆 + 三阶段生命周期 + 自进化技能）的设计，分阶段将感知层从"文字"升级到"行为语义"，将记忆层从"存储"升级到"自组织 + 反思 + 进化"。

## What Changes

### Phase 1：感知增强 — 让"看见"从文字升级到行为语义
- 新增 `ActivityClassifier`：基于应用名 + 窗口标题 + OCR 文本模式，识别活动类型（coding/writing/reading/browsing/chatting/designing/meeting/managing/idle）
- 新增 `ContentClassifier`：识别内容类型（chat/webpage/document/code/video/forum/product/other）并提取结构化数据，支撑"聊天/网页/论坛/视频/商品"分类要点输出
- 新增 `BrowserContextCollector`：采集浏览器当前页面 URL（Chrome/Edge/Firefox），通过窗口标题解析 + 可选浏览器扩展双通道
- 新增 `LayoutAnalyzer`：基于已有 OCR 块坐标分布，识别 UI 布局类型（form/list/article/editor/chat/dashboard），区分"填表单"与"读文章"
- 新增 `ActionFlowInferrer`：分析相邻 segment 文本差异 + 时间间隔 + 应用切换，推断操作流（copy-paste/switch-context/scroll-deep/edit-continuous/browse-linear）
- 修改 `WorkSegment` 类型与 schema：新增 `activityType`、`contentType`、`contentData`（JSON）、`browserUrl`、`layoutType`、`actionFlow` 字段
- 修改 `OcrQueue.onOcrSuccess`：OCR 完成后调用上述分类器，丰富 segment 元数据
- 修改 `EpisodeBuilder`：聚类时考虑 activityType，避免"读代码文档"与"写代码"被误合并

### Phase 2：记忆结构化 — 借鉴 EverOS MemCell
- 新增 `MemCell` 记忆原语：结构 `{ episode: string, facts: string[], foresight: {statement, validFrom, validTo}[], metadata: {timestamp, sourceSegmentIds, confidence} }`
- 新增 `memory_cells` 表：存储 MemCell，与 `clean_episodes` 一对一关联（CleanEpisode 保留兼容，MemCell 是其上层结构化）
- 修改 `DistillManager`：AI 输出从扁平 CleanEpisode 升级为 MemCell（E+F+P+M），`DistillEventSchema` 扩展
- 新增 `EmbeddingService`：本地 ONNX embedding 模型（multilingual-e5-small 或 bge-small-zh），为 MemCell 生成语义向量
- 新增 `embeddings` 表：存储 `{id, memory_cell_id, embedding BLOB, model_version, created_at}`
- 新增 `SemanticSearchRepository`：余弦相似度查询，与现有 FTS5 混合检索（关键词 + 语义）
- 新增 `MemSceneClusterer`：增量聚类，新 MemCell 到来时与现有 MemScene 质心比较，相似度超阈值则归并，否则新建 MemScene
- 新增 `memory_scenes` 表：存储主题聚类 `{id, title, centroid_embedding, member_cell_ids, summary, updated_at}`
- 新增 `UserProfileEvolver`：从 MemScene 摘要提取稳定特质（偏好/习惯/技能）vs 瞬态状态（当前任务/情绪），每日更新
- 新增 `user_profile` 表：存储画像 `{key, value, type: stable|transient, confidence, updated_at, sources}`

### Phase 3：层级化理解 — 小时→日→周→月
- 新增 `DailyDistillManager`：在小时级 CleanEpisode 基础上聚合日级摘要 + 跨小时主题 + 模式
- 新增 `daily_distills` 表：存储日级理解结果
- 新增 `WeeklyPatternDetector`：分析近 7 天日级摘要，发现工作模式（深度工作时段/碎片化时段/常用应用组合/效率趋势）
- 新增 `weekly_patterns` 表：存储周级模式
- 新增 `CausalChainBuilder`：AI 推断跨 Episode 因果关系（A导致B / A阻塞B / A促进B），构建因果链网络
- 新增 `causal_chains` 表：存储因果关系 `{cause_cell_id, effect_cell_id, relation: leads_to|blocks|enables, confidence, evidence}`

### Phase 4：反思与进化
- 新增 `ReflectionEngine`：基于周级模式 + 用户画像，生成反思报告（发现的模式/问题/改进建议），每周或用户主动触发
- 新增 `SkillEvolver`：从重复 CleanEpisode（同主题 ≥3 次）提炼 SOP 技能卡（步骤/陷阱/关键洞察），借鉴 EverOS 的 Case→聚类→Skill 路径
- 新增 `skills` 表：存储技能卡 `{id, title, steps, traps, insights, source_cell_ids, confidence, evolved_at}`
- 新增 `FeedbackLoop`：捕获用户编辑（Episode 标题修改/Wiki 候选拒绝/日报编辑），回流调整算法参数（关键词权重/聚类阈值/动作映射）
- 新增 `feedback_events` 表：存储反馈事件 `{type, target_id, before, after, timestamp}`
- 新增 `ProactiveAdvisor`：检测到模式匹配时主动建议（"你在 A 任务上花了很多时间，上周有类似经验要参考吗"），通过桌面伙伴推送

### Phase 5：日报结构化升级
- 修改 `ReportGenerator`：日报输出结构升级为用户期望的分层结构（管家总结/今日做了什么/今日看了什么/主题归纳/时间线/聊天记录要点/网页记录要点/论坛记录要点/视频记录要点/商品记录要点/证据片段/优化建议）
- 修改 `ReportTemplateDef`：新增 `structuredSections` 配置，控制输出哪些分类要点
- 日报输入增加 MemCell + MemScene + 因果链上下文，让 AI 有更丰富的理解基础

### Phase 6：验证
- 新增端到端验证脚本：构造 1 小时多类型活动 segments（编码/聊天/浏览/视频），验证分类、聚类、检索、日报全链路
- 构建与类型验证：typecheck/build/lint 零错误

## Impact
- Affected specs: `workmemory-mvp`（基础架构）、`workmemory-v04-trust-beauty`（信任与美化）、`ocr-ai-pipeline-trust`（OCR/AI 管线可信化）
- Affected code:
  - 新增：`electron/capture/ActivityClassifier.ts`、`ContentClassifier.ts`、`BrowserContextCollector.ts`、`LayoutAnalyzer.ts`、`ActionFlowInferrer.ts`
  - 新增：`electron/memory/MemCell.ts`、`MemSceneClusterer.ts`、`UserProfileEvolver.ts`、`EmbeddingService.ts`、`SemanticSearchRepository.ts`
  - 新增：`electron/ai/DailyDistillManager.ts`、`WeeklyPatternDetector.ts`、`CausalChainBuilder.ts`、`ReflectionEngine.ts`、`SkillEvolver.ts`、`FeedbackLoop.ts`、`ProactiveAdvisor.ts`
  - 修改：`src/types/index.ts`（WorkSegment 新字段）、`electron/db/schema.ts`（6+ 新表）、`electron/db/migrations.ts`（v6 迁移）、`electron/ocr/OcrQueue.ts`（调用分类器）、`electron/capture/EpisodeBuilder.ts`（activityType 感知聚类）、`electron/ai/DistillManager.ts`（MemCell 输出）、`electron/ai/ReportGenerator.ts`（结构化日报）、`electron/db/repositories/SearchRepository.ts`（混合检索）
  - 修改：`src/pages/Reports.tsx`、`src/pages/Today.tsx`、`src/pages/Search.tsx`（展示新结构）

## ADDED Requirements

### Requirement: 活动类型识别
系统 SHALL 为每个 Segment 识别活动类型（coding/writing/reading/browsing/chatting/designing/meeting/managing/idle），基于应用名、窗口标题、OCR 文本模式综合判断。

#### Scenario: 编码活动识别
- **WHEN** 用户在 VS Code 中编辑代码，OCR 文本含 `function`/`const`/`import` 等代码关键词
- **THEN** segment.activityType = 'coding'，segment.contentType = 'code'

#### Scenario: 聊天活动识别
- **WHEN** 用户在微信/飞书/Slack 中，OCR 文本含对话气泡布局特征
- **THEN** segment.activityType = 'chatting'，segment.contentType = 'chat'，contentData 含参与者与消息摘要

#### Scenario: 浏览活动识别
- **WHEN** 用户在 Chrome 中浏览网页，窗口标题含页面标题
- **THEN** segment.activityType = 'browsing'，segment.contentType = 'webpage'，browserUrl 采集到当前页面 URL

### Requirement: 内容类型分类与结构化提取
系统 SHALL 为每个 Segment 识别内容类型（chat/webpage/document/code/video/forum/product/other），并提取类型特定的结构化数据。

#### Scenario: 聊天内容结构化
- **WHEN** contentType = 'chat'
- **THEN** contentData = `{ participants: string[], messageCount: number, keyMessages: string[], platform: string }`

#### Scenario: 网页内容结构化
- **WHEN** contentType = 'webpage'
- **THEN** contentData = `{ url: string, pageTitle: string, domain: string, keyParagraphs: string[] }`

#### Scenario: 视频内容结构化
- **WHEN** contentType = 'video'（检测到播放器控件/进度条/字幕）
- **THEN** contentData = `{ platform: string, title: string, duration: string, subtitles: string[] }`

### Requirement: 浏览器 URL 采集
系统 SHALL 采集 Chrome/Edge/Firefox 当前标签页 URL，通过窗口标题解析（标题含页面标题）作为主通道，可选浏览器扩展作为精确通道。

#### Scenario: Chrome URL 采集
- **WHEN** 前台窗口为 Chrome，标题为 "Windrecorder - GitHub - Google Chrome"
- **THEN** segment.browserUrl 解析为可能的 URL（基于标题匹配历史），或通过扩展获取精确 URL

#### Scenario: 隐私模式不采集
- **WHEN** 浏览器处于无痕模式
- **THEN** segment.browserUrl 为空，不采集 URL

### Requirement: UI 布局分析
系统 SHALL 基于已有 OCR 块坐标分布，识别 UI 布局类型（form/list/article/editor/chat/dashboard），区分用户交互场景。

#### Scenario: 表单布局识别
- **WHEN** OCR 块呈"标签 + 输入框"交替排列，且存在按钮文字
- **THEN** segment.layoutType = 'form'

#### Scenario: 文章布局识别
- **WHEN** OCR 块呈长段落连续排列，无交互元素
- **THEN** segment.layoutType = 'article'

### Requirement: 截图间操作流推断
系统 SHALL 分析相邻 Segment 的文本差异、时间间隔、应用切换模式，推断操作流类型。

#### Scenario: 复制粘贴推断
- **WHEN** segment A 的某段文本在 segment B 中出现，且 A/B 时间间隔 <2min
- **THEN** actionFlow = 'copy-paste'，记录源 segment 与目标 segment

#### Scenario: 深度编辑推断
- **WHEN** 连续 ≥3 个 segment 同应用同窗口，OCR 文本渐进变化
- **THEN** actionFlow = 'edit-continuous'

### Requirement: MemCell 结构化记忆原语
系统 SHALL 将 AI 理解结果结构化为 MemCell：`{ episode: 第三人称叙事, facts: 可验证事实列表, foresight: 带有效期的前瞻推断, metadata: 时间戳与来源 }`，借鉴 EverOS 设计。

#### Scenario: MemCell 生成
- **WHEN** DistillManager 完成小时级理解
- **THEN** 每个 CleanEpisode 对应一个 MemCell，episode 为"用户在 9:00-10:00 与团队评审 V0.4 Sprint 优先级"，facts 含"确认 OCR 容错为 P0"，foresight 含"V0.4 Sprint 将于下周启动，有效期至 2026-04-15"

#### Scenario: MemCell 检索
- **WHEN** 用户搜索"上次 Sprint 评审"
- **THEN** 返回匹配的 MemCell，高亮 episode 叙事与匹配的 facts

### Requirement: 语义向量检索
系统 SHALL 为每个 MemCell 生成本地语义向量（ONNX embedding 模型），支持余弦相似度查询，与 FTS5 关键词检索混合。

#### Scenario: 概念相似检索
- **WHEN** 用户搜索"前端组件开发"（但 MemCell 中用的是"UI 组件库实现"）
- **THEN** 语义检索返回"UI 组件库实现"MemCell（余弦相似度 >0.75），FTS5 无法匹配

#### Scenario: 混合检索
- **WHEN** 用户搜索"OCR 容错"
- **THEN** FTS5 精确匹配 + 语义相似匹配合并去重，按综合分数排序

### Requirement: MemScene 主题自组织聚类
系统 SHALL 对 MemCell 进行增量聚类，形成 MemScene 主题，相似 MemCell 归并到同一 MemScene，新主题创建新 MemScene。

#### Scenario: 主题归并
- **WHEN** 新 MemCell"编写 Button 组件"到来，已有 MemScene"UI 组件库开发"质心相似度 >0.8
- **THEN** 新 MemCell 归并到"UI 组件库开发"MemScene，更新质心与摘要

#### Scenario: 新主题创建
- **WHEN** 新 MemCell"数据库迁移脚本"到来，无相似 MemScene
- **THEN** 创建新 MemScene"数据库迁移"，质心为该 MemCell 向量

### Requirement: 用户画像演进
系统 SHALL 从 MemScene 摘要提取用户画像，区分稳定特质（偏好/习惯/技能）与瞬态状态（当前任务/情绪），每日更新。

#### Scenario: 稳定特质提取
- **WHEN** 连续 7 天 MemScene 含"编码"活动
- **THEN** user_profile 新增 `{key: 'primary_activity', value: 'coding', type: 'stable', confidence: 0.9}`

#### Scenario: 瞬态状态追踪
- **WHEN** 当日 MemScene 集中在"V0.4 Sprint 评审"
- **THEN** user_profile 新增 `{key: 'current_focus', value: 'V0.4 Sprint', type: 'transient', confidence: 0.8, validTo: '今日'}`

### Requirement: 层级化理解（日/周/月）
系统 SHALL 在小时级理解之上，聚合日级摘要、周级模式、月级主题，形成层级化理解。

#### Scenario: 日级理解
- **WHEN** 每日 23:00 或次日首次启动
- **THEN** DailyDistillManager 聚合当日所有 MemCell，输出日级摘要 + 跨小时主题 + 当日模式

#### Scenario: 周级模式发现
- **WHEN** 每周固定时间
- **THEN** WeeklyPatternDetector 分析近 7 天日级摘要，输出工作模式（深度工作时段/碎片化时段/常用应用组合/效率趋势）

### Requirement: 跨 Episode 因果链
系统 SHALL AI 推断跨 MemCell 因果关系（A导致B / A阻塞B / A促进B），构建因果链网络。

#### Scenario: 因果推断
- **WHEN** MemCell A"API Key 加密实现"与 MemCell B"safeStorage 文档查阅"时间相邻且主题相关
- **THEN** causal_chains 新增 `{cause: B, effect: A, relation: 'enables', confidence: 0.85}`

### Requirement: 反思引擎
系统 SHALL 基于周级模式 + 用户画像，生成反思报告，发现工作模式问题与改进建议。

#### Scenario: 模式发现问题
- **WHEN** 周级模式显示"每日 14:00-15:00 窗口切换次数异常 >50"
- **THEN** 反思报告输出"下午 2 点注意力碎片化严重，建议该时段关闭即时通讯工具"

#### Scenario: 改进建议生成
- **WHEN** 反思引擎发现"深度工作时长连续 3 周下降"
- **THEN** 输出"深度工作时长呈下降趋势，建议每天预留 2 小时无干扰时段"

### Requirement: 技能进化
系统 SHALL 从重复 MemCell（同主题 ≥3 次）提炼 SOP 技能卡，记录步骤、陷阱、关键洞察。

#### Scenario: 技能提炼
- **WHEN** 3 个以上 MemCell 主题为"数据库迁移"且成功完成
- **THEN** SkillEvolver 生成技能卡 `{title: '数据库迁移 SOP', steps: [...], traps: [...], insights: [...]}`

### Requirement: 反馈回流
系统 SHALL 捕获用户编辑（Episode 标题修改/Wiki 候选拒绝/日报编辑），回流调整算法参数。

#### Scenario: 标题修改反馈
- **WHEN** 用户将 Episode 标题从"推进文件编辑"修改为"订单退款方案评审"
- **THEN** feedback_events 记录修改，FeedbackLoop 调整 EpisodeBuilder 的关键词权重，降低"推进"权重

### Requirement: 主动建议
系统 SHALL 检测到模式匹配时，通过桌面伙伴主动推送建议。

#### Scenario: 经验参考建议
- **WHEN** 用户开始"数据库迁移"任务，且 skills 表有相关 SOP
- **THEN** ProactiveAdvisor 推送"你上周做过类似的数据库迁移，要参考当时的经验吗？"

### Requirement: 结构化日报
系统 SHALL 生成结构化日报，包含管家总结/今日做了什么/今日看了什么/主题归纳/时间线/聊天记录要点/网页记录要点/论坛记录要点/视频记录要点/商品记录要点/证据片段/优化建议。

#### Scenario: 分类要点输出
- **WHEN** 当日有聊天/网页/视频活动
- **THEN** 日报分别输出"聊天记录要点""网页记录要点""视频记录要点"章节，每章节含结构化摘要

## MODIFIED Requirements

### Requirement: Episode 语义合并（修改自 V0.4）
Episode 合并算法 SHALL 在原有时间连续性 + 关键词 Jaccard + 应用切换融合基础上，增加 activityType 感知：相同 activityType 的 segment 优先合并，不同 activityType（如"读代码文档"与"写代码"）即使关键词重叠也不合并。

### Requirement: 本地 OCR 推理（修改自 V0.4）
OCR 完成后 SHALL 调用 ActivityClassifier + ContentClassifier + LayoutAnalyzer + ActionFlowInferrer，丰富 segment 元数据，再交由 EpisodeBuilder 重建。

### Requirement: 小时级 AI 理解（修改自 ocr-ai-pipeline-trust）
DistillManager SHALL 输出 MemCell 结构（E+F+P+M）而非扁平 CleanEpisode，CleanEpisode 作为 MemCell 的兼容视图保留。

### Requirement: 全文搜索（修改自 V0.4）
SearchRepository SHALL 支持混合检索：FTS5 关键词匹配 + 语义向量余弦相似度，按综合分数排序返回。

## REMOVED Requirements

### Requirement: 静态阈值告警
**Reason**: AnomalyDetector 的静态阈值告警（窗口切换 >50 warning）无法发现真正的工作模式问题，被 ReflectionEngine 替代。
**Migration**: AnomalyDetector 保留作为 ReflectionEngine 的输入信号源之一，但不再直接向用户展示告警，改为喂给反思引擎生成有上下文的改进建议。
