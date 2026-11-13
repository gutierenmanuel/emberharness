/**
 * Remote managed settings and policy limits of several Claude accounts in one
 * session (decision D7): the policies of every account in use apply to the
 * whole session, combined keeping the most restrictive value, so using another
 * account never sidesteps a company's policy on its machine.
 *
 * Telemetry settings (OTEL_*, CLAUDE_CODE_ENABLE_TELEMETRY, otelHeadersHelper)
 * are not process-wide: they belong to the account (a telemetry receiver of
 * that account), so they are stripped from what reaches process.env.
 *
 * Everything here is pure and unit-tested.
 */

type Json = Record<string, unknown>

/** Pure: whether an env var name is telemetry configuration of an account. */
export function isTelemetryEnvKey(name: string): boolean {
  const k = name.toUpperCase()
  return k.startsWith('OTEL_') || k.startsWith('CLAUDE_CODE_OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY'
}

/** Settings keys that only configure telemetry. */
const TELEMETRY_SETTINGS_KEYS = ['otelHeadersHelper']

/** Pure: `settings` without its telemetry part (null stays null; the input is not mutated). */
export function stripTelemetrySettings<T extends Json | null>(settings: T): T {
  if (!settings) return settings
  const out: Json = { ...settings }
  for (const k of TELEMETRY_SETTINGS_KEYS) delete out[k]
  const env = settings.env
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const kept = Object.fromEntries(Object.entries(env as Json).filter(([k]) => !isTelemetryEnvKey(k)))
    if (Object.keys(kept).length) out.env = kept
    else delete out.env
  }
  return out as T
}

/** Pure: only the telemetry env of `settings` (what a receiver of that account would use). */
export function telemetryEnvOf(settings: Json | null | undefined): Record<string, string> {
  const env = settings?.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {}
  return Object.fromEntries(
    Object.entries(env as Json).filter(([k, v]) => isTelemetryEnvKey(k) && typeof v === 'string'),
  ) as Record<string, string>
}

const RESTRICTIVE_TRUE = /^(allowManaged|disable|strict|require|force|block|deny)/
const RESTRICTIVE_FALSE = /^(allow|enable)/
const UNION_ARRAY = /(deny|denied|disallow|block|ask)/i

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function union(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set(a.map(x => JSON.stringify(x)))
  return [...a, ...b.filter(x => !seen.has(JSON.stringify(x)))]
}

function intersect(a: unknown[], b: unknown[]): unknown[] {
  const inB = new Set(b.map(x => JSON.stringify(x)))
  return a.filter(x => inB.has(JSON.stringify(x)))
}

/**
 * Pure: one value out of two for the same key, keeping the most restrictive.
 * `a` belongs to the account listed first (the session's), which wins when
 * there is no notion of "more restrictive".
 */
function mergeValue(key: string, a: unknown, b: unknown): unknown {
  if (a === undefined) return b
  if (b === undefined) return a
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    if (RESTRICTIVE_TRUE.test(key)) return a || b
    if (RESTRICTIVE_FALSE.test(key)) return a && b
    return a
  }
  if (key === 'disableBypassPermissionsMode') return a === 'disable' || b === 'disable' ? 'disable' : a
  if (Array.isArray(a) && Array.isArray(b)) {
    if (key === 'allow' || /^allowed/i.test(key)) return intersect(a, b)
    if (UNION_ARRAY.test(key)) return union(a, b)
    return a
  }
  if (isObject(a) && isObject(b)) {
    if (key === 'hooks') {
      const out: Json = { ...a }
      for (const [ev, list] of Object.entries(b)) {
        out[ev] = Array.isArray(out[ev]) && Array.isArray(list) ? [...(out[ev] as unknown[]), ...list] : (out[ev] ?? list)
      }
      return out
    }
    if (key === 'env') return { ...b, ...a }
    return mergeObjects(a, b)
  }
  return a
}

function mergeObjects(a: Json, b: Json): Json {
  const out: Json = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = mergeValue(k, a[k], b[k])
  return out
}

export type AccountSettings = { accountId: string; settings: Json | null }

export type MergedManagedSettings = {
  /** Combined settings, telemetry stripped; null when no account brings any. */
  settings: Json | null
  /** Top-level key → accounts that set it (for `/account`: who imposes what). */
  imposedBy: Record<string, string[]>
}

/** Pure: the managed settings of every in-force account, combined (D7) and without telemetry. */
export function mergeManagedSettings(list: AccountSettings[]): MergedManagedSettings {
  let merged: Json | null = null
  const imposedBy: Record<string, string[]> = {}
  for (const { accountId, settings } of list) {
    const clean = stripTelemetrySettings(settings)
    if (!clean || Object.keys(clean).length === 0) continue
    for (const k of Object.keys(clean)) (imposedBy[k] ??= []).push(accountId)
    merged = merged ? mergeObjects(merged, clean) : { ...clean }
  }
  return { settings: merged, imposedBy }
}

export type Restrictions = Record<string, { allowed: boolean }>

/** Pure: policy restrictions of every in-force account; a policy is allowed only if all allow it. */
export function mergeRestrictions(list: Array<Restrictions | null | undefined>): Restrictions | null {
  let out: Restrictions | null = null
  for (const r of list) {
    if (!r) continue
    out ??= {}
    for (const [k, v] of Object.entries(r)) {
      const allowed = typeof v?.allowed === 'boolean' ? v.allowed : true
      out[k] = { allowed: (out[k]?.allowed ?? true) && allowed }
    }
  }
  return out
}
