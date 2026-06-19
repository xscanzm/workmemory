import { ReportTemplate } from "../../shared/types";

const SYSTEM_PROMPT = `你是一个专业的个人工作记录整理助手。
你只能基于用户提供的工作片段生成内容。
不要编造未发生的工作、会议、结果、数据、上线、修复、成交或交付。
可以对真实工作进行归纳、结构化、表达增强和价值提炼。
如果信息不足，请使用谨慎表达，不要补充不存在的事实。
输出应适合中文职场场景，语气自然、清晰、不过度夸张。`;

export const BUILT_IN_TEMPLATES: Omit<ReportTemplate, "id" | "createdAt" | "updatedAt">[] = [
  {
    name: "客观日报版",
    description: "按今日完成/进行中/问题风险/明日计划组织，适合提交给直属领导",
    type: "daily",
    isBuiltIn: true,
    outputFormat: "rich_text",
    prompt: `${SYSTEM_PROMPT}

请根据以下工作片段生成一份客观日报。

要求：
1. 只使用给定工作片段。
2. 不虚构结果。
3. 按"今日完成 / 进行中事项 / 问题与风险 / 明日计划"组织。
4. 表达简洁，适合提交给直属领导。

日期：{{date}}
工作片段：
{{selected_segments}}
用户补充：
{{user_notes}}`,
  },
  {
    name: "汇报优化版",
    description: "将零散工作归纳为具体事项，强调进展与协作",
    type: "daily",
    isBuiltIn: true,
    outputFormat: "rich_text",
    prompt: `${SYSTEM_PROMPT}

请根据以下工作片段生成一份汇报优化版日报。

要求：
1. 不编造没有发生的事情。
2. 将零散工作归纳为具体事项。
3. 强调进展、协作、问题澄清、风险控制和后续计划。
4. 语气专业自然，不要过度夸张。
5. 输出适合直接复制到公司日报系统。

日期：{{date}}
工作片段：
{{selected_segments}}
用户补充：
{{user_notes}}`,
  },
  {
    name: "个人记忆版",
    description: "按时间线回顾，保留关键细节，帮助个人复盘",
    type: "daily",
    isBuiltIn: true,
    outputFormat: "rich_text",
    prompt: `${SYSTEM_PROMPT}

请根据以下工作片段生成一份个人工作记忆。

要求：
1. 按时间线回顾今天做了什么。
2. 保留关键细节、资料、沟通对象、待办事项。
3. 帮助用户未来回忆当天工作。
4. 不需要过度包装。

日期：{{date}}
工作片段：
{{selected_segments}}
用户补充：
{{user_notes}}`,
  },
  {
    name: "简洁日报版",
    description: "极简风格，只列要点，适合快速提交",
    type: "daily",
    isBuiltIn: true,
    outputFormat: "rich_text",
    prompt: `${SYSTEM_PROMPT}

请根据以下工作片段生成一份简洁日报。

要求：
1. 只列出今日完成的关键事项，每条不超过一句话。
2. 用无序列表呈现。
3. 不虚构、不夸大。

日期：{{date}}
工作片段：
{{selected_segments}}
用户补充：
{{user_notes}}`,
  },
  {
    name: "详细日报版",
    description: "包含详细工作描述、时间分布和成果说明",
    type: "daily",
    isBuiltIn: true,
    outputFormat: "rich_text",
    prompt: `${SYSTEM_PROMPT}

请根据以下工作片段生成一份详细日报。

要求：
1. 按工作类型分组（如：需求工作、开发工作、沟通协作、文档编写等）。
2. 每项工作包含简要描述、投入时间、产出或进展。
3. 最后附上明日计划和风险提示。
4. 不虚构任何内容。

日期：{{date}}
工作片段：
{{selected_segments}}
用户补充：
{{user_notes}}`,
  },
  {
    name: "明日计划版",
    description: "侧重今日总结和明日计划，适合项目管理者",
    type: "daily",
    isBuiltIn: true,
    outputFormat: "rich_text",
    prompt: `${SYSTEM_PROMPT}

请根据以下工作片段生成一份带明日计划的日报。

要求：
1. 简要总结今日完成事项。
2. 列出进行中或未完成的事项。
3. 基于今日工作合理推断明日计划。
4. 明日计划只能基于今日未完成事项推断，不能凭空编造。

日期：{{date}}
工作片段：
{{selected_segments}}
用户补充：
{{user_notes}}`,
  },
];

export function renderTemplate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

export function formatSegmentsForPrompt(
  segments: Array<{
    startTime: string;
    endTime: string;
    appName: string;
    windowTitle: string;
    ocrSummary?: string;
    ocrText?: string;
    userNote?: string;
    userSummary?: string;
    tags: string[];
  }>
): string {
  return segments
    .map((s, i) => {
      const title = s.userSummary || s.ocrSummary || s.windowTitle;
      const summary = s.ocrText ? s.ocrText.substring(0, 200) : title;
      return `${i + 1}. [${s.startTime}-${s.endTime}] ${s.appName} - ${title}
   摘要: ${summary}${s.userNote ? `\n   备注: ${s.userNote}` : ""}${s.tags.length > 0 ? `\n   标签: ${s.tags.join(", ")}` : ""}`;
    })
    .join("\n\n");
}