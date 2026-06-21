# WorkMemory (今日记忆) 桌面工作记忆伙伴 Spec

> 范围说明：本 Spec 为 **V0.3 终极完全体设计**，实现产品规格说明书中的全部功能，拒绝任何妥协。所有功能必须提供完整闭环代码，不允许在代码中留下任何 `// TODO`、`// 后期实现` 或功能占位符。技术路线采用 **路线 B：Electron + React + Node**（文档指定的 MVP 首选且 AI Coding 契合度极佳），在此路线上实现全部 8 大功能模块、六层价值链路、5 种桌面伙伴形象、3 种日报模板、完整隐私防护与 Wiki 双链知识资产体系。团队/云同步/企业后台属产品定位明确排除项（"绝对不是监控软件"），不在范围内。

## Why

职场用户下班写日报或做周复盘时，常常想不起今天做了什么；工作碎片散落在 IM、文档、网页、编辑器之间，写出的汇报缺乏价值感与结构。同时用户对"被监控"和"隐私上传云端"高度焦虑，且担心大模型虚构工作成果。

WorkMemory 作为一款 **Windows 本地工作记忆与认知资产助手**，通过本地 OCR 自动整理当天电脑工作痕迹，并基于用户**勾选确认**的真实片段生成结构化、排版精美的日报/周报。它定位为个人 C 端单机版，绝对不是监控软件。

## What Changes

### 六层价值链路（全部实现）
1. **像素输入 (Capture/WindowWatcher)**：捕捉活跃窗口及低频关键帧。
2. **隐私防御 (PrivacyGuard)**：命中应用黑名单与敏感上下文时自动阻断截图。
3. **本地识别 (PP-OCRv6)**：在本地将屏幕图片转换为可搜索文本。
4. **语义降噪 (Segment/Episode)**：剔除重复像素，聚合成用户理解的事件。
5. **认知资产化 (Memory Wiki)**：提取人、事、文档双链，沉淀为知识页。
6. **主动洞察 (Insights/Reminders)**：自动异常检测，在下班/周五提供复盘建议。

### 8 大核心功能模块（全部实现）
1. **今日 (Today) 页**：三栏桌面布局核心看板。记录状态条（正在记录/已暂停/已保护）、今日一句话总结卡（可编辑）、垂直时间轴 Episode 卡片、原始 Segment 列表默认折叠。
2. **日历 (Calendar) 页**：月视图/周视图网格，单元格显示日期、工作时长估算、高产度小横条、日报状态标记。点击日期右侧面板展示该日一句话故事及重点事件。
3. **搜索 (Search) 页**：自然语言语义搜索。结果呈现最佳匹配 Episode、关联事件链、关联实体，右侧高亮匹配原因（OCR 命中、项目标签等），非简单列表。
4. **洞察 (Insights) 页**：时间审计看板。统计各项目、联系人及工作类型（沟通/文档/开发/杂务）时间分布；异常和效率洞察（如"今日窗口切换 73 次，建议合并碎片"）。
5. **知识库 (Wiki) 页**：`[[wikilink]]` 双链沉淀中心。页面含一句话、当前进展、关键事实、待确认及反链。左侧目录按人/项目/需求/客户分类。含 Review Queue 审核队列。
6. **关系图谱 (Graph) 页**：记忆导图。展示选定日期或项目下人/事/文档/Wiki 页/报告节点关联，节点颜色区分，支持点击穿透和框选导出。
7. **报告 (Reports) 页**：日报、周报与复盘中心。富文本编辑、复制及 Markdown/Word/JSON 导出。显示报告生成历史记录。
8. **设置 (Settings) 页**：开机自启、保存截图天数限制、本地 OCR 模型选择（tiny/small）、API Key 配置、敏感黑名单、桌面伙伴样式、数据一键瘦身/清空。

### 智能截图与降噪合并算法（全部实现）
- **CaptureDecision**：事件驱动 + ImageHash + Text Similarity 判定，合并或新建 WorkSegment。
- **截图频率约束**：快速切换节流（2 秒内频繁切换暂缓，等稳定 3 秒）、静止阅读降频（仅滚动停止后捕捉）、空闲检测（3 分钟无操作标记 `idle` 停止队列）。
- **EpisodeBuilder**：时间连续性（<5min）+ 语义相似度 + 应用频繁切换融合；一句话总结用户编辑后 `userEdited: true` 永不覆盖。

