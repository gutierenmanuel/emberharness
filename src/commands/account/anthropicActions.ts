/**
 * /account for Claude (Anthropic OAuth) accounts: identity panel, import,
 * login into accounts/<id>/, permission doctor. The pure formatting comes
 * first and is unit-tested; the collectors below do the I/O.
 *
 * Never prints a token: the panel only says whether an account has a login.
 */

import { readFileSync } from 'fs'
import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  isAnthropicAccount,
  listAccounts,
  loadStore,
  type Account,
} from '../../services/api/openai-compat/accounts.js'
import {
  anthropicAccountStatus,
  auditAccountPermissions,
  fixAccountPermissions,
  importAnthropicAccount,
  migrateRootClaudeAccount,
  type AnthropicAccountStatus,
  type PermissionFinding,
} from '../../services/accounts/anthropicAccounts.js'
import { readAccountFile, rootFilePath } from '../../services/accounts/anthropicFiles.js'
import { telemetryEnvOf } from '../../services/accounts/managedPolicy.js'
import { accountDisabledReason, accountsInForce } from '../../services/accounts/sessionAccounts.js'
import { MultimodelConfigError } from '../../services/api/openai-compat/profiles.js'
import { getProviderPresets } from '../../services/config/providers.js'
import type { ActionResult } from './actions.js'

type Env = Record<string, string | undefined>

// ── pure ────────────────────────────────────────────────────────────────

export type PanelEntry = {
  id: string
  /** `Claude (Anthropic)`, `llama.cpp local`, ... */
  title: string
  session: boolean
  isDefault?: boolean
  /** Claude: `correo · organización · plan`; OpenAI-compatible: base URL. */
  identity: string
  model: string | null
  remembered?: string | null
  /** `✓ lista`, `✗ sin login`, `✓ responde`, `✗ no responde`, `✗ falta clave`, `✗ desactivada`. */
  state: string
  /** Extra detail lines (telemetry of the organisation, policies it imposes, why disabled). */
  notes?: string[]
}

const WIDTH = 70

/** Pure: `── id · title ● sesión ───…` padded to a fixed width. */
export function panelHeader(e: Pick<PanelEntry, 'id' | 'title' | 'session' | 'isDefault'>): string {
  const tags = [e.session ? '● sesión' : '', e.isDefault ? '[predeterminada]' : ''].filter(Boolean).join(' ')
  const head = `── ${e.id} · ${e.title}${tags ? ` ${tags}` : ''} `
  return head + '─'.repeat(Math.max(3, WIDTH - head.length))
}

/** Pure: the identity line of a Claude account. */
export function claudeIdentity(s: Pick<AnthropicAccountStatus, 'email' | 'org' | 'orgUuid' | 'plan'>): string {
  const parts: string[] = []
  parts.push(s.email ?? 'sin identidad (falta login)')
  if (s.org) parts.push(s.orgUuid ? `${s.org} (org ${s.orgUuid.slice(0, 4)}…)` : s.org)
  else if (s.email) parts.push('personal')
  if (s.plan) parts.push(`plan ${s.plan.charAt(0).toUpperCase()}${s.plan.slice(1)}`)
  return parts.join(' · ')
}

/** Pure: `modelo: x (recordado: y)` plus the state aligned on the right. */
export function modelLine(e: Pick<PanelEntry, 'model' | 'remembered' | 'state'>): string {
  const model = e.model ?? e.remembered ?? 'por defecto'
  const rem = e.remembered && e.model && e.remembered !== e.model ? ` (recordado: ${e.remembered})` : ''
  const left = `modelo: ${model}${rem}`
  return `${left.padEnd(Math.max(left.length + 2, 50))}${e.state}`
}

/** Pure: the whole /account panel, as in the plan's mockup (docs/plans/otel_telemetry.md §3). */
export function formatAccountPanel(entries: PanelEntry[], hidden = 0): string[] {
  const lines = ['  Cuentas']
  for (const e of entries) {
    lines.push(`  ${panelHeader(e)}`)
    lines.push(`     ${e.identity}`)
    lines.push(`     ${modelLine(e)}`)
    for (const n of e.notes ?? []) lines.push(`     ${n}`)
  }
  if (hidden > 0) lines.push(`  (+${hidden} cuentas integradas sin clave: /account catalog, /account key <id> <apikey>)`)
  return lines
}

