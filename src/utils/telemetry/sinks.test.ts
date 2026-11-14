import { describe, expect, test } from 'bun:test'
import type { TelemetryCtx } from './context.js'
import {
  PROMPT_MARK,
  editUserSinkInText,
  eventMetadataFor,
  headersFromSecret,
  managedSinkFromEnv,
  parseHeaderList,
  parseUserSinks,
  scrubSecrets,
  setSinkAccountsInText,
  setSinkEnabledInText,
  setSinkFlagsInText,
  setSinkSignalsInText,
  sinkAttributes,
  sinksFor,
  type SinkDef,
} from './sinks.js'

const ACME_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.datadoghq.eu',
  OTEL_EXPORTER_OTLP_HEADERS: 'dd-api-key=SECRETO-DD-1234',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_METRICS_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_LOG_TOOL_DETAILS: '1',
  OTEL_METRICS_INCLUDE_SESSION_ID: 'false',
  OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=production',
}

const USER_JSON = JSON.stringify({
  sinks: {
    'otel-3amdata': {
      endpoint: 'https://otel.3amdata.win',
      protocol: 'http/json',
      headersRef: 'pass:ionos/otel-token',
      headersAs: 'bearer',
      accounts: ['claude', 'qwen36', 'ollama', 'zcode', 'venice'],
      schema: 'enriched',
      logUserPrompts: false,
    },
  },
})

const work = managedSinkFromEnv('claude-work', ACME_ENV)!
const own = parseUserSinks(USER_JSON).sinks[0]!
const all: SinkDef[] = [work, own]
const ids = (account: string, humanDisabled = false) => sinksFor(account, all, { humanDisabled }).map(s => s.id)

const ctx = (account: string, over: Partial<TelemetryCtx> = {}): TelemetryCtx => ({
  account,
  accountKind: account.startsWith('claude') ? 'anthropic' : 'openai_compat',
  backend: 'api.anthropic.com',
  model: 'sonnet',
  routed: false,
  sessionAccount: account,
  agentType: undefined,
  ...over,
})

describe('sinksFor (delivery table)', () => {
  test.each([
    ['claude', ['otel-3amdata']],
    ['claude-work', ['claude-work:otlp.datadoghq.eu']],
    ['qwen36', ['otel-3amdata']],
    ['ollama', ['otel-3amdata']],
    ['zcode', ['otel-3amdata']],
    ['venice', ['otel-3amdata']],
    ['desconocida', []],
  ])('%s -> %p', (account, expected) => {
    expect(ids(account)).toEqual(expected)
  })

  test('the explicit list never reaches claude-work', () => {
    expect(own.accounts).not.toContain('claude-work')
    expect(ids('claude-work')).not.toContain('otel-3amdata')
  })

  test('"*" would include claude-work, which is why the config lists accounts', () => {
    const star = parseUserSinks(JSON.stringify({ sinks: { todo: { endpoint: 'http://x', accounts: '*' } } })).sinks
    expect(sinksFor('claude-work', star, { humanDisabled: false }).map(s => s.id)).toEqual(['todo'])
  })

  test("a managed sink only sees its own account's measurements", () => {
    for (const a of ['claude', 'qwen36', 'venice']) expect(ids(a)).not.toContain(work.id)
  })

  test("the person's DISABLE_TELEMETRY switches off user sinks but never the managed one", () => {
    expect(ids('claude', true)).toEqual([])
    expect(ids('claude-work', true)).toEqual(['claude-work:otlp.datadoghq.eu'])
  })

  test('a managed sink the organisation disables stays off whatever the person does', () => {
    const off = managedSinkFromEnv('claude-work', { ...ACME_ENV, CLAUDE_CODE_ENABLE_TELEMETRY: '0' })!
    expect(sinksFor('claude-work', [off], { humanDisabled: false })).toEqual([])
  })
})

describe('managedSinkFromEnv', () => {
  test('reads the organisation settings', () => {
    expect(work).toMatchObject({
      id: 'claude-work:otlp.datadoghq.eu',
      origin: 'managed',
      account: 'claude-work',
      schema: 'official',
      enabled: true,
      logToolDetails: true,
      logUserPrompts: false,
      temporality: 'delta',
    })
    expect(work.signals.metrics).toMatchObject({ url: 'https://otlp.datadoghq.eu/v1/metrics', protocol: 'http/protobuf' })
    expect(work.signals.logs).toMatchObject({ url: 'https://otlp.datadoghq.eu/v1/logs' })
    expect(work.cardinality.sessionId).toBe(false)
    expect(work.resourceAttributes).toEqual({ 'deployment.environment': 'production' })
  })
  test('no endpoint or no OTLP exporter: no receiver', () => {
    expect(managedSinkFromEnv('x', { CLAUDE_CODE_ENABLE_TELEMETRY: '1' })).toBeNull()
    expect(managedSinkFromEnv('x', { ...ACME_ENV, OTEL_METRICS_EXPORTER: 'console', OTEL_LOGS_EXPORTER: 'none' })).toBeNull()
  })
})

