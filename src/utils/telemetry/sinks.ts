/**
 * Telemetry receivers ("sinks") and who may see what (pure, no I/O except the
 * small `readUserSinksFile` at the bottom).
 *
 * A sink is an OTLP destination with a name. Two origins:
 *
 *   managed  built from the OTEL_* of a Claude account's remote managed
 *            settings (its organisation's receiver). Bound to THAT account
 *            only, always the `official` schema, and it follows what the
 *            organisation says (prompts, tool details, intervals). Only the
 *            organisation can switch it off.
 *   user     declared in `<config>/telemetry.json`. Bound to the accounts
 *            listed there (an explicit list; "*" means every account, so it
 *            is never written for a setup that has a corporate account).
 *            DISABLE_TELEMETRY set by the person switches these off.
 *
 * `sinksFor(account)` is the whole delivery rule. A receiver never sees an
 * account it is not bound to, and the identity attributes of a measurement
 * are those of the account that served it, so one receiver never learns the
 * e-mail or organisation of another account.
 */

import type { Attributes } from '@opentelemetry/api'
import type { TelemetryCtx } from './context.js'
import { toTaggedId } from '../taggedId.js'

export function isTruthy(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
}

/** Pure: `k=v,k2=v2` (OTEL_EXPORTER_OTLP_HEADERS style, values may be percent-encoded) to a record. */
export function parseHeaderList(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const name = part.slice(0, i).trim()
    let value = part.slice(i + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {
      // keep the raw value
    }
    if (name) out[name] = value
  }
  return out
}

export type SinkSchema = 'official' | 'enriched'
export type SinkProtocol = 'http/json' | 'http/protobuf'
export type Signal = 'metrics' | 'logs'

export type SignalConfig = {
  /** Full URL (`<endpoint>/v1/metrics` unless the receiver gave a per-signal endpoint). */
  url: string
  protocol: SinkProtocol
  intervalMs: number
}

export type SinkDef = {
  id: string
  origin: 'managed' | 'user'
  /** Owning account of a managed sink. */
  account?: string
  /** Accounts a user sink is bound to (`'*'` = all). Managed sinks ignore it. */
  accounts: '*' | string[]
  schema: SinkSchema
  /** Switched on at all (managed: the organisation enables telemetry; user: not `enabled:false`). */
  enabled: boolean
  /** Why it is off, for /telemetry. */
  disabledReason?: string
  signals: { metrics?: SignalConfig; logs?: SignalConfig }
  /** Managed: the `k=v,k2=v2` list straight from the organisation. */
  headersList?: string
  /** User: reference to the secret that carries the credentials (services/secrets). */
  headersRef?: string
  /** How the secret reads: `list` = `k=v,...`, `bearer` = a bare token sent as `Authorization: Bearer`. */
  headersAs: 'list' | 'bearer'
  logUserPrompts: boolean
  logToolDetails: boolean
  resourceAttributes: Record<string, string>
  temporality: 'delta' | 'cumulative'
  cardinality: { sessionId: boolean; version: boolean; accountUuid: boolean }
}

// ── live view (for /telemetry and /otel) ────────────────────────────────

export type SinkStatus = {
  lastOkAt: number | null
  lastError: string | null
  lastErrorAt: number | null
  ok: number
  failed: number
  /** Why the receiver cannot send at all (secret unavailable, SDK failed to load). */
  blocked: string | null
}

export type SinkInfo = {
  id: string
  origin: 'managed' | 'user'
  /** Scheme and host only: never a path, query or credential. */
  endpoint: string
  protocol: string
  schema: SinkSchema
  /** Accounts bound to it. */
  accounts: string[]
  enabled: boolean
  disabledReason: string | null
  /** Receives measurements of the session account right now. */
  activeForSession: boolean
  signals: string[]
  prompts: boolean
  toolDetails: boolean
  hasCredentials: boolean
  status: SinkStatus | null
}

// ── user sinks (telemetry.json) ─────────────────────────────────────────

export type UserSinksParse = { sinks: SinkDef[]; errors: string[] }

const SINK_ID = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/
const DEFAULT_METRICS_MS = 60_000
const DEFAULT_LOGS_MS = 5_000

function signalUrl(endpoint: string, signal: Signal): string {
  const base = endpoint.replace(/\/+$/, '')
  return base.endsWith(`/v1/${signal}`) ? base : `${base}/v1/${signal}`
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 100 ? Math.floor(v) : fallback
}

