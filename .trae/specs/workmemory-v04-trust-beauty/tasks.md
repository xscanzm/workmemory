# Tasks — WorkMemory V0.4 Trust & Beauty Sprint

> 原则：收敛与加固，不新增大功能模块。每个任务必须真实可用、完整闭环，禁止 TODO/占位符/mock/空实现。依赖安装与 typecheck/build 通过是所有任务的前置。

## Phase A：可信可运行（P0 安全与可用性）

- [x] Task A0：环境与构建基线
  - [x] A0.1 `npm install`（含 `--ignore-scripts` 绕过 native 编译失败）恢复 node_modules
  - [x] A0.2 修复 `npm run typecheck`（tsc --noEmit）所有错误至零
  - [x] A0.3 修复 `npm run build`（vite build）至成功
  - [x] A0.4 安装新依赖：`zod`、`docx`、`lucide-react`、`@radix-ui/react-dialog`、`@radix-ui/react-tooltip`、`@radix-ui/react-popover`、`@radix-ui/react-menu`、`@radix-ui/react-switch`、`@radix-ui/react-select`

- [x] Task A1：OCR 启动容错与 runtime 管理
  - [x] A1.1 修改 `electron/ocr/PpOcrEngine.ts`：`selectBackend()` 无可用后端时不抛错，返回 `null` + 状态 `unconfigured`
  - [x] A1.2 修改 `electron/ocr/OcrManager.ts`：`initialize()` 容错，无后端时状态置"未配置"，不抛未捕获异常；OCR 队列暂停，segment.source_status 停留 'pending'
  - [x] A1.3 新增 `electron/ocr/OcrRuntimeManager.ts`：检测后端类型（PP-OCRv6/Tesseract/未配置）、模型路径、健康检查 `healthCheck()`、测试识别 `testRecognize(imagePath)` 返回 `{ok, text?, elapsedMs?, error?}`
  - [x] A1.4 IPC：`ocr:getRuntimeStatus`、`ocr:testRecognize`、`ocr:openInstallDir`
  - [x] A1.5 preload 暴露上述 API
  - [x] A1.6 验证：删除 resources/ocr 内容后启动应用不崩溃，设置页显示"未配置"

- [x] Task A2：API Key 加密存储
  - [x] A2.1 修改 `electron/db/SettingsStore.ts`：API Key 字段改用 `electron.safeStorage.encryptString` 加密，存为 `apiKeyEncrypted`（base64 blob）；移除明文 `apiKey` 字段
  - [x] A2.2 新增 `getApiKey()`：运行时 `safeStorage.decryptString` 解密返回；解密失败（如换机器）返回空并提示
  - [x] A2.3 修改 `electron/ai/ReportGenerator.ts`/`OpenAIClient.ts`：从 `getApiKey()` 取 key，不得读明文
  - [x] A2.4 修改 `src/pages/Settings.tsx`：API Key 输入框永不回填完整 key（显示 `sk-****xxxx` 掩码）；新增"清空 API Key"按钮
  - [x] A2.5 日志审计：全局搜索 `console.log`/`console.error` 确保不打印 apiKey
  - [x] A2.6 验证：grep settings.json 不含 `sk-`；重启后 AI 调用仍可用；清空后 AI 失败提示

- [x] Task A3：截图降级策略修复
  - [x] A3.1 修改 `electron/capture/Screenshot.ts`：`captureActiveWindow()` 找不到目标窗口时返回 `{ status: 'failed' }`，**不**调用 `captureScreen()`
  - [x] A3.2 `captureWindow(hwnd)` 失败时返回失败状态，CaptureDecision 收到失败则跳过该次捕获或标记 `screenshot_failed`
  - [x] A3.3 新增设置项 `allowFullScreenshotFallback`（默认 false）
  - [x] A3.4 仅当 `allowFullScreenshotFallback=true` 时允许整屏降级，且首次开启弹风险提示；多屏时明确屏幕范围
  - [x] A3.5 验证：无目标窗口时不产生整屏截图；设置页整屏降级默认关闭

