/**
 * Telemetry per account and receiver, against fake servers only.
 *
 * Session on `acctc` (OpenAI-compatible); the model launches a subagent on
 * `claude-a:sonnet` and another on `claude-b:haiku`.
 *
 *   corpA   managed receiver of account A (from A's remote settings)
 *   corpB   managed receiver of account B (from B's remote settings)
 *   propio  receiver of telemetry.json, bound to [acctc, claude-a]
 *
 * Expected, each receiver sees only what belongs to the accounts bound to it:
 *   corpA   only A's requests, `official` schema, A's e-mail
 *   corpB   only B's requests, `official` schema, B's e-mail
 *   propio  acctc and A (A routed from acctc), `enriched` schema, never B
 * and no credential ever shows up in stdout, stderr or the debug log.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLI, hasCli, makeSandbox } from './harness.js'

type Msg = { role: string; content?: unknown }
type Body = { model?: string; stream?: boolean; messages?: Msg[] }

const random = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
const TOKEN_A = `fake-a-${random()}`
const TOKEN_B = `fake-b-${random()}`
const KEY_CORP_A = `corp-a-key-${random()}`
const KEY_CORP_B = `corp-b-key-${random()}`
const KEY_OWN = `own-token-${random()}`
const SECRETS = [TOKEN_A, TOKEN_B, KEY_CORP_A, KEY_CORP_B, KEY_OWN]

const textOf = (m: Msg | undefined): string => {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content.map((p: { text?: string; content?: unknown }) => p.text ?? (typeof p.content === 'string' ? p.content : '')).join('\n')
}

// ── fake OTLP receiver (http/json) ──────────────────────────────────────

type OtlpAttr = { key: string; value: Record<string, unknown> }
type Point = { name: string; attrs: Record<string, unknown>; resource: Record<string, unknown>; value?: number }
type Event = { body: string; attrs: Record<string, unknown>; resource: Record<string, unknown> }

const flat = (list: OtlpAttr[] | undefined): Record<string, unknown> =>
  Object.fromEntries((list ?? []).map(a => [a.key, a.value.stringValue ?? a.value.boolValue ?? (a.value.intValue !== undefined ? Number(a.value.intValue) : a.value.doubleValue)]))

function fakeOtlp(expectedAuth: { header: string; value: string }) {
  const points: Point[] = []
  const events: Event[] = []
  const raw: string[] = []
  const requests: Array<{ path: string; authOk: boolean }> = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const authOk = req.headers.get(expectedAuth.header) === expectedAuth.value
      requests.push({ path: url.pathname, authOk })
      const text = await req.text()
      raw.push(text)
      if (!authOk) return new Response('unauthorized', { status: 401 })
      const body = JSON.parse(text || '{}')
      for (const rm of body.resourceMetrics ?? []) {
        const resource = flat(rm.resource?.attributes)
        for (const sm of rm.scopeMetrics ?? []) {
          for (const m of sm.metrics ?? []) {
            for (const dp of m.sum?.dataPoints ?? m.gauge?.dataPoints ?? []) {
              points.push({ name: m.name, attrs: flat(dp.attributes), resource, value: Number(dp.asDouble ?? dp.asInt ?? 0) })
            }
          }
        }
      }
      for (const rl of body.resourceLogs ?? []) {
        const resource = flat(rl.resource?.attributes)
        for (const sl of rl.scopeLogs ?? []) {
          for (const lr of sl.logRecords ?? []) events.push({ body: lr.body?.stringValue ?? '', attrs: flat(lr.attributes), resource })
        }
      }
      return Response.json({})
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, points, events, raw, requests, stop: () => server.stop(true) }
}

// ── fake Anthropic server (one per Claude account) ──────────────────────

function sse(model: string, text: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const usage = { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  return (
    ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }) +
    ev('message_stop', {})
  )
}

function fakeAnthropic(token: string, reply: string, settingsEnv: Record<string, string>) {
  const seen: Array<{ path: string; tokenOk: boolean }> = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      seen.push({ path: url.pathname, tokenOk: req.headers.get('authorization') === `Bearer ${token}` })
      if (url.pathname === '/api/claude_code/settings') return Response.json({ uuid: 'u-1', checksum: 'c-1', settings: { env: settingsEnv } })
      if (url.pathname === '/api/claude_code/policy_limits') return new Response(null, { status: 404 })
      if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 })
      if (!url.pathname.endsWith('/v1/messages')) return new Response('not found', { status: 404 })
      const body = (await req.json()) as Body
      const model = body.model ?? 'claude-fake'
      if (body.stream === false) {
        return Response.json({ id: 'msg_fake', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } })
      }
      return new Response(sse(model, reply), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}

// ── fake OpenAI-compatible server for the session account ───────────────

function openaiSse(model: string, delta: object, finish: string): string {
  const chunk = (d: object, f: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`
  return (
    chunk({ role: 'assistant' }, null) +
    chunk(delta, null) +
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n` +
    'data: [DONE]\n\n'
  )
}

function fakeOpenAI(model: string) {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: model, object: 'model' }] })
      if (!url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 })
      const body = (await req.json()) as Body
      const toolResults = (body.messages ?? []).filter(m => m.role === 'tool').length
      const call = (args: object) => openaiSse(model, { tool_calls: [{ index: 0, id: `call_${toolResults}`, type: 'function', function: { name: 'Agent', arguments: JSON.stringify(args) } }] }, 'tool_calls')
      let out: string
      if (toolResults === 0) out = call({ description: 'sub en A', prompt: 'SUB_A di hola', subagent_type: 'general-purpose', model: 'claude-a:sonnet' })
      else if (toolResults === 1) out = call({ description: 'sub en B', prompt: 'SUB_B di hola', subagent_type: 'general-purpose', model: 'claude-b:haiku' })
      else out = openaiSse(model, { content: 'MAIN_DONE' }, 'stop')
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

const servers: Array<{ stop: () => void }> = []
afterAll(() => {
  for (const s of servers) s.stop()
})

function sandbox(a: string, b: string, c: string, propioUrl: string) {
  const { configDir, cwd } = makeSandbox()
  const far = Date.now() + 30 * 24 * 3600 * 1000
  const account = (id: string, baseUrl: string, token: string, email: string, org: string) => {
    const dir = join(configDir, 'accounts', id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${random()}`, expiresAt: far, scopes: ['user:inference'], subscriptionType: 'team', rateLimitTier: null } }), { mode: 0o600 })
    writeFileSync(join(dir, 'oauth-account.json'), JSON.stringify({ accountUuid: `uuid-${id}`, emailAddress: email, organizationUuid: `org-${id}-0000`, organizationName: org }), { mode: 0o600 })
    return { kind: 'anthropic', label: 'Claude (Anthropic)', baseUrl }
  }
  writeFileSync(
    join(configDir, 'accounts.json'),
    JSON.stringify({
      active: 'acctc',
      accounts: {
        'claude-a': account('claude-a', a, TOKEN_A, 'ana@empresa-a.test', 'Empresa A'),
        'claude-b': account('claude-b', b, TOKEN_B, 'beto@empresa-b.test', 'Empresa B'),
        acctc: { provider: 'custom', baseUrl: c, model: 'model-c', label: 'Servidor C' },
      },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(configDir, 'telemetry.json'),
    JSON.stringify({
      sinks: {
        propio: {
          endpoint: propioUrl,
          protocol: 'http/json',
          headersRef: 'env:FNH_E2E_OTLP_TOKEN',
          headersAs: 'bearer',
          accounts: ['acctc', 'claude-a'],
          schema: 'enriched',
          metricsIntervalMs: 200,
          logsIntervalMs: 200,
        },
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
  for (const k of ['CLAUDECODE', 'FNHARNESS_ACCOUNT', 'TMUX', 'DISABLE_TELEMETRY']) delete env[k]
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}

const orgEnv = (url: string, key: string, env: string): Record<string, string> => ({
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_EXPORTER_OTLP_ENDPOINT: url,
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_HEADERS: `x-corp-key=${key}`,
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRIC_EXPORT_INTERVAL: '200',
  OTEL_LOGS_EXPORT_INTERVAL: '200',
  OTEL_RESOURCE_ATTRIBUTES: `deployment.environment=${env}`,
})

const names = (r: { points: Point[] }) => [...new Set(r.points.map(p => p.name))]
const dump = (r: { raw: string[] }) => r.raw.join('\n')

describe.skipIf(!hasCli)('telemetry per account and receiver e2e', () => {
  test('each receiver sees only the accounts bound to it, with that account identity; no credential leaks', async () => {
    const corpA = fakeOtlp({ header: 'x-corp-key', value: KEY_CORP_A })
    const corpB = fakeOtlp({ header: 'x-corp-key', value: KEY_CORP_B })
    const propio = fakeOtlp({ header: 'authorization', value: `Bearer ${KEY_OWN}` })
    const a = fakeAnthropic(TOKEN_A, 'SUB_A_DONE', orgEnv(corpA.url, KEY_CORP_A, 'corp-a'))
    const b = fakeAnthropic(TOKEN_B, 'SUB_B_DONE', orgEnv(corpB.url, KEY_CORP_B, 'corp-b'))
    const c = fakeOpenAI('model-c')
    servers.push(corpA, corpB, propio, a, b, c)
    const { configDir, cwd } = sandbox(a.baseUrl, b.baseUrl, c.baseUrl, propio.url)
    const env = cleanEnv(configDir)
    env.FNH_E2E_OTLP_TOKEN = KEY_OWN
    env.CLAUDE_CODE_SUBAGENT_MODEL = 'sonnet'
    const debugFile = join(configDir, 'debug.log')
    const proc = Bun.spawn([CLI, '-p', 'LANZA_SUBS ahora', '--debug-file', debugFile], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 90_000 })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    await proc.exited
    if (!out.includes('MAIN_DONE')) console.error('stdout:', out.slice(0, 1500), '\nstderr:', err.slice(0, 1500))
    expect(out).toContain('MAIN_DONE')
    // Both subagents reached their own Anthropic server.
    expect(a.seen.some(s => s.path.endsWith('/v1/messages') && s.tokenOk)).toBe(true)
    expect(b.seen.some(s => s.path.endsWith('/v1/messages') && s.tokenOk)).toBe(true)

    const strip = (r: { points: Point[] }, key: string) => r.points.filter(p => key in p.attrs)

    // corpA: only A, official schema, A's identity, its resource.
    expect(names(corpA)).toEqual(expect.arrayContaining(['claude_code.cost.usage', 'claude_code.token.usage']))
    expect(corpA.points.every(p => p.attrs['user.email'] === 'ana@empresa-a.test')).toBe(true)
    expect(corpA.points.some(p => p.attrs.model === 'sonnet' || String(p.attrs.model).includes('sonnet'))).toBe(true)
    expect(corpA.points.every(p => p.resource['deployment.environment'] === 'corp-a')).toBe(true)
    expect(names(corpA)).not.toContain('claude_code.session.count')
    expect(dump(corpA)).not.toContain('fnharness')
    expect(dump(corpA)).not.toContain('beto@empresa-b')
    expect(dump(corpA)).not.toContain('acctc')
    expect(corpA.requests.every(r => r.authOk)).toBe(true)

    // corpB: only B.
    expect(names(corpB)).toEqual(expect.arrayContaining(['claude_code.cost.usage', 'claude_code.token.usage']))
    expect(corpB.points.every(p => p.attrs['user.email'] === 'beto@empresa-b.test')).toBe(true)
    expect(corpB.points.every(p => p.resource['deployment.environment'] === 'corp-b')).toBe(true)
    expect(dump(corpB)).not.toContain('fnharness')
    expect(dump(corpB)).not.toContain('ana@empresa-a')
    expect(dump(corpB)).not.toContain('acctc')
    expect(corpB.requests.every(r => r.authOk)).toBe(true)

    // propio: acctc and A (routed), enriched, never B.
    expect(propio.requests.every(r => r.authOk)).toBe(true)
    const accountsSeen = new Set(propio.points.map(p => p.attrs['fnharness.account']))
    expect(accountsSeen.has('acctc')).toBe(true)
    expect(accountsSeen.has('claude-a')).toBe(true)
    expect(accountsSeen.has('claude-b')).toBe(false)
    expect(names(propio)).toContain('claude_code.session.count')
    const sessionCount = propio.points.filter(p => p.name === 'claude_code.session.count')
    expect(sessionCount.every(p => p.attrs['fnharness.account'] === 'acctc' && p.attrs['fnharness.routed'] === false)).toBe(true)
    const aCost = propio.points.filter(p => p.name === 'claude_code.cost.usage' && p.attrs['fnharness.account'] === 'claude-a')
    expect(aCost.length).toBeGreaterThan(0)
    expect(aCost.every(p => p.attrs['fnharness.routed'] === true && p.attrs['fnharness.session_account'] === 'acctc' && p.attrs['user.email'] === 'ana@empresa-a.test')).toBe(true)
    // acctc has no OAuth identity: its points carry none.
    expect(propio.points.filter(p => p.attrs['fnharness.account'] === 'acctc').every(p => !('user.email' in p.attrs))).toBe(true)
    expect(strip(propio, 'fnharness.account').length).toBe(propio.points.length)
    expect(dump(propio)).not.toContain('beto@empresa-b')
    expect(dump(propio)).not.toContain('claude-b')
    expect(propio.points.every(p => p.resource['service.name'] === 'fnharness')).toBe(true)

    // Events: each receiver gets its own account's, prompts redacted.
    const apiA = corpA.events.filter(e => e.body === 'claude_code.api_request')
    const apiB = corpB.events.filter(e => e.body === 'claude_code.api_request')
    expect(apiA.length).toBeGreaterThan(0)
    expect(apiB.length).toBeGreaterThan(0)
    expect(apiA.every(e => e.attrs['user.email'] === 'ana@empresa-a.test')).toBe(true)
    expect(apiB.every(e => e.attrs['user.email'] === 'beto@empresa-b.test')).toBe(true)
    expect(propio.events.every(e => e.attrs['fnharness.account'] !== 'claude-b')).toBe(true)
    expect(JSON.stringify([...corpA.events, ...corpB.events, ...propio.events])).not.toContain('LANZA_SUBS')

    // No credential in the output or in the debug log.
    const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''
    for (const secret of SECRETS) {
      expect(out).not.toContain(secret)
      expect(err).not.toContain(secret)
      expect(debug).not.toContain(secret)
    }
  }, 100_000)

  test('-p "hola" ends in under 3 s with every receiver down', async () => {
    const dead = 'http://127.0.0.1:9'
    const a = fakeAnthropic(TOKEN_A, 'hola de A', orgEnv(dead, KEY_CORP_A, 'corp-a'))
    const b = fakeAnthropic(TOKEN_B, 'x', orgEnv(dead, KEY_CORP_B, 'corp-b'))
    const c = fakeOpenAI('model-c')
    servers.push(a, b, c)
    const { configDir, cwd } = sandbox(a.baseUrl, b.baseUrl, c.baseUrl, dead)
    // Session on A: its managed receiver and none of the own ones are down.
    writeFileSync(join(configDir, 'accounts.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(configDir, 'accounts.json'), 'utf8')), active: 'claude-a' }))
    const telemetry = JSON.parse(readFileSync(join(configDir, 'telemetry.json'), 'utf8'))
    telemetry.sinks.propio.accounts = ['claude-a', 'acctc']
    writeFileSync(join(configDir, 'telemetry.json'), JSON.stringify(telemetry))
    const env = cleanEnv(configDir)
    env.FNH_E2E_OTLP_TOKEN = KEY_OWN
    const debugFile = join(configDir, 'debug.log')
    const t0 = Date.now()
    const proc = Bun.spawn([CLI, '-p', 'hola', '--debug-file', debugFile], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const elapsed = Date.now() - t0
    expect(out).toContain('hola de A')
    expect(elapsed).toBeLessThan(3000)
    const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''
    // A dead receiver leaves a debug line, never a header.
    expect(debug).toMatch(/\[telemetry\] .*no se pudo enviar/)
    for (const secret of SECRETS) expect(debug).not.toContain(secret)
  }, 40_000)
})
