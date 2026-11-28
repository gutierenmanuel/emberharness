/**
 * The inverse of accountRouting.e2e: the SESSION runs on an OpenAI-compatible
 * account (`zcode`, GLM, multimodel profile live in process.env) and the model
 * launches a subagent on `claude:opus`. Two fake servers stand in for z.ai and
 * Anthropic and record every request, so the tests prove:
 *
 *  - the subagent reaches the Anthropic server with the Claude token and an
 *    Opus model, and nothing of it reaches zcode;
 *  - every request of the main thread, before, during and after the child,
 *    keeps going to zcode with the GLM model (the session never "becomes opus");
 *  - the cost of each side is priced on its own account and model;
 *  - in the TUI, the status line of the session describes zcode/GLM (its
 *    window, no Claude 5h/7d windows), the viewed child describes claude/opus
 *    with its own limits, and leaving the view goes back to zcode; the agent
 *    panel row reads `· claude:claude-opus-… ·`.
 *
 * Variants: a child on another OpenAI-compatible account and a child on the
 * session's own account with another model.
 *
 * The fake token is a random test string; nothing here prints a header.
 * No request ever leaves 127.0.0.1.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, hasCli, makeSandbox } from './harness.js'
import { startTui } from './tui.js'

type OaMsg = { role: string; content?: unknown; tool_calls?: unknown }
type OaBody = { model?: string; stream?: boolean; messages?: OaMsg[] }
type AnMsg = { role: string; content?: unknown }
type AnBody = { model?: string; stream?: boolean; messages?: AnMsg[]; system?: unknown }

const GLM = 'glm-5.3-flash'
const N_CTX = 32768
const random = () => Math.random().toString(36).slice(2)
const TOKEN = `fake-claude-${random()}`

const oaText = (m: OaMsg | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? '').join('\n') : ''
const anText = (m: AnMsg | undefined): string => {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content
    .map((p: { type?: string; text?: string; content?: unknown }) =>
      p.type === 'tool_result' ? `[tool_result] ${typeof p.content === 'string' ? p.content : JSON.stringify(p.content)}` : (p.text ?? ''),
    )
    .join('\n')
}
/** Every user message of a conversation, joined: what tells a main-thread request from a subagent's. */
const userText = (msgs: Array<{ role: string }> | undefined, text: (m: any) => string) =>
  (msgs ?? []).filter(m => m.role === 'user').map(text).join('\n')

type Plan = { text?: string; tool?: { name: string; args: unknown }; delayMs?: number }

