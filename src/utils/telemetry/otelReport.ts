/**
 * Report behind `/otel` and `/telemetry`: which receivers exist, which
 * accounts are bound to each, what the session sends right now, and the last
 * successful send and error of each receiver. Read-only.
 *
 * Everything here is pure. The command (commands/otel/otel.ts) gathers the
 * inputs (the live receivers from sinkRuntime, settings layers, process env,
 * account) and hands them over; this module decides origins, resolves the
 * OTEL_* view and masks secrets. Nothing in the output ever carries a header value: headers
 * are reduced to `name=***` at the moment they are read (maskOtelHeaders), so
 * neither the text nor the JSON form can leak one.
 *
 * Where each variable comes from mirrors how the process env is built at
 * startup (utils/managedEnv.ts): later layers overwrite earlier ones, so the
 * effective value belongs to the highest-precedence layer that defines it:
 *   remote-settings / managed policy  >  settings.json env (flag > local >
 *   project > user)  >  ~/.claude.json env  >  account profile  >  shell env.
 */

import { isTruthy, type SinkInfo } from './sinks.js'

export type Env = Record<string, string | undefined>

export type OtelOrigin =
  | 'remote-settings'
  | 'managed-settings'
  | 'settings'
  | 'global-config'
  | 'account-profile'
  | 'process-env'

/** One layer that can define env vars, listed from highest to lowest precedence. */
export type EnvLayer = {
  origin: OtelOrigin
  /** Human label, e.g. "remote-settings de la organización" or "settings.json (user)". */
  label: string
  env: Env | undefined
}

export type OtelVar = {
  name: string
  /** Display value: secrets already masked. */
  value: string
  origin: OtelOrigin
  originLabel: string
  masked: boolean
}

export type OtelSignal = 'metrics' | 'logs' | 'traces'

export type OtelDestination = {
  signal: OtelSignal
  exporters: string[]
  /** True when an `otlp` exporter is selected (the only one that leaves the machine). */
  otlp: boolean
  endpoint: string | null
  protocol: string
  protocolIsDefault: boolean
  /** Header NAMES only, shown as `name=***`. */
  headers: string[]
  intervalMs: number
  intervalIsDefault: boolean
}

export type SinksBlock = {
  /** telemetry.json path. */
  path: string
  present: boolean
  /** Problems found reading it (a bad receiver is skipped, never half used). */
  errors: string[]
  sinks: SinkInfo[]
  /** DISABLE_TELEMETRY set by the person: switches off the `user` receivers. */
  humanDisabled: boolean
}

export type OtelAccount = {
  id: string
  label: string
  provider: string | null
  email: string | null
  org: string | null
  /**
   * Claude account whose remote settings the report reads (the request scope's
   * or the session's; `claude` from an OpenAI-compatible session). Its OTEL_*
   * are a receiver of that account and never reach process.env.
   */
  managedFrom?: string | null
}

export type OtelReport = {
  /** Does this build carry the telemetry code (isTelemetryEnabled()). */
  buildEnabled: boolean
  /** Settings ask for telemetry (CLAUDE_CODE_ENABLE_TELEMETRY truthy, DISABLE_TELEMETRY not). */
  requested: boolean
  /** Something leaves the machine for the session account: an enabled receiver is bound to it. */
  sends: boolean
  verdict: string
  account: OtelAccount
  switches: { enable: OtelVar | null; disable: OtelVar | null }
  vars: OtelVar[]
  destinations: OtelDestination[]
  resourceAttributes: { key: string; value: string }[]
  sinksBlock: SinksBlock
}

export type OtelReportInput = {
  buildEnabled: boolean
  account: OtelAccount
  /** Highest precedence first. The shell env goes last (or use `processEnv`). */
  layers: EnvLayer[]
  processEnv: Env
  /** Vars an account profile sets by default (profiles.ts); empty when no profile is active. */
  profileEnv?: Env
  profileLabel?: string
  sinksBlock: SinksBlock
}