- [x] Task A4：IPC 入参 Zod schema 校验
  - [x] A4.1 新增 `electron/ipc/schemas.ts`：为每个 IPC 通道定义 Zod schema（segment/episode/wiki/report/privacyRule/settings/ai/mascot/ocr/capture/insights/system）
  - [x] A4.2 新增 `electron/ipc/validatedHandler.ts`：高阶函数包装 `ipcMain.handle`，自动校验入参，失败返回 `{ ok:false, error:'VALIDATION_ERROR', details }`
  - [x] A4.3 重构 `electron/main/ipc.ts`：所有 handler 改用 `validatedHandler` 包装
  - [x] A4.4 业务 action 化：删除 `segment.insert`/`report.insert` 直通通道，改为 `segment.markImportant(id)`/`wiki.confirmIngest(id)` 等业务 action；保留 `wiki.insert`/`privacyRule.insert`/`episode.insert` 为合法业务 action，新增 `report.saveDraft`
  - [x] A4.5 `settings.set` 限制可写字段白名单（apiKey 走专门 `settings.setApiKey`）
  - [x] A4.6 `system.saveFile` 限制扩展名白名单（.md/.docx/.json/.png 等）与文件名
  - [x] A4.7 统一错误返回：所有 handler 返回 `{ ok, data?, error? }` 形态
  - [x] A4.8 验证：构造非法 payload 调用被拒；settings 文件不被污染（typecheck/build/lint 全通过）

## Phase B：颜值第一落地（UI 组件体系）

- [x] Task B1：建立统一组件库 `src/ui/`
  - [x] B1.1 `src/ui/Button.tsx`：variants（primary/secondary/ghost/danger）、sizes、loading、icon slot，6px 圆角
  - [x] B1.2 `src/ui/IconButton.tsx`：仅图标按钮，tooltip 内置
  - [x] B1.3 `src/ui/Card.tsx`：8px 圆角、亚克力背景、阴影 token
  - [x] B1.4 `src/ui/Dialog.tsx`：基于 Radix Dialog，8px 圆角、亚克力、esc 关闭、遮罩
  - [x] B1.5 `src/ui/Toast.tsx`：全局 toast 系统（zustand store + portal）
  - [x] B1.6 `src/ui/SegmentedControl.tsx`：分段选择（如月/周视图切换）
  - [x] B1.7 `src/ui/Switch.tsx`：基于 Radix Switch
  - [x] B1.8 `src/ui/TextField.tsx`：输入框 + label + error
  - [x] B1.9 `src/ui/Select.tsx`：基于 Radix Select
  - [x] B1.10 `src/ui/Tooltip.tsx`：基于 Radix Tooltip
  - [x] B1.11 `src/ui/Badge.tsx`：状态徽章（颜色变体）
  - [x] B1.12 `src/ui/Timeline.tsx`：时间轴容器与项
  - [x] B1.13 `src/ui/MemoryCard.tsx`：Episode 记忆卡（封装时间/标题/摘要/标签/勾选）
  - [x] B1.14 `src/ui/index.ts`：统一导出
  - [x] B1.15 `src/ui/icons.ts`：统一从 lucide-react 导出常用图标

- [x] Task B2：迁移核心组件到组件库
  - [x] B2.1 重构 `src/components/TitleBar.tsx`：用 Button/IconButton
  - [x] B2.2 重构 `src/components/IconSidebar.tsx`：用 lucide 图标 + Tooltip
  - [x] B2.3 重构 `src/components/EpisodeCard.tsx` → 用 MemoryCard
  - [x] B2.4 重构 `src/components/SegmentList.tsx`、`StatusBar.tsx`、`ContextPanel.tsx`、`EmptyState.tsx`
  - [x] B2.5 移除页面内大段内联 `<style>`，样式集中到组件或 CSS Module

