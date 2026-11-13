/**
 * Telemetry delivery: which receivers exist, which of them a measurement may
 * reach, and sending it. The decisions are pure (sinks.ts, context.ts); this
 * module reads the live state (request scope, accounts, remote settings,
 * telemetry.json, secrets) and runs the exporters.
 *
 *   counter.add() / logOTelEvent()
 *        └─ ctx = account that served the request (or the session's)
 *             └─ sinksFor(ctx.account) ─▶ per receiver: its attributes, its
 *                                         own MeterProvider/LoggerProvider
 *
 * Session metrics (session count, active time, lines, commits, PRs, edit
 * decisions) go only to the receivers of the SESSION's account, whatever
 * account a subagent happens to be running on. Cost, tokens and events go to
 * those of the account that served the request.
 *
 * A receiver that is down only leaves a debug-log line; nothing here prints a
 * header or a secret.
 */

import type { Attributes, Counter, MetricOptions } from '@opentelemetry/api'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getPromptId, getSessionId, setCounters, type AttributedCounter } from '../../bootstrap/state.js'
import { isAnthropicAccountId, readStoreView } from '../../services/accounts/sessionAccounts.js'
import { readAccountInfo } from '../../services/accounts/anthropicAccounts.js'
import { telemetryEnvOf } from '../../services/accounts/managedPolicy.js'
import { getMultimodelProfile, getScopedAccountId } from '../../services/api/openai-compat/profiles.js'
import { getAccountRemoteSettings } from '../../services/remoteManagedSettings/syncCacheState.js'
import { resolveRef } from '../../services/secrets/secrets.js'
import { getAgentContext } from '../agentContext.js'
import { getGlobalConfig, getOrCreateUserID } from '../config.js'
import { logForDebugging } from '../debug.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { envDynamic } from '../envDynamic.js'
import { resolveTelemetryCtx, type TelemetryCtx } from './context.js'
import type { ExportResult, SinkProviders } from './sinkProviders.js'
import {
  eventMetadataFor,
  headersFromSecret,
  isTruthy,
  managedSinkFromEnv,
  parseHeaderList,
  parseUserSinks,
  scrubSecrets,
  sinkAttributes,
  sinksFor,
  type Identity,
  type Signal,
  type SinkDef,
  type SinkInfo,
  type SinkStatus,
} from './sinks.js'

const ROOT_ACCOUNT = 'claude'
const FLUSH_TIMEOUT_MS = 2_000

/** Metrics about the session itself: they follow the session's account, not the request's. */
const SESSION_METRICS = new Set([
  'claude_code.session.count',
  'claude_code.active_time.total',
  'claude_code.lines_of_code.count',
  'claude_code.commit.count',
  'claude_code.pull_request.count',
  'claude_code.code_edit_tool.decision',
])

type Runtime = {
  def: SinkDef
  status: SinkStatus
  building: Promise<void> | null
  providers: SinkProviders | null
  counters: Map<string, Counter>
  sessionStarted: boolean
  secrets: string[]
  lastLoggedError: string | null
}

const runtimes = new Map<string, Runtime>()

// ── receivers ───────────────────────────────────────────────────────────

export function userSinksPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || getClaudeConfigHomeDir(), 'telemetry.json')
}

let userCache: { path: string; mtimeMs: number; checkedAt: number; sinks: SinkDef[]; errors: string[] } | null = null

/** telemetry.json receivers, re-read when the file changes (checked at most once a second). */
export function loadUserSinks(): { sinks: SinkDef[]; errors: string[]; path: string; present: boolean } {
  const path = userSinksPath()
  const now = Date.now()
  if (userCache && userCache.path === path && now - userCache.checkedAt < 1000) {
    return { sinks: userCache.sinks, errors: userCache.errors, path, present: userCache.mtimeMs > 0 }
  }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    mtimeMs = 0
  }
  if (userCache && userCache.path === path && userCache.mtimeMs === mtimeMs) {
    userCache.checkedAt = now
    return { sinks: userCache.sinks, errors: userCache.errors, path, present: mtimeMs > 0 }
  }
  let parsed: ReturnType<typeof parseUserSinks> = { sinks: [], errors: [] }
  if (mtimeMs > 0) {
    try {
      parsed = parseUserSinks(readFileSync(path, 'utf8'))
    } catch (e) {
      parsed = { sinks: [], errors: [`no se pudo leer: ${(e as Error).message}`] }
    }
  }
  userCache = { path, mtimeMs, checkedAt: now, sinks: parsed.sinks, errors: parsed.errors }
  return { sinks: parsed.sinks, errors: parsed.errors, path, present: mtimeMs > 0 }
}

