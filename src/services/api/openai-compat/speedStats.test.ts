import { beforeEach, describe, expect, test } from 'bun:test'
import { createOpenAICompatFetch } from './adapter.js'
import {
  buildSpeedSample,
  drainSpeedSamples,
  formatSpeedLine,
  isLocalBaseUrl,
  localSpeedEnabled,
  speedSummaryToJson,
  summarizeSamples,
} from './speedStats.js'
import { parseSSE, toAnthropicEvents } from './stream.js'

const llamaTimings = {
  cache_n: 2800,
  prompt_n: 300,
  prompt_ms: 200,
  prompt_per_second: 1500,
  predicted_n: 210,
  predicted_ms: 5000,
  predicted_per_second: 42,
  draft_n: 120,
  draft_n_accepted: 90,
}

function sse(chunks: unknown[]): Response {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

describe('isLocalBaseUrl', () => {
  test('detects localhost variants only', () => {
    expect(isLocalBaseUrl('http://localhost:8082/v1')).toBe(true)
    expect(isLocalBaseUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLocalBaseUrl('http://[::1]:1234/v1')).toBe(true)
    expect(isLocalBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isLocalBaseUrl('https://localhost.evil.com/v1')).toBe(false)
  })
  test('kill switch', () => {
    expect(localSpeedEnabled({})).toBe(true)
    expect(localSpeedEnabled({ FNHARNESS_LOCAL_SPEED: '0' })).toBe(false)
  })
})

describe('buildSpeedSample / summary', () => {
  test('uses server timings with cache and draft', () => {
    const s = buildSpeedSample({ timings: llamaTimings, ttftMs: 420, totalMs: 5300 })!
    expect(s.source).toBe('server')
    const sum = summarizeSamples([s])!
    expect(sum.promptTps).toBeCloseTo(1500)
    expect(sum.predictedTps).toBeCloseTo(42)
    expect(formatSpeedLine(sum)).toBe(
      'TTFT 0.42 s · lectura 1500 tok/s (300 tok, 2800 en caché) · generación 42.0 tok/s (210 tok) · especulación 75% (90/120)',
    )
  })
  test('falls back to client measurements and usage', () => {
    const s = buildSpeedSample({
      timings: null,
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      ttftMs: 500,
      totalMs: 1500,
    })!
    expect(s.source).toBe('client')
    const sum = summarizeSamples([s])!
    expect(sum.promptTps).toBeCloseTo(200)
    expect(sum.predictedTps).toBeCloseTo(50)
    expect(formatSpeedLine(sum)).toContain('medido en cliente')
    expect(formatSpeedLine(sum)).not.toContain('especulación')
  })
  test('nothing to report returns null', () => {
    expect(buildSpeedSample({ ttftMs: null, totalMs: 10 })).toBeNull()
    expect(summarizeSamples([])).toBeNull()
  })
  test('ignores side queries without tools when the loop has samples', () => {
    const main = buildSpeedSample({ timings: llamaTimings, ttftMs: 400, totalMs: 1, withTools: true })!
    const side = buildSpeedSample({ timings: llamaTimings, ttftMs: 100, totalMs: 1, withTools: false })!
    expect(summarizeSamples([side, main])!.requests).toBe(1)
    expect(summarizeSamples([side])!.requests).toBe(1)
  })
  test('aggregates several requests of a turn', () => {
    const a = buildSpeedSample({ timings: llamaTimings, ttftMs: 400, totalMs: 1 })!
    const b = buildSpeedSample({ timings: llamaTimings, ttftMs: 600, totalMs: 1 })!
    const sum = summarizeSamples([a, b])!
    expect(sum.requests).toBe(2)
    expect(sum.ttftMs).toBe(500)
    expect(sum.promptN).toBe(600)
    expect(speedSummaryToJson(sum)).toMatchObject({ requests: 2, ttft_s: 0.5, generated_tokens: 420 })
  })
})

describe('stream capture', () => {
  test('toAnthropicEvents reports timings, usage and ttft', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'hola' } }] }
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
      yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 }, timings: llamaTimings }
    }
    let got: any
    for await (const _ of toAnthropicEvents(chunks(), 'm', 'id', s => (got = s))) void _
    expect(got.timings.predicted_n).toBe(210)
    expect(got.usage.prompt_tokens).toBe(3)
    expect(got.ttftMs).toBeGreaterThanOrEqual(0)
  })
})

describe('adapter records only for local profiles', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => drainSpeedSamples())

  async function run(baseUrl: string) {
    globalThis.fetch = (async () =>
      sse([
        { choices: [{ delta: { content: 'ok' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], timings: llamaTimings },
      ])) as any
    try {
      const f = createOpenAICompatFetch({ baseUrl, model: 'm', label: 'x', maxTokensParam: 'max_tokens' } as any)
      const res = await f('https://x/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
      })
      await res.json()
    } finally {
      globalThis.fetch = realFetch
    }
    return drainSpeedSamples()
  }

  test('local -> one sample', async () => {
    expect((await run('http://localhost:8082/v1')).length).toBe(1)
  })
  test('remote -> none', async () => {
    expect((await run('https://api.openai.com/v1')).length).toBe(0)
  })
})
