/**
 * Accounts: named, switchable backends (claude, llamacpp, openai, ...).
 *
 * An account is either the native Anthropic path ("claude") or an
 * OpenAI-compatible backend built from a provider preset plus optional
 * per-account overrides (key, model, base URL) persisted in
 * `<config dir>/accounts.json` with mode 0600.
 *
 * Everything that touches the filesystem takes its paths/env as parameters so
 * the pure parts stay testable.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { SecretError, defaultCtx, resolveRef } from '../../secrets/secrets.js'
import { findProvider } from './catalog.js'
import { loadCatalog } from './catalogStore.js'
import { getProviderPresets, providerKeyRef } from '../../config/providers.js'
import {
  MultimodelConfigError,
  resolveProfile,
  type MultimodelProfile,
} from './profiles.js'

export const CLAUDE_ACCOUNT_ID = 'claude'

/**
 * `anthropic`: a Claude account with its own OAuth login; its tokens and
 * organisation data live in `<config>/accounts/<id>/` (services/accounts).
 * `openai_compat` (the default, so older accounts.json files keep working):
 * an OpenAI-compatible backend built from a provider preset.
 */
export type AccountKind = 'anthropic' | 'openai_compat'

export type StoredAccount = {
  kind?: AccountKind
  /** Directory an anthropic account was imported from (`/account import`); read-only, never written. */
  importedFrom?: string
  provider?: string
  label?: string
  baseUrl?: string
  apiKey?: string
  /**
   * Where the key lives instead of `apiKey`: `<gestor>:<ref>` (pass:apis/venice,
   * file:x, keyring:x, cmd:x, env:X). Managed with /secrets; see services/secrets.
   */
  apiKeyRef?: string
  model?: string
  smallModel?: string
  /** Context profile (/scope, Ctrl+Tab) remembered for this account. */
  contextProfile?: { mcp: string; skill: string; tools: string }
}

export type AccountStore = {
  /** Last account used (written by every switch). */
  active?: string
  /**
   * Account fixed by the user for new sessions (`/account default <id>`).
   * Wins over `active`; absent = "last used".
   */
  default?: string
  accounts: Record<string, StoredAccount>
}

export type Account = {
  id: string
  label: string
  /** null for the native Anthropic account. */
  provider: string | null
  baseUrl: string | null
  /** Whether the account can be used right now without more setup. */
  ready: boolean
  /** Why it is not ready, or a short hint when it is. */
  detail: string
}

type Env = Record<string, string | undefined>

export function accountsFilePath(env: Env = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'accounts.json')
}

export function loadStore(path = accountsFilePath()): AccountStore {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return { active: raw.active, default: raw.default, accounts: raw.accounts ?? {} }
  } catch {
    return { accounts: {} }
  }
}

/** Like `loadStore` but an unreadable or invalid file throws; a missing one is an empty store. */
export function loadStoreStrict(path = accountsFilePath()): AccountStore {
  if (!existsSync(path)) return { accounts: {} }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  return { active: raw.active, default: raw.default, accounts: raw.accounts ?? {} }
}

export function saveStore(store: AccountStore, path = accountsFilePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  // writeFileSync only applies the mode on creation.
  chmodSync(path, 0o600)
}

/** Pure: the kind of a stored account (absent = openai_compat). */
export function accountKind(stored: StoredAccount | undefined): AccountKind {
  return stored?.kind === 'anthropic' ? 'anthropic' : 'openai_compat'
}

/** Pure: whether `id` is a Claude (Anthropic OAuth) account: `claude` or a stored `kind: anthropic`. */
export function isAnthropicAccount(id: string, store: AccountStore): boolean {
  return id === CLAUDE_ACCOUNT_ID || accountKind(store.accounts[id]) === 'anthropic'
}

/** Pure: ids of every Claude account, `claude` first. */
export function anthropicAccountIds(store: AccountStore): string[] {
  return [
    CLAUDE_ACCOUNT_ID,
    ...Object.keys(store.accounts).filter(id => id !== CLAUDE_ACCOUNT_ID && accountKind(store.accounts[id]) === 'anthropic'),
  ]
}

/** The env the profile resolver should see for one account. */
export function accountEnv(
  id: string,
  store: AccountStore,
  base: Env,
): Env {
  const stored = store.accounts[id] ?? {}
  const provider = stored.provider ?? id
  return {
    ...base,
    CLAUDE_MULTIMODEL_PROVIDER: provider,
    CLAUDE_MULTIMODEL_BASE_URL: stored.baseUrl,
    CLAUDE_MULTIMODEL_API_KEY: stored.apiKey ?? keyFromRef(id, stored, provider, base),
    CLAUDE_MULTIMODEL_MODEL: stored.model,
    CLAUDE_MULTIMODEL_SMALL_MODEL: stored.smallModel ?? stored.model,
  }
}

/** Name of the environment variable that carries a provider's key (VENICE_API_KEY, ...), if known. */
export function providerKeyEnv(provider: string, base: Env = process.env): string | undefined {
  return getProviderPresets()[provider]?.apiKeyEnv ?? findProvider(loadCatalog(base), provider)?.env[0]
}

