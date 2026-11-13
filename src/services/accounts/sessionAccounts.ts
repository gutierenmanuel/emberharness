/**
 * Which Claude (Anthropic OAuth) accounts are in force in this session.
 *
 * - The **active** account answers token and identity lookups: the request
 *   scope's account when a routed request (`claude-work:sonnet`) runs, else
 *   the session's account when it is a Claude one, else `claude`.
 * - The **in-force** set is the session's Claude account plus every Claude
 *   account that has served a request in this session (decision D7: their
 *   organisation policies apply to the whole session while they are in use).
 * - A **disabled** account is one whose managed-settings dialog was rejected:
 *   it no longer serves requests in this session.
 *
 * Leaf module (fs/path only, through anthropicFiles): the settings pipeline
 * reads it. The request scope lives in profiles.ts, which is not a leaf, so
 * it is injected with setScopedAccountResolver() by anthropicAccounts.ts.
 */

import { configHome, fileMtimeMs, readJsonObject, ROOT_LINKED_ACCOUNT_ID } from './anthropicFiles.js'
import { join } from 'path'

type Env = Record<string, string | undefined>
type StoreView = { accounts: Record<string, { kind?: string; baseUrl?: string; label?: string; importedFrom?: string }> }

let scopedResolver: () => string | undefined = () => undefined

/** Injected by anthropicAccounts.ts: the account of the live request scope, if any. */
export function setScopedAccountResolver(fn: () => string | undefined): void {
  scopedResolver = fn
}

let storeCache: { path: string; mtimeMs: number; store: StoreView } | undefined

/** accounts.json as a minimal view, re-read only when the file changes (called per token lookup). */
export function readStoreView(env: Env = process.env): StoreView {
  const path = join(configHome(env), 'accounts.json')
  const mtimeMs = fileMtimeMs(path)
  if (storeCache && storeCache.path === path && storeCache.mtimeMs === mtimeMs) return storeCache.store
  const raw = readJsonObject<{ accounts?: StoreView['accounts'] }>(path)
  const store: StoreView = { accounts: raw?.accounts && typeof raw.accounts === 'object' ? raw.accounts : {} }
  storeCache = { path, mtimeMs, store }
  return store
}

/** Pure: `id` is a Claude account in `store`. */
export function isAnthropicIn(id: string, store: StoreView): boolean {
  return id === ROOT_LINKED_ACCOUNT_ID || store.accounts[id]?.kind === 'anthropic'
}

export function isAnthropicAccountId(id: string, env: Env = process.env): boolean {
  return isAnthropicIn(id, readStoreView(env))
}

/** The session's account when it is a Claude one, else null (session on an OpenAI-compatible account). */
export function sessionAnthropicAccountId(env: Env = process.env): string | null {
  const id = env.FNHARNESS_ACCOUNT ?? ROOT_LINKED_ACCOUNT_ID
  return isAnthropicAccountId(id, env) ? id : null
}

/** The Claude account that answers token and identity lookups right now. */
export function activeAnthropicAccountId(env: Env = process.env): string {
  const scoped = scopedResolver()
  if (scoped && isAnthropicAccountId(scoped, env)) return scoped
  return sessionAnthropicAccountId(env) ?? ROOT_LINKED_ACCOUNT_ID
}

// ── in-force and disabled accounts ──────────────────────────────────────

const touched = new Set<string>()
const disabled = new Map<string, string>()
const listeners = new Set<(id: string) => void>()

/**
 * Records that `id` served (or is about to serve) a request. Returns true the
 * first time, and tells the listeners so cached policies are re-merged.
 */
export function markAccountTouched(id: string): boolean {
  if (touched.has(id)) return false
  touched.add(id)
  for (const l of listeners) {
    try {
      l(id)
    } catch {
      // A listener must never break the request that touched the account.
    }
  }
  return true
}

export function onAccountTouched(fn: (id: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Pure: in-force accounts, the session's first, without disabled ones or duplicates. */
export function inForceAccounts(session: string | null, used: Iterable<string>, off: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  for (const id of [...(session ? [session] : []), ...used]) {
    if (!out.includes(id) && !off.has(id)) out.push(id)
  }
  return out
}

/** The Claude accounts whose policies apply to this session right now. */
export function accountsInForce(env: Env = process.env): string[] {
  return inForceAccounts(sessionAnthropicAccountId(env), touched, disabled)
}

export function touchedAccounts(): string[] {
  return [...touched]
}

export function disableAccountForSession(id: string, reason: string): void {
  disabled.set(id, reason)
  for (const l of listeners) {
    try {
      l(id)
    } catch {
      // ignore
    }
  }
}

export function enableAccountForSession(id: string): void {
  if (!disabled.delete(id)) return
  for (const l of listeners) {
    try {
      l(id)
    } catch {
      // ignore
    }
  }
}

/** Why `id` is disabled in this session, or undefined when it is usable. */
export function accountDisabledReason(id: string): string | undefined {
  return disabled.get(id)
}

let readyHook: ((id: string) => Promise<void>) | null = null

/**
 * Injected by remote managed settings: what must happen before a Claude
 * account serves its first request in this session (load its organisation's
 * settings and policies, and ask about dangerous ones).
 */
export function setAccountReadyHook(fn: ((id: string) => Promise<void>) | null): void {
  readyHook = fn
}

export function accountReady(id: string): Promise<void> | null {
  return readyHook ? readyHook(id) : null
}

export function resetSessionAccountsForTesting(): void {
  touched.clear()
  disabled.clear()
  storeCache = undefined
}