/** Pure: `<config>/telemetry.json` text into sinks. A bad sink is skipped with a message, never half-used. */
export function parseUserSinks(text: string | null): UserSinksParse {
  if (text === null) return { sinks: [], errors: [] }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { sinks: [], errors: [`JSON inválido (${(e as Error).message})`] }
  }
  const raw = (data as { sinks?: unknown } | null)?.sinks
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { sinks: [], errors: ['falta el objeto "sinks"'] }
  const sinks: SinkDef[] = []
  const errors: string[] = []
  for (const [id, s] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!SINK_ID.test(id)) {
      errors.push(`${id}: id no válido (letras, números, . _ -)`)
      continue
    }
    if (!s || typeof s !== 'object') {
      errors.push(`${id}: debe ser un objeto`)
      continue
    }
    if (typeof s.endpoint !== 'string' || !/^https?:\/\//.test(s.endpoint)) {
      errors.push(`${id}: falta "endpoint" (http:// o https://)`)
      continue
    }
    const protocol = s.protocol === undefined ? 'http/json' : s.protocol
    if (protocol !== 'http/json' && protocol !== 'http/protobuf') {
      errors.push(`${id}: protocolo "${String(s.protocol)}" no soportado (http/json o http/protobuf)`)
      continue
    }
    const accounts = s.accounts
    if (accounts === undefined) {
      errors.push(`${id}: falta "accounts" (lista explícita de cuentas, o "*")`)
      continue
    }
    if (accounts !== '*' && !(Array.isArray(accounts) && accounts.length > 0 && accounts.every(a => typeof a === 'string' && a))) {
      errors.push(`${id}: "accounts" debe ser "*" o una lista no vacía de ids`)
      continue
    }
    const schema: SinkSchema = s.schema === 'official' ? 'official' : 'enriched'
    const headersAs = s.headersAs === 'bearer' ? 'bearer' : 'list'
    const sink: SinkDef = {
      id,
      origin: 'user',
      accounts: accounts as '*' | string[],
      schema,
      enabled: s.enabled !== false,
      disabledReason: s.enabled === false ? 'enabled:false en telemetry.json' : undefined,
      signals: {},
      headersRef: typeof s.headersRef === 'string' && s.headersRef ? s.headersRef : undefined,
      headersAs,
      logUserPrompts: s.logUserPrompts === true,
      logToolDetails: s.logToolDetails === true,
      resourceAttributes: { 'service.name': 'fnharness', ...(isStringRecord(s.resourceAttributes) ? s.resourceAttributes : {}) },
      temporality: s.temporality === 'cumulative' ? 'cumulative' : 'delta',
      cardinality: { sessionId: true, version: false, accountUuid: true },
    }
    if (s.metrics !== false) {
      sink.signals.metrics = { url: signalUrl(s.endpoint, 'metrics'), protocol, intervalMs: positiveInt(s.metricsIntervalMs, DEFAULT_METRICS_MS) }
    }
    if (s.logs !== false) {
      sink.signals.logs = { url: signalUrl(s.endpoint, 'logs'), protocol, intervalMs: positiveInt(s.logsIntervalMs, DEFAULT_LOGS_MS) }
    }
    sinks.push(sink)
  }
  return { sinks, errors }
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'string')
}

// ── managed sinks (remote settings of an account) ───────────────────────

type Env = Record<string, string | undefined>

function exporters(v: string | undefined): string[] {
  return (v ?? '').split(',').map(s => s.trim()).filter(s => s && s !== 'none')
}

function toProtocol(v: string | undefined): SinkProtocol | 'unsupported' {
  const p = (v ?? 'http/protobuf').trim()
  return p === 'http/json' || p === 'http/protobuf' ? p : 'unsupported'
}

