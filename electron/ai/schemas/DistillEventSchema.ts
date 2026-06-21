/**
 * DistillEventSchema：AI 小时级理解输出 JSON 契约
 *
 * 用 Zod 定义 DistillEvent 校验 schema，配合 parseDistillResponse
 * 容错解析 AI 返回的 JSON（剥 ```json 围栏 / 提取首个 { 到最后 }），
 * 逐条校验 events，合法的入 events，不合法的计入 skipped。
 */
import { z } from 'zod'

const timeString = z.string().regex(/^\d{2}:\d{2}:\d{2}$/, '时间格式必须为 HH:MM:SS')

const entitySchema = z.object({
  type: z.enum(['person', 'project', 'document', 'url']),
  name: z.string().min(1),
  value: z.string().optional(),
  confidence: z.number().min(0).max(1)
})

const evidenceRefSchema = z.object({
  segmentId: z.string().min(1),
  quote: z.string().default(''),
  reason: z.string().default('')
})

export const DistillEventSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  startTime: timeString,
  endTime: timeString,
  memoryKind: z.enum([
    'work',
    'research',
    'communication',
    'coding',
    'planning',
    'review',
    'admin',
    'idle_uncertain'
  ]),
  project: z.string().default(''),
  entities: z.array(entitySchema).default([]),
  topics: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  todos: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  segmentIds: z.array(z.string().min(1)).min(1),
  evidenceRefs: z.array(evidenceRefSchema).default([]),
  sourceQuality: z.enum(['high', 'medium', 'low', 'failed', 'private']),
  confidence: z.number().min(0).max(1),
  reportEligible: z.boolean().default(true),
  wikiEligible: z.boolean().default(false),
  wikiStatus: z
    .enum(['none', 'candidate', 'auto_upserted', 'needs_review', 'rejected'])
    .default('none')
})

export type DistillEvent = z.infer<typeof DistillEventSchema>

export const DistillResponseSchema = z.object({
  events: z.array(DistillEventSchema)
})

function hasEventsArray(value: unknown): value is { events: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { events?: unknown }).events)
  )
}

/**
 * 解析 AI 返回的 Distill 响应文本：
 *  1. 剥 ```json 围栏
 *  2. 尝试 JSON.parse
 *  3. 失败则提取首个 { 到最后一个 } 再 parse
 *  4. 仍失败抛 Error
 *  5. 逐条用 DistillEventSchema 校验 events，合法入 events，不合法计入 skipped
 */
export function parseDistillResponse(content: string): {
  events: DistillEvent[]
  skipped: number
  raw: unknown
} {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  let jsonText = fenced ? fenced[1].trim() : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    const start = jsonText.indexOf('{')
    const end = jsonText.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('AI 输出无法解析为 JSON')
    }
    jsonText = jsonText.slice(start, end + 1)
    try {
      parsed = JSON.parse(jsonText)
    } catch (e) {
      throw new Error(`AI 输出 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const events: DistillEvent[] = []
  let skipped = 0

  if (hasEventsArray(parsed)) {
    parsed.events.forEach((event, index) => {
      const result = DistillEventSchema.safeParse(event)
      if (result.success) {
        events.push(result.data)
      } else {
        skipped++
        const detail = result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
        console.warn(`[DistillEventSchema] 跳过第 ${index} 条事件: ${detail}`)
      }
    })
  }

  return { events, skipped, raw: parsed }
}