### 隐私防护中心（全部实现）
- 应用级/进程级/窗口标题黑名单。
- `skip`（完全跳过）与 `placeholder`（隐私占位 `[14:15 - 14:22 隐私窗口被保护]` + 紫色小锁标识）两种过滤表现。
- 无痕模式感知（Chrome/Edge/Firefox Incognito/Private）→ 桌面伙伴遮眼拉帘 + 切入隐私模式。
- **绝不记录键盘输入**，仅记录窗口句柄切换、页面滚动、应用切换等宏观操作及屏幕 OCR。

### 本地 OCR 推理（全部实现）
- 默认 PP-OCRv6 Tiny，C++ 编译动态链接库，CPU 多线程优化。
- 截图文字较少时单核推理，最大耗时 ≤300ms。
- 空闲超 10 秒立即释放显存和垃圾堆内存，常驻 CPU 降为 0%。

### 日报/周报生成工作流（全部实现）
- **AI 上传确认面板**：安全提示（仅发送勾选文本摘要，不发送截图）、发送大模型与模型名、估算字符数、可勾选 Episode 片段、用户备注框。
- **3 种预置模板**：汇报优化版（杂事改写为具商业价值表达）、简洁客观版（项目/用时/产出列表）、OKR 对齐版（按 OKR 进度归纳）。
- **模板渲染语法**：`{{timeline}}`、`{{user_notes}}`、`{{project_tags}}` 占位符。
- **导出**：Markdown / Word / JSON，`reports` 表记录历史。

### 桌面伙伴 Mascot（全部实现）
- **5 种内置形象**：小记（默认，便签卡片折角呼吸灯）、胶片（复看风，齿轮指示标）、副驾驶（技术风，戴耳麦工作台）、极简光标（极简风，半透明状态光点）、纸页精灵（文档风，折纸小精灵抱信封）。
- **交互**：左键单击（今日一句话总结气泡，再点跳转今日页）、右键双击（隐藏至托盘）、右键单击（快捷上下文菜单）、拖拽边缘吸附（贴边 + 半透明 50%）。
- **频率限制硬约束**：主动气泡每天最多 2 次；10 分钟内连续 3 次关闭则当天停止主动气泡，仅显示表情动作。

### Wiki 自动提取与人工审核（全部实现）
- 高价值信号识别（反复撰写/修改某文档或重复搜索某主题 → Ingest 候选源）。
- Review Queue 审核队列：卡片询问是否沉淀为 Wiki 页，用户预览 Markdown 后确认才写入。

### 数据模型与存储（全部实现）
- TypeScript 类型：`WorkSegment`、`Episode`、`EntityRef`、`WikiPage`。
- SQLite 5 张表：`segments`、`episodes`、`wiki_pages`、`reports`、`privacy_rules`。

### 视觉设计治理硬约束（全部实现）
- 无套壳感：无边框定制窗口 + 自定义最小化/最大化/关闭按钮，禁止系统默认 Chrome 和低质网页滚动条。
- Fluent Design 亚克力材质（侧边栏、详情面板、桌面伙伴背景）+ 窗口阴影 `0px 4px 16px rgba(0,0,0,0.1)`。
- 圆角：卡片/弹窗/气泡 `8px`，按钮 `6px`。
- 间距系统：`4px` / `8px` / `12px` / `16px` / `24px` / `32px`。

### 明确不做（产品定位排除，非妥协）
- **BREAKING（产品定位）**：不做团队日报聚合、云同步、企业后台、老板查看面板（"绝对不是监控软件"）。
- 不做键盘监听（产品原则硬约束）。
- 不做长期原始截图保存（默认 OCR 后即删，可选保存最多 7 天）。
- 不做 Tauri 重构（属文档定义的"第二阶段"技术债务优化，非功能缺失；本 Spec 在 Electron 路线上实现全部功能完全体）。