- [x] Task B3：重构 Today 与 Reports 两页（核心页）
  - [x] B3.1 Today 页：信息层级重设计（今日总结 + 记录状态 + 生成日报入口一眼可见），用 MemoryCard/Timeline/Button/Badge
  - [x] B3.2 Reports 页：AI 确认面板用 Dialog，历史列表用 Card，编辑区用 TextField，导出用 Button 组
  - [x] B3.3 移除两页所有内联样式，确保无文字溢出/布局拥挤

- [x] Task B4：迁移其余 6 页到组件库
  - [x] B4.1 Calendar、Search、Insights、Wiki、Graph、Settings 逐页迁移
  - [x] B4.2 搜索页文案改为"记忆搜索"（Phase D 联动）
  - [x] B4.3 图谱页加节点上限与"关系预览"降级（Phase D 联动）

- [x] Task B5：Mascot 视觉统一
  - [x] B5.1 5 种形象重绘为统一风格（统一描边粗细/配色语言/状态表情规范）
  - [x] B5.2 保留 SVG 路线，确保 5 形象 × 5 状态视觉一致

- [x] Task B6：视觉验收基线
  - [x] B6.1 准备 5 Episode + 20 Segment 测试数据脚本
  - [x] B6.2 Today/Reports/Settings 三页截图，对照设计治理硬约束（8px/6px 圆角、间距 token、亚克力、无溢出）

## Phase C：产品主链路打磨（日报闭环）

- [x] Task C1：富文本复制
  - [x] C1.1 新增 `electron/ai/HtmlExporter.ts`：markdown → HTML（保留标题/列表/段落/粗体）
  - [x] C1.2 Reports 页新增"复制富文本"按钮：调 `clipboard.write({text, html})` 同时写 text/plain 与 text/html
  - [x] C1.3 验证：粘贴到 Word/飞书保留排版

- [x] Task C2：Word 导出升级 .docx
  - [x] C2.1 修改 `electron/ai/ReportExporter.ts`：`exportWord()` 改用 `docx` 库生成真实 .docx（标题 HeadingLevel、列表、段落）
  - [x] C2.2 移除旧 HTML .doc 方案
  - [x] C2.3 IPC `ai:exportWord` 返回 .docx buffer，前端调 `system.saveFile` 保存
  - [x] C2.4 验证：Word 可打开，格式正确

- [x] Task C3：AI 上传确认面板增强
  - [x] C3.1 确认面板每条 Episode 可展开预览发送文本
  - [x] C3.2 可逐条删除（取消勾选）
  - [x] C3.3 敏感词脱敏：对 OCR 文本中的手机号/邮箱/身份证号自动掩码后再发送
  - [x] C3.4 显示脱敏后字符数

- [x] Task C4：日历 ↔ 报告联动
  - [x] C4.1 日历点击日期右侧面板新增"查看当天日报"按钮（若已生成）
  - [x] C4.2 点击跳转 Reports 页并加载该日报告
  - [x] C4.3 日历单元格日报状态标记与 reports 表联动

- [x] Task C5：报告类型字段
  - [x] C5.1 reports 表新增 `report_type` 字段（daily/weekly/review），迁移脚本
  - [x] C5.2 Reports 页 P0 文案诚实称"日报中心"
  - [x] C5.3 P1 预留周报/复盘入口（UI 可见但标注"即将推出"不算占位——需真实可用或隐藏，本任务选择隐藏入口，待 P1 真实实现再显示）

## Phase D：高级能力降噪（诚实化）

- [x] Task D1：搜索命名诚实化
  - [x] D1.1 Search 页所有"语义搜索"文案改为"记忆搜索"或"关键词 + 时间搜索"
  - [x] D1.2 匹配原因 UI 明确显示 OCR/时间/项目/人物四类标签
  - [x] D1.3 移除 `AiChannels.SemanticSearch` 的 `return []` 空实现通道