/** Forces the next read of telemetry.json (after /telemetry add). */
export function invalidateUserSinks(): void {
  userCache = null
}

const managedCache = new Map<string, { src: unknown; def: SinkDef | null }>()

/** The receiver an organisation configured for one Claude account (its remote settings), if any. */
export function managedSinkOf(account: string): SinkDef | null {
  const settings = getAccountRemoteSettings(account) as Record<string, unknown> | null
  const hit = managedCache.get(account)
  if (hit && hit.src === settings) return hit.def
  const env = settings ? telemetryEnvOf(settings) : {}
  const def = Object.keys(env).length ? managedSinkFromEnv(account, env) : null
  managedCache.set(account, { src: settings, def })
  return def
}

export function claudeAccountIds(): string[] {
  const store = readStoreView()
  return [ROOT_ACCOUNT, ...Object.entries(store.accounts).filter(([id, a]) => id !== ROOT_ACCOUNT && a.kind === 'anthropic').map(([id]) => id)]
}

/** Every receiver known now: telemetry.json plus each Claude account's managed one. */
export function allSinkDefs(): SinkDef[] {
  const managed = claudeAccountIds().map(managedSinkOf).filter((s): s is SinkDef => s !== null)
  return [...managed, ...loadUserSinks().sinks]
}

/** DISABLE_TELEMETRY set by the person. The profile's own switch is FNHARNESS_PROFILE_NO_TELEMETRY and never counts here. */
export function humanDisabledTelemetry(): boolean {
  return isTruthy(process.env.DISABLE_TELEMETRY)
}

export function sinksForAccount(account: string): SinkDef[] {
  return sinksFor(account, allSinkDefs(), { humanDisabled: humanDisabledTelemetry() })
}

// ── context ─────────────────────────────────────────────────────────────

export function sessionAccountId(): string {
  return process.env.FNHARNESS_ACCOUNT || ROOT_ACCOUNT
}

function currentCtx(mode: 'request' | 'session', model?: string): TelemetryCtx {
  const session = sessionAccountId()
  const scoped = mode === 'request' ? getScopedAccountId() : undefined
  const store = readStoreView()
  const agent = getAgentContext()
  const agentType = agent ? (('subagentName' in agent && agent.subagentName) || agent.agentType) : undefined
  return resolveTelemetryCtx(
    {
      scopedAccount: scoped,
      sessionAccount: session,
      kindOf: id => (id === ROOT_ACCOUNT || isAnthropicAccountId(id) ? 'anthropic' : 'openai_compat'),
      baseUrlOf: id => {
        if (id === session && id !== scoped) {
          const b = process.env.FNHARNESS_MODEL_BACKEND
          return b && /^https?:\/\//.test(b) ? b : store.accounts[id]?.baseUrl
        }
        return (id === scoped ? getMultimodelProfile()?.baseUrl : undefined) ?? store.accounts[id]?.baseUrl
      },
      model,
      agentType,
    },
    [ROOT_ACCOUNT, ...Object.keys(store.accounts)],
  )
}

function identityOf(account: string): Identity | null {
  if (!(account === ROOT_ACCOUNT || isAnthropicAccountId(account))) return null
  const info = account === ROOT_ACCOUNT ? getGlobalConfig().oauthAccount : readAccountInfo(account)
  if (!info) return null
  return { email: info.emailAddress, organizationId: info.organizationUuid, accountUuid: info.accountUuid }
}

let pcCache: string | null | undefined
function pcName(): string | undefined {
  if (pcCache === undefined) {
    try {
      const p = join(homedir(), '.fn_pc')
      pcCache = existsSync(p) ? readFileSync(p, 'utf8').split('\n')[0]!.trim() || null : null
    } catch {
      pcCache = null
    }
  }
  return pcCache ?? undefined
}