/** Pure: the host of an OTLP endpoint, or the raw value when it is not a URL. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** Pure: notes about what a Claude account's organisation sets (telemetry, policies). */
export function organisationNotes(
  remote: Record<string, unknown> | null,
  restrictions: Record<string, { allowed?: boolean }> | null,
  inForce: boolean,
): string[] {
  const notes: string[] = []
  const tele = telemetryEnvOf(remote)
  const endpoint = tele.OTEL_EXPORTER_OTLP_ENDPOINT ?? tele.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? tele.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  if (endpoint) notes.push(`telemetría corporativa → ${endpointHost(endpoint)} (de sus remote-settings; este build aún no envía)`)
  const denied = Object.entries(restrictions ?? {})
    .filter(([, v]) => v?.allowed === false)
    .map(([k]) => k)
  if (denied.length) {
    notes.push(`políticas${inForce ? ' (aplican a la sesión)' : ''}: ${denied.length} restricciones (${denied.slice(0, 3).join(', ')}${denied.length > 3 ? ', …' : ''})`)
  }
  return notes
}

/** Pure: findings to report lines; group/other bits on are an error. */
export function formatPermissionReport(findings: PermissionFinding[], fixed: string[] = []): string[] {
  if (findings.length === 0) return ['No hay credenciales ni cuentas Claude en esta configuración.']
  const lines = findings.map(f => {
    const mode = f.mode.toString(8).padStart(3, '0')
    const want = f.want.toString(8)
    const mark = f.ok ? '✓' : fixed.includes(f.path) ? '✓ corregido' : '✗'
    return `${mark.padEnd(12)} ${mode}${f.ok ? '' : ` (debe ser ${want})`}  ${f.path}`
  })
  const bad = findings.filter(f => !f.ok && !fixed.includes(f.path)).length
  lines.push(bad ? `${bad} con permisos abiertos: /account doctor --fix los deja en 0600 (ficheros) y 0700 (carpetas).` : 'Permisos correctos.')
  return lines
}

/** Pure: `/account import <dir> --as <id>` arguments. */
export function parseImportArgs(rest: string[]): { dir: string; id: string } {
  const at = rest.indexOf('--as')
  const id = at >= 0 ? rest[at + 1] : undefined
  const dir = rest.filter((_, i) => i !== at && i !== at + 1).join(' ')
  if (!dir || !id) throw new MultimodelConfigError('Uso: /account import <directorio> --as <id>   (p. ej. /account import ~/.fnharness-work --as claude-work)')
  return { dir, id }
}

// ── I/O ─────────────────────────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Identity and tokens of `claude`, read from the root files (only to show them). */
function rootIdentity(env: Env): Parameters<typeof anthropicAccountStatus>[1] {
  const cfg = readJson(rootFilePath('globalConfig', env))
  const creds = readJson(rootFilePath('credentials', env))
  return {
    info: (cfg?.oauthAccount as never) ?? null,
    tokens: (creds?.claudeAiOauth as never) ?? null,
  }
}

export type PanelOptions = {
  env?: Env
  /** The session's model (only known inside the running session). */
  sessionModel?: string | null
  /** Accounts with a probe result for local servers (accountsWithStatus). */
  accounts?: Array<Account & { online?: boolean }>
}