const SIGNALS: OtelSignal[] = ['metrics', 'logs', 'traces']
const EXPORTER_VAR: Record<OtelSignal, string> = {
  metrics: 'OTEL_METRICS_EXPORTER',
  logs: 'OTEL_LOGS_EXPORTER',
  traces: 'OTEL_TRACES_EXPORTER',
}
const INTERVAL_VAR: Record<OtelSignal, string> = {
  metrics: 'OTEL_METRIC_EXPORT_INTERVAL',
  logs: 'OTEL_LOGS_EXPORT_INTERVAL',
  traces: 'OTEL_TRACES_EXPORT_INTERVAL',
}
/** OpenTelemetry SDK defaults. */
const DEFAULT_INTERVAL_MS: Record<OtelSignal, number> = { metrics: 60_000, logs: 5_000, traces: 5_000 }
const DEFAULT_PROTOCOL = 'http/protobuf'

/** Vars worth showing even when they do not start with OTEL_. */
const EXTRA_VARS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA',
  'FNHARNESS_PROFILE_NO_TELEMETRY',
]

const SECRET_NAME = /(key|token|secret|password|passwd|auth|credential)/i

export { isTruthy }

/** `dd-api-key=abc, x-org=7` -> `dd-api-key=***,x-org=***`. Never keeps a value. */
export function maskOtelHeaders(raw: string): string {
  return raw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const i = p.indexOf('=')
      return i <= 0 ? '***' : `${p.slice(0, i).trim()}=***`
    })
    .join(',')
}

/** Header names of a raw `k=v,k2=v2` list (for the destinations table). */
export function headerNames(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const i = p.indexOf('=')
      return i <= 0 ? '***' : p.slice(0, i).trim()
    })
}

/** `https://user:pw@host/p?x=1` -> `https://host/p`: no credentials, no query. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    const out = u.toString()
    return raw.endsWith('/') ? out : out.replace(/\/$/, '')
  } catch {
    return SECRET_NAME.test(raw) ? '***' : raw
  }
}

/** OTEL_RESOURCE_ATTRIBUTES parsed to pairs; values of sensitive-looking keys are masked. */
export function parseResourceAttributes(raw: string | undefined): { key: string; value: string }[] {
  if (!raw) return []
  return raw
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => {
      const i = p.indexOf('=')
      if (i <= 0) return { key: p, value: '' }
      const key = p.slice(0, i).trim()
      const value = p.slice(i + 1).trim()
      return { key, value: SECRET_NAME.test(key) ? '***' : value }
    })
}

/** Display value of a variable, with secrets masked. `masked` says whether anything was hidden. */
export function displayValue(name: string, value: string): { value: string; masked: boolean } {
  if (/HEADERS$/i.test(name)) return { value: maskOtelHeaders(value), masked: true }
  if (/ENDPOINT$/i.test(name)) {
    const m = maskUrl(value)
    return { value: m, masked: m !== value }
  }
  if (name === 'OTEL_RESOURCE_ATTRIBUTES') {
    const attrs = parseResourceAttributes(value)
    const text = attrs.map(a => `${a.key}=${a.value}`).join(',')
    return { value: text, masked: attrs.some(a => a.value === '***') }
  }
  if (SECRET_NAME.test(name)) return { value: '***', masked: true }
  return { value, masked: false }
}

/** Highest-precedence definition of `name`, or null when nobody sets it. */
function resolveVar(name: string, input: OtelReportInput): OtelVar | null {
  let raw: string | undefined
  let origin: OtelOrigin = 'process-env'
  let originLabel = 'entorno del proceso'
  for (const l of input.layers) {
    const v = l.env?.[name]
    if (v !== undefined && v !== '') {
      raw = v
      origin = l.origin
      originLabel = l.label
      break
    }
  }
  if (raw === undefined && input.profileEnv?.[name] !== undefined && input.processEnv[name] === input.profileEnv[name]) {
    raw = input.profileEnv[name]
    origin = 'account-profile'
    originLabel = input.profileLabel ?? 'perfil de cuenta'
  }
  if (raw === undefined) {
    const v = input.processEnv[name]
    if (v === undefined || v === '') return null
    raw = v
  }
  const d = displayValue(name, raw)
  return { name, value: d.value, origin, originLabel, masked: d.masked }
}

/** Raw effective value (internal use only: never put it in the report). */
function rawEffective(name: string, input: OtelReportInput): string | undefined {
  for (const l of input.layers) {
    const v = l.env?.[name]
    if (v !== undefined && v !== '') return v
  }
  const v = input.processEnv[name]
  return v === undefined || v === '' ? undefined : v
}