- [x] Task D2：SQLite FTS5 全文索引
  - [x] D2.1 `electron/db/schema.ts` 新增 FTS5 虚拟表：fts_segments(ocr_text)、fts_episodes(title, one_line_summary)、fts_wiki(content)
  - [x] D2.2 迁移脚本建 FTS5 表 + 触发器（insert/update/delete 同步）
  - [x] D2.3 Search 页改用 FTS5 MATCH 查询（经 IPC），保留关键词 + 时间 + 实体多维匹配原因
  - [x] D2.4 验证：搜索结果可解释、性能提升

- [x] Task D3：Wiki 自动提取草稿化与置信度
  - [x] D3.1 WikiExtractor 输出 confidence（已有），UI Review Queue 卡片展示置信度与"为什么建议保存"
  - [x] D3.2 自动生成一律 `review_status='needs_review'`
  - [x] D3.3 低置信（<0.5）候选不进入 Wiki/报告默认选择

- [x] Task D4：EntityExtractor 置信度
  - [x] D4.1 EntityRef 类型新增 `confidence: number` 字段
  - [x] D4.2 EntityExtractor 为每类实体计算 confidence（人名：姓氏常见度+长度；项目：匹配强度；文档：扩展名明确度；URL：协议明确度）
  - [x] D4.3 低置信实体不进入 Wiki/报告默认选择
  - [x] D4.4 UI 支持用户确认/修正实体（Wiki/图谱页）

- [x] Task D5：图谱稳定性
  - [x] D5.1 Graph 页节点数上限 100，超过降级"关系预览"提示
  - [x] D5.2 布局结果缓存（按筛选条件 hash），避免重复抖动
  - [x] D5.3 文案诚实称"关系预览"（当降级时）

- [x] Task D6：Insights 主动推送降噪
  - [x] D6.1 ReminderScheduler 默认低频（下班复盘每天最多 1 次，周五复盘每周 1 次）
  - [x] D6.2 受 Mascot 频率限制器约束（每天 2 次上限）

## Phase V：集成验证与收尾

- [x] Task V1：端到端闭环验证
  - [x] V1.1 无 OCR runtime 启动不崩 → 配置 OCR → 识别中文截图
  - [x] V1.2 API Key 加密保存 → 重启可用 → 清空失败
  - [x] V1.3 截图失败不整屏降级
  - [x] V1.4 IPC 非法 payload 被拒
  - [x] V1.5 生成日报 → 复制富文本 → 粘贴 Word 保留排版
  - [x] V1.6 导出 .docx → Word 打开格式正确
  - [x] V1.7 搜索命名诚实 + FTS5 可解释
  - [x] V1.8 图谱节点上限降级

- [x] Task V2：代码审计
  - [x] V2.1 全局搜索 TODO/FIXME/后期实现/占位/mock 零残留
  - [x] V2.2 全局搜索键盘监听零残留
  - [x] V2.3 全局搜索 settings.json 不含明文 apiKey
  - [x] V2.4 设计 token 使用审计

- [x] Task V3：构建与类型
  - [x] V3.1 `npm run typecheck` 零错误
  - [x] V3.2 `npm run build` 成功
  - [x] V3.3 `npm run lint` 零警告（业务代码）

# Task Dependencies

- Task A0（环境基线）为全部前置
- Task A1/A2/A3/A4 互相独立，可并行（均属 Phase A 安全可用性）
- Task B1（组件库）为 B2/B3/B4 前置
- Task B2 为 B3/B4 前置
- Task B3（Today/Reports 重构）与 C1/C2（富文本/docx）有 Reports 页交集，建议 B3 先行再 C1/C2
- Task C5（report_type 字段）影响 C4（日历联动），C5 先行
- Task D2（FTS5）依赖 A4（IPC 校验）的 schema 定义
- Task D4（Entity confidence）影响 D3（Wiki 默认选择），D4 先行或并行
- Task V1 依赖全部前置完成
- Task V2/V3 为最后审计