## Impact
- Affected specs: 无（全新项目，工作区为空）。
- Affected code: 全新代码库。建议目录结构：
  - `electron/main/` — 主进程、无边框窗口管理、托盘
  - `electron/capture/` — WindowWatcher、CaptureDecision、PrivacyGuard、EpisodeBuilder
  - `electron/ocr/` — PP-OCRv6 本地推理封装（Node native addon 或子进程 + C++ DLL）
  - `electron/db/` — SQLite schema、迁移、访问层（5 张表）
  - `electron/ai/` — OpenAI-compatible 客户端、模板渲染、确认面板后端
  - `electron/mascot/` — 桌面伙伴窗口、5 种形象、频率限制器
  - `src/` — React 渲染进程
  - `src/pages/` — Today / Calendar / Search / Insights / Wiki / Graph / Reports / Settings 8 大页面
  - `src/components/` — 三栏布局、卡片、时间轴、Wiki 双链编辑器、图谱可视化、Mascot 渲染、AI 确认面板
  - `src/store/` — 状态管理（记录状态、当前选中片段、Wiki、图谱等）
  - `src/design-system/` — 间距/圆角/亚克力材质设计 token
- 关键外部依赖：PP-OCRv6（本地 OCR，C++ DLL）、OpenAI-compatible API（用户自有 Key）、better-sqlite3（SQLite 绑定）、图谱可视化库、富文本/Markdown 编辑器。

## ADDED Requirements

### Requirement: 窗口捕捉与截图决策 (CaptureDecision)
系统 SHALL 在事件驱动下捕捉活跃窗口画面，并通过相似度判定避免高频垃圾截图。

#### Scenario: 窗口切换触发截图
- **WHEN** 用户切换活跃窗口或窗口标题改变
- **THEN** 系统等待窗口稳定 3 秒后抓取一帧临时截图
- **AND** 计算局部 ImageHash 与前一截图比较
- **AND** 若相似则合并至前一片段并更新其结束时间，不创建新 Segment

#### Scenario: 快速切换节流
- **WHEN** 用户在 2 秒内频繁切换窗口
- **THEN** 系统暂缓截图，等待窗口稳定 3 秒后再截取最终画面

#### Scenario: 静止阅读降频
- **WHEN** 用户在长网页或文档中静止阅读
- **THEN** 系统不截图
- **AND** 仅在页面滚动并停止后捕捉一帧新画面

#### Scenario: 空闲检测
- **WHEN** 鼠标与键盘持续 3 分钟无操作
- **THEN** 系统标记状态为 `idle`，立即停止截图和 OCR 队列
- **AND** 直到重新检测到用户活跃才恢复

#### Scenario: 截图默认不长期保存
- **WHEN** 本地 OCR 提取文字完成
- **THEN** 系统删除物理临时截图
- **AND** 仅当用户在设置中开启"保存截图"时，按配置天数（最多 7 天）保留

### Requirement: 隐私防护中心 (PrivacyGuard)
系统 SHALL 在截图前进行隐私判断，命中规则时按配置执行跳过或占位，且绝不记录键盘输入。

#### Scenario: 命中应用/进程黑名单完全跳过
- **WHEN** 活跃应用命中应用级黑名单，或进程命中进程级黑名单（如 `KeePass.exe`、`Bitwarden.exe`）
- **THEN** 系统执行 `skip`，彻底不做任何动作，不截图不 OCR

#### Scenario: 命中窗口标题关键词生成占位符
- **WHEN** 窗口标题包含"银行、网银、密码、支付、身份证、医疗、无痕模式、Incognito"等关键词
- **THEN** 系统执行 `placeholder`，截图为空、OCR 为空
- **AND** 仅记录 `[14:15 - 14:22 隐私窗口被保护]`
- **AND** 在时间轴上展示紫色小锁标识以防时间统计断层

#### Scenario: 无痕模式感知
- **WHEN** 检测到 Chrome/Edge/Firefox 开启了 Incognito 或 Private 隐私浏览窗口
- **THEN** 桌面伙伴立即进入遮眼拉帘动作
- **AND** 系统切入隐私模式

