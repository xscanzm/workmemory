# Tasks

> 全部任务必须提供完整闭环实现，禁止任何 `// TODO`、`// 后期实现`、占位符、mock 桩、空实现。

## 阶段 0：工程脚手架与设计系统

- [x] Task 0.1：初始化 Electron + React + TypeScript 工程
  - [x] 配置 Vite + React + TypeScript 渲染进程
  - [x] 配置 Electron 主进程入口与 preload 安全上下文
  - [x] 配置 electron-builder 打包（Windows nsis）
  - [x] 配置 ESLint / Prettier / TypeScript 严格模式
- [x] Task 0.2：建立设计系统 token
  - [x] 间距 token：`4/8/12/16/24/32px`
  - [x] 圆角 token：卡片 `8px`、按钮 `6px`
  - [x] 阴影 token：`0px 4px 16px rgba(0,0,0,0.1)`
  - [x] Fluent 亚克力材质样式（侧边栏、详情面板、Mascot 背景）
  - [x] 自定义滚动条样式（替换系统默认低质滚动条）
- [x] Task 0.3：无边框定制主窗口
  - [x] `frame: false` + 自定义最小化/最大化/关闭按钮
  - [x] 可拖拽标题栏区域
  - [x] 三栏布局骨架（Icon Sidebar / Main Workspace / Context Panel）

## 阶段 1：数据层与本地存储

- [x] Task 1.1：SQLite 数据库初始化与迁移
  - [x] better-sqlite3 集成，本地数据库文件路径管理
  - [x] `segments` 表建表与索引（date、image_hash、is_deleted）
  - [x] `episodes` 表建表与索引（date、segment_ids JSON）
  - [x] `wiki_pages` 表建表与索引（type、review_status）
  - [x] `reports` 表建表与索引（date、status）
  - [x] `privacy_rules` 表建表与索引（type、enabled）
  - [x] 迁移版本管理机制
- [x] Task 1.2：数据访问层（Repository）
  - [x] `SegmentRepository`：增删改查、按日期查询、勾选/重点/删除标记
  - [x] `EpisodeRepository`：增删改查、按日期查询、`userEdited` 保护逻辑
  - [x] `WikiRepository`：增删改查、双链反链维护、Review Queue
  - [x] `ReportRepository`：增删改查、历史记录
  - [x] `PrivacyRuleRepository`：增删改查、规则匹配引擎
- [x] Task 1.3：TypeScript 类型定义
  - [x] `WorkSegment`、`Episode`、`EntityRef`、`WikiPage` 完整类型
  - [x] IPC 通道类型定义（主进程 ↔ 渲染进程）

## 阶段 2：像素输入层（Capture）

- [x] Task 2.1：WindowWatcher 活跃窗口监听
  - [x] Windows API 获取前台窗口句柄、进程名、窗口标题
  - [x] 窗口切换/标题改变事件触发
  - [x] 页面滚动停止检测
  - [x] 停留满 5 分钟关键帧触发
- [x] Task 2.2：CaptureDecision 截图决策
  - [x] 快速切换节流（2 秒内频繁切换暂缓，等稳定 3 秒）
  - [x] 静止阅读降频（仅滚动停止后捕捉）
  - [x] 空闲检测（3 分钟无操作标记 `idle` 停止队列）
  - [x] 局部 ImageHash 计算与相似度比对
  - [x] 文本相似度比对（OCR 后）
  - [x] 合并至前一片段 vs 新建 WorkSegment 决策
- [x] Task 2.3：屏幕截图采集
  - [x] 活跃窗口区域截图
  - [x] 临时截图文件管理（OCR 后默认删除）
  - [x] 可选保存截图（按设置天数，最多 7 天）+ 过期清理

## 阶段 3：隐私防御层（PrivacyGuard）

- [x] Task 3.1：隐私规则匹配引擎
  - [x] 应用级黑名单匹配（app_name）
  - [x] 进程级黑名单匹配（process_name，如 KeePass.exe、Bitwarden.exe）
  - [x] 窗口标题关键词匹配（银行/网银/密码/支付/身份证/医疗/无痕模式/Incognito）
  - [x] URL 黑名单匹配
  - [x] 匹配模式：包含 / 完全相等 / 正则
