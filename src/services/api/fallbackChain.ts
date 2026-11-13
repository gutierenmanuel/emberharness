/**
 * Fallback chain: when the active account/model is unavailable, the turn is
 * retried on the next entry of a short list (max 3), which may live on a
 * different account (a local llama-server that is down, falling back to a
 * hosted API, to the native Claude account, ...).
 *
 * Entry format (flag `--fallback-model a,b,c` or setting `fallbackModel`):
 *   `cuenta`          switch account, keep the account's own model   (qwen36)
 *   `cuenta:modelo`   switch account and model                       (claude:haiku, openrouter:x/y)
 *   `modelo`          same account, other model                      (gpt-4.1-mini)
 * A prefix counts as account only when it is `claude`, a built-in preset or a
 * stored account, so model ids with colons (`qwen3:8b`) keep working.
 *
 * Like the official feature the substitution lasts one user turn: the next
 * prompt tries the primary again (`restorePrimary`). The pure helpers come
 * first and are unit-tested; the stateful part below only orchestrates them.
 */

import { APIError } from '@anthropic-ai/sdk'
import {
  CLAUDE_ACCOUNT_ID,
  accountsFilePath,
  loadStore,
  profileForAccount,
  type AccountStore,
} from './openai-compat/accounts.js'
import { getProviderPresets } from '../config/providers.js'
import {
  getMultimodelProfile,
  setActiveProfile,
  type MultimodelProfile,
} from './openai-compat/profiles.js'

export const MAX_FALLBACKS = 3
/** Failed attempts of the primary before moving on to the next entry. */
export const FALLBACK_AFTER_ATTEMPTS = 3

export type FallbackTarget = {
  /** The entry as the user wrote it, for messages. */
  raw: string
  /** Account to switch to; undefined = stay on the active one. */
  account?: string
  /** Model to use; undefined = the account's own model. */
  model?: string
}

type Env = Record<string, string | undefined>

/** Pure: flag value or setting (string, comma list or array) to a clean list of at most 3. */
export function parseFallbackList(
  input: string | readonly string[] | undefined | null,
): string[] {
  if (input == null) return []
  const parts = (typeof input === 'string' ? [input] : input)
    .flatMap(s => String(s).split(','))
    .map(s => s.trim())
    .filter(Boolean)
  return [...new Set(parts)].slice(0, MAX_FALLBACKS)
}

/** Pure: one entry to a target, given a predicate that recognises account ids. */
export function parseFallbackTarget(
  raw: string,
  isAccount: (id: string) => boolean,
): FallbackTarget {
  const colon = raw.indexOf(':')
  if (colon > 0 && isAccount(raw.slice(0, colon))) {
    const model = raw.slice(colon + 1).trim()
    return { raw, account: raw.slice(0, colon), ...(model && { model }) }
  }
  if (isAccount(raw)) return { raw, account: raw }
  return { raw, model: raw }
}

/** Pure: account ids known to a store (claude, presets and the stored ones). */
export function accountPredicate(store: AccountStore): (id: string) => boolean {
  return id =>
    id === CLAUDE_ACCOUNT_ID || id in getProviderPresets() || id in store.accounts
}

/**
 * Pure: whether a failed request means "this backend is not available" (5xx,
 * 529/overloaded, the adapter's 503 for a refused connection). Auth, billing,
 * rate-limit and 4xx errors keep their normal handling and never fall back.
 */
export function isFallbackEligible(error: unknown): boolean {
  const status =
    error instanceof APIError
      ? error.status
      : typeof (error as { status?: unknown } | null)?.status === 'number'
        ? ((error as { status: number }).status)
        : undefined
  return status !== undefined && status >= 500
}

/** Pure: whether a resolved entry would leave the session exactly where it is. */
export function isSameBackend(
  r: { accountId: string; model: string },
  active: { account: string; model: string | undefined },
): boolean {
  return r.accountId === active.account && r.model === active.model
}

// ── runtime state ───────────────────────────────────────────────────────

export type ResolvedFallback = {
  target: FallbackTarget
  accountId: string
  profile: MultimodelProfile | null
  /** Model id the request must use ('' on the claude account = alias still to resolve). */
  model: string
  /** Position of the target in the chain (to advance the cursor). */
  index: number
}

type Primary = { accountId: string; profile: MultimodelProfile | null }

let targets: FallbackTarget[] = []
let cursor = 0
let primary: Primary | undefined
let env: Env = process.env

function activeAccount(): string {
  return env.FNHARNESS_ACCOUNT ?? CLAUDE_ACCOUNT_ID
}

/** Configures the chain once at startup (flag wins over the setting). */
export function configureFallbackChain(
  entries: readonly string[],
  e: Env = process.env,
  store: AccountStore = loadStore(accountsFilePath(e)),
): FallbackTarget[] {
  env = e
  const isAccount = accountPredicate(store)
  targets = parseFallbackList(entries).map(r => parseFallbackTarget(r, isAccount))
  cursor = 0
  primary = undefined
  return targets
}

export function getFallbackTargets(): readonly FallbackTarget[] {
  return targets
}

function resolveTarget(
  t: FallbackTarget,
  index: number,
  store: AccountStore,
): ResolvedFallback | null {
  const accountId = t.account ?? activeAccount()
  try {
    if (accountId === CLAUDE_ACCOUNT_ID || store.accounts[accountId]?.kind === 'anthropic') {
      return { target: t, accountId, profile: null, model: t.model ?? '', index }
    }
    const withModel: AccountStore = t.model
      ? { ...store, accounts: { ...store.accounts, [accountId]: { ...store.accounts[accountId], model: t.model } } }
      : store
    const profile = profileForAccount(accountId, withModel, env)!
    return { target: t, accountId, profile, model: profile.model, index }
  } catch {
    // Missing key or unknown account: this entry cannot serve, try the next.
    return null
  }
}

/** The next entry that can actually serve, without switching anything. */
export function peekNextFallback(
  currentModel: string | undefined,
  store: AccountStore = loadStore(accountsFilePath(env)),
): ResolvedFallback | null {
  const active = { account: activeAccount(), model: currentModel }
  for (let i = cursor; i < targets.length; i++) {
    const r = resolveTarget(targets[i]!, i, store)
    if (r && !isSameBackend(r, active)) return r
  }
  return null
}

/**
 * Switches the live backend to `r` for the rest of the turn and returns the
 * model id to send. `claudeModel` resolves an alias on the native account and
 * runs after the switch, because it reads the model slots of the env.
 */
export function applyFallback(
  r: ResolvedFallback,
  claudeModel: (alias: string | undefined) => string,
): string {
  primary ??= { accountId: activeAccount(), profile: getMultimodelProfile() }
  cursor = r.index + 1
  setActiveProfile(r.profile, r.accountId, env)
  return r.profile ? r.model : claudeModel(r.target.model)
}

/**
 * Called at the start of a user turn: puts the primary account back after a
 * fallback. Returns the account to resync the session model with, or null when
 * nothing had changed.
 */
export function restorePrimary(): Primary | null {
  cursor = 0
  if (!primary) return null
  const p = primary
  primary = undefined
  setActiveProfile(p.profile, p.accountId, env)
  return p
}

export function isFallbackActive(): boolean {
  return primary !== undefined
}

export function resetFallbackChainForTesting(): void {
  targets = []
  cursor = 0
  primary = undefined
  env = process.env
}