function relevantNames(input: OtelReportInput): string[] {
  const names = new Set<string>(EXTRA_VARS)
  const add = (e: Env | undefined) => {
    for (const k of Object.keys(e ?? {})) if (k.startsWith('OTEL_')) names.add(k)
  }
  for (const l of input.layers) add(l.env)
  add(input.processEnv)
  add(input.profileEnv)
  return [...names].sort((a, b) => {
    const ao = a.startsWith('OTEL_') ? 1 : 0
    const bo = b.startsWith('OTEL_') ? 1 : 0
    return ao - bo || a.localeCompare(b)
  })
}

function parseExporters(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s && s !== 'none')
}

function resolveDestination(signal: OtelSignal, input: OtelReportInput): OtelDestination {
  const S = signal.toUpperCase()
  const get = (n: string) => rawEffective(n, input)
  const exporters = parseExporters(get(EXPORTER_VAR[signal]))
  const endpointRaw = get(`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`) ?? get('OTEL_EXPORTER_OTLP_ENDPOINT')
  const protocolRaw = get(`OTEL_EXPORTER_OTLP_${S}_PROTOCOL`) ?? get('OTEL_EXPORTER_OTLP_PROTOCOL')
  const headersRaw = [get('OTEL_EXPORTER_OTLP_HEADERS'), get(`OTEL_EXPORTER_OTLP_${S}_HEADERS`)].filter(Boolean).join(',')
  const intervalRaw = Number(get(INTERVAL_VAR[signal]))
  const hasInterval = Number.isFinite(intervalRaw) && intervalRaw > 0
  return {
    signal,
    exporters,
    otlp: exporters.includes('otlp'),
    endpoint: endpointRaw ? maskUrl(endpointRaw) : null,
    protocol: protocolRaw ?? DEFAULT_PROTOCOL,
    protocolIsDefault: !protocolRaw,
    headers: headerNames(headersRaw),
    intervalMs: hasInterval ? intervalRaw : DEFAULT_INTERVAL_MS[signal],
    intervalIsDefault: !hasInterval,
  }
}

/** Pure: builds the whole report. */
export function buildOtelReport(input: OtelReportInput): OtelReport {
  const names = relevantNames(input)
  const vars = names.map(n => resolveVar(n, input)).filter((v): v is OtelVar => v !== null)
  const enable = vars.find(v => v.name === 'CLAUDE_CODE_ENABLE_TELEMETRY') ?? null
  const disable = vars.find(v => v.name === 'DISABLE_TELEMETRY') ?? null
  const requested = isTruthy(rawEffective('CLAUDE_CODE_ENABLE_TELEMETRY', input)) && !isTruthy(rawEffective('DISABLE_TELEMETRY', input))
  const destinations = SIGNALS.map(s => resolveDestination(s, input))
  const attrs = parseResourceAttributes(rawEffective('OTEL_RESOURCE_ATTRIBUTES', input))

  const b = input.sinksBlock
  const active = b.sinks.filter(s => s.enabled && s.activeForSession)
  const sends = input.buildEnabled && active.length > 0
  let verdict: string
  if (!input.buildEnabled) {
    verdict = 'No se envía nada: este build no lleva la telemetría (isTelemetryEnabled() = false).'
  } else if (sends) {
    verdict = `Se envía telemetría de la cuenta ${input.account.id} a: ${active.map(s => `${s.id} (${s.endpoint})`).join(', ')}.`
  } else if (b.humanDisabled && b.sinks.some(s => s.origin === 'user')) {
    verdict = 'No se envía nada: DISABLE_TELEMETRY está activo (apaga los receptores propios; los de una organización no dependen de él).'
  } else {
    verdict = `No se envía nada: ningún receptor está ligado a la cuenta ${input.account.id}.`
  }

  return {
    buildEnabled: input.buildEnabled,
    requested,
    sends,
    verdict,
    account: input.account,
    switches: { enable, disable },
    vars,
    destinations,
    resourceAttributes: attrs,
    sinksBlock: b,
  }
}