describe('parseUserSinks', () => {
  test('3amdata sink as configured', () => {
    expect(own).toMatchObject({ id: 'otel-3amdata', origin: 'user', schema: 'enriched', logUserPrompts: false, headersAs: 'bearer', headersRef: 'pass:ionos/otel-token' })
    expect(own.signals.metrics?.url).toBe('https://otel.3amdata.win/v1/metrics')
    expect(own.signals.metrics?.protocol).toBe('http/json')
  })
  test('refuses a sink without an explicit accounts field', () => {
    const r = parseUserSinks(JSON.stringify({ sinks: { a: { endpoint: 'http://x' } } }))
    expect(r.sinks).toEqual([])
    expect(r.errors[0]).toContain('accounts')
  })
  test('refuses grpc, bad ids and bad JSON; absent file is empty', () => {
    expect(parseUserSinks(JSON.stringify({ sinks: { a: { endpoint: 'http://x', protocol: 'grpc', accounts: ['c'] } } })).errors[0]).toContain('grpc')
    expect(parseUserSinks(JSON.stringify({ sinks: { 'a b': { endpoint: 'http://x', accounts: ['c'] } } })).errors[0]).toContain('id no válido')
    expect(parseUserSinks('{').errors[0]).toContain('JSON')
    expect(parseUserSinks(null)).toEqual({ sinks: [], errors: [] })
  })
})

describe('attributes per schema and per account', () => {
  const input = (account: string, identity: object | null, over = {}) => ({
    userId: 'uid',
    sessionId: 'sess-1',
    appVersion: '1.0.0',
    terminal: 'xterm',
    identity,
    ctx: ctx(account, over),
    pc: 'pc-b',
  })
  const identityA = { email: 'persona@work.test', organizationId: 'org-work', accountUuid: 'uuid-work' }
  const identityP = { email: 'yo@personal.test', organizationId: 'org-personal', accountUuid: 'uuid-personal' }

  test('official carries no fnharness.* and no pc / agent.type', () => {
    const a = sinkAttributes(work, input('claude-work', identityA, { routed: true, sessionAccount: 'qwen36', agentType: 'general-purpose' }))
    expect(Object.keys(a).filter(k => k.startsWith('fnharness.'))).toEqual([])
    expect(a).not.toHaveProperty('pc')
    expect(a).not.toHaveProperty('agent.type')
    expect(a['user.email']).toBe('persona@work.test')
    expect(a['organization.id']).toBe('org-work')
  })
  test('official honours the organisation turning session.id off; enriched always has it', () => {
    expect(sinkAttributes(work, input('claude-work', identityA))).not.toHaveProperty('session.id')
    expect(sinkAttributes(own, input('claude', identityP))['session.id']).toBe('sess-1')
  })
  test('enriched adds the account context', () => {
    const a = sinkAttributes(own, input('venice', null, { accountKind: 'openai_compat', backend: 'api.venice.ai', routed: true, sessionAccount: 'claude', agentType: 'Explore' }))
    expect(a).toMatchObject({
      'fnharness.account': 'venice',
      'fnharness.account_kind': 'openai_compat',
      'fnharness.backend': 'api.venice.ai',
      'fnharness.routed': true,
      'fnharness.session_account': 'claude',
      'agent.type': 'Explore',
      pc: 'pc-b',
    })
  })
  test('identity belongs to the account that served the request: no leak across receivers', () => {
    const toAcme = sinkAttributes(work, input('claude-work', identityA))
    const toOwn = sinkAttributes(own, input('claude', identityP))
    const dump = (x: object) => JSON.stringify(x)
    expect(dump(toAcme)).not.toContain('personal')
    expect(dump(toOwn)).not.toContain('work')
  })
  test('an OpenAI-compatible account has no identity attributes', () => {
    const a = sinkAttributes(own, input('qwen36', null))
    expect(a).not.toHaveProperty('user.email')
    expect(a).not.toHaveProperty('organization.id')
  })
})

describe('redaction per receiver', () => {
  const md = { prompt: PROMPT_MARK + 'texto secreto', prompt_length: '13', tool_parameters: '{"bash_command":"ls"}', tool_input: '{"x":1}', tool_name: 'Bash' }
  test('prompts are redacted unless the receiver allows them', () => {
    expect(eventMetadataFor(own, md).prompt).toBe('<REDACTED>')
    expect(eventMetadataFor({ ...own, logUserPrompts: true }, md).prompt).toBe('texto secreto')
  })
  test('tool details only where the receiver allows them', () => {
    expect(eventMetadataFor(own, md)).not.toHaveProperty('tool_parameters')
    expect(eventMetadataFor(own, md)).not.toHaveProperty('tool_input')
    expect(eventMetadataFor(work, md)).toHaveProperty('tool_parameters')
    expect(eventMetadataFor(own, md).tool_name).toBe('Bash')
  })
  test('the mark never leaks', () => {
    for (const s of all) expect(JSON.stringify(eventMetadataFor(s, md))).not.toContain('fnh:prompt')
  })
})

