import type { HourContextPack } from '@/types'

export const DISTILL_VERSION = 'hourly-v1'

export function buildDistillMessages(pack: HourContextPack): {
  systemPrompt: string
  userPrompt: string
} {
  const systemPrompt = [
    '你是 WorkMemory 的小时级工作理解器。',
    '你的任务是把一小时内的屏幕 OCR 文本证据，整理为可长期复用的工作记忆事件。',
    '不要虚构，不要写没有证据支持的项目名、人物、任务或结论。',
    '只输出严格 JSON，不要 Markdown，不要解释。',
    '只输出 JSON 对象，不要 Markdown 代码块，不要任何解释文字，第一个字符必须是 {',
    '如果证据不足，使用 idle_uncertain，并降低 confidence。',
    'Wiki 候选必须有明确标题，禁止“推进”“梳理”“配置”“笔记”这类空洞标题单独成页。'
  ].join('\n')

  const userPrompt = [
    `日期：${pack.date}`,
    `小时：${pack.hourBucket}`,
    '请基于下面的 HourContextPack 输出 JSON：',
    '',
    JSON.stringify(pack, null, 2),
    '',
    '输出格式：',
    `{
  "events": [
    {
      "title": "清晰具体的事件标题",
      "summary": "基于证据的简短总结",
      "startTime": "HH:MM:SS", // 必须为 HH:MM:SS 格式
      "endTime": "HH:MM:SS", // 必须为 HH:MM:SS 格式
      "memoryKind": "work|research|communication|coding|planning|review|admin|idle_uncertain", // 必须为枚举值之一
      "project": "项目名，没有则空字符串",
      "entities": [{"type":"person|project|document|url","name":"...","value":"...","confidence":0.8}],
      "topics": ["主题"],
      "materials": ["看过/使用过的资料、网页、文档、代码、配置"],
      "outputs": ["本小时可能产生的产出"],
      "todos": ["明确待办"],
      "blockers": ["明确阻塞"],
      "segmentIds": ["必须来自输入"], // segmentIds 必须来自输入
      "evidenceRefs": [{"segmentId":"必须来自输入","quote":"证据摘录","reason":"为什么支持该事件"}], // evidenceRefs.segmentId 必须来自输入
      "sourceQuality": "high|medium|low|failed",
      "confidence": 0.0, // confidence 0-1
      "reportEligible": true,
      "wikiEligible": false,
      "wikiStatus": "none|candidate"
    }
  ]
}`
  ].join('\n')

  return { systemPrompt, userPrompt }
}
