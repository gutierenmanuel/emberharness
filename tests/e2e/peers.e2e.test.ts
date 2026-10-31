/**
 * Sessions talking to each other and subagents that always answer their parent,
 * against the real ./cli with fake OpenAI-compatible backends:
 *  - a headless session A stays alive on stream-json input with its UDS inbox;
 *  - `/peers` from another process lists it with its pid, `/peers send` reaches it;
 *  - a session B whose model calls ListPeers and then SendMessage(peer:<pid>) reaches it;
 *  - a subagent that ends its turn with no text is asked once for its report,
 *    and the parent receives that report as the Agent result.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, hasCli, makeSandbox } from './harness.js'

type Msg = { role: string; content?: unknown }
type Body = { model?: string; messages?: Msg[] }
type Plan = { text?: string; tool?: { name: string; args: unknown } }

const text = (m: Msg | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? '').join('\n') : ''
// Conversation text without the system prompt, which itself mentions the tags.
const allText = (b: Body) => (b.messages ?? []).filter(m => m.role !== 'system').map(text).join('\n')
const toolResults = (b: Body) => (b.messages ?? []).filter(m => m.role === 'tool').map(text)

function sse(model: string, delta: object, finish: string): string {
  const chunk = (d: object, f: string | null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`
  return (
    chunk({ role: 'assistant' }, null) +
    chunk(delta, null) +
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

function fakeServer(model: string, plan: (b: Body) => Plan) {
  const requests: Body[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: model, object: 'model' }] })
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const body = (await req.json()) as Body
      requests.push(body)
      const p = plan(body)
      const out = p.tool
        ? sse(model, { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }, 'tool_calls')
        : sse(model, { content: p.text ?? '' }, 'stop')
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

async function waitFor(fn: () => boolean, ms = 30_000) {
  const end = Date.now() + ms
  while (!fn() && Date.now() < end) await Bun.sleep(200)
  return fn()
}

let pidA = 0
const server = fakeServer('model-a', b => {
  const all = allText(b)
  const results = toolResults(b)
  // Session A: answers whatever a peer sends it.
  if (all.includes('<cross-session-message')) return { text: 'A_GOT_PEER_MESSAGE' }
  // Session B: ListPeers, then SendMessage to A, then done.
  if (all.includes('HABLA_CON_A')) {
    if (results.length === 0) return { tool: { name: 'ListPeers', args: {} } }
    if (results.length === 1) return { tool: { name: 'SendMessage', args: { to: `peer:${pidA}`, message: 'PING_DESDE_B_POR_TOOL' } } }
    return { text: 'B_DONE' }
  }
  // Subagent: first an empty turn, then the report once it is asked for it.
  if (all.includes('SUB_TASK')) {
    if (all.includes('only sees your final text message')) return { text: 'SUB_REPORT_42' }
    return { text: '' }
  }
  // Main thread of the subagent test.
  if (all.includes('LANZA_SUB')) {
    if (results.length === 0) {
      return { tool: { name: 'Agent', args: { description: 'sub mudo', prompt: 'SUB_TASK', subagent_type: 'general-purpose', model: 'accta:model-a' } } }
    }
    return { text: 'MAIN_DONE' }
  }
  return { text: 'ok' }
})

afterAll(() => server.stop())

function sandboxEnv() {
  const { configDir, cwd } = makeSandbox()
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({ active: 'accta', accounts: { accta: { provider: 'custom', baseUrl: server.baseUrl, model: 'model-a' } } }),
  )
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir, FNHARNESS_DISABLE_MODELS_FETCH: '1', FNHARNESS_CONTEXT_PROFILE: 'full' }
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k]
  for (const k of ['CLAUDE_MULTIMODEL_PROVIDER', 'CLAUDE_MULTIMODEL_ACCOUNT', 'CLAUDE_MULTIMODEL_BASE_URL', 'CLAUDE_MULTIMODEL_MODEL', 'FNHARNESS_ACCOUNT', 'ANTHROPIC_MODEL', 'TMUX']) delete env[k]
  return { configDir, cwd, env }
}

// Async on purpose: spawnSync would block this process, and with it the fake backend.
async function run(env: Record<string, string | undefined>, cwd: string, prompt: string) {
  const p = Bun.spawn([CLI, '-p', prompt], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  await p.exited
  return { out, err }
}

describe.skipIf(!hasCli)('peers e2e', () => {
  test('sessions list each other by pid and exchange messages through /peers and the tools', async () => {
    const { configDir, cwd, env } = sandboxEnv()
    const a = Bun.spawn([CLI, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    pidA = a.pid
    let outA = ''
    void (async () => {
      const reader = a.stdout.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        outA += dec.decode(value)
      }
    })()
    try {
      const pidFile = join(configDir, 'sessions', `${a.pid}.json`)
      const socketOf = () => {
        try {
          return (JSON.parse(readFileSync(pidFile, 'utf8')) as { messagingSocketPath?: string }).messagingSocketPath ?? ''
        } catch {
          return ''
        }
      }
      expect(await waitFor(() => socketOf() !== '' && existsSync(socketOf()))).toBe(true)

      // /peers from another process lists A with its pid and address.
      const listed = await run(env, cwd, '/peers')
      expect(listed.out).toContain(`pid ${a.pid}`)
      expect(listed.out).toContain(`uds:${socketOf()}`)

      // /peers send reaches A, which answers it as a new turn.
      const sent = await run(env, cwd, `/peers send ${a.pid} HOLA_DESDE_PEERS`)
      expect(sent.out).toContain('Sent to')
      expect(await waitFor(() => server.requests.some(b => allText(b).includes('HOLA_DESDE_PEERS')))).toBe(true)
      const req = server.requests.find(b => allText(b).includes('HOLA_DESDE_PEERS'))!
      expect(allText(req)).toMatch(/<cross-session-message from="uds:[^"]+" pid="\d+"/)
      expect(await waitFor(() => outA.includes('A_GOT_PEER_MESSAGE'))).toBe(true)

      // A model in session B finds A with ListPeers and messages it with SendMessage.
      const b = await run(env, cwd, 'HABLA_CON_A')
      if (!b.out.includes('B_DONE')) console.error('B stdout:', b.out.slice(0, 2000), '\nB stderr:', b.err.slice(0, 2000))
      const bReqs = server.requests.filter(r => allText(r).includes('HABLA_CON_A'))
      expect(toolResults(bReqs.at(-1)!).join('\n')).toContain(`pid ${a.pid}`)
      expect(toolResults(bReqs.at(-1)!).join('\n')).toContain('PING_DESDE_B_POR_TOOL')
      expect(b.out).toContain('B_DONE')
      expect(await waitFor(() => server.requests.some(r => allText(r).includes('<cross-session-message') && allText(r).includes('PING_DESDE_B_POR_TOOL')))).toBe(true)
    } finally {
      a.kill()
      await a.exited
    }
  }, 120_000)

  test('a subagent that ends without text is asked for its report and the parent gets it', async () => {
    const { cwd, env } = sandboxEnv()
    const r = await run(env, cwd, 'LANZA_SUB ahora')
    if (!r.out.includes('MAIN_DONE')) console.error('stdout:', r.out.slice(0, 2000), '\nstderr:', r.err.slice(0, 2000))
    const subReqs = server.requests.filter(b => allText(b).includes('SUB_TASK') && !allText(b).includes('LANZA_SUB'))
    expect(subReqs.length).toBe(2)
    expect(allText(subReqs[1]!)).toContain('only sees your final text message')
    const last = server.requests.filter(b => allText(b).includes('LANZA_SUB')).at(-1)!
    expect(toolResults(last).join('\n')).toContain('SUB_REPORT_42')
    expect(r.out).toContain('MAIN_DONE')
  }, 100_000)
})
