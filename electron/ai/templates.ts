/**
 * 日报模板系统
 * 3 种预置模板：汇报优化版 / 简洁客观版 / OKR 对齐版
 * 模板使用 {{timeline}}、{{user_notes}}、{{project_tags}} 占位符拼接提示词。
 *
 * 每个模板导出 buildPrompt(params) 函数，构建 { systemPrompt, userPrompt }。
 * 所有模板的 systemPrompt 包含"内容真实不虚构"强约束。
 */
import type { ReportTemplate } from '@/types'

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
  /** 构建提示词（每个模板独立导出） */
  buildPrompt: (params: TemplateParams) => BuiltPrompt
}

/** 通用系统提示词：内容真实不虚构硬约束（任务要求逐字包含） */
const COMMON_SYSTEM_PROMPT = `你是一名专业的工作汇报撰写助手。请严格遵守以下规则：
1. 你只能基于以下用户勾选的真实工作片段进行归纳和表达增强，严禁虚构任何未发生的事项、未提及的项目或未列出的产出。如果信息不足，宁可简短也不要编造。
2. 不得编造时间、数据、人名或项目名。
3. 若片段信息不足以支撑某部分内容，则省略该部分，不要补充臆测。
4. 输出纯 Markdown 格式，结构清晰，语言专业。
5. 尊重用户备注（user_notes），如有特殊要求优先满足。`

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
- 全文使用 Markdown，语言精炼专业`,
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
- 全文使用 Markdown，客观陈述，不加修饰`,
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
- 全文使用 Markdown，结构清晰`,
    buildPrompt(params: TemplateParams): BuiltPrompt {
      return defaultBuildPrompt(REPORT_TEMPLATES.okr, params)
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