describe('headers and secrets', () => {
  test('bearer secret becomes an Authorization header; list is parsed', () => {
    expect(headersFromSecret('tok123\n', 'bearer')).toEqual({ Authorization: 'Bearer tok123' })
    expect(headersFromSecret('a=1,b=x%20y', 'list')).toEqual({ a: '1', b: 'x y' })
    expect(parseHeaderList('dd-api-key=abc')).toEqual({ 'dd-api-key': 'abc' })
  })
  test('scrubSecrets removes values and bearer tokens from error text', () => {
    const msg = 'POST failed: Authorization: Bearer abcDEF123xyz and key SECRETO-DD-1234'
    const out = scrubSecrets(msg, ['SECRETO-DD-1234'])
    expect(out).not.toContain('abcDEF123xyz')
    expect(out).not.toContain('SECRETO-DD-1234')
  })
})

describe('editUserSinkInText and the toggle helpers', () => {
  const parse = (text: string | null) => (text === null ? null : parseUserSinks(text))
  const find = (text: string | null, id: string) => parse(text)?.sinks.find(s => s.id === id)

  test('editUserSinkInText changes one entry and keeps the rest', () => {
    const two = JSON.stringify({ sinks: { a: { endpoint: 'http://a', accounts: ['x'] }, b: { endpoint: 'http://b', accounts: '*' } } })
    const r = editUserSinkInText(two, 'a', raw => ({ ...raw, schema: 'official' }))
    expect(find(r.text, 'a')?.schema).toBe('official')
    expect(find(r.text, 'b')?.accounts).toBe('*')
  })

  test('setSinkEnabledInText toggles and clears cleanly (absent = on)', () => {
    const off = setSinkEnabledInText(USER_JSON, 'otel-3amdata', false)
    expect(find(off.text, 'otel-3amdata')?.enabled).toBe(false)
    const back = setSinkEnabledInText(off.text, 'otel-3amdata', true)
    const parsed = JSON.parse(back.text!)
    expect(parsed.sinks['otel-3amdata']).not.toHaveProperty('enabled')
    expect(find(back.text, 'otel-3amdata')?.enabled).toBe(true)
  })

  test('setSinkAccountsInText swaps the list and accepts "*"', () => {
    const r = setSinkAccountsInText(USER_JSON, 'otel-3amdata', ['claude'])
    expect(find(r.text, 'otel-3amdata')?.accounts).toEqual(['claude'])
    const star = setSinkAccountsInText(r.text, 'otel-3amdata', '*')
    expect(find(star.text, 'otel-3amdata')?.accounts).toBe('*')
  })

  test('setSinkFlagsInText sets and unsets prompt/tool flags', () => {
    const on = setSinkFlagsInText(USER_JSON, 'otel-3amdata', { logUserPrompts: true, logToolDetails: true })
    expect(find(on.text, 'otel-3amdata')).toMatchObject({ logUserPrompts: true, logToolDetails: true })
    const off = setSinkFlagsInText(on.text, 'otel-3amdata', { logUserPrompts: false, logToolDetails: false })
    const parsed = JSON.parse(off.text!)
    expect(parsed.sinks['otel-3amdata']).not.toHaveProperty('logUserPrompts')
    expect(parsed.sinks['otel-3amdata']).not.toHaveProperty('logToolDetails')
  })

  test('setSinkSignalsInText: false writes the switch, true removes it (default on)', () => {
    const noMetrics = setSinkSignalsInText(USER_JSON, 'otel-3amdata', { metrics: false })
    expect(find(noMetrics.text, 'otel-3amdata')?.signals.metrics).toBeUndefined()
    expect(find(noMetrics.text, 'otel-3amdata')?.signals.logs).toBeDefined()
    const back = setSinkSignalsInText(noMetrics.text, 'otel-3amdata', { metrics: true })
    const parsed = JSON.parse(back.text!)
    expect(parsed.sinks['otel-3amdata']).not.toHaveProperty('metrics')
    expect(find(back.text, 'otel-3amdata')?.signals.metrics).toBeDefined()
  })

  test('refuses unknown ids, broken JSON and a sink that would stop parsing', () => {
    expect(editUserSinkInText(USER_JSON, 'nope', r => r).error).toContain('no existe')
    expect(editUserSinkInText('{', 'otel-3amdata', r => r).error).toContain('JSON')
    const bad = setSinkAccountsInText(USER_JSON, 'otel-3amdata', [])
    expect(bad.text).toBeNull()
    expect(bad.error).toContain('otel-3amdata')
  })

  test('a disabled sink missing endpoint stays refused (validation is the runtime parser)', () => {
    const broken = JSON.stringify({ sinks: { a: { accounts: ['x'] } } })
    expect(setSinkEnabledInText(broken, 'a', true).text).toBeNull()
  })
})
