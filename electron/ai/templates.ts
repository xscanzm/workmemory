/**
 * 日报模板系统
 * 3 种预置模板：汇报优化版 / 简洁客观版 / OKR 对齐版
 * 模板使用 {{timeline}}、{{user_notes}}、{{project_tags}} 占位符拼接提示词。
 *
 * 每个模板导出 buildPrompt(params) 函数，构建 { systemPrompt, userPrompt }。
 * 所有模板的 systemPrompt 包含"内容真实不虚构"强约束。
 *
 * Task RP1：新增 'structured' 模板与 structuredSections 配置，
 * 支持按 sections 分区输出结构化日报（管家总结/今日做了什么/今日看了什么/...）。
 */
import type { ReportTemplate } from '@/types'

/** 结构化日报分区类型（Task RP1.1） */
export type ReportSection =
  | 'butler_summary'      // 管家总结
  | 'what_i_did'          // 今日做了什么
  | 'what_i_saw'          // 今日看了什么
  | 'themes'              // 主题归纳
  | 'timeline'            // 时间线
  | 'chat_notes'          // 聊天记录要点
  | 'web_notes'           // 网页记录要点
  | 'forum_notes'         // 论坛记录要点
  | 'video_notes'         // 视频记录要点
  | 'product_notes'       // 商品记录要点
  | 'evidence'            // 证据片段
  | 'suggestions'         // 优化建议

/** 默认结构化分区（Task RP1.2） */
export const DEFAULT_STRUCTURED_SECTIONS: ReportSection[] = [
  'butler_summary',
  'what_i_did',
  'what_i_saw',
  'themes',
  'timeline',
  'chat_notes',
  'web_notes',
  'forum_notes',
  'video_notes',
  'product_notes',
  'evidence',
  'suggestions'
]

/** 分区标题映射（中文） */
export const REPORT_SECTION_TITLES: Record<ReportSection, string> = {
  butler_summary: '管家总结',
  what_i_did: '今日做了什么',
  what_i_saw: '今日看了什么',
  themes: '主题归纳',
  timeline: '时间线',
  chat_notes: '聊天记录要点',
  web_notes: '网页记录要点',
  forum_notes: '论坛记录要点',
  video_notes: '视频记录要点',
  product_notes: '商品记录要点',
  evidence: '证据片段',
  suggestions: '优化建议'
}

/** 时间线条目 */
export interface TimelineEntry {
  /** 时间段，如 "2026-03-29T17:47:54+08:00 ~ 2026-03-29T17:48:19+08:00" */
  time: string
  /** 时间线条目标题 */
  title: string
  /** 细节 */
  detail?: string
  /** 金句/字幕 */
  quote?: string
  /** 证据 */
  evidence?: string
}

/** 分类要点（聊天/网页/论坛/视频/商品） */
export interface CategoryNote {
  /** 要点标题 */
  title: string
  /** 详细内容 */
  details: string[]
}

/** 结构化日报数据模型（Task RP1.11） */
export interface StructuredReport {
  date: string
  /** 管家总结 */
  butlerSummary: string
  /** 今日做了什么（列表） */
  whatIDid: string[]
  /** 今日看了什么（列表） */
  whatISaw: string[]
  /** 主题归纳 */
  themes: string[]
  /** 时间线 */
  timeline: TimelineEntry[]
  /** 聊天记录要点 */
  chatNotes: CategoryNote[]
  /** 网页记录要点 */
  webNotes: CategoryNote[]
  /** 论坛记录要点 */
  forumNotes: CategoryNote[]
  /** 视频记录要点 */
  videoNotes: CategoryNote[]
  /** 商品记录要点 */
  productNotes: CategoryNote[]
  /** 证据片段 */
  evidence: string[]
  /** 优化建议 */
  suggestions: string[]
}

/** 模板渲染参数 */
export interface TemplateParams {
  /** 时间线文本（已构建好的 Episode 摘要） */
  timeline: string
  /** 用户备注 */
  userNotes: string
  /** 项目标签数组 */
  projectTags: string[]
  /** 日期 YYYY-MM-DD */
  date: string
}

/** 渲染后的提示词 */
export interface BuiltPrompt {
  systemPrompt: string
  userPrompt: string
}

export interface ReportTemplateDef {
  id: ReportTemplate
  name: string
  description: string
  /** 系统提示词：定义 AI 角色与硬约束 */
  systemPrompt: string
  /** 用户提示词模板：含占位符 */
  userPromptTemplate: string
  /** 是否启用结构化输出（JSON 模式），默认 false；为 true 时调用方会以 json_object 模式请求并渲染为 Markdown */
  structuredOutput?: boolean
  /** 结构化分区配置（Task RP1.1）：控制输出哪些分类要点；为空或不设置则不启用结构化分区输出 */
  structuredSections?: ReportSection[]
  /** 构建提示词（每个模板独立导出） */
  buildPrompt: (params: TemplateParams) => BuiltPrompt
}

