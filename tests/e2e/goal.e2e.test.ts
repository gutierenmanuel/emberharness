/**
 * /goal end to end in headless mode: a scripted OpenAI-compatible backend plays
 * both the agent (one Bash call, then a text answer) and the judge (first
 * "not_met", then "met"), so the goal must drive a second agent turn.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CLI, FAKE_MODEL, fakeEnv, hasCli, makeSandbox } from './harness.js'

type Req = { messages: Array<{ role: string; content?: unknown }>; stream?: boolean }

const text = (m?: { content?: unknown }): string =>
  typeof m?.content === 'string'
    ? m.content
    : Array.isArray(m?.content)
      ? m!.content.map((p: { text?: string }) => p.text ?? '').join('\n')
      : ''

function sse(deltas: object[], finish: string): string {
  const chunk = (delta: object, fin: string | null) =>
    `data: ${JSON.stringify({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: FAKE_MODEL,
      choices: [{ index: 0, delta, finish_reason: fin }],
    })}\n\n`
  return (
    deltas.map(d => chunk(d, null)).join('') +
    chunk({}, finish) +
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: FAKE_MODEL, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

function startScripted(judgeAnswers: string[]) {
  const agent: Req[] = []
  const judge: Req[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) {
        return Response.json({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] })
      }
      if (!url.pathname.endsWith('/chat/completions')) return new Response('nf', { status: 404 })
      const body = (await req.json()) as Req
      const sys = text(body.messages.find(m => m.role === 'system'))
      let reply: { content?: string; tool?: boolean }
      if (sys.includes('strict, impartial evaluator')) {
        judge.push(body)
        reply = { content: judgeAnswers[Math.min(judge.length - 1, judgeAnswers.length - 1)]! }
      } else {
        agent.push(body)
        const last = body.messages[body.messages.length - 1]!
        reply = last.role === 'tool' ? { content: `listo ${agent.length}` } : { tool: true }
      }
      if (body.stream === false) {
        return Response.json({
          id: 'x',
          object: 'chat.completion',
          model: FAKE_MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: reply.content ?? '' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        })
      }
      const stream = reply.tool
        ? sse(
            [
              { role: 'assistant', tool_calls: [{ index: 0, id: `call_${agent.length}`, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo goal-step', description: 'step' }) } }] },
            ],
            'tool_calls',
          )
        : sse([{ role: 'assistant', content: reply.content }], 'stop')
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, agent, judge, stop: () => server.stop(true) }
}

async function runP(prompt: string, baseUrl: string, extra: string[] = []) {
  const { configDir, cwd } = makeSandbox()
  const proc = Bun.spawn([CLI, '-p', prompt, '--allowedTools', 'Bash', ...extra], {
    cwd,
    env: fakeEnv(baseUrl, configDir),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 90_000,
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

describe.skipIf(!hasCli)('/goal e2e (-p)', () => {
  let met: ReturnType<typeof startScripted>
  let idle: ReturnType<typeof startScripted>
  beforeAll(() => {
    met = startScripted([
      '{"status":"not_met","reason":"falta verificar"}',
      '{"status":"met","reason":"verificado"}',
    ])
    idle = startScripted(['{"status":"not_met","reason":"sigue sin cumplirse"}'])
  })
  afterAll(() => {
    met.stop()
    idle.stop()
  })

  test('keeps working until the judge says met', async () => {
    const out = await runP('/goal crear el fichero listo --turns 5', met.baseUrl)
    expect(met.judge.length).toBe(2)
    expect(met.agent.length).toBeGreaterThanOrEqual(3)
    // The second agent turn received the judge's feedback.
    const fed = JSON.stringify(met.agent[met.agent.length - 1])
    expect(fed).toContain('falta verificar')
    expect(out.length).toBeGreaterThan(0)
  }, 100_000)

  test('stops at the turn cap when the judge never agrees', async () => {
    await runP('/goal imposible de cumplir --turns 2', idle.baseUrl)
    expect(idle.judge.length).toBe(2)
  }, 100_000)
})