function attrsFor(def: SinkDef, ctx: TelemetryCtx): Attributes {
  return sinkAttributes(def, {
    userId: getOrCreateUserID(),
    sessionId: getSessionId(),
    appVersion: MACRO.VERSION,
    terminal: envDynamic.terminal ?? undefined,
    identity: identityOf(ctx.account),
    ctx,
    pc: pcName(),
  })
}

// ── runtime of one receiver ─────────────────────────────────────────────

function runtimeOf(def: SinkDef): Runtime {
  const hit = runtimes.get(def.id)
  if (hit) {
    // A receiver edited in telemetry.json is a new definition: rebuild it.
    if (hit.def === def || JSON.stringify(hit.def) === JSON.stringify(def)) return hit
    void hit.providers?.shutdown()
  }
  const rt: Runtime = {
    def,
    status: { lastOkAt: null, lastError: null, lastErrorAt: null, ok: 0, failed: 0, blocked: null },
    building: null,
    providers: null,
    counters: new Map(),
    sessionStarted: false,
    secrets: [],
    lastLoggedError: null,
  }
  runtimes.set(def.id, rt)
  return rt
}

function note(rt: Runtime, signal: Signal, r: ExportResult): void {
  const now = Date.now()
  if (r.ok) {
    rt.status.ok++
    rt.status.lastOkAt = now
    if (rt.lastLoggedError !== null || rt.status.ok === 1) logForDebugging(`[telemetry] ${rt.def.id}: ${signal} enviadas (2xx)`)
    rt.lastLoggedError = null
    return
  }
  rt.status.failed++
  const msg = scrubSecrets(r.error ?? 'exportación fallida', rt.secrets)
  rt.status.lastError = `${signal}: ${msg}`
  rt.status.lastErrorAt = now
  if (rt.lastLoggedError !== msg) {
    rt.lastLoggedError = msg
    logForDebugging(`[telemetry] ${rt.def.id}: no se pudo enviar ${signal}: ${msg}`)
  }
}

/** Resolves the receiver's credentials. Throws a message that never carries the value. */
function headersOf(def: SinkDef, rt: Runtime): Record<string, string> {
  if (def.origin === 'managed') {
    const h = def.headersList ? parseHeaderList(def.headersList) : {}
    rt.secrets.push(...Object.values(h))
    return h
  }
  if (!def.headersRef) return {}
  let value: string
  try {
    value = resolveRef(def.headersRef)
  } catch (e) {
    throw new Error(`secreto ${def.headersRef} no disponible (${(e as Error).message.split('\n')[0]})`)
  }
  rt.secrets.push(value)
  const h = headersFromSecret(value, def.headersAs)
  rt.secrets.push(...Object.values(h))
  return h
}

function ensureBuilt(rt: Runtime): Promise<void> {
  if (rt.building) return rt.building
  rt.building = (async () => {
    try {
      const headers = headersOf(rt.def, rt)
      const { buildProviders } = await import('./sinkProviders.js')
      rt.providers = buildProviders(rt.def, headers, MACRO.VERSION, (signal, r) => note(rt, signal, r))
    } catch (e) {
      const msg = scrubSecrets((e as Error).message, rt.secrets)
      rt.status.blocked = msg
      rt.status.lastError = msg
      rt.status.lastErrorAt = Date.now()
      logForDebugging(`[telemetry] ${rt.def.id}: receptor sin iniciar: ${msg}`)
    }
  })()
  return rt.building
}

function counterOf(rt: Runtime, name: string, options: MetricOptions): Counter | null {
  const meter = rt.providers?.meter
  if (!meter) return null
  let c = rt.counters.get(name)
  if (!c) {
    c = meter.createCounter(name, options)
    rt.counters.set(name, c)
  }
  return c
}

// ── metrics ─────────────────────────────────────────────────────────────

function addTo(rt: Runtime, name: string, options: MetricOptions, value: number, attrs: Attributes): void {
  if (!rt.def.signals.metrics) return
  void ensureBuilt(rt).then(() => counterOf(rt, name, options)?.add(value, attrs))
}