/** 通用系统提示词：内容真实不虚构硬约束（任务要求逐字包含） */
const COMMON_SYSTEM_PROMPT = `你是一名专业的工作汇报撰写助手。请严格遵守以下规则：
1. 你只能基于以下用户勾选的真实工作片段进行归纳和表达增强，严禁虚构任何未发生的事项、未提及的项目或未列出的产出。如果信息不足，宁可简短也不要编造。
2. 不得编造时间、数据、人名或项目名。
3. 若片段信息不足以支撑某部分内容，则省略该部分，不要补充臆测。
4. 输出纯 Markdown 格式，结构清晰，语言专业。
5. 尊重用户备注（user_notes），如有特殊要求优先满足。
6. 只输出最终答案，不要输出思考过程、推理过程、reasoning、analysis、解释说明或额外前后缀。`

/** 将项目标签数组转为可读字符串 */
function formatProjectTags(tags: string[]): string {
  return tags.length > 0 ? tags.join('、') : ''
}

/** 占位符替换：支持 {{timeline}}、{{user_notes}}、{{project_tags}}、{{date}} */
export function renderTemplate(
  templateId: ReportTemplate,
  vars: { timeline: string; userNotes: string; projectTags: string; date: string }
): { systemPrompt: string; userPrompt: string } {
  const tpl = REPORT_TEMPLATES[templateId]
  if (!tpl) throw new Error(`未知的报告模板: ${templateId}`)

  const userPrompt = tpl.userPromptTemplate
    .replace(/\{\{timeline\}\}/g, vars.timeline || '（无片段）')
    .replace(/\{\{user_notes\}\}/g, vars.userNotes || '（无备注）')
    .replace(/\{\{project_tags\}\}/g, vars.projectTags || '（无项目标签）')
    .replace(/\{\{date\}\}/g, vars.date)

  return { systemPrompt: tpl.systemPrompt, userPrompt }
}

/** 通用 buildPrompt 实现：将 TemplateParams 转换后调用 renderTemplate */
function defaultBuildPrompt(tpl: ReportTemplateDef, params: TemplateParams): BuiltPrompt {
  const projectTagsStr = formatProjectTags(params.projectTags)
  const result = renderTemplate(tpl.id, {
    timeline: params.timeline,
    userNotes: params.userNotes,
    projectTags: projectTagsStr,
    date: params.date
  })
  return { systemPrompt: tpl.systemPrompt, userPrompt: result.userPrompt }
}