- [x] Task 3.2：过滤表现实现
  - [x] `skip`：完全跳过，不截图不 OCR
  - [x] `placeholder`：截图为空 OCR 为空，记录 `[14:15 - 14:22 隐私窗口被保护]`，时间轴紫色小锁标识
- [x] Task 3.3：无痕模式感知
  - [x] Chrome/Edge/Firefox Incognito/Private 窗口检测
  - [x] 触发桌面伙伴遮眼拉帘动作
  - [x] 系统切入隐私模式
- [x] Task 3.4：键盘不监听硬约束
  - [x] 代码审计确保无任何键盘钩子/监听代码
  - [x] 仅记录窗口句柄切换、页面滚动、应用切换宏观操作

## 阶段 4：本地识别层（PP-OCRv6）

- [x] Task 4.1：PP-OCRv6 本地推理封装
  - [x] C++ 编译 PP-OCRv6 Tiny 动态链接库
  - [x] Node native addon 或子进程加载
  - [x] CPU 多线程优化
  - [x] 截图文字较少时单核推理，最大耗时 ≤300ms
- [x] Task 4.2：OCR 队列与资源管理
  - [x] OCR 处理队列（与截图队列解耦）
  - [x] 空闲超 10 秒立即释放显存和垃圾堆内存
  - [x] 常驻 CPU 降为 0%
- [x] Task 4.3：OCR 模型可选
  - [x] tiny / small 两种本地模型切换
  - [x] 设置页模型选择联动

## 阶段 5：语义降噪层（Segment/Episode）

- [x] Task 5.1：EpisodeBuilder 语义合并
  - [x] 时间连续性合并（相邻 Segment 时间差 <5min）
  - [x] 语义相似度判定（OCR 关键词一致或窗口标题含相同任务单号）
  - [x] 应用频繁切换融合（多应用高频切换 + 同一主题 → 单一 Episode）
  - [x] Episode 标题与一句话总结生成
- [x] Task 5.2：今日一句话总结
  - [x] 系统自动生成今日一句话总结
  - [x] 用户双击手动改写
  - [x] `userEdited: true` 标记后自动更新永不覆盖
- [x] Task 5.3：实体提取
  - [x] 从 Episode 提取人、项目、文档、URL 实体（EntityRef）
  - [x] 实体与 Episode 关联存储

## 阶段 6：渲染进程 8 大页面

- [x] Task 6.1：今日 (Today) 页
  - [x] 记录状态条（正在记录/已暂停/已保护）
  - [x] 今日一句话总结卡（双击编辑）
  - [x] 垂直时间轴 Episode 卡片
  - [x] 原始 Segment 列表默认折叠
  - [x] 一键暂停/隐私模式/勾选日报/删除/标重点操作
- [x] Task 6.2：日历 (Calendar) 页
  - [x] 月视图网格
  - [x] 周视图网格
  - [x] 单元格：日期、工作时长估算、高产度小横条、日报状态标记
  - [x] 点击日期右侧面板展示一句话故事及重点事件
- [x] Task 6.3：搜索 (Search) 页
  - [x] 自然语言语义搜索框
  - [x] 最佳匹配 Episode 卡
  - [x] 关联事件链
  - [x] 关联实体面板
  - [x] 右侧匹配原因高亮（OCR 命中/项目标签/时间匹配/人物提及）
- [x] Task 6.4：洞察 (Insights) 页
  - [x] 项目时间分布统计
  - [x] 联系人时间分布统计
  - [x] 工作类型（沟通/文档/开发/杂务）时间分布
  - [x] 异常洞察（窗口切换次数、碎片合并建议）
  - [x] 效率洞察
- [x] Task 6.5：知识库 (Wiki) 页
  - [x] `[[wikilink]]` 双链编辑器
  - [x] 页面结构：一句话、当前进展、关键事实、待确认、反链
  - [x] 左侧目录按人/项目/需求/客户分类
  - [x] Review Queue 审核队列卡片
  - [x] Wiki 预览与确认写入