/** Records one increment where it belongs (see the module comment). */
export function recordMetric(name: string, options: MetricOptions, value: number, extra: Attributes | undefined): void {
  const mode = SESSION_METRICS.has(name) ? 'session' : 'request'
  const ctx = currentCtx(mode, typeof extra?.model === 'string' ? extra.model : undefined)
  const sinks = sinksForAccount(ctx.account)
  for (const def of sinks) {
    const rt = runtimeOf(def)
    const attrs: Attributes = { ...attrsFor(def, ctx), ...extra }
    if (mode === 'session' && !rt.sessionStarted) {
      // A receiver that joins mid-session (account switch) starts with its own session.count.
      rt.sessionStarted = true
      if (name !== 'claude_code.session.count') {
        addTo(rt, 'claude_code.session.count', { description: 'Count of CLI sessions started' }, 1, attrsFor(def, ctx))
      }
    }
    addTo(rt, name, options, value, attrs)
  }
}

/** The counter factory handed to bootstrap/state: each add() goes through recordMetric. */
export function createAttributedCounter(name: string, options: MetricOptions): AttributedCounter {
  return { add: (value, extra) => recordMetric(name, options, value, extra) }
}

export function installCounters(): void {
  setCounters(createAttributedCounter)
}

// ── events ──────────────────────────────────────────────────────────────

let eventSequence = 0

/** True when some receiver reached by the current request wants user prompt text. */
export function promptsWanted(): boolean {
  return sinksForAccount(currentCtx('request').account).some(s => s.signals.logs && s.logUserPrompts)
}

/** True when some receiver reached by the current request wants tool details. */
export function toolDetailsWanted(): boolean {
  return sinksForAccount(currentCtx('request').account).some(s => s.signals.logs && s.logToolDetails)
}

export function emitEvent(eventName: string, metadata: Record<string, string | undefined>): void {
  const ctx = currentCtx('request')
  const sinks = sinksForAccount(ctx.account).filter(s => s.signals.logs)
  if (sinks.length === 0) return
  const sequence = eventSequence++
  const timestamp = new Date().toISOString()
  const promptId = getPromptId()
  for (const def of sinks) {
    const rt = runtimeOf(def)
    const attributes: Attributes = {
      ...attrsFor(def, ctx),
      'event.name': eventName,
      'event.timestamp': timestamp,
      'event.sequence': sequence,
      ...(promptId ? { 'prompt.id': promptId } : {}),
      ...eventMetadataFor(def, metadata),
    }
    void ensureBuilt(rt).then(() => rt.providers?.logger?.emit({ body: `claude_code.${eventName}`, attributes }))
  }
}

// ── flush, status, test ─────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => void setTimeout(r, ms))

/** Sends what is pending. At most FLUSH_TIMEOUT_MS per receiver, all in parallel; never rejects. */
export async function flushSinks(): Promise<void> {
  const live = [...runtimes.values()].filter(rt => rt.building)
  await Promise.all(
    live.map(async rt => {
      const timedOut = Symbol('timeout')
      const r = await Promise.race([
        (async () => {
          await rt.building
          await rt.providers?.forceFlush()
        })().catch(() => undefined),
        sleep(FLUSH_TIMEOUT_MS).then(() => timedOut),
      ])
      if (r === timedOut && rt.providers) {
        // The exporter keeps retrying a receiver that is down; at exit we stop waiting.
        note(rt, rt.def.signals.metrics ? 'metrics' : 'logs', { ok: false, error: `sin respuesta en ${FLUSH_TIMEOUT_MS / 1000} s al salir; se descarta lo pendiente` })
      }
    }),
  )
}

function hostPath(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '(url no válida)'
  }
}

/** Live view of every receiver for /telemetry and /otel. Never carries a credential. */
export function sinkInfos(): SinkInfo[] {
  const session = sessionAccountId()
  const humanOff = humanDisabledTelemetry()
  const known = claudeAccountIds().concat(Object.keys(readStoreView().accounts))
  return allSinkDefs().map(def => {
    const sig = def.signals.metrics ?? def.signals.logs
    const bound = def.origin === 'managed' ? [def.account!] : def.accounts === '*' ? [...new Set(known), '(todas)'] : def.accounts
    const userOff = def.origin === 'user' && humanOff
    return {
      id: def.id,
      origin: def.origin,
      endpoint: sig ? hostPath(sig.url) : '(sin señales)',
      protocol: sig?.protocol ?? '-',
      schema: def.schema,
      accounts: bound,
      enabled: def.enabled && !userOff,
      disabledReason: userOff ? 'DISABLE_TELEMETRY activo' : (def.disabledReason ?? null),
      activeForSession: sinksFor(session, [def], { humanDisabled: humanOff }).length > 0,
      signals: (['metrics', 'logs'] as const).filter(s => def.signals[s]),
      prompts: def.logUserPrompts,
      toolDetails: def.logToolDetails,
      hasCredentials: !!(def.headersRef || def.headersList),
      status: runtimes.get(def.id)?.status ?? null,
    }
  })
}

