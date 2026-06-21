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
    'Wiki 候选必须有明确标题，禁止“推进”“梳理”“配置”“笔记”这类空洞标题单独成页。',
    '',
    '除 events 外，每个事件还需输出 MemCell 结构化记忆单元，包含三部分：',
    '- episode：第三人称叙事，1-2 句客观描述用户做了什么，如 "用户在 VS Code 中实现了 API Key 加密功能，使用了 Electron 的 safeStorage API"。',
    '- facts：原子事实数组，3-5 条，每条一个独立事实，如 ["使用了 safeStorage API", "密钥存储在 userData 目录", "加密失败时降级到明文"]。',
    '- foresight：预见数组，0-2 条，每条带 statement（前瞻性陈述）、validFrom（生效日期 YYYY-MM-DD）、validTo（失效日期 YYYY-MM-DD）、confidence（0-1），如 {"statement":"未来涉及密钥存储时可复用 safeStorage 方案","validFrom":"2026-03-29","validTo":"2027-03-29","confidence":0.8}。',
    'episode/facts/foresight 应基于本小时证据提炼，不要虚构；foresight 仅在有充分依据时输出，否则留空数组。'
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
      "wikiStatus": "none|candidate",
      "episode": "第三人称叙事，1-2 句客观描述用户做了什么",
      "facts": ["原子事实1", "原子事实2", "原子事实3"],
      "foresight": [
        {"statement": "前瞻性陈述", "validFrom": "YYYY-MM-DD", "validTo": "YYYY-MM-DD", "confidence": 0.8}
      ]
    }
  ]
}`
  ].join('\n')

  return { systemPrompt, userPrompt }
}