#### Scenario: 不记录键盘输入
- **WHEN** 系统运行期间
- **THEN** 系统 SHALL NOT 实施任何键盘监听
- **AND** 仅记录窗口句柄切换、页面滚动、应用切换等宏观操作及屏幕文字 OCR

### Requirement: 本地 OCR 推理 (PP-OCRv6)
系统 SHALL 在本地完成 OCR，默认使用 PP-OCRv6 Tiny，并控制资源占用以避免前台卡顿。

#### Scenario: 轻量推理性能约束
- **WHEN** 截图文字较少时
- **THEN** 系统限制使用单核推理
- **AND** 最大耗时不超过 300ms

#### Scenario: 空闲内存清理
- **WHEN** OCR 引擎完成一批处理队列后空闲超过 10 秒
- **THEN** 系统立即释放显存和垃圾堆内存
- **AND** 常驻 CPU 消耗降为 0%

#### Scenario: OCR 模型可选
- **WHEN** 用户在设置中选择 OCR 模型
- **THEN** 可选 tiny 或 small 两种本地模型

### Requirement: Episode 语义合并 (EpisodeBuilder)
系统 SHALL 将连续的 Segment 片段合成人类可理解的 Episode 工作事件，并生成今日一句话总结。

#### Scenario: 时间连续性合并
- **WHEN** 相邻两个 Segment 之间时间差小于 5 分钟
- **AND** 语义相似度达标（OCR 关键词高度一致或窗口标题含相同任务单号）
- **THEN** 系统将两者合并为同一 Episode

#### Scenario: 应用频繁切换融合
- **WHEN** 用户短时间内高频切换多个应用（如浏览器查文档 → IM 确认 → 编辑器写码）
- **AND** 关键词指向同一主题
- **THEN** 系统融合成一个以主题命名的 Episode（如"推进订单退款需求开发及接口确认"）

#### Scenario: 用户编辑不可覆盖
- **WHEN** 用户双击手动改写一句话总结
- **THEN** 系统标记 `userEdited: true`
- **AND** 此后的自动更新机制 SHALL NOT 覆盖或篡改用户手动编辑的内容

### Requirement: 今日 (Today) 页
系统 SHALL 提供三栏桌面布局的今日看板，作为核心工作区。

#### Scenario: 展示记录状态
- **WHEN** 用户打开今日页
- **THEN** 顶部状态条显示"正在记录/已暂停/已保护"当前状态
- **AND** 展示今日一句话总结卡（支持双击编辑）
- **AND** 展示垂直时间轴排列的 Episode 卡片
- **AND** 原始 Segment 片段列表默认折叠

#### Scenario: 用户可控操作
- **WHEN** 用户在今日页操作
- **THEN** 可一键暂停记录、切换隐私模式、勾选片段参与日报、删除片段、标为重点

### Requirement: 日历 (Calendar) 页
系统 SHALL 提供月/周视图网格作为记忆入口。

#### Scenario: 日历网格展示
- **WHEN** 用户打开日历页
- **THEN** 每个单元格显示日期、工作时长估算、高产度小横条、日报状态标记
- **AND** 点击特定日期在右侧面板展示该日一句话故事及重点事件

### Requirement: 搜索 (Search) 页
系统 SHALL 提供自然语言语义搜索，结果以最佳匹配 + 关联链 + 匹配原因呈现，而非简单列表。

#### Scenario: 语义搜索结果
- **WHEN** 用户输入自然语言查询（如"上周四下午和李明沟通退款接口"）
- **THEN** 呈现最佳匹配 Episode、关联事件链、关联实体
- **AND** 右侧高亮显示匹配原因（OCR 命中、项目标签等）

### Requirement: 洞察 (Insights) 页
系统 SHALL 提供时间审计看板。

#### Scenario: 时间分布统计
- **WHEN** 用户打开洞察页
- **THEN** 统计各项目、联系人及工作类型（沟通/文档/开发/杂务）的时间分布
- **AND** 提供异常和效率洞察（如"今日窗口切换 73 次，建议合并碎片"）

### Requirement: Wiki 知识库页
系统 SHALL 提供知识双链沉淀中心，含 Review Queue 审核队列。

