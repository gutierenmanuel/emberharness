/**
 * Several Claude (Anthropic OAuth) accounts in one harness, against two fake
 * Anthropic servers. Every account points its `baseUrl` at its own server and
 * carries its own fake token, so each request shows which account sent it.
 *
 * The fake tokens are random test strings; the servers only record whether
 * the Authorization header matched the expected token (never the value), and
 * nothing here prints a header.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, hasCli, makeSandbox, stripAnsi } from './harness.js'

type Msg = { role: string; content?: unknown }
type Body = { model?: string; stream?: boolean; messages?: Msg[] }
type Seen = { model?: string; tokenOk: boolean; hasAuth: boolean; text: string; path: string }

const textOf = (m: Msg | undefined): string => {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content
    .map((p: { type?: string; text?: string; content?: unknown }) =>
      p.type === 'tool_result' ? `[tool_result] ${typeof p.content === 'string' ? p.content : JSON.stringify(p.content)}` : (p.text ?? ''),
    )
    .join('\n')
}
const hasToolResult = (b: Body) =>
  (b.messages ?? []).some(m => Array.isArray(m.content) && m.content.some((p: { type?: string }) => p.type === 'tool_result'))

function sse(model: string, reply: { text?: string; tool?: { name: string; input: unknown } }): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const usage = { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let out = ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } })
  if (reply.tool) {
    out += ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_fake_1', name: reply.tool.name, input: {} } })
    out += ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) } })
  } else {
    out += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    out += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text ?? '' } })
  }
  out += ev('content_block_stop', { index: 0 })
  out += ev('message_delta', { delta: { stop_reason: reply.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
  out += ev('message_stop', {})
  return out
}

/** A fake Anthropic API for one account: /v1/messages plus the managed-settings endpoints. */
function fakeAnthropic(
  token: string,
  plan: (b: Body) => { text?: string; tool?: { name: string; input: unknown } },
  managed: { settings?: object; limits?: object } = {},
) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get('authorization')
      const record = (body: Body) =>
        seen.push({
          model: body.model,
          tokenOk: auth === `Bearer ${token}`,
          hasAuth: !!auth,
          text: (body.messages ?? []).map(textOf).join('\n'),
          path: url.pathname,
        })
      if (url.pathname === '/api/claude_code/settings') {
        record({})
        return managed.settings ? Response.json({ uuid: 'u-1', checksum: 'c-1', settings: managed.settings }) : new Response(null, { status: 404 })
      }
      if (url.pathname === '/api/claude_code/policy_limits') {
        record({})
        return managed.limits ? Response.json(managed.limits) : new Response(null, { status: 404 })
      }
      if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
      if (!url.pathname.endsWith('/v1/messages')) return new Response('not found', { status: 404 })
      const body = (await req.json()) as Body
      record(body)
      const model = body.model ?? 'claude-fake'
      const reply = plan(body)
      if (body.stream === false) {
        return Response.json({
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: reply.text ?? 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 3 },
        })
      }
      return new Response(sse(model, reply), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

const random = () => Math.random().toString(36).slice(2)
const TOKEN_A = `fake-a-${random()}`
const TOKEN_B = `fake-b-${random()}`

/** Config dir with two Claude accounts (A = session, B) and, optionally, an OpenAI-compatible one. */
function sandboxWithAccounts(a: string, b: string, extra: Record<string, object> = {}) {
  const { configDir, cwd } = makeSandbox()
  const far = Date.now() + 30 * 24 * 3600 * 1000
  const account = (id: string, baseUrl: string, token: string, email: string, org: string) => {
    const dir = join(configDir, 'accounts', id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${random()}`, expiresAt: far, scopes: ['user:inference'], subscriptionType: 'team', rateLimitTier: null } }),
      { mode: 0o600 },
    )
    writeFileSync(
      join(dir, 'oauth-account.json'),
      JSON.stringify({ accountUuid: `uuid-${id}`, emailAddress: email, organizationUuid: `org-${id}-0000`, organizationName: org }),
      { mode: 0o600 },
    )
    return { kind: 'anthropic', label: 'Claude (Anthropic)', baseUrl }
  }
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      active: 'claude-a',
      accounts: {
        'claude-a': account('claude-a', a, TOKEN_A, 'ana@empresa-a.test', 'Empresa A'),
        'claude-b': account('claude-b', b, TOKEN_B, 'beto@empresa-b.test', 'Empresa B'),
        ...extra,
      },
    }),
    { mode: 0o600 },
  )
  return { configDir, cwd }
}

function cleanEnv(configDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: configDir,
    FNHARNESS_DISABLE_MODELS_FETCH: '1',
    FNHARNESS_CONTEXT_PROFILE: 'full',
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_MULTIMODEL_') || k.startsWith('ANTHROPIC_') || k.startsWith('OTEL_')) delete env[k]
  }
  for (const k of ['CLAUDECODE', 'FNHARNESS_ACCOUNT', 'TMUX', 'DISABLE_TELEMETRY']) delete env[k]
  // Only the fake servers: no update checks, no other first-party traffic.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}

const servers: Array<{ stop: () => void }> = []
afterAll(() => {
  for (const s of servers) s.stop()
})

describe.skipIf(!hasCli)('several Claude accounts e2e', () => {
  test('each request carries its account token; a subagent claude-b:sonnet reaches B with B token', async () => {
    const a = fakeAnthropic(TOKEN_A, b => {
      if (hasToolResult(b)) return { text: 'MAIN_DONE' }
      const last = (b.messages ?? []).at(-1)
      if (textOf(last).includes('LANZA_SUB')) {
        return { tool: { name: 'Agent', input: { description: 'sub en B', prompt: 'SUB_TASK di hola', subagent_type: 'general-purpose', model: 'claude-b:sonnet' } } }
      }
      return { text: 'ok' }
    })
    const b = fakeAnthropic(TOKEN_B, () => ({ text: 'SUB_DONE_FROM_B' }))
    servers.push(a, b)
    const { configDir, cwd } = sandboxWithAccounts(a.baseUrl, b.baseUrl)
    const env = cleanEnv(configDir)
    env.CLAUDE_CODE_SUBAGENT_MODEL = 'sonnet'
    const proc = Bun.spawn([CLI, '-p', 'LANZA_SUB ahora'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    await proc.exited
    if (!out.includes('MAIN_DONE')) console.error('stdout:', out.slice(0, 1500), '\nstderr:', err.slice(0, 1500))

    const aMsgs = a.seen.filter(s => s.path.endsWith('/v1/messages'))
    const bMsgs = b.seen.filter(s => s.path.endsWith('/v1/messages'))
    // The main thread stayed on A, with A's token only.
    expect(aMsgs.length).toBeGreaterThanOrEqual(2)
    expect(aMsgs.every(s => s.tokenOk)).toBe(true)
    // The subagent reached B, with B's token, with the account prefix gone.
    const sub = bMsgs.filter(s => s.text.includes('SUB_TASK'))
    expect(sub.length).toBeGreaterThan(0)
    expect(sub.every(s => s.tokenOk)).toBe(true)
    expect(sub.every(s => !!s.model && !s.model.includes(':') && /sonnet/.test(s.model))).toBe(true)
    // Nothing of the subagent went to A, and no request of A went to B.
    expect(aMsgs.some(s => s.text.includes('SUB_TASK') && !s.text.includes('LANZA_SUB'))).toBe(false)
    expect(bMsgs.some(s => s.text.includes('LANZA_SUB'))).toBe(false)
    // A got B's answer back as the tool result.
    expect(aMsgs.at(-1)!.text).toContain('SUB_DONE_FROM_B')
    expect(out).toContain('MAIN_DONE')
    // No token ever reaches the output.
    expect(out + err).not.toContain(TOKEN_A)
    expect(out + err).not.toContain(TOKEN_B)
  }, 100_000)

  test('--perfil with a Claude account and model starts on that account with that model', async () => {
    const a = fakeAnthropic(TOKEN_A, () => ({ text: 'FROM_A' }))
    const b = fakeAnthropic(TOKEN_B, () => ({ text: 'FROM_B' }))
    servers.push(a, b)
    const { configDir, cwd } = sandboxWithAccounts(a.baseUrl, b.baseUrl)
    mkdirSync(join(configDir, 'profiles'))
    writeFileSync(join(configDir, 'profiles', 'emp.json'), JSON.stringify({ account: 'claude-b', model: 'haiku' }))
    const env = cleanEnv(configDir)
    const proc = Bun.spawn([CLI, '--perfil', 'emp', '-p', 'di hola'], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const bMsgs = b.seen.filter(s => s.path.endsWith('/v1/messages') && s.text.includes('di hola'))
    expect(out).toContain('FROM_B')
    expect(bMsgs.length).toBeGreaterThan(0)
    expect(bMsgs.every(s => s.tokenOk && /haiku/.test(s.model ?? ''))).toBe(true)
    expect(a.seen.filter(s => s.path.endsWith('/v1/messages') && s.text.includes('di hola'))).toHaveLength(0)
  }, 100_000)

  test('/account list shows who each of 3 accounts is (pseudo-terminal)', async () => {
    const a = fakeAnthropic(TOKEN_A, () => ({ text: 'ok' }))
    const b = fakeAnthropic(TOKEN_B, () => ({ text: 'ok' }))
    const local = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ object: 'list', data: [{ id: 'model-c' }] }) })
    servers.push(a, b, { stop: () => local.stop(true) })
    const { configDir, cwd } = sandboxWithAccounts(a.baseUrl, b.baseUrl, {
      acctc: { provider: 'custom', baseUrl: `http://127.0.0.1:${local.port}/v1`, model: 'model-c', label: 'Servidor C' },
    })
    const env = { ...cleanEnv(configDir), COLUMNS: '120', LINES: '45', TERM: 'xterm-256color' }
    const proc = Bun.spawn(['script', '-qc', `stty cols 120 rows 45 2>/dev/null; timeout 14 ${CLI}`, '/dev/null'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const send = (t: string, ms: number) =>
      setTimeout(() => {
        proc.stdin.write(t)
        proc.stdin.flush()
      }, ms)
    send('/account list', 5000)
    send('\r', 5600)
    const out = stripAnsi(await new Response(proc.stdout).text())
    await proc.exited
    const flat = out.replace(/\s+/g, '')
    const has = (t: string) => expect(flat).toContain(t.replace(/\s+/g, ''))
    has('── claude-a · Claude (Anthropic) ● sesión')
    has('ana@empresa-a.test · Empresa A (org org-…) · plan Team')
    has('── claude-b · Claude (Anthropic)')
    has('beto@empresa-b.test · Empresa B')
    has('── acctc · Servidor C')
    expect(flat).toMatch(/✓responde/)
    expect(flat).toMatch(/✓lista/)
    writeFileSync(join(configDir, 'panel-capture.txt'), out)
    expect(out).not.toContain(TOKEN_A)
    expect(out).not.toContain(TOKEN_B)
  }, 30_000)

  test('new dangerous settings of B wait for /account approve; rejecting them disables B and the session on A goes on (pseudo-terminal)', async () => {
    const a = fakeAnthropic(TOKEN_A, b => {
      const last = textOf((b.messages ?? []).at(-1))
      if (last.includes('SEGUIMOS')) return { text: 'SEGUIMOS_EN_A' }
      if (last.includes('LANZA_B')) {
        return { tool: { name: 'Agent', input: { description: 'sub en B', prompt: 'SUB_RECHAZO', subagent_type: 'general-purpose', model: 'claude-b:sonnet' } } }
      }
      return { text: 'MAIN_SIGUE_VIVA' }
    })
    // B's organisation brings a dangerous setting (an env var outside the safe list).
    const b = fakeAnthropic(TOKEN_B, () => ({ text: 'NO_DEBERIA_LLEGAR' }), { settings: { env: { FNH_E2E_PELIGROSA: '1' } } })
    servers.push(a, b)
    const { configDir, cwd } = sandboxWithAccounts(a.baseUrl, b.baseUrl)
    const env = { ...cleanEnv(configDir), COLUMNS: '110', LINES: '40', TERM: 'xterm-256color' }
    const proc = Bun.spawn(['script', '-qc', `stty cols 110 rows 40 2>/dev/null; timeout 45 ${CLI}`, '/dev/null'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    let out = ''
    const reader = (async () => {
      const dec = new TextDecoder()
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) out += dec.decode(chunk)
    })()
    const flat = () => stripAnsi(out).replace(/\s+/g, '')
    const waitFor = async (test: () => boolean, ms: number) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (test()) return true
        await Bun.sleep(200)
      }
      return false
    }
    const type = async (t: string) => {
      proc.stdin.write(t)
      proc.stdin.flush()
      await Bun.sleep(400)
      proc.stdin.write('\r')
      proc.stdin.flush()
    }
    await Bun.sleep(5000)
    await type('LANZA_B ya')
    // B is asked for its managed settings with B's token; the new dangerous
    // ones are held, so B is disabled and the subagent fails; A hears about it.
    const heldBack = await waitFor(() => a.seen.some(s => /claude-b está desactivada en esta sesión/.test(s.text)), 25_000)
    await Bun.sleep(1500)
    await type('/account approve claude-b')
    const dialog = await waitFor(() => /Cuentaclaude-b·beto@empresa-b\.test/.test(flat()) && /FNH_E2E_PELIGROSA/.test(flat()), 10_000)
    await Bun.sleep(600)
    proc.stdin.write('\x1b') // Esc = reject
    proc.stdin.flush()
    const rejected = await waitFor(() => /Rechazadoslosajustesgestionadosdeclaude-b/.test(flat()), 10_000)
    await Bun.sleep(800)
    await type('SEGUIMOS aqui')
    const goesOn = await waitFor(() => /SEGUIMOS_EN_A/.test(flat()), 15_000)
    const alive = proc.exitCode === null
    proc.kill()
    await reader.catch(() => {})
    writeFileSync(join(configDir, 'reject-capture.txt'), stripAnsi(out))
    expect(heldBack).toBe(true)
    expect(dialog).toBe(true)
    expect(rejected).toBe(true)
    expect(goesOn).toBe(true)
    expect(alive).toBe(true)
    // B served no model request: only its managed-settings endpoints were asked, with its token.
    expect(b.seen.filter(s => s.path.endsWith('/v1/messages')).length).toBe(0)
    expect(b.seen.some(s => s.path === '/api/claude_code/settings' && s.tokenOk)).toBe(true)
    expect(existsSync(join(configDir, 'accounts', 'claude-b', 'remote-settings.json'))).toBe(false)
    expect(out).not.toContain(TOKEN_A)
    expect(out).not.toContain(TOKEN_B)
  }, 70_000)
})