export const REPORT_TEMPLATES: Record<ReportTemplate, ReportTemplateDef> = {
  enhanced: {
    id: 'enhanced',
    name: '汇报优化版',
    description: '将杂事改写为具商业价值的表达，突出产出与价值',
    systemPrompt: `${COMMON_SYSTEM_PROMPT}
6. 采用"汇报优化"风格：将技术性描述转化为业务价值陈述，将琐碎操作改写为具商业价值与成果导向的表达。例如"改了一上午Bug"应改写为"定位并修复订单状态机历史遗留异常流，大幅提升结算准确度"。突出工作产出、推进进度与价值贡献，但不得夸大或虚构。`,
    userPromptTemplate: `请根据以下今日工作片段，生成一份"汇报优化版"日报。

## 今日工作片段（timeline）
{{timeline}}

## 涉及项目标签（project_tags）
{{project_tags}}

## 用户备注（user_notes）
{{user_notes}}

## 输出要求
- 标题：# 今日工作日报（YYYY-MM-DD）
- 按"核心产出 / 推进事项 / 协作沟通 / 其他"分类组织
- 每个事项用一句话概括价值与进展，附时间区间
- 将技术性描述转化为业务价值陈述，突出产出与影响
- 末尾附"明日计划"占位（仅当 user_notes 中有相关内容时填写）
- 全文使用 Markdown，语言精炼专业
- 只输出最终日报正文，不要附加解释`,
    buildPrompt(params: TemplateParams): BuiltPrompt {
      return defaultBuildPrompt(REPORT_TEMPLATES.enhanced, params)
    }
  },
  concise: {
    id: 'concise',
    name: '简洁客观版',
    description: '项目/用时/产出列表，客观陈述事实',
    systemPrompt: `${COMMON_SYSTEM_PROMPT}
6. 采用"简洁客观"风格：按项目分组，每项列出用时和关键产出，不加修饰，仅陈述事实。`,
    userPromptTemplate: `请根据以下今日工作片段，生成一份"简洁客观版"日报。

## 今日工作片段（timeline）
{{timeline}}

## 涉及项目标签（project_tags）
{{project_tags}}

## 用户备注（user_notes）
{{user_notes}}

## 输出要求
- 标题：# 工作日报 {{date}}
- 按项目分组，每组列出：项目名、总用时、产出事项（bullet 列表）
- 每项产出仅陈述事实，不加价值修饰
- 末尾汇总：总工作时长、项目数、片段数
- 全文使用 Markdown，客观陈述，不加修饰
- 只输出最终日报正文，不要附加解释`,
    buildPrompt(params: TemplateParams): BuiltPrompt {
      return defaultBuildPrompt(REPORT_TEMPLATES.concise, params)
    }
  },
  okr: {
    id: 'okr',
    name: 'OKR 对齐版',
    description: '按 OKR 进度归纳，对齐目标推进',
    systemPrompt: `${COMMON_SYSTEM_PROMPT}
6. 采用"OKR 对齐"风格：识别工作对应的 OKR 项，标注进度推进。将工作事项归纳到目标（Objective）与关键结果（Key Result）维度。若无法从片段中识别明确的 OKR，则按主题归纳并标注"待对齐目标"。`,
    userPromptTemplate: `请根据以下今日工作片段，生成一份"OKR 对齐版"日报。

## 今日工作片段（timeline）
{{timeline}}

## 涉及项目标签（project_tags）
{{project_tags}}

## 用户备注（user_notes）
{{user_notes}}

## 输出要求
- 标题：# OKR 对齐日报 {{date}}
- 识别工作对应的 OKR 项，按目标（Objective）分组，每组下含关键结果（Key Result）与今日推进事项
- 每个推进事项标注：用时、进展（基于片段推断，保守估计）
- 若无法识别对应 OKR，归入"待对齐目标"分组
- 末尾附"风险与阻碍"占位（仅当 user_notes 中有相关内容时填写）
- 全文使用 Markdown，结构清晰
- 只输出最终日报正文，不要附加解释`,
    buildPrompt(params: TemplateParams): BuiltPrompt {
      return defaultBuildPrompt(REPORT_TEMPLATES.okr, params)
    }
  },
  structured: {
    id: 'structured',
    name: '结构化分区版',
    description: '按管家总结/今日做了什么/今日看了什么/主题归纳/时间线/分类要点/证据/建议分区输出',
    systemPrompt: `${COMMON_SYSTEM_PROMPT}
6. 采用"结构化分区"风格：按指定的 sections 分区输出，每个分区有明确标题与要点。
7. 输出 JSON 对象，字段对应分区：butlerSummary（字符串）、whatIDid/whatISaw/themes/evidence/suggestions（字符串数组）、timeline（TimelineEntry 数组）、chatNotes/webNotes/forumNotes/videoNotes/productNotes（CategoryNote 数组）。
8. 严禁虚构：所有要点必须来源于提供的片段/记忆单元/因果链上下文。`,
    userPromptTemplate: `请根据以下今日工作上下文，生成一份"结构化分区版"日报。

## 日期
{{date}}

## 今日工作片段（timeline）
{{timeline}}

## 涉及项目标签（project_tags）
{{project_tags}}

## 用户备注（user_notes）
{{user_notes}}

## 输出要求
- 输出 JSON 对象，包含以下字段：
  - butlerSummary: string（管家总结，1-3 句话概括当日整体情况）
  - whatIDid: string[]（今日做了什么，每条一句话）
  - whatISaw: string[]（今日看了什么，每条一句话）
  - themes: string[]（主题归纳，每条一个主题）
  - timeline: Array<{ time: string; title: string; detail?: string; quote?: string; evidence?: string }>
  - chatNotes/webNotes/forumNotes/videoNotes/productNotes: Array<{ title: string; details: string[] }>
- evidence: string[]（证据片段，每条 ≤80 字）
- suggestions: string[]（优化建议）
- 严格基于上下文，禁止虚构
- 如果某类内容没有对应片段，对应数组为空
- 只输出 JSON 对象本身，不要 Markdown 代码块，不要解释，不要思考过程`,
    structuredOutput: true,
    structuredSections: DEFAULT_STRUCTURED_SECTIONS,
    buildPrompt(params: TemplateParams): BuiltPrompt {
      return defaultBuildPrompt(REPORT_TEMPLATES.structured, params)
    }
  }
}

/** 获取所有模板元信息（供前端选择） */
export function getTemplateList(): Array<{ id: ReportTemplate; name: string; description: string }> {
  return Object.values(REPORT_TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description
  }))
}

/** 根据模板 id 获取模板定义 */
export function getTemplate(templateId: ReportTemplate): ReportTemplateDef {
  const tpl = REPORT_TEMPLATES[templateId]
  if (!tpl) throw new Error(`未知的报告模板: ${templateId}`)
  return tpl
}