/**
 * Key behind `apiKeyRef` (or the provider's `keyRef` in providers.json). An exported provider variable (VENICE_API_KEY, ...)
 * wins over the reference, so it is not even read; a literal `apiKey` in the
 * store still wins over both (older behaviour). A reference that cannot be read
 * aborts with the reason instead of the generic "needs an API key".
 */
function keyFromRef(id: string, stored: StoredAccount, provider: string, base: Env): string | undefined {
  // The account's own reference wins; else the one providers.json gives its
  // provider (a preset `keyRef` or the `keyRefTemplate`), except for local
  // servers that need no key.
  const ref = stored.apiKeyRef ?? (getProviderPresets()[provider]?.keyOptional ? undefined : providerKeyRef(provider))
  if (!ref) return undefined
  const envName = providerKeyEnv(provider, base)
  if (envName && base[envName]) return undefined
  try {
    return resolveRef(ref, defaultCtx(base))
  } catch (err) {
    const why = err instanceof SecretError ? err.message : String(err)
    throw new MultimodelConfigError(`No se pudo leer la clave de "${id}" (${ref}): ${why}. Revisa /secrets.`)
  }
}

/** Resolves an account to a backend profile; null means native Anthropic. */
export function profileForAccount(
  id: string,
  store: AccountStore,
  base: Env,
): MultimodelProfile | null {
  if (isAnthropicAccount(id, store)) return null
  const known = id in getProviderPresets() || id in store.accounts
  if (!known) {
    throw new MultimodelConfigError(
      `Unknown account "${id}". Use /account list to see the available ones.`,
    )
  }
  return resolveProfile(accountEnv(id, store, base))
}

export function listAccounts(store: AccountStore, base: Env): Account[] {
  const ids = [
    CLAUDE_ACCOUNT_ID,
    ...Object.keys(getProviderPresets()).filter(id => id !== 'custom'),
    ...Object.keys(store.accounts).filter(
      id => id !== CLAUDE_ACCOUNT_ID && !(id in getProviderPresets()),
    ),
  ]
  return ids.map(id => describeAccount(id, store, base))
}

function describeAccount(id: string, store: AccountStore, base: Env): Account {
  if (isAnthropicAccount(id, store)) {
    const stored = store.accounts[id]
    return {
      id,
      label: stored?.label ?? 'Claude (Anthropic)',
      provider: null,
      baseUrl: stored?.baseUrl ?? null,
      ready: true,
      detail:
        id === CLAUDE_ACCOUNT_ID
          ? 'cuenta nativa; usa /login dentro de fnharness'
          : `cuenta Claude; credenciales en accounts/${id}/ (/account add claude ${id} para iniciar sesión)`,
    }
  }
  const stored = store.accounts[id]
  try {
    const profile = profileForAccount(id, store, base)!
    return {
      id,
      label: stored?.label ?? profile.label,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      ready: true,
      detail: `${profile.model} @ ${profile.baseUrl}`,
    }
  } catch (err) {
    const preset = getProviderPresets()[stored?.provider ?? id]
    return {
      id,
      label: stored?.label ?? preset?.label ?? id,
      provider: stored?.provider ?? id,
      baseUrl: stored?.baseUrl ?? preset?.baseUrl ?? null,
      ready: false,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Probes a local server's model list so the picker can show what is up. */
export async function probeBackend(
  baseUrl: string,
  timeoutMs = 800,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

export function isLocalUrl(baseUrl: string | null): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/** Can `id` be resolved to an account right now (built-in, preset or saved)? */
export function isKnownAccount(id: string, store: AccountStore): boolean {
  return id === CLAUDE_ACCOUNT_ID || id in getProviderPresets() || id in store.accounts
}

/**
 * Account id chosen at launch: `--account` (env) first, then the default the
 * user fixed, then the last one used, then claude. A default that no longer
 * exists is skipped rather than aborting the launch.
 */
export function startupAccountId(store: AccountStore, env: Env): string {
  if (env.CLAUDE_MULTIMODEL_ACCOUNT) return env.CLAUDE_MULTIMODEL_ACCOUNT
  if (store.default && isKnownAccount(store.default, store)) return store.default
  return store.active || CLAUDE_ACCOUNT_ID
}

/** Why `startupAccountId` picked what it did, for `--accounts` and `/account list`. */
export function startupSource(store: AccountStore, env: Env): 'flag' | 'default' | 'last' | 'fallback' {
  if (env.CLAUDE_MULTIMODEL_ACCOUNT) return 'flag'
  if (store.default && isKnownAccount(store.default, store)) return 'default'
  return store.active ? 'last' : 'fallback'
}

/** Pure: store with the default set (`null` clears it: back to "last used"). */
export function withDefault(store: AccountStore, id: string | null): AccountStore {
  if (id === null) {
    const { default: _drop, ...rest } = store
    return rest
  }
  if (!isKnownAccount(id, store)) {
    throw new MultimodelConfigError(`Unknown account "${id}". Use /account list to see the available ones.`)
  }
  return { ...store, default: id }
}

export function storeExists(path = accountsFilePath()): boolean {
  return existsSync(path)
}