/** Fake OpenAI-compatible server (z.ai stand-in): records model and messages, answers /props like llama.cpp. */
function fakeOpenAI(model: string, plan: (b: OaBody) => Plan) {
  const requests: OaBody[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/props') return Response.json({ default_generation_settings: { n_ctx: N_CTX } })
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: model, object: 'model' }] })
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const body = (await req.json()) as OaBody
      requests.push(body)
      const p = plan(body)
      if (p.delayMs) await Bun.sleep(p.delayMs)
      const m = body.model ?? model
      const chunk = (d: object, f: string | null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: m, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`
      const delta = p.tool
        ? { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }
        : { content: p.text ?? '' }
      if (body.stream === false) {
        return Response.json({
          id: 'c',
          object: 'chat.completion',
          model: m,
          choices: [{ index: 0, message: { role: 'assistant', content: p.text ?? 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        })
      }
      const out =
        chunk({ role: 'assistant' }, null) +
        chunk(delta, null) +
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: m, choices: [{ index: 0, delta: {}, finish_reason: p.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n` +
        'data: [DONE]\n\n'
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

type Seen = { model?: string; tokenOk: boolean; text: string; user: string; path: string }

/** Fake Anthropic API: records model, token match (never its value) and text; sends 5h/7d windows. */
function fakeAnthropic(plan: (b: AnBody) => Plan) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const tokenOk = req.headers.get('authorization') === `Bearer ${TOKEN}`
      if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
      if (!url.pathname.endsWith('/v1/messages')) {
        seen.push({ tokenOk, text: '', user: '', path: url.pathname })
        return new Response(null, { status: 404 })
      }
      const body = (await req.json()) as AnBody
      seen.push({ model: body.model, tokenOk, text: (body.messages ?? []).map(anText).join('\n'), user: userText(body.messages, anText), path: url.pathname })
      const p = plan(body)
      if (p.delayMs) await Bun.sleep(p.delayMs)
      const model = body.model ?? 'claude-fake'
      const now = Math.floor(Date.now() / 1000)
      const headers = {
        'content-type': body.stream === false ? 'application/json' : 'text/event-stream',
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': String(now + 3600),
        'anthropic-ratelimit-unified-7d-utilization': '0.17',
        'anthropic-ratelimit-unified-7d-reset': String(now + 86400),
      }
      const usage = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      if (body.stream === false) {
        return new Response(
          JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: p.text ?? 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage }),
          { headers },
        )
      }
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
      let out = ev('message_start', { message: { id: `msg_${random()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
      if (p.tool) {
        out += ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${random()}`, name: p.tool.name, input: {} } })
        out += ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.tool.args) } })
      } else {
        out += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        out += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: p.text ?? '' } })
      }
      out += ev('content_block_stop', { index: 0 })
      out += ev('message_delta', { delta: { stop_reason: p.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } })
      out += ev('message_stop', {})
      return new Response(out, { headers })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

/** Config dir: session on `zcode` (OpenAI-compatible), `claude` (root OAuth) on the fake Anthropic, plus extras. */
function sandbox(zcodeUrl: string, claudeUrl: string, extra: Record<string, object> = {}) {
  const { configDir, cwd } = makeSandbox()
  const far = Date.now() + 30 * 24 * 3600 * 1000
  writeFileSync(
    join(configDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: `r-${random()}`, expiresAt: far, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: null } }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      active: 'zcode',
      accounts: {
        zcode: { provider: 'custom', label: 'Z.ai GLM (fake)', baseUrl: zcodeUrl, apiKey: 'fake-zcode-key', model: GLM, smallModel: GLM },
        claude: { kind: 'anthropic', label: 'Claude (Anthropic)', baseUrl: claudeUrl },
        ...extra,
      },
    }),
    { mode: 0o600 },
  )
  return { configDir, cwd }
}

function cleanEnv(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: configDir, FNHARNESS_DISABLE_MODELS_FETCH: '1', FNHARNESS_CONTEXT_PROFILE: 'full' }
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_MULTIMODEL_') || k.startsWith('ANTHROPIC_') || k.startsWith('OTEL_')) delete env[k]
  }
  for (const k of ['CLAUDECODE', 'FNHARNESS_ACCOUNT', 'TMUX', 'TMUX_PANE', 'DISABLE_TELEMETRY']) delete env[k]
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  // A default subagent model must not override the explicit cuenta:modelo.
  env.CLAUDE_CODE_SUBAGENT_MODEL = 'sonnet'
  return env
}

const servers: Array<{ stop: () => void }> = []
afterAll(() => {
  for (const s of servers) s.stop()
})

