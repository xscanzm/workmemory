import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseDistillResponse, DistillEventSchema } from '../DistillEventSchema'

function makeValidEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '审阅 PR #42',
    summary: '审阅了同事提交的 PR #42，提出 3 条修改建议',
    startTime: '09:00:00',
    endTime: '09:30:00',
    memoryKind: 'review',
    project: 'workmemory',
    entities: [
      { type: 'person', name: '张三', confidence: 0.9 },
      { type: 'url', name: 'GitHub PR', value: 'https://github.com/repo/pull/42', confidence: 0.8 }
    ],
    topics: ['代码审阅', 'PR'],
    materials: ['PR #42'],
    outputs: ['审阅意见'],
    todos: ['等待作者修改'],
    blockers: [],
    segmentIds: ['seg-001', 'seg-002'],
    evidenceRefs: [{ segmentId: 'seg-001', quote: '审阅 PR #42', reason: '明确提到审阅动作' }],
    sourceQuality: 'high',
    confidence: 0.85,
    reportEligible: true,
    wikiEligible: false,
    wikiStatus: 'none',
    ...overrides
  }
}

describe('DistillEventSchema', () => {
  let originalWarn: typeof console.warn

  beforeEach(() => {
    originalWarn = console.warn
    console.warn = () => {}
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  it('valid event passes schema validation', () => {
    const result = DistillEventSchema.safeParse(makeValidEvent())
    assert.ok(result.success, 'Schema should accept a complete valid event')
  })

  it('parses a complete valid JSON response', () => {
    const content = JSON.stringify({ events: [makeValidEvent()] })
    const { events, skipped, raw } = parseDistillResponse(content)
    assert.equal(events.length, 1)
    assert.equal(skipped, 0)
    assert.ok(typeof raw === 'object' && raw !== null)
    assert.ok(Array.isArray((raw as { events?: unknown[] }).events))
  })

  it('skips event with missing required field (no summary)', () => {
    const event = makeValidEvent()
    delete event.summary
    const content = JSON.stringify({ events: [event] })
    const { events, skipped } = parseDistillResponse(content)
    assert.equal(events.length, 0)
    assert.equal(skipped, 1)
  })

  it('skips event with wrong type (confidence as string)', () => {
    const event = makeValidEvent({ confidence: 'high' })
    const content = JSON.stringify({ events: [event] })
    const { events, skipped } = parseDistillResponse(content)
    assert.equal(events.length, 0)
    assert.equal(skipped, 1)
  })

  it('returns empty events and skipped=0 for empty events array', () => {
    const content = JSON.stringify({ events: [] })
    const { events, skipped } = parseDistillResponse(content)
    assert.deepEqual(events, [])
    assert.equal(skipped, 0)
  })

  it('throws Error for non-JSON input', () => {
    assert.throws(() => parseDistillResponse('not json at all'), Error)
  })

  it('parses JSON wrapped in code fences', () => {
    const inner = JSON.stringify({ events: [makeValidEvent()] })
    const content = '```json\n' + inner + '\n```'
    const { events, skipped } = parseDistillResponse(content)
    assert.equal(events.length, 1)
    assert.equal(skipped, 0)
  })

  it('extracts JSON from surrounding text', () => {
    const inner = JSON.stringify({ events: [makeValidEvent()] })
    const content = 'Here is the response:\n' + inner + '\nHope this helps!'
    const { events, skipped } = parseDistillResponse(content)
    assert.equal(events.length, 1)
    assert.equal(skipped, 0)
  })
})