#### Scenario: Wiki 双链编辑
- **WHEN** 用户在 Wiki 页编辑
- **THEN** 支持 `[[wikilink]]` 双链
- **AND** 页面包含一句话、当前进展、关键事实、待确认及反链
- **AND** 左侧目录按人/项目/需求/客户分类

#### Scenario: Review Queue 审核
- **WHEN** 系统识别高价值 Ingest 候选源（用户反复撰写/修改某文档或重复搜索某主题）
- **THEN** 在 Wiki 侧边栏 Review Queue 展示卡片询问是否沉淀为 Wiki 页
- **AND** 用户预览由本地 AI/规则提炼的 Markdown Wiki 后确认才写入

### Requirement: 关系图谱 (Graph) 页
系统 SHALL 提供记忆导图可视化。

#### Scenario: 图谱展示与交互
- **WHEN** 用户打开图谱页
- **THEN** 展示选定日期或项目下，人/事/文档/Wiki 页/报告节点之间的关联
- **AND** 节点通过颜色区分
- **AND** 支持点击穿透和框选导出

### Requirement: 报告 (Reports) 页
系统 SHALL 提供日报、周报与复盘中心，含富文本编辑、复制及多格式导出。

#### Scenario: 报告生成与编辑
- **WHEN** 用户在报告页
- **THEN** 支持富文本编辑、复制
- **AND** 可导出 Markdown / Word / JSON
- **AND** 显示报告生成历史记录

### Requirement: 日报生成工作流
系统 SHALL 在调用 AI 生成日报前展示确认面板，仅发送用户勾选的文本摘要，并严格基于真实片段生成，禁止虚构。

#### Scenario: AI 上传确认面板
- **WHEN** 用户点击"生成今日日报"
- **THEN** 系统展示确认面板，包含：安全提示（仅发送勾选文本摘要，不发送截图）、发送大模型与模型名、估算发送字符数、可勾选的 Episode 片段列表、用户备注输入框
- **AND** 用户点击"确认生成日报"后才调用 AI

#### Scenario: 内容真实不虚构
- **WHEN** AI 归纳和表达增强
- **THEN** 系统 SHALL 严格基于用户选择和勾选的真实片段
- **AND** SHALL NOT 在日报/周报中虚构任何未发生的事项

#### Scenario: 模板系统
- **WHEN** 用户选择日报模板
- **THEN** 可选"汇报优化版"（将杂事改写为具商业价值的表达）、"简洁客观版"（项目/用时/产出列表）、"OKR 对齐版"（按 OKR 进度归纳）
- **AND** 模板使用 `{{timeline}}`、`{{user_notes}}`、`{{project_tags}}` 占位符拼接提示词

#### Scenario: 导出
- **WHEN** 日报生成完成
- **THEN** 用户可复制、导出为 Markdown / Word / JSON
- **AND** 系统在 `reports` 表记录生成历史

### Requirement: 桌面伙伴 (Mascot)
系统 SHALL 提供 5 种内置形象的桌面伙伴作为系统状态的人格化呈现，严格控制视觉打扰频次。

#### Scenario: 5 种内置形象
- **WHEN** 用户在设置或右键菜单选择伙伴形象
- **THEN** 可选：小记（默认，便签卡片折角呼吸灯，商务沉稳）、胶片（复看风，齿轮指示标）、副驾驶（技术风，戴耳麦工作台）、极简光标（极简风，半透明状态光点）、纸页精灵（文档风，折纸小精灵抱信封）

#### Scenario: 默认形象与交互
- **WHEN** 系统启动
- **THEN** 桌面伙伴以默认"小记"形象呈现
- **AND** 左键单击触发"今日一句话总结"悬浮气泡，再次点击跳转主窗口今日页
- **AND** 右键单击弹出快捷上下文菜单（打开今日页/一键暂停/隐私模式/灵感捕捉/生成日报/设置/选择形象）
- **AND** 右键双击隐藏至托盘
- **AND** 拖拽后松开自动贴边并降低半透明度至 50%

#### Scenario: 频率限制硬约束
- **WHEN** 系统准备主动弹出气泡
- **THEN** 每天最多弹出 2 次
- **AND** 若用户在 10 分钟内连续 3 次关闭弹出的气泡，当天停止所有主动气泡弹出
- **AND** 仅显示伙伴表情动作（如递出小信封），不展示任何文字弹框

