/**
 * Local-model speed line end to end. The fake backend listens on 127.0.0.1 (so
 * the profile counts as local) and sends llama-server style `timings` in its
 * last chunk, so the built ./cli must show the line in the TUI and add a
 * `local_speed` object to `-p --output-format json`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CLI, FAKE_MODEL, fakeEnv, hasCli, makeSandbox } from './harness.js'
import { startTui } from './tui.js'

const TIMINGS = {
  cache_n: 2800,
  prompt_n: 300,
  prompt_ms: 200,
  predicted_n: 12,
  predicted_ms: 300,
  draft_n: 8,
  draft_n_accepted: 6,
}

let server: ReturnType<typeof Bun.serve>
let baseUrl = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
      }
      if (!url.pathname.endsWith('/chat/completions')) return new Response('nf', { status: 404 })
      const c = (o: object) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: FAKE_MODEL, ...o })}\n\n`
      const body =
        c({ choices: [{ index: 0, delta: { content: 'Hola mundo' }, finish_reason: null }] }) +
        c({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
        c({ choices: [], usage: { prompt_tokens: 3100, completion_tokens: 12, total_tokens: 3112 }, timings: TIMINGS }) +
        'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}/v1`
})
afterAll(() => server.stop(true))

async function runJson(extra: Record<string, string> = {}) {
  const { configDir, cwd } = makeSandbox()
  const proc = Bun.spawn([CLI, '-p', '--output-format', 'json', 'di hola'], {
    cwd,
    env: fakeEnv(baseUrl, configDir, extra),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return JSON.parse(out.trim().split('\n').pop()!)
}

describe.skipIf(!hasCli)('local speed line e2e', () => {
  test('-p json carries local_speed from the server timings', async () => {
    const res = await runJson()
    expect(res.local_speed).toMatchObject({
      requests: 1,
      source: 'server',
      prompt_tokens: 300,
      prompt_cached_tokens: 2800,
      prompt_tokens_per_second: 1500,
      generated_tokens: 12,
      generation_tokens_per_second: 40,
      draft_tokens: 8,
      draft_accepted_tokens: 6,
    })
    expect(res.local_speed.ttft_s).toBeGreaterThanOrEqual(0)
  }, 70_000)

  test('FNHARNESS_LOCAL_SPEED=0 removes it', async () => {
    const res = await runJson({ FNHARNESS_LOCAL_SPEED: '0' })
    expect(res.local_speed).toBeUndefined()
  }, 70_000)

  test('the TUI prints the line under the answer', async () => {
    const { configDir, cwd } = makeSandbox()
    const tui = startTui(fakeEnv(baseUrl, configDir), cwd)
    try {
      await tui.waitFor(/for shortcuts|bypass|simple mode|❯|>/i, 30_000)
      await new Promise(r => setTimeout(r, 2000))
      tui.line('di hola')
      await tui.waitFor('Hola mundo', 30_000)
      await tui.waitFor('especulación75%(6/8)', 15_000)
      const t = tui.text()
      expect(t.replace(/\s+/g, '')).toContain('lectura1500tok/s(300tok,2800encaché)')
      expect(t.replace(/\s+/g, '')).toContain('generación40.0tok/s(12tok)')
    } finally {
      await tui.stop()
    }
  }, 90_000)
})
