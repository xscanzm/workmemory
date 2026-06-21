# Checklist — WorkMemory V0.4 Trust & Beauty Sprint

> 验收清单：对应 spec.md 全部 Requirement 与 tasks.md 全部任务。任何一项不通过即视为 Sprint 未完成。检查方法：Read 相关代码 + Grep 搜索 + 运行 typecheck/build + 构造场景验证。

## Phase A：可信可运行

### Task A0：环境与构建基线
- [x] node_modules 已安装（含 `--ignore-scripts` 绕过 native 编译）
- [x] `npm run typecheck`（tsc --noEmit）零错误
- [x] `npm run build`（vite build）成功
- [x] 新依赖已安装：zod、docx、lucide-react、@radix-ui/react-dialog、tooltip、popover、menu、switch、select

### Task A1：OCR 启动容错与 runtime 管理
- [x] `PpOcrEngine.selectBackend()` 无可用后端时返回 null + 状态 unconfigured，不抛错
- [x] `OcrManager.initialize()` 无后端时状态置"未配置"，不抛未捕获异常
- [x] 无后端时 OCR 队列暂停，segment.source_status 停留 'pending'
- [x] `OcrRuntimeManager` 实现检测后端类型/模型路径/healthCheck/testRecognize
- [x] IPC `ocr:getRuntimeStatus`、`ocr:testRecognize`、`ocr:openInstallDir` 注册且 preload 暴露
- [x] 删除 resources/ocr 内容后启动应用不崩溃
- [x] 设置页 OCR 区显示当前后端（PP-OCRv6/Tesseract/未配置）与模型路径
- [x] 设置页"测试 OCR"返回成功/失败原因
- [x] 设置页"打开 OCR 安装目录"可用

### Task A2：API Key 加密存储
- [x] `SettingsStore` API Key 改用 `safeStorage.encryptString`，存为 `apiKeyEncrypted` blob
- [x] `settings.json` 不含明文 apiKey 字段
- [x] `getApiKey()` 运行时解密返回
- [x] ReportGenerator/OpenAIClient 从 `getApiKey()` 取 key
- [x] Settings 页 API Key 输入框永不回填完整 key（掩码显示）
- [x] Settings 页"清空 API Key"按钮可用
- [x] 重启应用后 AI 调用仍可用
- [x] 清空 Key 后 AI 调用失败并提示
- [x] 全局日志不打印 apiKey（grep 零命中）
- [x] grep settings.json 不含 `sk-` 明文

### Task A3：截图降级策略修复
- [x] `Screenshot.captureActiveWindow()` 找不到目标窗口时返回 `{status:'failed'}`，不调用 captureScreen
- [x] `captureWindow(hwnd)` 失败返回失败状态
- [x] CaptureDecision 收到失败时跳过或标记 screenshot_failed
- [x] 设置项 `allowFullScreenshotFallback` 默认 false
- [x] 仅 allowFullScreenshotFallback=true 时允许整屏降级
- [x] 首次开启整屏降级弹风险提示
- [x] 多屏时明确屏幕范围
- [x] 无目标窗口时不产生整屏截图

### Task A4：IPC 入参 Zod schema 校验
- [x] `electron/ipc/schemas.ts` 为每个 IPC 通道定义 Zod schema
- [x] `validatedHandler` 高阶函数实现，自动校验入参
- [x] 所有 IPC handler 用 validatedHandler 包装
- [x] 非法 payload 被拒，返回 `{ok:false, error:'VALIDATION_ERROR', details}`
- [x] 删除 segment.insert/report.insert 直通通道（wiki.insert/privacyRule.insert/episode.insert 保留为合法业务 action）
- [x] 改为业务 action（segment.setImportant、wiki.confirmIngest、report.saveDraft 等）
- [x] renderer 无法直接硬删全部 Wiki/Report
- [x] `settings.set` 限制可写字段白名单
- [x] apiKey 走专门 `settings.setApiKey`
- [x] `system.saveFile` 限制扩展名白名单与文件名
- [x] 所有 handler 统一返回 `{ok, data?, error?}`

## Phase B：颜值第一落地

### Task B1：统一组件库 src/ui/
- [x] Button（variants/sizes/loading/icon slot，6px 圆角）
- [x] IconButton（内置 tooltip）
- [x] Card（8px 圆角、亚克力、阴影 token）
- [x] Dialog（Radix，8px 圆角、亚克力、esc、遮罩）
- [x] Toast（全局 store + portal）
- [x] SegmentedControl
- [x] Switch（Radix）
- [x] TextField（label + error）
- [x] Select（Radix）
- [x] Tooltip（Radix）
- [x] Badge（颜色变体）
- [x] Timeline
- [x] MemoryCard
- [x] index.ts 统一导出
- [x] icons.ts 统一 lucide-react 导出

### Task B2：核心组件迁移
- [x] TitleBar 用 Button/IconButton
- [x] IconSidebar 用 lucide 图标 + Tooltip
- [x] EpisodeCard 用 MemoryCard
- [x] SegmentList/StatusBar/ContextPanel/EmptyState 迁移
- [x] 页面内大段内联 `<style>` 移除

### Task B3：Today 与 Reports 重构
- [x] Today 信息层级：今日总结 + 记录状态 + 生成日报入口一眼可见
- [x] Today 用 MemoryCard/Timeline/Button/Badge
- [x] Reports AI 确认面板用 Dialog
- [x] Reports 历史列表用 Card
- [x] Reports 编辑区用 TextField
- [x] Reports 导出用 Button 组
- [x] 两页无文字溢出/布局拥挤
- [x] 两页无内联样式