/** Every account worth showing, with identity, model and state. */
export function collectAccountPanel(opts: PanelOptions = {}): { entries: PanelEntry[]; hidden: number } {
  const env = opts.env ?? process.env
  const store = loadStore(accountsFilePath(env))
  const session = env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID
  const accounts = opts.accounts ?? listAccounts(store, env)
  const inForce = new Set(accountsInForce(env))
  const presets = getProviderPresets()
  const entries: PanelEntry[] = []
  let hidden = 0
  for (const a of accounts) {
    const isDefault = store.default === a.id
    if (isAnthropicAccount(a.id, store)) {
      const status = anthropicAccountStatus(a.id, a.id === CLAUDE_ACCOUNT_ID ? rootIdentity(env) : {}, env)
      const off = accountDisabledReason(a.id)
      const remote = a.id === CLAUDE_ACCOUNT_ID ? readJson(rootFilePath('remoteSettings', env)) : readAccountFile(a.id, 'remoteSettings', env)
      const limits = (a.id === CLAUDE_ACCOUNT_ID ? readJson(rootFilePath('policyLimits', env)) : readAccountFile(a.id, 'policyLimits', env)) as {
        restrictions?: Record<string, { allowed?: boolean }>
      } | null
      const notes = organisationNotes(remote, limits?.restrictions ?? null, inForce.has(a.id))
      if (status.importedFrom) notes.push(`importada de ${status.importedFrom} (ese directorio no se toca)`)
      if (off) notes.push(`desactivada en esta sesión: ${off}`)
      entries.push({
        id: a.id,
        title: a.label,
        session: a.id === session,
        isDefault,
        identity: claudeIdentity(status),
        model: a.id === session ? (opts.sessionModel ?? null) : null,
        remembered: store.accounts[a.id]?.model ?? null,
        state: off ? '✗ desactivada' : status.hasToken ? '✓ lista' : '✗ sin login',
        notes,
      })
      continue
    }
    // OpenAI-compatible: hide built-in presets that still have no key (they are in the picker).
    if (!a.ready && a.id in presets && !(a.id in store.accounts)) {
      hidden++
      continue
    }
    const local = (a as { online?: boolean }).online
    entries.push({
      id: a.id,
      title: a.label,
      session: a.id === session,
      isDefault,
      identity: a.baseUrl ?? a.detail,
      model: a.id === session ? (opts.sessionModel ?? null) : null,
      remembered: store.accounts[a.id]?.model ?? (a.ready ? a.detail.split(' @ ')[0] ?? null : null),
      state: !a.ready ? '✗ falta clave' : local === undefined ? '✓ lista' : local ? '✓ responde' : '✗ no responde',
    })
  }
  // The session's account first, then Claude accounts, then the rest in their order.
  const rank = (e: PanelEntry) => (e.session ? 0 : isAnthropicAccount(e.id, store) ? 1 : 2)
  entries.sort((x, y) => rank(x) - rank(y))
  return { entries, hidden }
}

/**
 * Runs the one-time migration of the root login into `accounts/claude/`
 * (copy only). Called by every /account use; returns a line to show the first time.
 */
export function migrateOnce(env: Env = process.env): string | null {
  try {
    const r = migrateRootClaudeAccount(env)
    return r.migrated ? `Cuenta «claude» registrada como cuenta Claude; copia de su login y ajustes en accounts/claude/ (${r.copied.join(', ') || 'nada que copiar'}). La raíz no se ha tocado.` : null
  } catch (err) {
    return `No se pudo registrar la cuenta «claude»: ${err instanceof Error ? err.message : String(err)}`
  }
}

export function importAction(rest: string[], env: Env = process.env): ActionResult {
  const { dir, id } = parseImportArgs(rest)
  const r = importAnthropicAccount(dir, id, env)
  const who = [r.email, r.org].filter(Boolean).join(' · ') || 'sin identidad guardada en el origen'
  return {
    message: `Cuenta Claude ${id} importada (${who}); copiado: ${r.copied.join(', ')}. El directorio de origen no se ha tocado. Úsala con /account ${id} o en un agente con ${id}:sonnet.`,
  }
}

export function doctorAction(fix: boolean, env: Env = process.env): ActionResult {
  const findings = auditAccountPermissions(env)
  const fixed = fix ? fixAccountPermissions(findings) : []
  return { message: formatPermissionReport(findings, fixed).join('\n') }
}

export function panelText(opts: PanelOptions = {}): string {
  const { entries, hidden } = collectAccountPanel(opts)
  return formatAccountPanel(entries, hidden).join('\n')
}