async function runPrint(env: Record<string, string | undefined>, cwd: string, prompt: string) {
  const proc = Bun.spawn([CLI, '-p', prompt, '--output-format', 'json'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  await proc.exited
  let json: any = null
  try {
    json = JSON.parse(out.trim().split('\n').at(-1) ?? '')
  } catch {}
  return { out, err, json }
}

describe.skipIf(!hasCli)('session on zcode, subagent on claude:opus e2e', () => {
  test('the child reaches Anthropic as opus; every main-thread request stays on zcode with GLM; costs per account', async () => {
    const zc = fakeOpenAI(GLM, b => {
      const msgs = b.messages ?? []
      if (!userText(msgs, oaText).includes('LANZA_OPUS')) return { text: 'ok' }
      if (msgs.some(m => m.role === 'tool')) return { text: 'MAIN_DONE' }
      return { tool: { name: 'Agent', args: { description: 'sub en opus', prompt: 'SUB_OPUS di hola', subagent_type: 'general-purpose', model: 'claude:opus', run_in_background: false } } }
    })
    const an = fakeAnthropic(() => ({ text: 'SUB_DONE_FROM_OPUS' }))
    servers.push(zc, an)
    const { configDir, cwd } = sandbox(zc.baseUrl, an.baseUrl)
    const { out, err, json } = await runPrint(cleanEnv(configDir), cwd, 'LANZA_OPUS ahora')
    if (!out.includes('MAIN_DONE')) console.error('stdout:', out.slice(0, 2000), '\nstderr:', err.slice(0, 2000))

    const msgs = an.seen.filter(s => s.path.endsWith('/v1/messages'))
    const sub = msgs.filter(s => s.user.includes('SUB_OPUS'))
    // The child ran on Anthropic, with the Claude token, as an Opus model with the prefix gone.
    expect(sub.length).toBeGreaterThan(0)
    expect(sub.every(s => s.tokenOk && !!s.model && !s.model.includes(':') && /opus/.test(s.model))).toBe(true)
    // Anthropic never saw a main-thread request.
    expect(msgs.some(s => s.user.includes('LANZA_OPUS'))).toBe(false)
    // Every request zcode got is on GLM, the main thread before AND after the child.
    expect(zc.requests.every(b => b.model === GLM)).toBe(true)
    const main = zc.requests.filter(b => userText(b.messages, oaText).includes('LANZA_OPUS'))
    expect(main.length).toBeGreaterThanOrEqual(2)
    expect(main.some(b => (b.messages ?? []).some(m => m.role === 'tool' && oaText(m).includes('SUB_DONE_FROM_OPUS')))).toBe(true)
    // Nothing of the child went to zcode.
    expect(zc.requests.some(b => userText(b.messages, oaText).includes('SUB_OPUS'))).toBe(false)
    expect(out).toContain('MAIN_DONE')

    // Cost: the child's usage is keyed and priced as Opus; GLM's under its own id; no prefixed keys.
    const usage = (json?.modelUsage ?? {}) as Record<string, { costUSD: number; inputTokens: number }>
    const keys = Object.keys(usage)
    const opusKey = keys.find(k => /opus/.test(k))
    expect(opusKey).toBeDefined()
    expect(keys.some(k => k.includes(':'))).toBe(false)
    // 1000 input + 100 output tokens per child request at Opus prices (>= $5/$25 per Mtok).
    expect(usage[opusKey!]!.costUSD).toBeGreaterThan(0.0005 * sub.length)
    if (usage[GLM]) expect(usage[GLM]!.costUSD).toBe(0) // local fake server: free
    expect(json.total_cost_usd).toBeCloseTo(Object.values(usage).reduce((a, u) => a + u.costUSD, 0), 6)
    expect(out + err).not.toContain(TOKEN)
  }, 100_000)

  test('child on another OpenAI-compatible account, and child on zcode with another model', async () => {
    const zc = fakeOpenAI(GLM, b => {
      const msgs = b.messages ?? []
      const users = userText(msgs, oaText)
      if (users.includes('SUB_MISMA')) return { text: 'SUB_DONE_MISMA' }
      if (!users.includes('LANZA_DOS')) return { text: 'ok' }
      const tools = msgs.filter(m => m.role === 'tool').length
      if (tools === 0) return { tool: { name: 'Agent', args: { description: 'sub en otra', prompt: 'SUB_OTRA di hola', subagent_type: 'general-purpose', model: 'acctv:model-v', run_in_background: false } } }
      if (tools === 1) return { tool: { name: 'Agent', args: { description: 'sub misma', prompt: 'SUB_MISMA di hola', subagent_type: 'general-purpose', model: 'zcode:glm-5.4', run_in_background: false } } }
      return { text: 'MAIN_DONE' }
    })
    const v = fakeOpenAI('model-v', () => ({ text: 'SUB_DONE_OTRA' }))
    const an = fakeAnthropic(() => ({ text: 'NO_DEBERIA' }))
    servers.push(zc, v, an)
    const { configDir, cwd } = sandbox(zc.baseUrl, an.baseUrl, { acctv: { provider: 'custom', baseUrl: v.baseUrl, apiKey: 'fake-v', model: 'model-v' } })
    const { out, err } = await runPrint(cleanEnv(configDir), cwd, 'LANZA_DOS ahora')
    if (!out.includes('MAIN_DONE')) console.error('stdout:', out.slice(0, 2000), '\nstderr:', err.slice(0, 2000))
    expect(out).toContain('MAIN_DONE')
    // The other account served its child, with its model.
    const otra = v.requests.filter(b => userText(b.messages, oaText).includes('SUB_OTRA'))
    expect(otra.length).toBeGreaterThan(0)
    expect(v.requests.every(b => b.model === 'model-v')).toBe(true)
    // Same account, other model: the child on glm-5.4, the main thread always on GLM 5.3.
    const misma = zc.requests.filter(b => userText(b.messages, oaText).includes('SUB_MISMA'))
    expect(misma.length).toBeGreaterThan(0)
    expect(misma.every(b => b.model === 'glm-5.4')).toBe(true)
    const main = zc.requests.filter(b => userText(b.messages, oaText).includes('LANZA_DOS'))
    expect(main.length).toBeGreaterThanOrEqual(3)
    expect(main.every(b => b.model === GLM)).toBe(true)
    expect(zc.requests.some(b => userText(b.messages, oaText).includes('SUB_OTRA'))).toBe(false)
    expect(an.seen.filter(s => s.path.endsWith('/v1/messages'))).toHaveLength(0)
  }, 100_000)
})

async function waitForDump(path: string, ok: (j: any) => boolean, ms = 30_000): Promise<any> {
  const end = Date.now() + ms
  let last: any = null
  while (Date.now() < end) {
    if (existsSync(path)) {
      try {
        last = JSON.parse(readFileSync(path, 'utf8'))
        if (ok(last)) return last
      } catch {}
    }
    await Bun.sleep(200)
  }
  throw new Error(`statusLine input never matched; last: ${JSON.stringify(last)?.slice(0, 1500)}`)
}

describe.skipIf(!hasCli)('status line and panel: session zcode, background child claude:opus e2e', () => {
  test('session line stays zcode/GLM, the viewed child is claude/opus with its limits, leaving goes back', async () => {
    const zc = fakeOpenAI(GLM, b => {
      const msgs = b.messages ?? []
      const users = userText(msgs, oaText)
      if (msgs.some(m => m.role === 'user' && oaText(m).includes('SIGUE_MADRE'))) return { text: 'MADRE_SIGUE_EN_GLM' }
      if (!users.includes('LANZA_BG')) return { text: 'ok' }
      if (msgs.some(m => m.role === 'tool')) return { text: 'MAIN_LANZADO' }
      return { tool: { name: 'Agent', args: { description: 'opus en fondo', prompt: 'SUB_BG trabaja', subagent_type: 'general-purpose', model: 'claude:opus', run_in_background: true } } }
    })
    let childTurns = 0
    const an = fakeAnthropic(b => {
      if (!userText(b.messages, anText).includes('SUB_BG')) return { text: 'ok' }
      childTurns++
      // First turn answers at once (its 5h/7d headers arrive), the second stays open while we look.
      const hasResult = (b.messages ?? []).some(m => Array.isArray(m.content) && m.content.some((p: { type?: string }) => p.type === 'tool_result'))
      return hasResult ? { text: 'SUB_BG_HECHO', delayMs: 25_000 } : { tool: { name: 'Read', args: { file_path: '/nonexistent-fnh-e2e/x.txt' } } }
    })
    servers.push(zc, an)
    const { configDir, cwd } = sandbox(zc.baseUrl, an.baseUrl)
    const dump = join(configDir, 'statusline.json')
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `cat > ${dump}.tmp && mv ${dump}.tmp ${dump}`, refreshInterval: 1 } }))
    const tui = startTui(cleanEnv(configDir), cwd, 140)
    try {
      await tui.waitFor('❯', 20_000)
      await Bun.sleep(1500)
      tui.line('LANZA_BG ya')
      // Panel row of the child: name · claude:claude-opus-… · task.
      await tui.waitFor(/general-purpose · claude:claude-opus-[^·]*· opus en fondo/, 30_000)
      // Wait until the child's first response (with its Claude windows) is in.
      const end = Date.now() + 20_000
      while (childTurns < 2 && Date.now() < end) await Bun.sleep(200)
      expect(childTurns).toBeGreaterThanOrEqual(2)
      await Bun.sleep(1500)

      // Session view: zcode, GLM, the server's window, no Claude limits.
      const s1 = await waitForDump(dump, j => j.fnharness?.account?.id === 'zcode' && !j.agent?.viewed && j.context_window?.context_window_size === N_CTX)
      expect(s1.model.id).toBe(GLM)
      expect(s1.fnharness.account).toMatchObject({ id: 'zcode', provider: 'custom', model: GLM })
      expect(s1.fnharness.context).toMatchObject({ window: N_CTX, source: 'server' })
      expect(s1.rate_limits).toBeUndefined()

      // Enter the child's view: down to the panel, down to the agent, Enter.
      tui.type('\u001b[B')
      await Bun.sleep(400)
      tui.type('\u001b[B')
      await Bun.sleep(400)
      tui.type('\r')
      const c = await waitForDump(dump, j => j.agent?.viewed === true, 15_000)
      expect(c.model.id).toMatch(/^claude-opus-/)
      expect(c.fnharness.account).toMatchObject({ id: 'claude', provider: null, model: c.model.id })
      expect(c.fnharness.context.source).toBe('claude')
      expect(c.context_window.context_window_size).toBeGreaterThanOrEqual(200_000)
      expect(c.rate_limits?.five_hour?.used_percentage).toBeCloseTo(42, 3)
      expect(c.rate_limits?.seven_day?.used_percentage).toBeCloseTo(17, 3)
      // 1000 in + 100 out at Opus prices per child turn.
      expect(c.cost.total_cost_usd).toBeGreaterThan(0.0005)

      // Leave the view: back to the session line.
      tui.type('\u001b[A')
      await Bun.sleep(400)
      tui.type('\r')
      const s2 = await waitForDump(dump, j => !j.agent?.viewed, 15_000)
      expect(s2.fnharness.account.id).toBe('zcode')
      expect(s2.model.id).toBe(GLM)
      expect(s2.context_window.context_window_size).toBe(N_CTX)
      expect(s2.rate_limits).toBeUndefined()

      // The session speaks again while the child is still running: on zcode, with GLM.
      tui.type('\u001b')
      await Bun.sleep(400)
      tui.line('SIGUE_MADRE por favor')
      await tui.waitFor('MADRE_SIGUE_EN_GLM', 20_000)
      const madre = zc.requests.filter(b => (b.messages ?? []).some(m => m.role === 'user' && oaText(m).includes('SIGUE_MADRE')))
      expect(madre.length).toBeGreaterThanOrEqual(1)
      expect(zc.requests.every(b => b.model === GLM)).toBe(true)
      expect(an.seen.filter(s => s.path.endsWith('/v1/messages')).every(s => !s.text.includes('SIGUE_MADRE'))).toBe(true)
      expect(tui.text()).not.toContain(TOKEN)
    } finally {
      writeFileSync(join(configDir, 'tui-capture.txt'), tui.text())
      await tui.stop()
    }
  }, 120_000)
})