- [x] Task 6.6：关系图谱 (Graph) 页
  - [x] 人/事/文档/Wiki 页/报告节点可视化
  - [x] 节点颜色区分
  - [x] 选定日期或项目范围筛选
  - [x] 点击穿透
  - [x] 框选导出
- [x] Task 6.7：报告 (Reports) 页
  - [x] 富文本编辑器
  - [x] 复制功能
  - [x] Markdown / Word / JSON 导出
  - [x] 报告生成历史记录列表
- [x] Task 6.8：设置 (Settings) 页
  - [x] 开机自启
  - [x] 保存截图天数限制（最多 7 天）
  - [x] 本地 OCR 模型选择（tiny/small）
  - [x] API Key 配置（OpenAI-compatible）
  - [x] 敏感黑名单管理（应用/进程/窗口标题/URL）
  - [x] 桌面伙伴样式选择
  - [x] 数据一键瘦身/清空

## 阶段 7：认知资产化层（Wiki 提取与审核）

- [x] Task 7.1：高价值信号识别
  - [x] 用户反复撰写/修改某项目文档检测
  - [x] 重复搜索某主题词检测（如"Tauri 编译配置"）
  - [x] Ingest 候选源标记
- [x] Task 7.2：Wiki 自动提取
  - [x] 本地 AI/规则提炼 Markdown Wiki
  - [x] 关键事实、更新点、双链标签提取
  - [x] 置信度评分
- [x] Task 7.3：Review Queue 审核流程
  - [x] Wiki 侧边栏 Review Queue 卡片展示
  - [x] "是否将以下 Episode 整理并沉淀为 [[xxx]] Wiki 页？"
  - [x] 用户预览 Markdown Wiki
  - [x] 确认后才写入 `wiki_pages` 表
- [x] Task 7.4：双链与反链维护
  - [x] `[[wikilink]]` 解析与目标页查找
  - [x] backlinks 反向链接自动维护
  - [x] 断链提示

## 阶段 8：主动洞察层（Insights/Reminders）

- [x] Task 8.1：时间审计统计引擎
  - [x] 按项目/联系人/工作类型聚合时间
  - [x] 工作类型分类规则（沟通/文档/开发/杂务）
- [x] Task 8.2：异常检测
  - [x] 窗口切换次数异常（如 73 次）
  - [x] 碎片化工作检测
  - [x] 合并建议生成
- [x] Task 8.3：复盘建议触发
  - [x] 下班时段检测
  - [x] 周五复盘建议
  - [x] 主动洞察推送（受 Mascot 频率限制约束）

## 阶段 9：日报/周报生成工作流

- [x] Task 9.1：AI 上传确认面板
  - [x] 安全提示（仅发送勾选文本摘要，不发送截图）
  - [x] 发送大模型与模型名显示
  - [x] 估算发送字符数
  - [x] 可勾选 Episode 片段列表
  - [x] 用户备注输入框
  - [x] 取消返回 / 确认生成日报按钮
- [x] Task 9.2：3 种预置模板
  - [x] 汇报优化版（杂事改写为具商业价值表达）
  - [x] 简洁客观版（项目/用时/产出列表）
  - [x] OKR 对齐版（按 OKR 进度归纳）
- [x] Task 9.3：模板渲染引擎
  - [x] `{{timeline}}`、`{{user_notes}}`、`{{project_tags}}` 占位符拼接
  - [x] 提示词模板构建
- [x] Task 9.4：OpenAI-compatible 客户端
  - [x] 用户自有 API Key 调用
  - [x] 请求/响应处理
  - [x] 错误处理与重试
- [x] Task 9.5：内容真实不虚构约束
  - [x] AI 提示词强约束（仅基于勾选片段）
  - [x] 生成结果与原片段交叉校验
- [x] Task 9.6：导出与历史
  - [x] Markdown 导出
  - [x] Word 导出
  - [x] JSON 导出
  - [x] `reports` 表历史记录

## 阶段 10：桌面伙伴（Mascot）

- [x] Task 10.1：Mascot 独立窗口
  - [x] 透明无边框置顶窗口
  - [x] 拖拽与边缘吸附（贴边 + 半透明 50%）