### Requirement: 本地数据存储 (SQLite)
系统 SHALL 使用 SQLite 本地存储，包含 `segments`、`episodes`、`wiki_pages`、`reports`、`privacy_rules` 五张表。

#### Scenario: segments 表
- **WHEN** 系统创建原始窗口及 OCR 数据
- **THEN** 存入 `segments` 表，核心字段：`id`, `date`, `start_time`, `end_time`, `app_name`, `process_name`, `window_title`, `ocr_text`, `ocr_summary`, `image_hash`, `screenshot_path`, `is_selected_for_report`, `is_private`, `is_important`, `is_deleted`, `source_status`, `user_title`, `user_summary`, `user_note`, `tags`

#### Scenario: episodes 表
- **WHEN** EpisodeBuilder 聚合片段
- **THEN** 存入 `episodes` 表，核心字段：`id`, `date`, `start_time`, `end_time`, `title`, `one_line_summary`, `segment_ids` (JSON array), `entities`, `topics`, `user_edited`, `report_eligible`, `wiki_eligible`

#### Scenario: wiki_pages 表
- **WHEN** Wiki 页确认写入
- **THEN** 存入 `wiki_pages` 表，核心字段：`id`, `type`, `title`, `aliases` (JSON), `content` (Markdown), `sources`, `backlinks`, `confidence`, `review_status`, `created_at`, `updated_at`

#### Scenario: reports 表
- **WHEN** 日报/周报生成
- **THEN** 存入 `reports` 表，核心字段：`id`, `date`, `template_id`, `template_name`, `segment_ids`, `ai_input_snapshot`, `markdown_content`, `status` ("draft"/"exported")

#### Scenario: privacy_rules 表
- **WHEN** 用户配置隐私规则
- **THEN** 存入 `privacy_rules` 表，核心字段：`id`, `type` ("app_name"/"process_name"/"window_title"/"url"), `pattern` (包含/完全相等/正则), `enabled`

### Requirement: 视觉设计治理
系统 SHALL 严格执行视觉设计硬约束，颜值作为核心战略竞争力。

#### Scenario: 无套壳窗口
- **WHEN** 应用窗口渲染
- **THEN** 使用无边框定制窗口 + 自定义最小化/最大化/关闭按钮
- **AND** 禁止使用系统默认窗口 Chrome 和低质网页滚动条

#### Scenario: Fluent 材质与圆角
- **WHEN** 渲染侧边栏、右侧详情面板、桌面伙伴背景
- **THEN** 使用高保真 Fluent 亚克力（Acrylic）半透明材质
- **AND** 配合轻柔窗口阴影 `0px 4px 16px rgba(0,0,0,0.1)`
- **AND** 卡片/弹窗/气泡采用 `8px` 圆角，按钮采用 `6px` 圆角

#### Scenario: 间距设计系统
- **WHEN** 布局 UI 控件
- **THEN** 严格使用 `4px`（极小元素）/ `8px`（组件内部）/ `12px`（卡片内衬）/ `16px`（区块卡片）/ `24px`-`32px`（页面主干分栏）间距

### Requirement: 设置 (Settings) 页
系统 SHALL 提供完整设置入口。

#### Scenario: 设置项
- **WHEN** 用户打开设置页
- **THEN** 可配置：开机自启、保存截图天数限制、本地 OCR 模型选择（tiny/small）、API Key 配置、敏感黑名单、桌面伙伴样式、数据一键瘦身/清空

### Requirement: 完全闭环无占位符
系统 SHALL 提供全部功能的完整闭环代码，拒绝任何妥协。

#### Scenario: 禁止占位符
- **WHEN** 代码实现任何功能
- **THEN** SHALL NOT 留下任何 `// TODO`、`// 后期实现`、`// FIXME`、功能占位符、mock 桩、空实现
- **AND** 所有 8 大模块、六层价值链路、5 种 Mascot、3 种模板、全部隐私规则、Wiki 双链、图谱、Review Queue 均提供真实可用实现