const secs = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`)

/** Pure: the receivers block of the text report. */
function formatSinks(r: OtelReport): string[] {
  const L: string[] = []
  const o = r.sinksBlock
  L.push(`Receptores (${o.sinks.length}):`)
  if (o.sinks.length === 0) L.push(`  (ninguno; los propios se declaran en ${o.path}${o.present ? '' : ', que no existe'})`)
  for (const s of o.sinks) {
    const kind = s.origin === 'managed' ? 'organización' : 'propio'
    const state = !s.enabled ? `desactivado${s.disabledReason ? `: ${s.disabledReason}` : ''}` : s.activeForSession ? 'recibe esta sesión' : 'ligado, no recibe esta sesión'
    L.push(`  ${s.id} [${kind} · ${state}]`)
    L.push(`    ${s.endpoint} · ${s.protocol} · esquema ${s.schema} · señales ${s.signals.join(', ') || 'ninguna'}`)
    L.push(`    cuentas ligadas: ${s.accounts.join(', ')}`)
    L.push(`    prompts: ${s.prompts ? 'sí' : 'no (<REDACTED>)'} · detalle de herramientas: ${s.toolDetails ? 'sí' : 'no'} · credenciales: ${s.hasCredentials ? 'sí (ocultas)' : 'no'}`)
    const st = s.status
    const when = (t: number | null) => (t ? new Date(t).toISOString().slice(11, 19) + ' UTC' : null)
    L.push(`    último envío correcto: ${when(st?.lastOkAt ?? null) ?? 'ninguno en esta sesión'} · último error: ${st?.lastError ? `${st.lastError} (${when(st.lastErrorAt)})` : 'ninguno'}${st?.blocked ? ` · sin iniciar: ${st.blocked}` : ''}`)
  }
  for (const e of o.errors) L.push(`  aviso en ${o.path}: ${e}`)
  if (o.humanDisabled) L.push('  DISABLE_TELEMETRY activo: los receptores propios no reciben nada.')
  return L
}

/** Pure: human text of the report. */
export function formatOtelReport(r: OtelReport): string {
  const L: string[] = []
  L.push('Telemetría (OpenTelemetry)')
  L.push('')
  L.push(r.verdict)
  L.push(`Build: telemetría ${r.buildEnabled ? 'con código de envío' : 'desactivada'}${r.sends ? ' · SE ENVÍA' : ' · no se envía'}`)
  L.push('')
  const a = r.account
  L.push(`Cuenta: ${a.id}${a.label ? ` (${a.label})` : ''}${a.provider ? ` · ${a.provider}` : ''}`)
  L.push(`  correo: ${a.email ?? 'no disponible'}${a.org ? ` · organización: ${a.org}` : ''}`)
  if (a.managedFrom) {
    L.push(`  remote-settings de la cuenta Claude ${a.managedFrom}: sus OTEL_* son un receptor de esa cuenta y no se aplican a process.env`)
  }
  L.push('')
  L.push(...formatSinks(r))
  L.push('')
  L.push('Variables OTEL_* vistas (las de la organización se aplican solo a su receptor; el entorno del proceso no crea receptores):')
  if (r.vars.length === 0) L.push('  (ninguna)')
  const w = Math.max(0, ...r.vars.map(v => v.name.length))
  for (const v of r.vars) L.push(`  ${v.name.padEnd(w)} = ${v.value}   ← ${v.originLabel}`)
  L.push('')
  L.push('Destinos que dicta la organización de la cuenta activa:')
  for (const d of r.destinations) {
    const ex = d.exporters.length ? d.exporters.join(',') : 'ninguno'
    if (!d.otlp) {
      L.push(`  ${d.signal}: exportador ${ex}${d.exporters.length ? ' (no sale de la máquina)' : ''}`)
      continue
    }
    L.push(`  ${d.signal}: exportador ${ex} → ${d.endpoint ?? '(sin endpoint)'}`)
    L.push(`    protocolo ${d.protocol}${d.protocolIsDefault ? ' (por defecto)' : ''} · intervalo ${secs(d.intervalMs)}${d.intervalIsDefault ? ' (por defecto)' : ''}`)
    L.push(`    cabeceras: ${d.headers.length ? d.headers.map(h => `${h}=***`).join(', ') : 'ninguna'}`)
  }
  L.push('')
  L.push('Atributos de recurso (de la organización):')
  if (r.resourceAttributes.length === 0) L.push('  (ninguno)')
  for (const t of r.resourceAttributes) L.push(`  ${t.key}=${t.value}`)
  L.push('')
  return L.join('\n')
}