/** Pure: `OTEL_RESOURCE_ATTRIBUTES` (`k=v,k2=v2`) to a record. */
export function parseResourceEnv(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/**
 * Pure: the receiver an organisation configured through its remote settings,
 * or null when it configured none (no endpoint, no OTLP exporter, telemetry
 * not enabled). `env` is the account's own telemetry env (`telemetryEnvOf`).
 */
export function managedSinkFromEnv(account: string, env: Env): SinkDef | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  if (!endpoint) return null
  const metricsOn = exporters(env.OTEL_METRICS_EXPORTER).includes('otlp')
  const logsOn = exporters(env.OTEL_LOGS_EXPORTER).includes('otlp')
  if (!metricsOn && !logsOn) return null
  let host = ''
  try {
    host = new URL(endpoint).host
  } catch {
    return null
  }
  const enabledFlag = isTruthy(env.CLAUDE_CODE_ENABLE_TELEMETRY)
  const off = isTruthy(env.DISABLE_TELEMETRY)
  const perSignal = (signal: Signal): SignalConfig | undefined => {
    if (signal === 'metrics' ? !metricsOn : !logsOn) return undefined
    const S = signal.toUpperCase()
    const own = env[`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`]
    const proto = toProtocol(env[`OTEL_EXPORTER_OTLP_${S}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL)
    if (proto === 'unsupported') return undefined
    const n = Number(env[signal === 'metrics' ? 'OTEL_METRIC_EXPORT_INTERVAL' : 'OTEL_LOGS_EXPORT_INTERVAL'])
    return {
      url: own ?? signalUrl(endpoint, signal),
      protocol: proto,
      intervalMs: Number.isFinite(n) && n >= 100 ? n : signal === 'metrics' ? DEFAULT_METRICS_MS : DEFAULT_LOGS_MS,
    }
  }
  const headers = [env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_METRICS_HEADERS].filter(Boolean).join(',')
  const sink: SinkDef = {
    id: `${account}:${host}`,
    origin: 'managed',
    account,
    accounts: [account],
    schema: 'official',
    enabled: enabledFlag && !off,
    disabledReason: !enabledFlag ? 'la organización no activa CLAUDE_CODE_ENABLE_TELEMETRY' : off ? 'la organización fija DISABLE_TELEMETRY' : undefined,
    signals: { metrics: perSignal('metrics'), logs: perSignal('logs') },
    headersList: headers || undefined,
    headersAs: 'list',
    logUserPrompts: isTruthy(env.OTEL_LOG_USER_PROMPTS),
    logToolDetails: isTruthy(env.OTEL_LOG_TOOL_DETAILS),
    resourceAttributes: parseResourceEnv(env.OTEL_RESOURCE_ATTRIBUTES),
    temporality: (env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ?? 'delta').toLowerCase() === 'cumulative' ? 'cumulative' : 'delta',
    cardinality: {
      sessionId: env.OTEL_METRICS_INCLUDE_SESSION_ID === undefined ? true : isTruthy(env.OTEL_METRICS_INCLUDE_SESSION_ID),
      version: env.OTEL_METRICS_INCLUDE_VERSION === undefined ? false : isTruthy(env.OTEL_METRICS_INCLUDE_VERSION),
      accountUuid: env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID === undefined ? true : isTruthy(env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID),
    },
  }
  if (!sink.signals.metrics && !sink.signals.logs) return null
  return sink
}

// ── delivery rule ───────────────────────────────────────────────────────

/**
 * Pure: the sinks that may receive a measurement of `account`.
 *
 * - managed: only its own account's.
 * - user: those whose `accounts` lists the account (or is "*"), unless the
 *   person set DISABLE_TELEMETRY (`humanDisabled`). That switch never touches
 *   a managed sink: the organisation decides about its own receiver.
 */
export function sinksFor(account: string, sinks: readonly SinkDef[], opts: { humanDisabled: boolean }): SinkDef[] {
  return sinks.filter(s => {
    if (!s.enabled) return false
    if (s.origin === 'managed') return s.account === account
    if (opts.humanDisabled) return false
    return s.accounts === '*' || s.accounts.includes(account)
  })
}

// ── attributes per sink ─────────────────────────────────────────────────

export type Identity = { email?: string; organizationId?: string; accountUuid?: string }

export type AttrInput = {
  userId: string
  sessionId: string
  appVersion: string
  terminal?: string
  /** Identity of `ctx.account` (never of another account). */
  identity?: Identity | null
  ctx: TelemetryCtx
  pc?: string
}

/**
 * Pure: the attributes common to every measurement for one sink.
 *
 * `official` is what Claude Code sends: user.id, session.id (unless the
 * receiver turns it off), the identity of the account, terminal.type. Nothing
 * `fnharness.*`. `enriched` adds the account, backend and routing context.
 */
export function sinkAttributes(sink: SinkDef, input: AttrInput): Attributes {
  const a: Attributes = { 'user.id': input.userId }
  const enriched = sink.schema === 'enriched'
  if (enriched || sink.cardinality.sessionId) a['session.id'] = input.sessionId
  if (sink.cardinality.version) a['app.version'] = input.appVersion
  const id = input.identity
  if (id) {
    if (id.organizationId) a['organization.id'] = id.organizationId
    if (id.email) a['user.email'] = id.email
    if (id.accountUuid && sink.cardinality.accountUuid) {
      a['user.account_uuid'] = id.accountUuid
      try {
        a['user.account_id'] = toTaggedId('user', id.accountUuid)
      } catch {
        // Not a UUID (a test account, a hand-edited oauth-account.json): the plain uuid still goes.
      }
    }
  }
  if (input.terminal) a['terminal.type'] = input.terminal
  if (enriched) {
    const c = input.ctx
    a['fnharness.account'] = c.account
    a['fnharness.account_kind'] = c.accountKind
    a['fnharness.backend'] = c.backend
    a['fnharness.routed'] = c.routed
    a['fnharness.session_account'] = c.sessionAccount
    if (c.agentType) a['agent.type'] = c.agentType
    if (input.pc) a.pc = input.pc
  }
  return a
}

// ── redaction ───────────────────────────────────────────────────────────

/** Prefix that `redactIfDisabled` puts on prompt text so each sink decides for itself. */
export const PROMPT_MARK = '\u0000fnh:prompt\u0000'
export const REDACTED = '<REDACTED>'
/** Event fields that carry tool details (commands, paths, arguments). */
export const TOOL_DETAIL_KEYS = ['tool_parameters', 'tool_input']

/** Pure: event metadata as `sink` may see it (prompts redacted, tool details dropped unless allowed). */
export function eventMetadataFor(sink: SinkDef, metadata: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined) continue
    if (!sink.logToolDetails && TOOL_DETAIL_KEYS.includes(k)) continue
    out[k] = v.startsWith(PROMPT_MARK) ? (sink.logUserPrompts ? v.slice(PROMPT_MARK.length) : REDACTED) : v
  }
  return out
}

// ── headers ─────────────────────────────────────────────────────────────

/**
 * Pure: request headers from a secret's value. `list` reads `k=v,k2=v2`;
 * `bearer` turns a bare token into `Authorization: Bearer <token>`.
 */
export function headersFromSecret(value: string, as: 'list' | 'bearer'): Record<string, string> {
  const v = value.trim()
  if (!v) return {}
  return as === 'bearer' ? { Authorization: `Bearer ${v}` } : parseHeaderList(v)
}

/** Pure: removes every secret value from a message so an error line can never carry a header. */
export function scrubSecrets(message: string, secrets: readonly string[]): string {
  let out = message
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join('***')
  }
  return out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
}

// ── /telemetry add ──────────────────────────────────────────────────────

export type AddSinkSpec = {
  id: string
  endpoint: string
  accounts: '*' | string[]
  protocol?: string
  schema?: string
  headersRef?: string
  headersAs?: string
}

/** Pure: `/telemetry add <id> <endpoint> --accounts a,b [--protocol p] [--schema s] [--headers-ref ref] [--bearer]`. */
export function parseAddArgs(tokens: string[]): { spec: AddSinkSpec | null; error: string | null } {
  const [id, endpoint, ...rest] = tokens
  const usage = 'uso: /telemetry add <id> <endpoint> --accounts <a,b|*> [--protocol http/json|http/protobuf] [--schema official|enriched] [--headers-ref <gestor:ref>] [--bearer]'
  if (!id || !endpoint) return { spec: null, error: usage }
  const spec: AddSinkSpec = { id, endpoint, accounts: [] }
  let haveAccounts = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    const value = () => rest[++i]
    if (t === '--accounts') {
      const v = value()
      if (!v) return { spec: null, error: '--accounts necesita un valor' }
      spec.accounts = v === '*' ? '*' : v.split(',').map(x => x.trim()).filter(Boolean)
      haveAccounts = true
    } else if (t === '--protocol') spec.protocol = value()
    else if (t === '--schema') spec.schema = value()
    else if (t === '--headers-ref') spec.headersRef = value()
    else if (t === '--bearer') spec.headersAs = 'bearer'
    else return { spec: null, error: `opción desconocida ${t}\n${usage}` }
  }
  if (!haveAccounts) return { spec: null, error: `falta --accounts (lista explícita de cuentas)\n${usage}` }
  return { spec, error: null }
}

/**
 * Pure: telemetry.json text with the sink added (or replaced), validated with
 * the same parser the runtime uses so a file we write is always one we read.
 */
export function addUserSinkToText(existing: string | null, spec: AddSinkSpec): { text: string | null; error: string | null } {
  let doc: { sinks?: Record<string, unknown> } = {}
  if (existing !== null) {
    try {
      doc = JSON.parse(existing)
    } catch (e) {
      return { text: null, error: `telemetry.json actual no es JSON válido (${(e as Error).message}); arréglalo a mano antes` }
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { text: null, error: 'telemetry.json actual no es un objeto' }
  }
  const entry: Record<string, unknown> = { endpoint: spec.endpoint, accounts: spec.accounts }
  if (spec.protocol) entry.protocol = spec.protocol
  if (spec.schema) entry.schema = spec.schema
  if (spec.headersRef) entry.headersRef = spec.headersRef
  if (spec.headersAs) entry.headersAs = spec.headersAs
  const next = { ...doc, sinks: { ...(doc.sinks ?? {}), [spec.id]: entry } }
  const text = JSON.stringify(next, null, 2) + '\n'
  const parsed = parseUserSinks(text)
  if (!parsed.sinks.some(s => s.id === spec.id)) {
    return { text: null, error: parsed.errors.find(e => e.startsWith(`${spec.id}:`)) ?? parsed.errors[0] ?? 'receptor no válido' }
  }
  return { text, error: null }
}