- [x] Task 10.2：5 种内置形象实现
  - [x] 小记（默认，便签卡片折角呼吸灯，商务沉稳）
  - [x] 胶片（复看风，齿轮指示标）
  - [x] 副驾驶（技术风，戴耳麦工作台）
  - [x] 极简光标（极简风，半透明状态光点）
  - [x] 纸页精灵（文档风，折纸小精灵抱信封）
- [x] Task 10.3：Mascot 交互
  - [x] 左键单击：今日一句话总结气泡，再点跳转今日页
  - [x] 右键双击：隐藏至托盘
  - [x] 右键单击：快捷上下文菜单（打开今日页/一键暂停/隐私模式/灵感捕捉 Ghost Capture/生成日报/设置/选择形象）
- [x] Task 10.4：频率限制器
  - [x] 主动气泡每天最多 2 次
  - [x] 10 分钟内连续 3 次关闭则当天停止主动气泡
  - [x] 仅显示表情动作（递出小信封），不展示文字弹框
- [x] Task 10.5：状态联动
  - [x] recording / paused / privacy / ocr_scanning / report_ready 状态表情
  - [x] 无痕模式遮眼拉帘动作
- [x] Task 10.6：系统托盘
  - [x] 托盘图标
  - [x] 托盘右键菜单

## 阶段 11：IPC 通信与状态管理

- [x] Task 11.1：IPC 通道完整定义
  - [x] 捕获/隐私/OCR/Episode 相关通道
  - [x] 数据查询/修改通道
  - [x] Wiki/报告/AI 相关通道
  - [x] Mascot/设置相关通道
- [x] Task 11.2：渲染进程状态管理
  - [x] 记录状态全局 store
  - [x] 当前选中片段/Episode store
  - [x] Wiki/图谱 store
  - [x] 设置 store

## 阶段 12：集成验证与收尾

- [x] Task 12.1：端到端闭环验证
  - [x] 捕获 → 隐私 → OCR → Episode → 今日页展示 完整链路
  - [x] 今日页 → 勾选 → AI 确认面板 → 日报生成 → 导出 完整链路
  - [x] Episode → Wiki Review Queue → 确认 → Wiki 页 → 双链反链 完整链路
  - [x] 搜索 → 匹配原因 → 关联链 完整链路
  - [x] 图谱 → 点击穿透 → 框选导出 完整链路
- [x] Task 12.2：代码审计
  - [x] 全局搜索 `TODO`/`FIXME`/`后期实现`/占位符，确保零残留
  - [x] 键盘监听代码审计，确保零残留
  - [x] 设计系统 token 使用审计
- [x] Task 12.3：打包验证
  - [x] electron-builder Windows nsis 打包
  - [x] 启动与基本功能冒烟测试

# Task Dependencies

- Task 0.*（脚手架与设计系统）为所有后续任务前置
- Task 1.*（数据层）为 Task 2/3/5/7/9 提供存储基础
- Task 2.*（Capture）依赖 Task 1.*、Task 3.*（隐私需在截图前判断）
- Task 3.*（PrivacyGuard）与 Task 2.* 协同，Task 10.5（无痕遮眼）依赖 Task 3.3
- Task 4.*（OCR）依赖 Task 2.*（截图产出）
- Task 5.*（Episode）依赖 Task 4.*（OCR 文本）
- Task 6.*（8 大页面）依赖 Task 1.*（数据层）与 Task 11.*（IPC/状态）
- Task 7.*（Wiki）依赖 Task 5.*（Episode）与 Task 1.*（wiki_pages 表）
- Task 8.*（Insights）依赖 Task 5.*（Episode）与 Task 10.*（Mascot 推送）
- Task 9.*（报告）依赖 Task 5.*（Episode）、Task 1.*（reports 表）
- Task 10.*（Mascot）依赖 Task 0.*（窗口）与 Task 11.*（状态）
- Task 11.*（IPC/状态）依赖 Task 1.* 与各业务模块接口稳定
- Task 12.*（集成验证）为最后阶段，依赖全部前置任务完成
