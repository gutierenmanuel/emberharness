/**
 * Session-scoped override of the auto-compact behaviour, set by `/autocompact`
 * and `--autocompact`. Pure parsing/clamping plus one module-level slot.
 */

export type AutoCompactOverride =
  | { kind: 'auto' }
  | { kind: 'off' }
  | { kind: 'tokens'; tokens: number }

/** Below this a summary would not fit the threshold and compaction would loop. */
export const MIN_AUTOCOMPACT_TOKENS = 10_000

export const AUTOCOMPACT_USAGE =
  'Usage: /autocompact [auto|off|<tokens>]  (tokens accept k/m suffix, e.g. 150k, 1m)'

export type ParsedAutoCompact =
  | { ok: true; value: AutoCompactOverride | null }
  | { ok: false; error: string }

/**
 * Pure. Empty input yields `value: null` (meaning "just show the status").
 * `<tokens>` accepts plain integers and `k`/`m` suffixes (decimals allowed).
 */
export function parseAutoCompactArg(input: string | undefined): ParsedAutoCompact {
  const raw = (input ?? '').trim().toLowerCase()
  if (raw === '') return { ok: true, value: null }
  if (raw === 'auto') return { ok: true, value: { kind: 'auto' } }
  if (raw === 'off') return { ok: true, value: { kind: 'off' } }
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(raw)
  if (!m) return { ok: false, error: AUTOCOMPACT_USAGE }
  const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1
  const tokens = Math.round(Number(m[1]) * mult)
  if (tokens < MIN_AUTOCOMPACT_TOKENS) {
    return {
      ok: false,
      error: `The threshold must be at least ${MIN_AUTOCOMPACT_TOKENS} tokens.`,
    }
  }
  return { ok: true, value: { kind: 'tokens', tokens } }
}

/**
 * Pure. The configured threshold can lower the default one but never raise it
 * above the window-derived default (the model could not hold more anyway).
 */
export function applyThresholdOverride(
  defaultThreshold: number,
  override: AutoCompactOverride | null,
): number {
  if (override?.kind === 'tokens') {
    return Math.min(defaultThreshold, override.tokens)
  }
  return defaultThreshold
}

export function describeAutoCompact(
  override: AutoCompactOverride | null,
  effectiveThreshold: number,
  enabled: boolean,
): string {
  if (!enabled) return 'Auto-compact is off for this session.'
  if (override?.kind === 'tokens') {
    const capped = effectiveThreshold < override.tokens
    return `Auto-compact fires at ${effectiveThreshold} tokens${capped ? ` (requested ${override.tokens}, capped by the model window)` : ''}.`
  }
  return `Auto-compact is on, default threshold ${effectiveThreshold} tokens.`
}

let current: AutoCompactOverride | null = null

export function getAutoCompactOverride(): AutoCompactOverride | null {
  return current
}

/** `auto` clears the override (back to settings + default threshold). */
export function setAutoCompactOverride(o: AutoCompactOverride): void {
  current = o.kind === 'auto' ? null : o
}