export type TestResult = { ok: boolean; detail: string }

/**
 * Sends one test point to a receiver of telemetry.json and reports whether it
 * was accepted. Managed receivers are refused: they belong to an organisation
 * and a test point would end up in its data.
 */
export async function testSink(id: string): Promise<TestResult> {
  const def = allSinkDefs().find(s => s.id === id)
  if (!def) return { ok: false, detail: `no existe el receptor "${id}" (mira /telemetry)` }
  if (def.origin === 'managed') {
    return { ok: false, detail: `"${id}" es el receptor de una organización: no se le envían puntos de prueba` }
  }
  if (!def.enabled) return { ok: false, detail: `"${id}" está desactivado (${def.disabledReason ?? 'enabled:false'})` }
  const m = def.signals.metrics
  if (!m) return { ok: false, detail: `"${id}" no tiene la señal de métricas` }
  const rt = runtimeOf(def)
  let headers: Record<string, string>
  try {
    headers = headersOf(def, rt)
  } catch (e) {
    const msg = scrubSecrets((e as Error).message, rt.secrets)
    rt.status.blocked = msg
    return { ok: false, detail: msg }
  }
  const where = hostPath(m.url)
  if (m.protocol === 'http/json') {
    // Direct POST: the status code is the answer, and a dead receiver fails at once
    // instead of going through the exporter's retries.
    try {
      const res = await fetch(m.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(testPointJson(def.id)),
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) {
        note(rt, 'metrics', { ok: true })
        return { ok: true, detail: `punto de prueba aceptado por ${where} (HTTP ${res.status})` }
      }
      note(rt, 'metrics', { ok: false, error: `HTTP ${res.status}` })
      return { ok: false, detail: `${where} respondió HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (credenciales rechazadas)' : ''}` }
    } catch (e) {
      const msg = scrubSecrets((e as Error).message || 'sin conexión', rt.secrets)
      note(rt, 'metrics', { ok: false, error: msg })
      return { ok: false, detail: `no se pudo contactar con ${where}: ${msg}` }
    }
  }
  await ensureBuilt(rt)
  if (!rt.providers) return { ok: false, detail: rt.status.blocked ?? 'receptor sin iniciar' }
  const before = { ok: rt.status.ok, failed: rt.status.failed }
  const counter = counterOf(rt, 'fnharness.telemetry.test', { description: 'Test point sent by /telemetry test' })
  counter?.add(1, { 'fnharness.sink': def.id, 'fnharness.test': true })
  await Promise.race([rt.providers.forceFlush(), sleep(FLUSH_TIMEOUT_MS * 2)])
  if (rt.status.ok > before.ok) return { ok: true, detail: `punto de prueba aceptado por ${where} (respuesta 2xx)` }
  if (rt.status.failed > before.failed) return { ok: false, detail: rt.status.lastError ?? 'el receptor rechazó el punto' }
  return { ok: false, detail: `sin respuesta de ${where} en el plazo` }
}

/** The test point as an OTLP/JSON metrics request: one delta counter, no account or identity. */
export function testPointJson(sinkId: string): object {
  const nano = String(BigInt(Date.now()) * 1_000_000n)
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'fnharness' } }] },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code' },
            metrics: [
              {
                name: 'fnharness.telemetry.test',
                description: 'Test point sent by /telemetry test',
                sum: {
                  aggregationTemporality: 1,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: [
                        { key: 'fnharness.sink', value: { stringValue: sinkId } },
                        { key: 'fnharness.test', value: { boolValue: true } },
                        { key: 'pc', value: { stringValue: pcName() ?? 'unknown' } },
                      ],
                      startTimeUnixNano: nano,
                      timeUnixNano: nano,
                      asDouble: 1,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

export function resetSinkRuntimeForTesting(): void {
  for (const rt of runtimes.values()) void rt.providers?.shutdown()
  runtimes.clear()
  managedCache.clear()
  userCache = null
  eventSequence = 0
  pcCache = undefined
}