### Task B4：其余 6 页迁移
- [x] Calendar 迁移到组件库
- [x] Search 迁移（文案改"记忆搜索"）
- [x] Insights 迁移
- [x] Wiki 迁移
- [x] Graph 迁移（节点上限 + 关系预览降级）
- [x] Settings 迁移

### Task B5：Mascot 视觉统一
- [x] 5 种形象统一描边/配色/状态语言
- [x] 5 形象 × 5 状态视觉一致

### Task B6：视觉验收基线
- [x] 5 Episode + 20 Segment 测试数据脚本
- [x] Today 截图对照设计治理（8px/6px 圆角、间距 token、亚克力、无溢出）
- [x] Reports 截图对照设计治理
- [x] Settings 截图对照设计治理

## Phase C：产品主链路打磨

### Task C1：富文本复制
- [x] `HtmlExporter` markdown → HTML（标题/列表/段落/粗体）
- [x] Reports 页"复制富文本"按钮
- [x] `clipboard.write({text, html})` 同时写 text/plain 与 text/html
- [x] 粘贴到 Word 保留排版
- [x] 粘贴到飞书保留排版

### Task C2：Word 导出 .docx
- [x] `ReportExporter.exportWord()` 用 docx 库生成真实 .docx
- [x] 标题用 HeadingLevel
- [x] 列表/段落格式正确
- [x] 旧 HTML .doc 方案移除
- [x] IPC `ai:exportWord` 返回 .docx buffer
- [x] Word 可打开 .docx

### Task C3：AI 上传确认面板增强
- [x] 每条 Episode 可展开预览发送文本
- [x] 可逐条删除（取消勾选）
- [x] 敏感词脱敏（手机号/邮箱/身份证号掩码）
- [x] 显示脱敏后字符数

### Task C4：日历 ↔ 报告联动
- [x] 日历点击日期右侧面板"查看当天日报"按钮（若已生成）
- [x] 点击跳转 Reports 页加载该日报告
- [x] 日历单元格日报状态标记与 reports 表联动

### Task C5：报告类型字段
- [x] reports 表新增 `report_type` 字段（daily/weekly/review）
- [x] 迁移脚本
- [x] Reports 页 P0 文案"日报中心"
- [x] 周报/复盘入口隐藏（未真实实现不显示）

## Phase D：高级能力降噪

### Task D1：搜索命名诚实化
- [x] Search 页所有"语义搜索"文案改为"记忆搜索"/"关键词 + 时间搜索"
- [x] 匹配原因 UI 显示 OCR/时间/项目/人物四类标签
- [x] `AiChannels.SemanticSearch` 空实现通道移除

### Task D2：SQLite FTS5
- [x] FTS5 虚拟表建立（fts_segments/fts_episodes/fts_wiki）
- [x] 触发器同步 insert/update/delete
- [x] Search 页改用 FTS5 MATCH 查询
- [x] 保留关键词 + 时间 + 实体多维匹配原因
- [x] 搜索结果可解释
- [x] 搜索性能提升

### Task D3：Wiki 自动提取草稿化
- [x] WikiExtractor confidence 计算
- [x] Review Queue 卡片展示置信度
- [x] Review Queue 卡片展示"为什么建议保存"
- [x] 自动生成一律 review_status='needs_review'
- [x] 低置信（<0.5）不进入默认选择

### Task D4：EntityExtractor 置信度
- [x] EntityRef 类型新增 confidence 字段
- [x] EntityExtractor 为每类实体计算 confidence
- [x] 低置信实体不进入 Wiki/报告默认选择
- [x] UI 支持用户确认/修正实体

### Task D5：图谱稳定性
- [x] Graph 节点数上限 100
- [x] 超过上限降级"关系预览"提示
- [x] 布局结果缓存（按筛选条件 hash）
- [x] 降级时文案"关系预览"

### Task D6：Insights 主动推送降噪
- [x] ReminderScheduler 默认低频（下班每天最多 1 次，周五每周 1 次）
- [x] 受 Mascot 频率限制器约束（每天 2 次上限）

## Phase V：集成验证与收尾

### Task V1：端到端闭环验证
- [x] 无 OCR runtime 启动不崩 → 配置 OCR → 识别中文截图
- [x] API Key 加密保存 → 重启可用 → 清空失败
- [x] 截图失败不整屏降级
- [x] IPC 非法 payload 被拒
- [x] 生成日报 → 复制富文本 → 粘贴 Word 保留排版
- [x] 导出 .docx → Word 打开格式正确
- [x] 搜索命名诚实 + FTS5 可解释
- [x] 图谱节点上限降级

### Task V2：代码审计
- [x] 全局搜索 TODO/FIXME/后期实现/占位/mock 零残留（业务代码）
- [x] 全局搜索键盘监听零残留
- [x] settings.json 不含明文 apiKey
- [x] 设计 token 使用审计通过

### Task V3：构建与类型
- [x] `npm run typecheck` 零错误
- [x] `npm run build` 成功
- [x] `npm run lint` 零警告（业务代码）

## Sprint 总体验收（对照审查报告 10 个 Requirement）

- [x] Requirement 1：无 OCR runtime 时正常启动（A1）
- [x] Requirement 2：API Key 加密保存（A2）
- [x] Requirement 3：禁止活跃窗口截图失败自动整屏（A3）
- [x] Requirement 4：IPC 入参校验（A4）
- [x] Requirement 5：报告复制支持富文本（C1）
- [x] Requirement 6：Word 导出 .docx（C2）
- [x] Requirement 7：UI 组件库替代内联样式（B1-B4）
- [x] Requirement 8：Today 页截图级验收（B3/B6）
- [x] Requirement 9：搜索能力命名诚实（D1）
- [x] Requirement 10：OCR runtime 管理页（A1）
